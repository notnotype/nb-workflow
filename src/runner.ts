import {
    UnsupportedActivityExecutor,
    assertVersionedReference,
} from "./activities";
import {
    MemoryWorkflowBackend,
    SystemClock,
    SystemRandomSource,
    UuidIdGenerator,
    assertBackendCapabilities,
    WorkflowBackendConflictError,
    type WorkflowBackend,
} from "./backend";
import { UnsupportedChildWorkflowStore } from "./children";
import {
    MemoryDefinitionRegistry,
} from "./definitions";
import { UnsupportedEventSink } from "./events";
import { assertJsonValue, fingerprint } from "./fingerprint";
import type {
    ActivityExecutor,
    ChildWorkflowStore,
    Clock,
    DefinitionRegistry,
    DeferredActivityExecutor,
    EventSink,
    IdGenerator,
    RandomSource,
    SignalStore,
    TimerStore,
    WorkflowPorts,
} from "./ports";
import {
    DeferredActivityCompletionConflictError,
    DeferredActivityLateCompletionError,
    DeferredActivityNotFoundError,
} from "./deferred-activities";
import {
    runRecordToView,
    type RunRecord,
} from "./run-record";
import {
    RunnerRunStore,
} from "./runner-run-store";
import {
    archiveEphemeralSessions,
    bindExternalAbort,
    isTerminal,
    markCancelled,
    unbindExternalAbort,
    validateConcurrencyPolicy,
    type WorkflowRunnerOptions,
    type WorkflowSignalOptions,
    type WorkflowStartOptions,
} from "./runner-support";
import { WorkflowCancelledError } from "./runtime";
import { executeWorkflowRun } from "./runner-execution";
import type {
    RunEnv,
} from "./runtime-events";
import { emitWorkflowEvent } from "./runtime-events";
import {
    UnsupportedSignalStore,
    validateSignalReference,
} from "./signals";
import { UnsupportedTimerStore } from "./timers";
import type {
    ActivityCompletionRecord,
    ActivityRecord,
    AnyWorkflowDefinition,
    BackendCapabilities,
    DeferredActivityCompletionInput,
    JsonValue,
    PendingActivity,
    RunView,
} from "./types";
import { WorkflowValueCodec } from "./values";

export class WorkflowRunner {
    private readonly inFlight = new Set<string>();
    private readonly controlInFlight = new Set<string>();
    private readonly backend: WorkflowBackend;
    private readonly definitions: DefinitionRegistry;
    private readonly activities: ActivityExecutor;
    private readonly deferredActivities: DeferredActivityExecutor | undefined;
    private readonly children: ChildWorkflowStore;
    private readonly events: EventSink;
    private readonly signals: SignalStore;
    private readonly timers: TimerStore;
    private readonly values: WorkflowValueCodec;
    private readonly clock: Clock;
    private readonly ids: IdGenerator;
    private readonly random: RandomSource;
    private readonly defaultConcurrency: number;
    private readonly maxConcurrency: number;
    private readonly capabilities: BackendCapabilities;
    private readonly runStore: RunnerRunStore;

    constructor(
        private readonly ports: WorkflowPorts = {},
        private readonly env: RunEnv = {},
        options: WorkflowRunnerOptions = {},
    ) {
        this.clock = options.clock ?? new SystemClock();
        this.ids = options.ids ?? new UuidIdGenerator();
        this.random = options.random ?? new SystemRandomSource();
        this.maxConcurrency = options.maxConcurrency ?? 16;
        this.defaultConcurrency = options.defaultConcurrency ?? 4;
        validateConcurrencyPolicy(
            this.defaultConcurrency,
            this.maxConcurrency,
        );
        this.backend = options.backend ?? new MemoryWorkflowBackend();
        this.definitions = options.definitions
            ?? new MemoryDefinitionRegistry();
        this.activities = options.activities
            ?? new UnsupportedActivityExecutor();
        this.deferredActivities = options.deferredActivities;
        this.children = options.children
            ?? new UnsupportedChildWorkflowStore();
        this.events = options.events ?? new UnsupportedEventSink();
        this.signals = options.signals ?? new UnsupportedSignalStore();
        this.timers = options.timers ?? new UnsupportedTimerStore();
        this.values = new WorkflowValueCodec(
            options.values,
            options.inlineValueLimitBytes,
        );
        this.capabilities = {
            ...this.backend.capabilities,
            durableSignals:
                this.backend.capabilities.durableSignals
                && options.signals !== undefined,
            durableTimers:
                this.backend.capabilities.durableTimers
                && options.timers !== undefined,
            childWorkflows:
                this.backend.capabilities.childWorkflows
                && options.children !== undefined,
            externalReceipts:
                this.backend.capabilities.externalReceipts
                && options.deferredActivities !== undefined,
            outbox:
                this.backend.capabilities.outbox
                && options.events !== undefined,
            valueReferences:
                this.backend.capabilities.valueReferences
                && this.values.supportsReferences,
        };
        this.runStore = new RunnerRunStore(
            this.backend,
            this.definitions,
            this.values,
            this.clock,
            this.capabilities,
        );
    }

    begin(
        definition: AnyWorkflowDefinition,
        args: JsonValue,
        options: WorkflowStartOptions = {},
    ): { runId: string; done: Promise<RunView> } {
        assertJsonValue(args);
        if (options.budget !== undefined) {
            assertJsonValue(options.budget);
        }
        if (
            options.callerSessionId !== undefined
            && options.callerSessionId !== null
            && !Number.isSafeInteger(options.callerSessionId)
        ) {
            throw new Error(
                "Workflow callerSessionId must be a safe integer "
                + "or null.",
            );
        }
        if (
            options.defaultModel !== undefined
            && options.defaultModel !== null
            && typeof options.defaultModel !== "string"
        ) {
            throw new Error(
                "Workflow defaultModel must be a string or null.",
            );
        }
        assertBackendCapabilities(
            this.capabilities,
            definition.requires,
        );
        this.definitions.register(definition);
        const abortController = new AbortController();
        const now = this.clock.now().toISOString();
        const run: RunRecord = {
            runId: this.ids.nextId("run"),
            def: definition,
            args: structuredClone(args),
            callerSessionId: options.callerSessionId ?? null,
            abortController,
            defaultModel: options.defaultModel ?? null,
            workspace: options.workspace ?? null,
            ephemeralSessions: new Set(),
            status: "running",
            resumeRequired: false,
            cancelRequestedAt: null,
            budget: options.budget === undefined
                ? null
                : structuredClone(options.budget),
            checkpoint: null,
            journal: new Map(),
            pendingAsks: [],
            pendingWaits: [],
            pendingActivities: [],
            activityCompletions: [],
            logs: [],
            progress: null,
            revision: 0,
            createdAt: now,
            updatedAt: now,
            initialization: Promise.resolve(),
            persistence: Promise.resolve(),
        };
        this.runStore.add(run);
        bindExternalAbort(
            run,
            options.signal,
            this.clock,
            () => this.cancel(run.runId),
            (error) => emitWorkflowEvent(this.env, {
                type: "control_error",
                runId: run.runId,
                operation: "external_cancel",
                error: error instanceof Error
                    ? error.message
                    : String(error),
            }),
        );
        run.initialization = this.runStore.initialize(run);
        return {
            runId: run.runId,
            done: this.initializeAndExecute(run),
        };
    }

    async start(
        definition: AnyWorkflowDefinition,
        args: JsonValue,
        options: WorkflowStartOptions = {},
    ): Promise<RunView> {
        return await this.begin(definition, args, options).done;
    }

    async resume(
        runId: string,
        answers: Record<string, JsonValue>,
    ): Promise<RunView> {
        return await this.withControl(runId, async () => {
            const run = await this.runStore.loadRecord(runId);
            if (this.inFlight.has(runId)) {
                throw new Error(`run ${runId} 正在执行中`);
            }
            if (run.status !== "waiting") {
                throw new Error(
                    `run ${runId} 非 waiting 状态，当前为 ${run.status}`,
                );
            }
            if (run.pendingAsks.length === 0) {
                throw new Error(
                    `run ${runId} 没有可应答的 pending ask`,
                );
            }
            const answered = run.pendingAsks.map((ask) => {
                const answer = answers[ask.key];
                if (answer === undefined) {
                    throw new Error(
                        `缺少 ask 应答: ${ask.key}`
                        + `（${ask.spec.title}）`,
                    );
                }
                return { ask, answer };
            });
            const encoded = await Promise.all(answered.map(
                async ({ ask, answer }) => ({
                    ask,
                    result: await this.values.encode(answer),
                }),
            ));
            for (const { ask, result } of encoded) {
                run.journal.set(ask.key, {
                    key: ask.key,
                    path: ask.path,
                    seq: ask.seq,
                    kind: "ask",
                    fingerprint: ask.fingerprint,
                    result,
                });
            }
            run.status = "running";
            run.pendingAsks = [];
            await this.persist(run);
            return await this.execute(run);
        });
    }

    async rerun(runId: string): Promise<RunView> {
        return await this.withControl(runId, async () => {
            const run = await this.runStore.loadRecord(runId);
            if (run.status === "cancelled") {
                throw new Error(`run ${runId} 已取消，不能 rerun`);
            }
            if (
                run.status === "waiting"
                && run.pendingAsks.length > 0
            ) {
                throw new Error(
                    `run ${runId} 等待用户应答，不能 rerun`,
                );
            }
            if (
                run.status === "running"
                && !run.resumeRequired
                && !this.backend.capabilities.processRestart
            ) {
                throw new Error(`run ${runId} 正在执行，不能 rerun`);
            }
            return await this.execute(run);
        });
    }

    /**
     * 接收宿主对一个 pending Activity 的一次完成尝试，并在成功写入后
     * 恢复原 Workflow。Backend 的 CAS 是 completion 与 cancel 的并发边界。
     */
    async completeActivity(
        runId: string,
        input: DeferredActivityCompletionInput,
    ): Promise<RunView> {
        return await this.withControl(runId, async () => {
            validateCompletionInput(input);
            for (let attempt = 0; attempt < 2; attempt += 1) {
                try {
                    return await this.completeActivityOnce(runId, input);
                } catch (error) {
                    if (!isBackendConflict(error) || attempt > 0) {
                        throw error;
                    }
                    const refreshed = await this.runStore.reloadRecord(runId);
                    const existing = refreshed.activityCompletions.find(
                        (candidate) => candidate.key === input.activityKey,
                    );
                    if (existing) {
                        if (existing.status === "cancelled") {
                            if (
                                existing.completionFingerprint
                                === completionFingerprint(input)
                            ) {
                                return runRecordToView(refreshed);
                            }
                            throw new DeferredActivityLateCompletionError(
                                runId,
                                "cancelled",
                            );
                        }
                        if (
                            existing.completionFingerprint
                            === completionFingerprint(input)
                        ) {
                            return runRecordToView(refreshed);
                        }
                        throw new DeferredActivityCompletionConflictError(
                            input.activityKey,
                        );
                    }
                    if (isTerminal(refreshed)) {
                        throw new DeferredActivityLateCompletionError(
                            runId,
                            refreshed.status,
                        );
                    }
                }
            }
            throw new Error("Deferred Activity completion retry exhausted.");
        });
    }

    private async completeActivityOnce(
        runId: string,
        input: DeferredActivityCompletionInput,
    ): Promise<RunView> {
        const run = await this.runStore.loadRecord(runId);
        if (this.inFlight.has(runId)) {
            throw new Error("run " + runId + " 正在执行中");
        }
        const existing = run.activityCompletions.find(
            (candidate) => candidate.key === input.activityKey,
        );
        if (existing) {
            if (existing.status === "cancelled") {
                if (
                    existing.completionFingerprint
                    === completionFingerprint(input)
                ) {
                    return runRecordToView(run);
                }
                throw new DeferredActivityLateCompletionError(
                    runId,
                    "cancelled",
                );
            }
            const incomingFingerprint = completionFingerprint(input);
            if (existing.completionFingerprint === incomingFingerprint) {
                return runRecordToView(run);
            }
            throw new DeferredActivityCompletionConflictError(
                input.activityKey,
            );
        }
        if (isTerminal(run)) {
            throw new DeferredActivityLateCompletionError(
                runId,
                run.status,
            );
        }
        const pending = run.pendingActivities.find(
            (candidate) => candidate.key === input.activityKey,
        );
        if (!pending) {
            throw new DeferredActivityNotFoundError(input.activityKey);
        }
        assertCompletionMatches(pending, input);
        if (run.abortRequested) {
            throw new DeferredActivityLateCompletionError(
                runId,
                run.status,
            );
        }

        const completion: ActivityCompletionRecord = {
            ...pending,
            status: input.status,
            completionFingerprint: completionFingerprint(input),
            completedAt: this.clock.now().toISOString(),
            ...(input.error === undefined
                ? {}
                : { error: input.error }),
        };
        if (input.status === "completed") {
            if (input.result === undefined) {
                throw new Error(
                    "Completed Deferred Activity requires result.",
                );
            }
            completion.result = await this.values.encode(input.result);
            if (run.abortRequested) {
                throw new DeferredActivityLateCompletionError(
                    runId,
                    run.status,
                );
            }
            run.journal.set(pending.key, {
                key: pending.key,
                path: pending.path,
                seq: pending.seq,
                kind: "action",
                fingerprint: pending.fingerprint,
                result: completion.result,
            });
        }
        run.pendingActivities = run.pendingActivities.filter(
            (candidate) => candidate.key !== pending.key,
        );
        run.activityCompletions.push(completion);
        run.status = "running";
        run.resumeRequired = true;
        run.pendingWaits = run.pendingWaits.filter(
            (wait) => wait.key !== pending.key,
        );
        await this.persist(run);
        if (run.abortRequested) {
            markCancelled(run, this.clock.now().toISOString());
            await this.persist(run);
            return runRecordToView(run);
        }
        return await this.execute(run);
    }

    async signal(
        runId: string,
        reference: string,
        value: JsonValue,
        options: WorkflowSignalOptions = {},
    ): Promise<RunView> {
        return await this.withControl(runId, async () => {
            validateSignalReference(reference);
            assertJsonValue(value);
            const run = await this.runStore.loadRecord(runId);
            if (this.inFlight.has(runId)) {
                throw new Error(`run ${runId} 正在执行中`);
            }
            if (isTerminal(run)) {
                throw new Error(
                    `run ${runId} 已终止，不能接收 signal ${reference}`,
                );
            }
            await this.signals.publish({
                runId,
                reference,
                value,
                idempotencyKey: options.idempotencyKey
                    ?? this.ids.nextId("event"),
            });
            if (
                run.status === "waiting"
                && run.pendingWaits.some((wait) =>
                    wait.kind === "signal"
                    && wait.reference === reference
                )
            ) {
                return await this.execute(run);
            }
            return runRecordToView(run);
        });
    }

    async cancel(runId: string): Promise<RunView> {
        // 先发出 abort，保证正在运行的外部调用能尽快停下；终态修改和
        // 持久化随后排入控制串行区，避免与 completion 交错写同一 Run。
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const run = await this.runStore.loadRecord(runId);
            if (isTerminal(run)) {
                return runRecordToView(run);
            }
            run.abortRequested = true;
            run.cancelRequestedAt ??= this.clock.now().toISOString();
            if (!run.abortController.signal.aborted) {
                run.abortController.abort(new WorkflowCancelledError());
            }
            await this.children.cancelForParent(run.runId);
            if (!this.inFlight.has(runId) || run.status === "waiting") {
                await archiveEphemeralSessions(
                    run,
                    this.ports,
                ).catch(() => undefined);
                markCancelled(run, this.clock.now().toISOString());
                unbindExternalAbort(run);
            }
            try {
                await this.persist(run);
            } catch (error) {
                if (!isBackendConflict(error) || attempt > 0) {
                    throw error;
                }
                // persist() 已回滚到 Backend 快照；再次读取只是为了使
                // 控制路径明确看到外部并发更新，然后重试取消收口。
                await this.runStore.reloadRecord(runId);
                continue;
            }
            if (run.status === "cancelled") {
                emitWorkflowEvent(this.env, {
                    type: "status",
                    runId: run.runId,
                    status: run.status,
                });
            }
            return runRecordToView(run);
        }
        throw new Error("Workflow cancellation retry exhausted.");
    }

    view(runId: string): RunView {
        return this.runStore.view(runId);
    }

    async loadView(runId: string): Promise<RunView> {
        return await this.runStore.loadView(runId);
    }

    list(): RunView[] {
        return this.runStore.list();
    }

    async listStored(): Promise<RunView[]> {
        return await this.runStore.listStored();
    }

    private async initializeAndExecute(run: RunRecord): Promise<RunView> {
        try {
            await run.initialization;
        } catch (error) {
            this.runStore.delete(run.runId);
            unbindExternalAbort(run);
            throw error;
        }
        if (run.abortRequested) {
            markCancelled(run);
            await this.persist(run);
            unbindExternalAbort(run);
            emitWorkflowEvent(this.env, {
                type: "status",
                runId: run.runId,
                status: run.status,
            });
            return runRecordToView(run);
        }
        return await this.execute(run);
    }

    private async execute(run: RunRecord): Promise<RunView> {
        if (this.inFlight.has(run.runId)) {
            throw new Error(`run ${run.runId} 正在执行中`);
        }
        this.inFlight.add(run.runId);
        try {
            return await executeWorkflowRun({
                run,
                ports: this.ports,
                env: this.env,
                activities: this.activities,
                deferredActivities: this.deferredActivities,
                children: this.children,
                events: this.events,
                signals: this.signals,
                timers: this.timers,
                values: this.values,
                clock: this.clock,
                random: this.random,
                defaultConcurrency: this.defaultConcurrency,
                maxConcurrency: this.maxConcurrency,
                persist: () => this.persist(run),
            });
        } finally {
            this.inFlight.delete(run.runId);
        }
    }

    private async persist(run: RunRecord): Promise<void> {
        await this.runStore.persist(run);
    }

    private async withControl<T>(
        runId: string,
        operation: () => Promise<T>,
    ): Promise<T> {
        if (this.controlInFlight.has(runId)) {
            throw new Error("run " + runId + " 正在处理控制命令");
        }
        this.controlInFlight.add(runId);
        try {
            return await operation();
        } finally {
            this.controlInFlight.delete(runId);
        }
    }
}

function isBackendConflict(error: unknown): boolean {
    if (error instanceof WorkflowBackendConflictError) {
        return true;
    }
    return error instanceof Error
        && error.name === "WorkflowPersistenceError"
        && error.cause instanceof WorkflowBackendConflictError;
}

function validateCompletionInput(
    input: DeferredActivityCompletionInput,
): void {
    if (
        input === null
        || typeof input !== "object"
        || Array.isArray(input)
    ) {
        throw new Error("Deferred Activity completion must be an object.");
    }
    if (
        typeof input.activityKey !== "string"
        || !input.activityKey.trim()
        || typeof input.receipt !== "string"
        || !input.receipt.trim()
        || typeof input.reference !== "string"
        || !input.reference.trim()
        || typeof input.fingerprint !== "string"
        || !input.fingerprint.trim()
    ) {
        throw new Error("Deferred Activity completion identity is invalid.");
    }
    assertVersionedReference(input.reference);
    if (
        input.status !== "completed"
        && input.status !== "failed"
        && input.status !== "cancelled"
    ) {
        throw new Error("Deferred Activity completion status is invalid.");
    }
    const hasResult = Object.prototype.hasOwnProperty.call(input, "result");
    const hasError = Object.prototype.hasOwnProperty.call(input, "error");
    if (hasResult && input.result !== undefined) {
        assertJsonValue(input.result);
    }
    if (hasResult && input.result === undefined) {
        throw new Error("Deferred Activity completion result is invalid.");
    }
    if (hasError && typeof input.error !== "string") {
        throw new Error("Deferred Activity completion error must be a string.");
    }
    if (input.status === "completed") {
        if (!hasResult || hasError) {
            throw new Error("Completed Deferred Activity requires result and forbids error.");
        }
    } else if (input.status === "failed") {
        if (!hasError || !input.error?.trim() || hasResult) {
            throw new Error("Failed Deferred Activity requires error and forbids result.");
        }
    } else if (hasResult || hasError) {
        throw new Error("Cancelled Deferred Activity forbids result and error.");
    }
}

function assertCompletionMatches(
    pending: PendingActivity,
    input: DeferredActivityCompletionInput,
): void {
    if (
        pending.receipt !== input.receipt
        || pending.reference !== input.reference
        || pending.fingerprint !== input.fingerprint
    ) {
        throw new DeferredActivityCompletionConflictError(pending.key);
    }
}

function completionFingerprint(
    input: DeferredActivityCompletionInput,
): string {
    return fingerprint({
        activityKey: input.activityKey,
        receipt: input.receipt,
        reference: input.reference,
        fingerprint: input.fingerprint,
        status: input.status,
        hasResult: Object.prototype.hasOwnProperty.call(input, "result"),
        result: input.result === undefined ? null : input.result,
        hasError: Object.prototype.hasOwnProperty.call(input, "error"),
        error: input.error === undefined ? null : input.error,
    });
}
