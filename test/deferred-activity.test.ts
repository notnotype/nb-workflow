import { describe, expect, test } from "bun:test";

import { MemoryWorkflowBackend } from "../src/backend";
import { MemoryDefinitionRegistry } from "../src/definitions";
import type {
    ActivityExecutionRequest,
    DeferredActivityExecutor,
} from "../src/ports";
import { WorkflowRunner } from "../src/runner";
import type {
    WorkflowDefinition,
    WorkflowRunState,
} from "../src/types";

describe("Deferred Activity", () => {
    test("first call enters waiting and persists the activity receipt", async () => {
        const backend = new MemoryWorkflowBackend();
        const requests: ActivityExecutionRequest[] = [];
        const deferred: DeferredActivityExecutor = {
            startAction: async (request) => {
                requests.push(request);
                return {
                    status: "pending",
                    receipt: "completion-1",
                    reason: "queued by host",
                };
            },
        };
        const definition: WorkflowDefinition = {
            key: "deferred-first-call",
            version: "1",
            manifestHash: "sha256:deferred-first-call-v1",
            run: async (workflow) => await workflow.callAction(
                "source.fetch@1",
                { sourceId: "source-1" },
            ),
        };

        const runner = new WorkflowRunner(
            {},
            {},
            { backend, deferredActivities: deferred },
        );

        const waiting = await runner.start(definition, null);

        expect(waiting.status).toBe("waiting");
        expect(waiting.pendingActivities).toEqual([{
            kind: "action",
            key: "root#0",
            path: "root",
            seq: 0,
            fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
            reference: "source.fetch@1",
            receipt: "completion-1",
            reason: "queued by host",
            stateRevision: expect.any(Number),
            createdAt: expect.any(String),
        }]);
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
            reference: "source.fetch@1",
            input: { sourceId: "source-1" },
            context: {
                runId: waiting.runId,
                activity: {
                    key: "root#0",
                    path: "root",
                    seq: 0,
                    kind: "action",
                },
            },
        });

        expect(await backend.loadRun(waiting.runId)).toMatchObject({
            status: "waiting",
            pendingActivities: waiting.pendingActivities,
        });
    });

    test("completion writes the original journal entry and duplicate delivery is idempotent", async () => {
        const backend = new MemoryWorkflowBackend();
        const deferred: DeferredActivityExecutor = {
            startAction: async () => ({
                status: "pending",
                receipt: "completion-success",
                reason: "waiting for worker",
            }),
        };
        const definition: WorkflowDefinition = {
            key: "deferred-completion-success",
            version: "1",
            manifestHash: "sha256:deferred-completion-success-v1",
            run: async (workflow) => await workflow.callAction(
                "source.fetch@1",
                { sourceId: "source-1" },
            ),
        };
        const runner = new WorkflowRunner(
            {},
            {},
            { backend, deferredActivities: deferred },
        );
        const waiting = await runner.start(definition, null);
        const activity = waiting.pendingActivities[0]!;
        const completion = {
            activityKey: activity.key,
            receipt: activity.receipt,
            reference: activity.reference,
            fingerprint: activity.fingerprint,
            status: "completed" as const,
            result: { entries: 3 },
        };

        const completed = await runner.completeActivity(
            waiting.runId,
            completion,
        );

        expect(completed).toMatchObject({
            status: "completed",
            result: { entries: 3 },
            pendingActivities: [],
            journal: [{
                key: activity.key,
                kind: "action",
                fingerprint: activity.fingerprint,
                result: {
                    kind: "inline",
                    value: { entries: 3 },
                },
            }],
        });
        expect(completed.activityCompletions).toHaveLength(1);

        await expect(
            runner.completeActivity(waiting.runId, completion),
        ).resolves.toMatchObject({
            status: "completed",
            result: { entries: 3 },
        });
    });

    test("failed completion resumes the workflow as a deterministic failure", async () => {
        const backend = new MemoryWorkflowBackend();
        const starts: string[] = [];
        const deferred: DeferredActivityExecutor = {
            startAction: async (request) => {
                starts.push(request.context.activity.key);
                return {
                    status: "pending",
                    receipt: "completion-failure",
                    reason: "worker failed later",
                };
            },
        };
        const definition: WorkflowDefinition = {
            key: "deferred-completion-failure",
            version: "1",
            manifestHash: "sha256:deferred-completion-failure-v1",
            run: async (workflow) => await workflow.callAction(
                "source.fetch@1",
                { sourceId: "source-1" },
            ),
        };
        const runner = new WorkflowRunner(
            {},
            {},
            { backend, deferredActivities: deferred },
        );
        const waiting = await runner.start(definition, null);
        const activity = waiting.pendingActivities[0]!;

        const failed = await runner.completeActivity(waiting.runId, {
            activityKey: activity.key,
            receipt: activity.receipt,
            reference: activity.reference,
            fingerprint: activity.fingerprint,
            status: "failed",
            error: "upstream timeout",
        });

        expect(failed).toMatchObject({
            status: "failed",
            error: "upstream timeout",
            pendingActivities: [],
        });
        expect(starts).toEqual(["root#0"]);
    });

    test("different completion result is rejected without changing the accepted result", async () => {
        const backend = new MemoryWorkflowBackend();
        const deferred: DeferredActivityExecutor = {
            startAction: async () => ({
                status: "pending",
                receipt: "completion-conflict",
                reason: "waiting for worker",
            }),
        };
        const definition: WorkflowDefinition = {
            key: "deferred-completion-conflict",
            version: "1",
            manifestHash: "sha256:deferred-completion-conflict-v1",
            run: async (workflow) => await workflow.callAction(
                "source.fetch@1",
                { sourceId: "source-1" },
            ),
        };
        const runner = new WorkflowRunner(
            {},
            {},
            { backend, deferredActivities: deferred },
        );
        const waiting = await runner.start(definition, null);
        const activity = waiting.pendingActivities[0]!;
        const accepted = {
            activityKey: activity.key,
            receipt: activity.receipt,
            reference: activity.reference,
            fingerprint: activity.fingerprint,
            status: "completed" as const,
            result: { entries: 1 },
        };
        await runner.completeActivity(waiting.runId, accepted);

        await expect(
            runner.completeActivity(waiting.runId, {
                ...accepted,
                result: { entries: 2 },
            }),
        ).rejects.toBeInstanceOf(Error);
        expect(runner.view(waiting.runId)).toMatchObject({
            status: "completed",
            result: { entries: 1 },
        });
    });

    test("completion after cancellation is rejected and cannot write the journal", async () => {
        const backend = new MemoryWorkflowBackend();
        const deferred: DeferredActivityExecutor = {
            startAction: async () => ({
                status: "pending",
                receipt: "completion-late",
                reason: "waiting for worker",
            }),
        };
        const definition: WorkflowDefinition = {
            key: "deferred-completion-late",
            version: "1",
            manifestHash: "sha256:deferred-completion-late-v1",
            run: async (workflow) => await workflow.callAction(
                "source.fetch@1",
                { sourceId: "source-1" },
            ),
        };
        const runner = new WorkflowRunner(
            {},
            {},
            { backend, deferredActivities: deferred },
        );
        const waiting = await runner.start(definition, null);
        const activity = waiting.pendingActivities[0]!;
        const cancelled = await runner.cancel(waiting.runId);
        expect(cancelled.status).toBe("cancelled");

        await expect(
            runner.completeActivity(waiting.runId, {
                activityKey: activity.key,
                receipt: activity.receipt,
                reference: activity.reference,
                fingerprint: activity.fingerprint,
                status: "completed",
                result: { late: true },
            }),
        ).rejects.toMatchObject({
            name: "DeferredActivityLateCompletionError",
        });
        expect(runner.view(waiting.runId)).toMatchObject({
            status: "cancelled",
            journal: [],
        });
    });

    test("cancellation retries after a concurrent Backend revision conflict", async () => {
        const backend = new ConflictOnceOnCancelBackend();
        const deferred: DeferredActivityExecutor = {
            startAction: async () => ({
                status: "pending",
                receipt: "completion-cancel-retry",
                reason: "waiting for worker",
            }),
        };
        const definition: WorkflowDefinition = {
            key: "deferred-cancel-retry",
            version: "1",
            manifestHash: "sha256:deferred-cancel-retry-v1",
            run: async (workflow) => await workflow.callAction(
                "source.fetch@1",
                { sourceId: "source-1" },
            ),
        };
        const runner = new WorkflowRunner(
            {},
            {},
            { backend, deferredActivities: deferred },
        );
        const waiting = await runner.start(definition, null);

        await expect(runner.cancel(waiting.runId)).resolves.toMatchObject({
            status: "cancelled",
        });
        expect(await backend.loadRun(waiting.runId)).toMatchObject({
            status: "cancelled",
            logs: ["external update"],
        });
    });

    test("invalid duplicate completion payload is rejected before idempotency", async () => {
        const backend = new MemoryWorkflowBackend();
        const deferred: DeferredActivityExecutor = {
            startAction: async () => ({
                status: "pending",
                receipt: "completion-invalid-duplicate",
                reason: "waiting for worker",
            }),
        };
        const definition: WorkflowDefinition = {
            key: "deferred-invalid-duplicate",
            version: "1",
            manifestHash: "sha256:deferred-invalid-duplicate-v1",
            run: async (workflow) => await workflow.callAction(
                "source.fetch@1",
                { sourceId: "source-1" },
            ),
        };
        const runner = new WorkflowRunner(
            {},
            {},
            { backend, deferredActivities: deferred },
        );
        const waiting = await runner.start(definition, null);
        const activity = waiting.pendingActivities[0]!;
        const accepted = {
            activityKey: activity.key,
            receipt: activity.receipt,
            reference: activity.reference,
            fingerprint: activity.fingerprint,
            status: "completed" as const,
            result: null,
        };

        await runner.completeActivity(waiting.runId, accepted);

        await expect(runner.completeActivity(waiting.runId, {
            activityKey: accepted.activityKey,
            receipt: accepted.receipt,
            reference: accepted.reference,
            fingerprint: accepted.fingerprint,
            status: "completed",
        })).rejects.toThrow(/requires result/);
    });

    test("completion loses a concurrent cancel without writing a journal", async () => {
        const backend = new PauseFirstSaveBackend();
        const deferred: DeferredActivityExecutor = {
            startAction: async () => ({
                status: "pending",
                receipt: "completion-vs-cancel",
                reason: "waiting for worker",
            }),
        };
        const definition: WorkflowDefinition = {
            key: "deferred-completion-vs-cancel",
            version: "1",
            manifestHash: "sha256:deferred-completion-vs-cancel-v1",
            run: async (workflow) => await workflow.callAction(
                "source.fetch@1",
                { sourceId: "source-1" },
            ),
        };
        const definitions = new MemoryDefinitionRegistry();
        const first = new WorkflowRunner(
            {},
            {},
            { backend, definitions, deferredActivities: deferred },
        );
        const waiting = await first.start(definition, null);
        const activity = waiting.pendingActivities[0]!;
        const pause = backend.pauseNextSave();
        const completion = first.completeActivity(waiting.runId, {
            activityKey: activity.key,
            receipt: activity.receipt,
            reference: activity.reference,
            fingerprint: activity.fingerprint,
            status: "completed",
            result: { accepted: false },
        });
        await pause.started;

        const second = new WorkflowRunner({}, {}, { backend, definitions });
        await expect(second.cancel(waiting.runId)).resolves.toMatchObject({
            status: "cancelled",
        });
        pause.release();

        await expect(completion).rejects.toMatchObject({
            name: "DeferredActivityLateCompletionError",
        });
        expect(await backend.loadRun(waiting.runId)).toMatchObject({
            status: "cancelled",
            pendingActivities: [],
            activityCompletions: [{ status: "cancelled" }],
            journal: [],
        });
    });
    test("terminal execution persist loses concurrent cancel and closes the Run", async () => {
        const backend = new CancelOnCompletionPersistBackend();
        const definitions = new MemoryDefinitionRegistry();
        const runner = new WorkflowRunner(
            {},
            {},
            { backend, definitions },
        );
        const completed = await runner.start({
            key: "deferred-terminal-cancel-race",
            version: "1",
            manifestHash: "sha256:deferred-terminal-cancel-race-v1",
            run: async () => ({ done: true }),
        }, null);

        expect(completed).toMatchObject({
            status: "cancelled",
            cancelRequestedAt: "2026-08-13T00:00:01.000Z",
            resumeRequired: false,
        });
        expect(await backend.loadRun(completed.runId)).toMatchObject({
            status: "cancelled",
            cancelRequestedAt: "2026-08-13T00:00:01.000Z",
            resumeRequired: false,
        });
        await expect(runner.cancel(completed.runId)).resolves.toMatchObject({
            status: "cancelled",
        });
    });
});

class PauseFirstSaveBackend extends MemoryWorkflowBackend {
    private pause:
        | {
            started: () => void;
            wait: Promise<void>;
        }
        | undefined;

    pauseNextSave(): { started: Promise<void>; release(): void } {
        let markStarted!: () => void;
        let release!: () => void;
        const started = new Promise<void>((resolve) => {
            markStarted = resolve;
        });
        const wait = new Promise<void>((resolve) => {
            release = resolve;
        });
        this.pause = { started: markStarted, wait };
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

class ConflictOnceOnCancelBackend extends MemoryWorkflowBackend {
    private injected = false;

    override async saveRun(next: Parameters<MemoryWorkflowBackend["saveRun"]>[0], expectedRevision: number) {
        if (!this.injected && next.status === "cancelled") {
            this.injected = true;
            const current = await this.loadRun(next.runId);
            if (!current) {
                throw new Error("Expected the cancellation Run to exist.");
            }
            await super.saveRun({
                ...current,
                logs: ["external update"],
                updatedAt: "2026-08-13T00:00:01.000Z",
            }, current.revision);
        }
        return await super.saveRun(next, expectedRevision);
    }
}

class CancelOnCompletionPersistBackend extends MemoryWorkflowBackend {
    private injected = false;

    override async saveRun(
        next: WorkflowRunState,
        expectedRevision: number,
    ): Promise<WorkflowRunState> {
        if (!this.injected && next.status === "completed") {
            this.injected = true;
            const current = await this.loadRun(next.runId);
            if (!current) {
                throw new Error("Expected the completed Run to exist.");
            }
            await super.saveRun({
                ...current,
                cancelRequestedAt: "2026-08-13T00:00:01.000Z",
                updatedAt: "2026-08-13T00:00:01.000Z",
            }, current.revision);
        }
        return await super.saveRun(next, expectedRevision);
    }
}
