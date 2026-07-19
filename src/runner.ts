import { AsyncLocalStorage } from "node:async_hooks";
import { fingerprint } from "./fingerprint";
import { SessionStore } from "./session-store";
import { AgentRegistry } from "./agents";
import type {
    ActivityRecord, AskSpec, EntryId, InvokeOptions, InvokeResult, JsonValue, PendingAsk,
    ProgressState, RunStatus, RunView, SessionHandle, SessionId, Wf, WorkflowDefinition,
} from "./types";

/** ask 无应答时抛出的挂起信号：run 转 waiting，落盘退内存（spike 中即留在 RunRecord） */
export class SuspendSignal extends Error {
    constructor() {
        super("workflow 挂起等待人类应答");
        this.name = "SuspendSignal";
    }
}

/** 分支上下文：并发分支各持独立路径，seq 按路径计数，与完成顺序无关 */
const branchContext = new AsyncLocalStorage<{ path: string }>();

type RunRecord = {
    runId: string;
    def: WorkflowDefinition;
    args: JsonValue;
    callerSessionId: SessionId | null;
    status: RunStatus;
    result?: JsonValue;
    error?: string;
    /** key -> record；journal 跨执行持久，重放按它命中 */
    journal: Map<string, ActivityRecord>;
    pendingAsks: PendingAsk[];
    logs: string[];
    progress: ProgressState | null;
};

/** 单次执行（首跑或 resume 重放）内的易变状态；每次 execute 重建 */
class ExecutionState {
    /** 路径 -> 下一个 seq；重放时脚本确定性保证计数一致 */
    counters = new Map<string, number>();
    /** 路径 -> 首个不匹配 seq；该 seq 起本路径后缀失效转真跑 */
    dirtyFrom = new Map<string, number>();
    /** 本 run 创建且 ephemeral 的 session，run 成功后归档 */
    ephemeral = new Set<SessionId>();

    nextSeq(path: string): number {
        const seq = this.counters.get(path) ?? 0;
        this.counters.set(path, seq + 1);
        return seq;
    }
}

/** 执行运行时：Activity 包装器 + 锁 + 挂起登记，供 wf 面与 Handle 共用 */
class Runtime {
    constructor(
        readonly run: RunRecord,
        readonly exec: ExecutionState,
        readonly store: SessionStore,
        readonly agents: AgentRegistry,
        readonly env: RunEnv,
    ) {}

    path(): string {
        return branchContext.getStore()?.path ?? "root";
    }

    /**
     * Activity 核心：ActivityKey = (路径, 序号, kind, 参数指纹)。
     * 全匹配 → 返回记录值；不匹配 → 本路径从该 seq 起后缀失效，转真实执行。
     * spike 只记成功：错误不落 journal，重跑时重执行（发现 F4）。
     */
    async activity<T extends JsonValue>(kind: string, params: JsonValue, fn: () => Promise<T>): Promise<T> {
        const path = this.path();
        const seq = this.exec.nextSeq(path);
        const key = `${path}#${seq}`;
        const fp = fingerprint(params);
        const dirty = this.exec.dirtyFrom.get(path);
        const cached = this.run.journal.get(key);
        if (cached && (dirty === undefined || seq < dirty)) {
            if (cached.kind === kind && cached.fingerprint === fp) {
                this.env.onEvent?.({ type: "activity", runId: this.run.runId, record: cached, cached: true });
                return cached.result as T;
            }
            this.exec.dirtyFrom.set(path, seq);
            this.run.journal.delete(key);
        }
        const result = await fn();
        const record: ActivityRecord = { key, path, seq, kind, fingerprint: fp, result };
        this.run.journal.set(key, record);
        this.env.onEvent?.({ type: "activity", runId: this.run.runId, record, cached: false });
        return result;
    }

    /** ask 专用：命中 journal 直接返回应答；miss 则登记 pending 并抛挂起信号 */
    async askActivity(spec: AskSpec): Promise<JsonValue> {
        const path = this.path();
        const seq = this.exec.nextSeq(path);
        const key = `${path}#${seq}`;
        const fp = fingerprint(spec as unknown as JsonValue);
        const cached = this.run.journal.get(key);
        if (cached && cached.kind === "ask" && cached.fingerprint === fp) {
            this.env.onEvent?.({ type: "activity", runId: this.run.runId, record: cached, cached: true });
            return cached.result;
        }
        const pending: PendingAsk = { key, path, seq, fingerprint: fp, spec };
        this.run.pendingAsks.push(pending);
        this.env.onEvent?.({ type: "ask_pending", runId: this.run.runId, ask: pending });
        throw new SuspendSignal();
    }

    /** run 持锁到结束/挂起；重放命中的 open/acquire/create 也要重新加锁（锁是运行时态，不进 journal） */
    lock(sessionId: SessionId): void {
        this.store.lock(sessionId, this.run.runId);
    }
}

/**
 * SessionHandle：持显式游标。append/invoke 锚定游标而非全局 active leaf，
 * 这样挂起期间用户直接对话移动了 active leaf，重放也不会错位（发现 F2）。
 */
class Handle implements SessionHandle {
    private cursor: EntryId | null;

    constructor(private rt: Runtime, readonly id: SessionId, initialLeaf: EntryId | null) {
        this.cursor = initialLeaf;
    }

    leaf(): EntryId | null {
        return this.cursor;
    }

    async transcript(opts?: { tail?: number }): Promise<import("./types").SessionEntry[]> {
        const full = await this.rt.activity("sessions.transcript", { id: this.id, cursor: this.cursor, tail: opts?.tail ?? null },
            async () => this.rt.store.transcript(this.id, this.cursor) as unknown as JsonValue);
        const list = full as unknown as import("./types").SessionEntry[];
        return opts?.tail ? list.slice(-opts.tail) : list;
    }

    async checkout(entryId: EntryId): Promise<void> {
        await this.rt.activity("sessions.checkout", { id: this.id, entryId }, async () => {
            this.rt.store.setActiveLeaf(this.id, entryId);
            return null;
        });
        this.cursor = entryId;
    }

    async append(msg: { role: "user" | "assistant"; message?: string; input?: JsonValue }): Promise<EntryId> {
        const parent = this.cursor;
        const id = await this.rt.activity("sessions.append",
            { id: this.id, role: msg.role, message: msg.message ?? null, input: msg.input ?? null },
            async () => {
                const entry = this.rt.store.append(this.id, parent, {
                    type: "message", role: msg.role, message: msg.message, input: msg.input, origin: "workflow",
                });
                this.rt.store.setActiveLeaf(this.id, entry.id);
                return entry.id;
            });
        this.cursor = id;
        return id;
    }

    async invoke(opts: InvokeOptions): Promise<InvokeResult> {
        const parent = this.cursor;
        const out = await this.rt.activity("agents.invoke",
            { id: this.id, mode: opts.mode ?? "prompt", message: opts.message ?? null, input: opts.input ?? null },
            async () => {
                const user = this.rt.store.append(this.id, parent, {
                    type: "message", role: "user", message: opts.message, input: opts.input, origin: "workflow",
                });
                const resp = await this.rt.agents.respond(this.rt.store, this.id, user.id, opts);
                if (resp.waiting) {
                    this.rt.store.setActiveLeaf(this.id, user.id);
                    return { status: "waiting", result: { message: resp.message, data: null }, newLeaf: user.id } as unknown as JsonValue;
                }
                const asst = this.rt.store.append(this.id, user.id, {
                    type: "message", role: "assistant", message: resp.message, data: resp.data, origin: "workflow",
                });
                this.rt.store.setActiveLeaf(this.id, asst.id);
                return { status: "completed", result: { message: resp.message, data: resp.data ?? null }, newLeaf: asst.id } as unknown as JsonValue;
            }) as unknown as { status: "completed" | "waiting"; result: InvokeResult["result"]; newLeaf: EntryId };
        this.cursor = out.newLeaf;
        return { status: out.status, result: out.result };
    }

    async excursion<T>(at: EntryId | "leaf", fn: (branch: SessionHandle) => Promise<T>): Promise<T> {
        const origin = this.cursor;
        if (at !== "leaf") await this.checkout(at);
        try {
            return await fn(this);
        } finally {
            // 异常（含挂起）也恢复原位，旁支留在树上可追溯
            if (origin !== null) await this.checkout(origin);
        }
    }
}

/**
 * 运行时事件流：接入 NeuroBook 后对应 session-event-hub / SSE 公开投影的前置形态。
 * activity 事件带 cached 标记：replay 命中 = true（前端可用快闪表现"缓存命中"）。
 */
export type WorkflowEvent =
    | { type: "status"; runId: string; status: RunStatus }
    | { type: "activity"; runId: string; record: ActivityRecord; cached: boolean }
    | { type: "ask_pending"; runId: string; ask: PendingAsk }
    | { type: "log"; runId: string; message: string }
    | { type: "progress"; runId: string; state: ProgressState };

export type RunEnv = {
    /** wf.workspace.read 的数据源 */
    files?: Record<string, string>;
    /** 运行时事件订阅（SSE 前置形态） */
    onEvent?: (event: WorkflowEvent) => void;
};

/** 组装 V1 收敛面的 wf 根对象 */
function createWf(rt: Runtime, args: JsonValue): Wf {
    const openHandle = async (sessionId: SessionId): Promise<SessionHandle> => {
        const out = await rt.activity("sessions.open", { id: sessionId },
            async () => ({ leafId: rt.store.activeLeaf(sessionId) })) as { leafId: EntryId | null };
        rt.lock(sessionId);
        return new Handle(rt, sessionId, out.leafId);
    };

    return {
        args,
        agents: {
            profile: (profileKey) => rt.activity("agents.profile", { profileKey }, async () => rt.agents.profileInfo(profileKey)),
            create: async (profileKey, opts = {}) => {
                const out = await rt.activity("agents.create",
                    { profileKey, initial: opts.initial ?? null, tags: opts.tags ?? [], parent: opts.parent?.id ?? null, ephemeral: opts.ephemeral ?? false },
                    async () => {
                        const meta = rt.store.createSession({
                            profileKey, kind: "chat", tags: opts.tags ?? [], parentSessionId: opts.parent?.id,
                        });
                        return { sessionId: meta.sessionId };
                    }) as { sessionId: SessionId };
                if (opts.ephemeral) rt.exec.ephemeral.add(out.sessionId);
                rt.lock(out.sessionId);
                return new Handle(rt, out.sessionId, null);
            },
            acquire: async ({ profileKey, tag, parent }) => {
                const out = await rt.activity("agents.acquire", { profileKey, tag },
                    async () => {
                        const found = rt.store.findByTag(profileKey, tag);
                        if (found) return { sessionId: found.sessionId, leafId: rt.store.activeLeaf(found.sessionId), created: false };
                        const meta = rt.store.createSession({ profileKey, kind: "chat", tags: [tag], parentSessionId: parent?.id });
                        return { sessionId: meta.sessionId, leafId: null, created: true };
                    }) as { sessionId: SessionId; leafId: EntryId | null };
                rt.lock(out.sessionId);
                return new Handle(rt, out.sessionId, out.leafId);
            },
            invoke: async (sessionId, opts) => (await openHandle(sessionId)).invoke(opts),
        },
        sessions: { open: openHandle },
        all: async (thunks) => {
            // 每个 thunk 一条子路径，避免同路径并发争抢 seq
            const mapSeq = rt.exec.nextSeq(rt.path());
            const parent = rt.path();
            return await collectBranches(thunks.map((thunk, i) => () =>
                branchContext.run({ path: `${parent}/${mapSeq}:${i}` }, thunk)), thunks.length);
        },
        map: async (items, fn, opts = {}) => {
            const mapSeq = rt.exec.nextSeq(rt.path());
            const parent = rt.path();
            const thunks = items.map((item, i) => () =>
                branchContext.run({ path: `${parent}/${mapSeq}:${i}` }, () => fn(item, i)));
            return await collectBranches(thunks, opts.concurrency ?? 4);
        },
        ask: (spec) => rt.askActivity(spec),
        log: (message) => {
            rt.run.logs.push(message);
            rt.env.onEvent?.({ type: "log", runId: rt.run.runId, message });
        },
        progress: (state) => {
            rt.run.progress = { ...rt.run.progress, ...state };
            rt.env.onEvent?.({ type: "progress", runId: rt.run.runId, state: rt.run.progress });
        },
        workspace: {
            read: (path) => rt.activity("workspace.read", { path }, async () => {
                const content = rt.env.files?.[path];
                if (content === undefined) throw new Error(`workspace 文件不存在: ${path}`);
                return content;
            }),
        },
        caller: async () => {
            if (rt.run.callerSessionId === null) throw new Error("本 run 无 caller（面 A 触发）");
            return await openHandle(rt.run.callerSessionId);
        },
    };
}

/**
 * 并发收集：挂起的分支不阻止兄弟分支完成（它们的结果照常进 journal），
 * 全部落定后若有挂起统一上抛；业务错误 fail-fast（不再取新任务，已开始的跑完）。
 */
async function collectBranches<T>(thunks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
    const results = new Array<T>(thunks.length);
    const errors: unknown[] = [];
    let suspended = false;
    let next = 0;
    const worker = async () => {
        while (errors.length === 0) {
            const i = next++;
            if (i >= thunks.length) return;
            try {
                results[i] = await thunks[i]();
            } catch (error) {
                if (error instanceof SuspendSignal) suspended = true;
                else errors.push(error);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, thunks.length)) }, worker));
    if (errors.length > 0) throw errors[0];
    if (suspended) throw new SuspendSignal();
    return results;
}

/** workflow 运行器：start / resume / rerun；run 状态与 journal 常驻内存（spike） */
export class WorkflowRunner {
    private runs = new Map<string, RunRecord>();
    private nextRunId = 1;

    constructor(private store: SessionStore, private agents: AgentRegistry, private env: RunEnv = {}) {}

    /** 面 A（无 caller）/ 面 B（callerSessionId = 发起 agent 的 session） */
    async start(def: WorkflowDefinition<never, never> | WorkflowDefinition, args: JsonValue, opts?: { callerSessionId?: SessionId }): Promise<RunView> {
        const run: RunRecord = {
            runId: `run_${this.nextRunId++}`,
            def: def as WorkflowDefinition,
            args,
            callerSessionId: opts?.callerSessionId ?? null,
            status: "running",
            journal: new Map(),
            pendingAsks: [],
            logs: [],
            progress: null,
        };
        this.runs.set(run.runId, run);
        return await this.execute(run);
    }

    /** 应答 pending ask 后重放续跑；answers 按 ask key 对号 */
    async resume(runId: string, answers: Record<string, JsonValue>): Promise<RunView> {
        const run = this.record(runId);
        if (run.status !== "waiting") throw new Error(`run ${runId} 非 waiting 状态`);
        for (const ask of run.pendingAsks) {
            const answer = answers[ask.key];
            if (answer === undefined) throw new Error(`缺少 ask 应答: ${ask.key}（${ask.spec.title}）`);
            run.journal.set(ask.key, { key: ask.key, path: ask.path, seq: ask.seq, kind: "ask", fingerprint: ask.fingerprint, result: answer });
        }
        return await this.execute(run);
    }

    /** 崩溃/失败后按既有 journal 重放恢复（已完成 Activity 不重跑） */
    async rerun(runId: string): Promise<RunView> {
        return await this.execute(this.record(runId));
    }

    view(runId: string): RunView {
        return toView(this.record(runId));
    }

    private async execute(run: RunRecord): Promise<RunView> {
        run.status = "running";
        this.env.onEvent?.({ type: "status", runId: run.runId, status: "running" });
        run.pendingAsks = [];
        run.logs = [];
        run.progress = null;
        run.error = undefined;
        const exec = new ExecutionState();
        const rt = new Runtime(run, exec, this.store, this.agents, this.env);
        try {
            const result = await branchContext.run({ path: "root" }, () => run.def.run(createWf(rt, run.args), run.args));
            run.status = "completed";
            run.result = result as JsonValue;
            for (const sessionId of exec.ephemeral) this.store.archive(sessionId);
        } catch (error) {
            if (error instanceof SuspendSignal) {
                run.status = "waiting";
            } else {
                run.status = "failed";
                run.error = error instanceof Error ? error.message : String(error);
                // 失败时清掉并发兄弟分支挂起登记的 ask：run 已不可应答，残留会误导 UI
                run.pendingAsks = [];
            }
        } finally {
            // 结束或挂起都释放锁：挂起可能等很久，不该锁死用户对话
            this.store.releaseAll(run.runId);
            this.env.onEvent?.({ type: "status", runId: run.runId, status: run.status });
        }
        return toView(run);
    }

    private record(runId: string): RunRecord {
        const run = this.runs.get(runId);
        if (!run) throw new Error(`run ${runId} 不存在`);
        return run;
    }
}

function toView(run: RunRecord): RunView {
    return {
        runId: run.runId,
        workflowKey: run.def.key,
        status: run.status,
        result: run.result,
        error: run.error,
        pendingAsks: [...run.pendingAsks],
        logs: [...run.logs],
        progress: run.progress,
        journal: [...run.journal.values()].sort((a, b) => a.path === b.path ? a.seq - b.seq : a.path.localeCompare(b.path)),
    };
}
