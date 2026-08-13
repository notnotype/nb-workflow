import type { WorkflowBackend } from "./backend";
import { MemoryActivityExecutor } from "./activities";
import { MemoryDefinitionRegistry } from "./definitions";
import type {
    DeferredActivityExecutor,
    ValueStore,
} from "./ports";
import { WorkflowRunner } from "./runner";
import type {
    DeferredActivityCompletionInput,
    JsonValue,
    PendingActivity,
    WorkflowDefinition,
    WorkflowRunState,
} from "./types";

export type WorkflowBackendFactory = () => Promise<WorkflowBackend> | WorkflowBackend;

export type WorkflowBackendConformanceCase = {
    name: string;
    run(factory: WorkflowBackendFactory): Promise<void>;
};

export type ValueStoreFactory = () => Promise<ValueStore> | ValueStore;

export type ValueStoreConformanceCase = {
    name: string;
    run(factory: ValueStoreFactory): Promise<void>;
};

export type DeferredActivityConformanceHarness = {
    backend: WorkflowBackend;
    deferredActivities: DeferredActivityExecutor;
    values: ValueStore;
    definitions?: MemoryDefinitionRegistry;
};

export type DeferredActivityConformanceFactory = () =>
    Promise<DeferredActivityConformanceHarness>
    | DeferredActivityConformanceHarness;

export type DeferredActivityConformanceCase = {
    name: string;
    run(factory: DeferredActivityConformanceFactory): Promise<void>;
};

export const deferredActivityConformanceCases:
readonly DeferredActivityConformanceCase[] = [
    {
        name: "pending Activity is persisted with identity and receipt",
        async run(factory) {
            const harness = await factory();
            const definition = deferredDefinition("deferred-conformance-pending");
            const runner = deferredRunner(harness, definition);
            const waiting = await runner.start(definition, null);
            equal(waiting.status, "waiting");
            equal(waiting.pendingActivities.length, 1);
            equal(waiting.pendingActivities[0]?.key, "root#0");
            equal(waiting.pendingActivities[0]?.reference, "source.fetch@1");
            equal(
                (await harness.backend.loadRun(waiting.runId))
                    ?.pendingActivities?.length,
                1,
            );
        },
    },
    {
        name: "completion resumes the original call across Runner instances",
        async run(factory) {
            const harness = await factory();
            const definitions = harness.definitions ?? new MemoryDefinitionRegistry();
            const definition = deferredDefinition("deferred-conformance-resume");
            const first = deferredRunner(harness, definition, definitions);
            const waiting = await first.start(definition, null);
            const pending = requirePending(waiting.pendingActivities[0]);
            const second = deferredRunner(harness, definition, definitions);
            const completed = await second.completeActivity(
                waiting.runId,
                completedInput(pending, { value: "completed" }),
            );
            equal(completed.status, "completed");
            equal(completed.result, { value: "completed" });
            equal(completed.pendingActivities, []);
            equal(completed.journal.length, 1);
        },
    },
    {
        name: "same completion is idempotent across two Runners",
        async run(factory) {
            const harness = await factory();
            const definitions = harness.definitions ?? new MemoryDefinitionRegistry();
            const definition = deferredDefinition("deferred-conformance-duplicate");
            const first = deferredRunner(harness, definition, definitions);
            const waiting = await first.start(definition, null);
            const pending = requirePending(waiting.pendingActivities[0]);
            const second = deferredRunner(harness, definition, definitions);
            const input = completedInput(pending, { value: "same" });
            const results = await Promise.all([
                first.completeActivity(waiting.runId, input),
                second.completeActivity(waiting.runId, input),
            ]);
            equal(
                results.filter((result) => result?.result !== undefined).length,
                1,
            );
            equal(
                results.every((result) => result?.activityCompletions.length === 1),
                true,
            );
            equal((await harness.backend.loadRun(waiting.runId))?.journal.length, 1);
        },
    },
    {
        name: "different completion conflicts and cannot replace accepted result",
        async run(factory) {
            const harness = await factory();
            const definitions = harness.definitions ?? new MemoryDefinitionRegistry();
            const definition = deferredDefinition("deferred-conformance-conflict");
            const first = deferredRunner(harness, definition, definitions);
            const waiting = await first.start(definition, null);
            const pending = requirePending(waiting.pendingActivities[0]);
            const second = deferredRunner(harness, definition, definitions);
            const outcomes = await Promise.allSettled([
                first.completeActivity(
                    waiting.runId,
                    completedInput(pending, { value: "left" }),
                ),
                second.completeActivity(
                    waiting.runId,
                    completedInput(pending, { value: "right" }),
                ),
            ]);
            equal(
                outcomes.filter((outcome) => outcome.status === "fulfilled").length,
                1,
            );
            equal(
                outcomes.filter((outcome) => outcome.status === "rejected").length,
                1,
            );
            const stored = await harness.backend.loadRun(waiting.runId);
            equal(stored?.journal.length, 1);
            equal(stored?.activityCompletions?.length, 1);
        },
    },
    {
        name: "cancel converts pending Activity to a tombstone and rejects late completion",
        async run(factory) {
            const harness = await factory();
            const definition = deferredDefinition("deferred-conformance-cancel");
            const runner = deferredRunner(harness, definition);
            const waiting = await runner.start(definition, null);
            const pending = requirePending(waiting.pendingActivities[0]);
            const cancelled = await runner.cancel(waiting.runId);
            equal(cancelled.status, "cancelled");
            equal(cancelled.pendingActivities, []);
            equal(cancelled.activityCompletions[0]?.status, "cancelled");
            await rejects(() => runner.completeActivity(
                waiting.runId,
                completedInput(pending, { late: true }),
            ));
        },
    },
    {
        name: "large completion uses ValueRef and replays without a second start",
        async run(factory) {
            const harness = await factory();
            const definitions = harness.definitions ?? new MemoryDefinitionRegistry();
            const definition = deferredDefinition("deferred-conformance-value-ref");
            const first = deferredRunner(harness, definition, definitions, 16);
            const waiting = await first.start(definition, null);
            const pending = requirePending(waiting.pendingActivities[0]);
            const value = { value: "large-".repeat(40) };
            const completed = await first.completeActivity(
                waiting.runId,
                completedInput(pending, value),
            );
            equal(completed.journal[0]?.result.kind, "ref");
            equal(completed.result, value);
            const second = deferredRunner(harness, definition, definitions, 16);
            const rerun = await second.rerun(waiting.runId);
            equal(rerun.result, value);
        },
    },
    {
        name: "resumeRequired allows recovery of an accepted completion after a host crash",
        async run(factory) {
            const harness = await factory();
            const definitions = harness.definitions ?? new MemoryDefinitionRegistry();
            const definition = deferredDefinition("deferred-conformance-resume-required");
            const first = deferredRunner(harness, definition, definitions);
            const waiting = await first.start(definition, null);
            const pending = requirePending(waiting.pendingActivities[0]);
            const storedWaiting = requireStored(
                await harness.backend.loadRun(waiting.runId),
            );
            const result = { value: "after-crash" };
            const encoded = {
                kind: "inline" as const,
                value: result,
            };
            await harness.backend.saveRun({
                ...storedWaiting,
                status: "running",
                resumeRequired: true,
                pendingActivities: [],
                activityCompletions: [{
                    ...pending,
                    status: "completed" as const,
                    completionFingerprint: "sha256:conformance-completion",
                    result: encoded,
                    completedAt: "2026-08-13T00:00:01.000Z",
                }],
                journal: [{
                    ...pending,
                    result: encoded,
                }],
            }, storedWaiting.revision);
            const second = deferredRunner(harness, definition, definitions);
            const recovered = await second.rerun(waiting.runId);
            equal(recovered.status, "completed");
            equal(recovered.resumeRequired, false);
            equal(recovered.result, result);
        },
    },
];

/**
 * 可被宿主 Backend 直接复用的最小一致性套件。
 *
 * 它不依赖 Bun/Vitest；测试框架只需逐个运行 case 并报告异常。
 */
export const workflowBackendConformanceCases:
readonly WorkflowBackendConformanceCase[] = [
    {
        name: "create/load returns isolated snapshots",
        async run(factory) {
            const backend = await factory();
            const initial = sampleRun("run_create");
            await backend.createRun(initial);

            initial.logs.push("mutated outside backend");
            const loaded = requireRun(await backend.loadRun(initial.runId));
            equal(loaded.logs, []);

            loaded.logs.push("mutated loaded clone");
            equal(
                requireRun(await backend.loadRun(initial.runId)).logs,
                [],
            );
        },
    },
    {
        name: "duplicate run creation is rejected",
        async run(factory) {
            const backend = await factory();
            const initial = sampleRun("run_duplicate");
            await backend.createRun(initial);
            await rejects(() => backend.createRun(initial));
        },
    },
    {
        name: "compare-and-swap increments revision",
        async run(factory) {
            const backend = await factory();
            const initial = await backend.createRun(sampleRun("run_cas"));
            const saved = await backend.saveRun({
                ...initial,
                status: "completed",
                result: {
                    kind: "inline",
                    value: { ok: true },
                },
                updatedAt: "2026-08-11T00:00:01.000Z",
            }, 0);

            equal(saved.revision, 1);
            equal(saved.status, "completed");
            equal(saved.result, {
                kind: "inline",
                value: { ok: true },
            });
        },
    },
    {
        name: "stale compare-and-swap is rejected",
        async run(factory) {
            const backend = await factory();
            const initial = await backend.createRun(sampleRun("run_stale"));
            await backend.saveRun({
                ...initial,
                logs: ["first"],
                updatedAt: "2026-08-11T00:00:01.000Z",
            }, 0);

            await rejects(() => backend.saveRun({
                ...initial,
                logs: ["stale"],
                updatedAt: "2026-08-11T00:00:02.000Z",
            }, 0));
            equal(
                requireRun(await backend.loadRun(initial.runId)).logs,
                ["first"],
            );
        },
    },
    {
        name: "immutable identity fields cannot change",
        async run(factory) {
            const backend = await factory();
            const initial = await backend.createRun(sampleRun("run_identity"));
            await rejects(() => backend.saveRun({
                ...initial,
                input: {
                    kind: "inline",
                    value: { changed: true },
                },
                updatedAt: "2026-08-11T00:00:01.000Z",
            }, 0));
        },
    },
    {
        name: "extension start context is immutable",
        async run(factory) {
            const backend = await factory();
            const initial = await backend.createRun(
                sampleRun("run_extension_context"),
            );
            await rejects(() => backend.saveRun({
                ...initial,
                extensionContext: {
                    "conformance.example@1": {
                        changed: true,
                    },
                },
                updatedAt: "2026-08-11T00:00:01.000Z",
            }, 0));
        },
    },
    {
        name: "list returns creation order and isolated snapshots",
        async run(factory) {
            const backend = await factory();
            await backend.createRun(sampleRun(
                "run_second",
                "2026-08-11T00:00:02.000Z",
            ));
            await backend.createRun(sampleRun(
                "run_first",
                "2026-08-11T00:00:01.000Z",
            ));

            const listed = await backend.listRuns();
            equal(listed.map((run) => run.runId), ["run_first", "run_second"]);
            listed[0]!.logs.push("outside");
            equal(
                requireRun(await backend.loadRun("run_first")).logs,
                [],
            );
        },
    },
];

/**
 * Backend 与 Kernel 的组合门禁。Cosmos Prisma Backend 可以直接传入自己的
 * factory；Activity/Definition 使用 Memory 实现，宿主需要为 durable 重放与
 * manifest 解析自带测试。
 */
export const workflowRunnerBackendConformanceCases:
readonly WorkflowBackendConformanceCase[] = [
    {
        name: "runner replays completed activity across instances",
        async run(factory) {
            const backend = await factory();
            const definitions = new MemoryDefinitionRegistry();
            const activities = new MemoryActivityExecutor();
            let calls = 0;
            activities.registerAction("conformance.echo@1", (input) => {
                calls += 1;
                return input;
            });
            let crashOnce = true;
            const definition: WorkflowDefinition = {
                key: "conformance-action-replay",
                manifestHash: "sha256:conformance-action-replay-v1",
                run: async (workflow) => {
                    const output = await workflow.callAction(
                        "conformance.echo@1",
                        { value: 7 },
                    );
                    if (crashOnce) {
                        crashOnce = false;
                        throw new Error("conformance crash");
                    }
                    return output;
                },
            };
            const first = new WorkflowRunner(
                {},
                {},
                { backend, definitions, activities },
            );
            const failed = await first.start(definition, null);
            equal(failed.status, "failed");
            equal(calls, 1);

            const second = new WorkflowRunner(
                {},
                {},
                { backend, definitions, activities },
            );
            const recovered = await second.rerun(failed.runId);
            equal(recovered.status, "completed");
            equal(recovered.result, { value: 7 });
            equal(calls, 1);
        },
    },
    {
        name: "runner resumes persisted wait across instances",
        async run(factory) {
            const backend = await factory();
            const definitions = new MemoryDefinitionRegistry();
            const definition: WorkflowDefinition = {
                key: "conformance-wait-resume",
                manifestHash: "sha256:conformance-wait-resume-v1",
                run: async (workflow) => ({
                    answer: await workflow.ask({
                        kind: "text",
                        title: "answer",
                    }),
                }),
            };
            const first = new WorkflowRunner(
                {},
                {},
                { backend, definitions },
            );
            const waiting = await first.start(definition, null);
            equal(waiting.status, "waiting");
            equal(waiting.pendingAsks.length, 1);

            const second = new WorkflowRunner(
                {},
                {},
                { backend, definitions },
            );
            const completed = await second.resume(waiting.runId, {
                [waiting.pendingAsks[0]!.key]: "persisted",
            });
            equal(completed.status, "completed");
            equal(completed.result, { answer: "persisted" });
        },
    },
];

export const valueStoreConformanceCases:
readonly ValueStoreConformanceCase[] = [
    {
        name: "content addressing deduplicates equal JSON",
        async run(factory) {
            const store = await factory();
            const first = await store.put({
                nested: { b: 2, a: 1 },
            });
            const second = await store.put({
                nested: { a: 1, b: 2 },
            });
            equal(first, second);
        },
    },
    {
        name: "get returns isolated values",
        async run(factory) {
            const store = await factory();
            const reference = await store.put({
                items: [1, 2],
            });
            const first = await store.get(reference) as {
                items: JsonValue[];
            };
            first.items.push(3);
            equal(await store.get(reference), { items: [1, 2] });
        },
    },
    {
        name: "tampered reference is rejected",
        async run(factory) {
            const store = await factory();
            const reference = await store.put({ value: "safe" });
            await rejects(() => store.get({
                ...reference,
                hash: "sha256:tampered",
            }));
        },
    },
];

function sampleRun(
    runId: string,
    createdAt = "2026-08-11T00:00:00.000Z",
): WorkflowRunState {
    return {
        runId,
        definition: {
            key: "conformance",
            version: "1",
            manifestHash: "sha256:conformance",
        },
        input: {
            kind: "inline",
            value: {
                case: runId,
            },
        },
        extensionContext: {},
        status: "running",
        cancelRequestedAt: null,
        budget: null,
        checkpoint: null,
        pendingAsks: [],
        pendingWaits: [],
        logs: [],
        progress: null,
        journal: [],
        revision: 0,
        createdAt,
        updatedAt: createdAt,
    };
}

function requireRun(run: WorkflowRunState | null): WorkflowRunState {
    if (!run) {
        throw new Error("Expected workflow run to exist.");
    }
    return run;
}

function deferredDefinition(key: string): WorkflowDefinition {
    return {
        key,
        version: "1",
        manifestHash: "sha256:" + key,
        run: async (workflow) => await workflow.callAction("source.fetch@1", {
            sourceId: key,
        }),
    };
}

function deferredRunner(
    harness: DeferredActivityConformanceHarness,
    definition: WorkflowDefinition,
    definitions = harness.definitions ?? new MemoryDefinitionRegistry(),
    inlineValueLimitBytes?: number,
): WorkflowRunner {
    return new WorkflowRunner({}, {}, {
        backend: harness.backend,
        definitions,
        deferredActivities: harness.deferredActivities,
        values: harness.values,
        ...(inlineValueLimitBytes === undefined ? {} : { inlineValueLimitBytes }),
    });
}

function requirePending(value: PendingActivity | undefined): PendingActivity {
    if (!value) {
        throw new Error("Expected Deferred Activity to be pending.");
    }
    return value;
}

function completedInput(
    pending: PendingActivity,
    result: JsonValue,
): DeferredActivityCompletionInput {
    return {
        activityKey: pending.key,
        receipt: pending.receipt,
        reference: pending.reference,
        fingerprint: pending.fingerprint,
        status: "completed",
        result,
    };
}

function requireStored(value: WorkflowRunState | null): WorkflowRunState {
    if (!value) {
        throw new Error("Expected stored workflow run.");
    }
    return value;
}

function equal(actual: unknown, expected: unknown): void {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(
            `Conformance assertion failed: ${JSON.stringify(actual)} `
            + `!== ${JSON.stringify(expected)}`,
        );
    }
}

async function rejects(operation: () => Promise<unknown>): Promise<void> {
    try {
        await operation();
    } catch {
        return;
    }
    throw new Error("Expected operation to reject.");
}
