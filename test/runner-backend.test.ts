import { describe, expect, test } from "bun:test";

import {
    MemoryActivityExecutor,
    MemoryDefinitionRegistry,
    MemorySessionStore,
    MemoryValueStore,
    MemoryWorkflowBackend,
    MockAgentPort,
    WorkflowBackendCapabilityError,
    WorkflowRunner,
    createMemoryWorkspace,
} from "../src/index";
import type {
    AgentWorkflowDefinition as WorkflowDefinition,
    AgentPort,
    JsonValue,
    WorkflowEvent,
    ValueRef,
    ValueStore,
    WorkflowContext,
    WorkflowRunState,
} from "../src/index";

describe("WorkflowRunner Backend integration", () => {
    test("unmet Backend requirements reject before creating or executing a Run", async () => {
        const backend = new MemoryWorkflowBackend();
        const sessions = new MemorySessionStore();
        const runner = new WorkflowRunner(
            { sessions, agents: new MockAgentPort(sessions) },
            {},
            { backend },
        );
        let executions = 0;
        const definition: WorkflowDefinition = {
            key: "requires-process-restart",
            requires: {
                durability: "durable",
                processRestart: true,
            },
            run: async () => {
                executions += 1;
                return null;
            },
        };

        expect(() => runner.begin(definition, null)).toThrow(
            WorkflowBackendCapabilityError,
        );
        expect(executions).toBe(0);
        expect(await backend.listRuns()).toEqual([]);
    });

    test("a new Runner resumes persisted journal without repeating completed activities", async () => {
        const backend = new MemoryWorkflowBackend();
        const definitions = new MemoryDefinitionRegistry();
        const sessions = new MemorySessionStore();
        const agents = new MockAgentPort(sessions);
        let reads = 0;
        const workspace = {
            async read(path: string) {
                reads += 1;
                return await createMemoryWorkspace({
                    "input.txt": "persisted value",
                }).read(path);
            },
        };
        let crashOnce = true;
        const definition: WorkflowDefinition = {
            key: "cross-runner-recovery",
            version: "3",
            run: async (wf) => {
                const value = await wf.workspace.read("input.txt");
                if (crashOnce) {
                    crashOnce = false;
                    throw new Error("simulated process loss");
                }
                return value;
            },
        };
        const firstRunner = new WorkflowRunner(
            { sessions, agents },
            { workspace },
            { backend, definitions },
        );

        const failed = await firstRunner.start(definition, null);
        expect(failed).toMatchObject({
            workflowVersion: "3",
            status: "failed",
            error: "simulated process loss",
        });
        expect(reads).toBe(1);

        const secondRunner = new WorkflowRunner(
            { sessions, agents },
            { workspace },
            { backend, definitions },
        );
        expect(await secondRunner.loadView(failed.runId)).toMatchObject({
            status: "failed",
            journal: [{
                kind: "workspace.read",
                result: {
                    kind: "inline",
                    value: "persisted value",
                },
            }],
        });
        expect(await secondRunner.listStored()).toHaveLength(1);

        const recovered = await secondRunner.rerun(failed.runId);
        expect(recovered).toMatchObject({
            status: "completed",
            result: "persisted value",
        });
        expect(reads).toBe(1);
        expect(await backend.loadRun(failed.runId)).toMatchObject({
            status: "completed",
            result: {
                kind: "inline",
                value: "persisted value",
            },
        });
    });

    test("Agent extension start context survives resume on a different Runner", async () => {
        const backend = new MemoryWorkflowBackend();
        const definitions = new MemoryDefinitionRegistry();
        const sessions = new MemorySessionStore();
        const agents = new MockAgentPort(sessions);
        const caller = await sessions.createSession({
            profileKey: "caller",
            kind: "chat",
            tags: [],
        });
        const definition: WorkflowDefinition = {
            key: "agent-extension-context-recovery",
            manifestHash:
                "sha256:agent-extension-context-recovery-v1",
            run: async (workflow) => {
                const approved = await workflow.ask({
                    kind: "approve",
                    title: "continue?",
                });
                const callerHandle = await workflow.caller();
                return {
                    approved,
                    callerSessionId: callerHandle.id,
                };
            },
        };
        const first = new WorkflowRunner(
            { sessions, agents },
            {},
            { backend, definitions },
        );
        const waiting = await first.start(
            definition,
            null,
            {
                callerSessionId: caller.sessionId,
                defaultModel: "test/model",
            },
        );
        const second = new WorkflowRunner(
            { sessions, agents },
            {},
            { backend, definitions },
        );

        const completed = await second.resume(waiting.runId, {
            [waiting.pendingAsks[0]!.key]: true,
        });

        expect(completed).toMatchObject({
            status: "completed",
            result: {
                approved: true,
                callerSessionId: caller.sessionId,
            },
        });
    });

    test("read-only views survive a definition change but replay requires the exact manifest", async () => {
        const backend = new MemoryWorkflowBackend();
        const firstDefinitions = new MemoryDefinitionRegistry();
        const sessions = new MemorySessionStore();
        const agents = new MockAgentPort(sessions);
        const original: WorkflowDefinition = {
            key: "manifest-bound-run",
            version: "2",
            manifestHash: "sha256:original",
            run: async () => {
                throw new Error("persist this failed Run");
            },
        };
        const firstRunner = new WorkflowRunner(
            { sessions, agents },
            {},
            { backend, definitions: firstDefinitions },
        );
        const failed = await firstRunner.start(original, null);
        expect(failed.status).toBe("failed");

        const changed: WorkflowDefinition = {
            key: "manifest-bound-run",
            version: "2",
            manifestHash: "sha256:changed-without-version-bump",
            run: async () => "must not execute",
        };
        const secondRunner = new WorkflowRunner(
            { sessions, agents },
            {},
            {
                backend,
                definitions: new MemoryDefinitionRegistry([changed]),
            },
        );

        expect(await secondRunner.loadView(failed.runId)).toMatchObject({
            workflowKey: "manifest-bound-run",
            workflowVersion: "2",
            workflowManifestHash: "sha256:original",
            status: "failed",
        });
        await expect(secondRunner.rerun(failed.runId)).rejects.toThrow(
            /manifest|definition/i,
        );
    });

    test("awaiting cancel waits until a waiting Run is durably cancelled", async () => {
        const backend = new PausableMemoryWorkflowBackend();
        const definitions = new MemoryDefinitionRegistry();
        const sessions = new MemorySessionStore();
        const runner = new WorkflowRunner(
            { sessions, agents: new MockAgentPort(sessions) },
            {},
            { backend, definitions },
        );
        const definition: WorkflowDefinition = {
            key: "durable-cancel",
            run: async (wf) => await wf.ask({
                kind: "approve",
                title: "continue?",
            }),
        };
        const waiting = await runner.start(definition, null);
        const pause = backend.pauseNextSave();
        let cancellationSettled = false;

        const cancellation = Promise.resolve(runner.cancel(waiting.runId))
            .then(() => {
                cancellationSettled = true;
            });
        await pause.started;
        try {
            expect(cancellationSettled).toBe(false);
            expect(await backend.loadRun(waiting.runId)).toMatchObject({
                status: "waiting",
            });
        } finally {
            pause.release();
        }

        await cancellation;
        expect(await backend.loadRun(waiting.runId)).toMatchObject({
            status: "cancelled",
            pendingAsks: [],
        });
    });

    test("a Run can be cancelled while its initial Backend create is pending", async () => {
        const backend = new PausableCreateMemoryWorkflowBackend();
        let executions = 0;
        const definition: WorkflowDefinition = {
            key: "cancel-during-create",
            manifestHash: "sha256:cancel-during-create-v1",
            run: async () => {
                executions += 1;
                return null;
            },
        };
        const runner = new WorkflowRunner(
            {},
            {},
            { backend },
        );

        const { runId, done } = runner.begin(definition, null);
        await backend.createStarted;
        const cancellation = runner.cancel(runId);
        await Promise.resolve();
        backend.releaseCreate();

        await expect(cancellation).resolves.toMatchObject({
            status: "cancelled",
            cancelRequestedAt: expect.any(String),
        });
        await expect(done).resolves.toMatchObject({
            status: "cancelled",
        });
        expect(executions).toBe(0);
        expect(await backend.loadRun(runId)).toMatchObject({
            status: "cancelled",
            cancelRequestedAt: expect.any(String),
        });
    });

    test("a running cancellation request is persisted before its activity settles", async () => {
        const backend = new MemoryWorkflowBackend();
        const sessions = new MemorySessionStore();
        let markStarted!: () => void;
        let release!: () => void;
        const started = new Promise<void>((resolve) => {
            markStarted = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const agents: AgentPort = {
            async profileInfo(profileKey) {
                return { profileKey };
            },
            async invoke(_sessionId, fromLeaf) {
                markStarted();
                await gate;
                return {
                    status: "completed",
                    message: "late",
                    data: null,
                    newLeaf: fromLeaf,
                };
            },
        };
        const runner = new WorkflowRunner(
            { sessions, agents },
            {},
            { backend },
        );
        const definition: WorkflowDefinition = {
            key: "durable-running-cancel",
            run: async (wf) => {
                const agent = await wf.agents.create("slow");
                return await agent.invoke({}) as unknown as JsonValue;
            },
        };
        const { runId, done } = runner.begin(definition, null);
        await started;

        await runner.cancel(runId);

        expect(await backend.loadRun(runId)).toMatchObject({
            status: "running",
            cancelRequestedAt: expect.any(String),
        });
        release();
        await expect(done).resolves.toMatchObject({
            status: "cancelled",
            cancelRequestedAt: expect.any(String),
        });
    });

    test("an external AbortSignal reports cancellation persistence failure without an unhandled rejection", async () => {
        const backend = new FailOnNthSaveWorkflowBackend(2);
        const activities = new MemoryActivityExecutor();
        const controller = new AbortController();
        const events: WorkflowEvent[] = [];
        let markStarted!: () => void;
        let release!: () => void;
        const started = new Promise<void>((resolve) => {
            markStarted = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        activities.registerAction("external-abort.wait@1", async () => {
            markStarted();
            await gate;
            return null;
        });
        const runner = new WorkflowRunner(
            {},
            {
                onEvent: (event) => events.push(event),
            },
            { backend, activities },
        );
        const { done } = runner.begin({
            key: "external-abort-control-error",
            manifestHash: "sha256:external-abort-control-error-v1",
            run: async (workflow: WorkflowContext) => {
                await workflow.callAction("external-abort.wait@1", {});
                return null;
            },
        }, null, { signal: controller.signal });
        await started;

        controller.abort();
        await Promise.resolve();
        release();

        await expect(done).resolves.toMatchObject({
            status: "cancelled",
        });
        expect(events).toContainEqual({
            type: "control_error",
            runId: expect.any(String),
            operation: "external_cancel",
            error: "simulated Backend outage on save 2",
        });
    });

    test("cancellation during terminal ValueStore write cannot be overwritten by completion", async () => {
        const values = new BlockingValueStore();
        const runner = new WorkflowRunner(
            {},
            {},
            {
                values,
                inlineValueLimitBytes: 4,
            },
        );
        const { runId, done } = runner.begin({
            key: "cancel-terminal-value-write",
            manifestHash: "sha256:cancel-terminal-value-write-v1",
            run: async () => ({ completed: true }),
        }, null);
        await values.putStarted;

        const cancellation = runner.cancel(runId);
        values.releasePut();

        await expect(cancellation).resolves.toMatchObject({
            cancelRequestedAt: expect.any(String),
        });
        await expect(done).resolves.toMatchObject({
            status: "cancelled",
            result: undefined,
        });
    });

    test("cancellation during Activity ValueStore write cannot journal a late success", async () => {
        const values = new BlockingValueStore();
        const activities = new MemoryActivityExecutor();
        activities.registerAction("cancel.large-output@1", () => ({
            completed: true,
        }));
        const runner = new WorkflowRunner(
            {},
            {},
            {
                activities,
                values,
                inlineValueLimitBytes: 4,
            },
        );
        const { runId, done } = runner.begin({
            key: "cancel-activity-value-write",
            manifestHash: "sha256:cancel-activity-value-write-v1",
            run: async (workflow: WorkflowContext) =>
                await workflow.callAction(
                "cancel.large-output@1",
                {},
            ),
        }, null);
        await values.putStarted;

        const cancellation = runner.cancel(runId);
        values.releasePut();

        await expect(cancellation).resolves.toMatchObject({
            cancelRequestedAt: expect.any(String),
        });
        await expect(done).resolves.toMatchObject({
            status: "cancelled",
            journal: [],
        });
    });

    test("cancellation during checkpoint ValueStore write cannot advance the checkpoint", async () => {
        const values = new BlockingValueStore();
        const runner = new WorkflowRunner(
            {},
            {},
            {
                values,
                inlineValueLimitBytes: 4,
            },
        );
        const { runId, done } = runner.begin({
            key: "cancel-checkpoint-value-write",
            manifestHash: "sha256:cancel-checkpoint-value-write-v1",
            run: async (workflow: WorkflowContext) => {
                await workflow.checkpoint({ cursor: "page-2" });
                return null;
            },
        }, null);
        await values.putStarted;

        const cancellation = runner.cancel(runId);
        values.releasePut();

        await expect(cancellation).resolves.toMatchObject({
            cancelRequestedAt: expect.any(String),
        });
        await expect(done).resolves.toMatchObject({
            status: "cancelled",
            checkpoint: null,
            journal: [],
        });
    });

    test("Run views are isolated snapshots that cannot mutate Runner state", async () => {
        const sessions = new MemorySessionStore();
        const runner = new WorkflowRunner({
            sessions,
            agents: new MockAgentPort(sessions),
        });
        const definition: WorkflowDefinition = {
            key: "isolated-view",
            run: async (wf) => {
                wf.progress({ phase: "done" });
                return {
                    nested: {
                        value: "original",
                    },
                };
            },
        };
        const completed = await runner.start(definition, null);
        const mutableResult = completed.result as {
            nested: { value: string };
        };
        mutableResult.nested.value = "mutated by caller";
        completed.progress!.phase = "mutated by caller";

        expect(runner.view(completed.runId)).toMatchObject({
            result: {
                nested: {
                    value: "original",
                },
            },
            progress: {
                phase: "done",
            },
        });
    });

    test("an observation callback failure cannot change Workflow execution", async () => {
        const runner = new WorkflowRunner(
            {},
            {
                onEvent: () => {
                    throw new Error("observer unavailable");
                },
            },
        );

        await expect(runner.start({
            key: "observer-isolation",
            manifestHash: "sha256:observer-isolation-v1",
            run: async (workflow: WorkflowContext) => {
                workflow.log("still observable");
                return { completed: true };
            },
        }, null)).resolves.toMatchObject({
            status: "completed",
            result: { completed: true },
        });
    });

    test("Run input is snapshotted at begin and isolated from workflow mutation", async () => {
        const backend = new MemoryWorkflowBackend();
        let markStarted!: () => void;
        let release!: () => void;
        const started = new Promise<void>((resolve) => {
            markStarted = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const input = {
            nested: {
                value: "original",
            },
        };
        const definition: WorkflowDefinition = {
            key: "input-snapshot",
            manifestHash: "sha256:input-snapshot-v1",
            run: async (wf, args) => {
                markStarted();
                await gate;
                (wf.args as {
                    nested: { value: string };
                }).nested.value = "mutated inside workflow";
                return args;
            },
        };
        const runner = new WorkflowRunner(
            {},
            {},
            { backend },
        );
        const { runId, done } = runner.begin(definition, input);
        await started;
        input.nested.value = "mutated by caller";
        release();

        const completed = await done;

        expect(completed).toMatchObject({
            status: "completed",
            result: {
                nested: {
                    value: "mutated inside workflow",
                },
            },
        });
        expect(await backend.loadRun(runId)).toMatchObject({
            input: {
                kind: "inline",
                value: {
                    nested: {
                        value: "original",
                    },
                },
            },
        });
    });

    test("Backend write failure rejects execution instead of faking a workflow failure", async () => {
        const backend = new FailOnSaveWorkflowBackend();
        const definition: WorkflowDefinition = {
            key: "backend-failure",
            manifestHash: "sha256:backend-failure-v1",
            run: async () => "must not be reported as business failure",
        };
        const runner = new WorkflowRunner(
            {},
            {},
            { backend },
        );

        const { runId, done } = runner.begin(definition, null);

        await expect(done).rejects.toThrow("simulated Backend outage");
        expect(await backend.loadRun(runId)).toMatchObject({
            status: "running",
            revision: 0,
            error: undefined,
        });
    });

    test("Backend failure while journaling an Activity rejects instead of persisting a business failure", async () => {
        const backend = new FailOnNthSaveWorkflowBackend(2);
        const activities = new MemoryActivityExecutor();
        activities.registerAction("backend-failure.echo@1", (input) => input);
        const runner = new WorkflowRunner(
            {},
            {},
            { backend, activities },
        );
        const { runId, done } = runner.begin({
            key: "backend-failure-during-activity",
            manifestHash: "sha256:backend-failure-during-activity-v1",
            run: async (workflow: WorkflowContext) =>
                await workflow.callAction(
                "backend-failure.echo@1",
                { value: 1 },
            ),
        }, null);

        await expect(done).rejects.toThrow(
            "simulated Backend outage on save 2",
        );
        expect(await backend.loadRun(runId)).toMatchObject({
            status: "running",
            revision: 1,
            journal: [],
            error: undefined,
        });
    });

    test("resume validates every pending answer before changing the journal", async () => {
        const sessions = new MemorySessionStore();
        const runner = new WorkflowRunner({
            sessions,
            agents: new MockAgentPort(sessions),
        });
        const definition: WorkflowDefinition = {
            key: "atomic-resume-validation",
            run: async (wf) => await wf.all([
                () => wf.ask({ kind: "text", title: "first" }),
                () => wf.ask({ kind: "text", title: "second" }),
            ]) as JsonValue,
        };
        const waiting = await runner.start(definition, null);
        expect(waiting.pendingAsks).toHaveLength(2);

        await expect(runner.resume(waiting.runId, {
            [waiting.pendingAsks[0]!.key]: "only one answer",
        })).rejects.toThrow(/缺少 ask 应答/);

        expect(runner.view(waiting.runId)).toMatchObject({
            status: "waiting",
            pendingAsks: [
                { spec: { title: "first" } },
                { spec: { title: "second" } },
            ],
        });
        expect(
            runner.view(waiting.runId).journal.filter(
                (record) => record.kind === "ask",
            ),
        ).toEqual([]);
    });

    test("rerun persists a clean running projection before workflow code resumes", async () => {
        const backend = new MemoryWorkflowBackend();
        const definitions = new MemoryDefinitionRegistry();
        const sessions = new MemorySessionStore();
        const agents = new MockAgentPort(sessions);
        const runner = new WorkflowRunner(
            { sessions, agents },
            {},
            { backend, definitions },
        );
        let attempt = 0;
        let markSecondStarted!: () => void;
        let releaseSecond!: () => void;
        const secondStarted = new Promise<void>((resolve) => {
            markSecondStarted = resolve;
        });
        const secondGate = new Promise<void>((resolve) => {
            releaseSecond = resolve;
        });
        const definition: WorkflowDefinition = {
            key: "clean-rerun-projection",
            run: async (wf) => {
                attempt += 1;
                if (attempt === 1) {
                    wf.log("stale log");
                    throw new Error("first attempt failed");
                }
                markSecondStarted();
                await secondGate;
                return null;
            },
        };

        const first = await runner.start(definition, null);
        expect(first).toMatchObject({
            status: "failed",
            error: "first attempt failed",
            logs: ["stale log"],
        });

        const rerun = runner.rerun(first.runId);
        await secondStarted;

        expect(await backend.loadRun(first.runId)).toMatchObject({
            status: "running",
            logs: [],
        });
        expect((await backend.loadRun(first.runId))?.error).toBeUndefined();

        releaseSecond();
        await expect(rerun).resolves.toMatchObject({ status: "completed" });
    });
});

class PausableMemoryWorkflowBackend extends MemoryWorkflowBackend {
    private pause:
        | {
            started: () => void;
            wait: Promise<void>;
        }
        | undefined;

    pauseNextSave(): {
        started: Promise<void>;
        release(): void;
    } {
        let markStarted!: () => void;
        let release!: () => void;
        const started = new Promise<void>((resolve) => {
            markStarted = resolve;
        });
        const wait = new Promise<void>((resolve) => {
            release = resolve;
        });
        this.pause = {
            started: markStarted,
            wait,
        };
        return { started, release };
    }

    override async saveRun(
        next: WorkflowRunState,
        expectedRevision: number,
    ): Promise<WorkflowRunState> {
        const pause = this.pause;
        if (pause) {
            this.pause = undefined;
            pause.started();
            await pause.wait;
        }
        return await super.saveRun(next, expectedRevision);
    }
}

class PausableCreateMemoryWorkflowBackend extends MemoryWorkflowBackend {
    private markCreateStarted!: () => void;
    private release!: () => void;
    readonly createStarted = new Promise<void>((resolve) => {
        this.markCreateStarted = resolve;
    });
    private readonly createGate = new Promise<void>((resolve) => {
        this.release = resolve;
    });

    releaseCreate(): void {
        this.release();
    }

    override async createRun(
        initial: WorkflowRunState,
    ): Promise<WorkflowRunState> {
        this.markCreateStarted();
        await this.createGate;
        return await super.createRun(initial);
    }
}

class FailOnSaveWorkflowBackend extends MemoryWorkflowBackend {
    override async saveRun(): Promise<WorkflowRunState> {
        throw new Error("simulated Backend outage");
    }
}

class FailOnNthSaveWorkflowBackend extends MemoryWorkflowBackend {
    private saves = 0;

    constructor(private readonly failureNumber: number) {
        super();
    }

    override async saveRun(
        next: WorkflowRunState,
        expectedRevision: number,
    ): Promise<WorkflowRunState> {
        this.saves += 1;
        if (this.saves === this.failureNumber) {
            throw new Error(
                `simulated Backend outage on save ${this.saves}`,
            );
        }
        return await super.saveRun(next, expectedRevision);
    }
}

class BlockingValueStore implements ValueStore {
    private readonly delegate = new MemoryValueStore();
    private markPutStarted!: () => void;
    private release!: () => void;
    readonly putStarted = new Promise<void>((resolve) => {
        this.markPutStarted = resolve;
    });
    private readonly putGate = new Promise<void>((resolve) => {
        this.release = resolve;
    });

    releasePut(): void {
        this.release();
    }

    async put(value: JsonValue): Promise<ValueRef> {
        this.markPutStarted();
        await this.putGate;
        return await this.delegate.put(value);
    }

    async get(reference: ValueRef): Promise<JsonValue> {
        return await this.delegate.get(reference);
    }
}
