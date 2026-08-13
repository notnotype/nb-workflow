import type {
    ActivityExecutor,
    DeferredActivityExecutor,
    ChildWorkflowStore,
    Clock,
    DefinitionRegistry,
    EventSink,
    IdGenerator,
    RandomSource,
    SignalStore,
    TimerStore,
    ValueStore,
    WorkspacePort,
} from "./ports";
import type { RunRecord } from "./run-record";
import type { ExecutionState } from "./runtime";
import type {
    JsonValue,
    SessionId,
} from "./types";
import type { WorkflowBackend } from "./backend";
import { fingerprint } from "./fingerprint";

export type WorkflowRunnerOptions = {
    backend?: WorkflowBackend;
    definitions?: DefinitionRegistry;
    activities?: ActivityExecutor;
    deferredActivities?: DeferredActivityExecutor;
    children?: ChildWorkflowStore;
    events?: EventSink;
    signals?: SignalStore;
    timers?: TimerStore;
    values?: ValueStore;
    inlineValueLimitBytes?: number;
    clock?: Clock;
    ids?: IdGenerator;
    random?: RandomSource;
    defaultConcurrency?: number;
    maxConcurrency?: number;
};

export type WorkflowStartOptions = {
    callerSessionId?: SessionId;
    defaultModel?: string;
    workspace?: WorkspacePort;
    signal?: AbortSignal;
    budget?: JsonValue;
};

export type WorkflowSignalOptions = {
    idempotencyKey?: string;
};

export function resetExecutionProjection(run: RunRecord): void {
    run.status = "running";
    run.pendingAsks = [];
    run.pendingWaits = [];
    run.logs = [];
    run.progress = null;
    run.result = undefined;
    run.storedResult = undefined;
    run.error = undefined;
}

export function markCancelled(
    run: RunRecord,
    completedAt = new Date().toISOString(),
): void {
    cancelPendingActivities(run, completedAt);
    run.status = "cancelled";
    run.resumeRequired = false;
    run.error = "workflow run 被取消";
    run.pendingAsks = [];
    run.pendingWaits = [];
}

export function cancelPendingActivities(
    run: RunRecord,
    completedAt: string,
): void {
    for (const pending of run.pendingActivities) {
        run.activityCompletions.push({
            ...pending,
            status: "cancelled",
            completionFingerprint: fingerprint({
                activityKey: pending.key,
                receipt: pending.receipt,
                reference: pending.reference,
                fingerprint: pending.fingerprint,
                status: "cancelled",
                hasResult: false,
                result: null,
                hasError: false,
                error: null,
            }),
            error: "workflow run 被取消",
            completedAt,
        });
    }
    run.pendingActivities = [];
}

export function isTerminal(run: RunRecord): boolean {
    return (
        run.status === "completed"
        || run.status === "failed"
        || run.status === "cancelled"
    );
}

export function validateConcurrencyPolicy(
    defaultConcurrency: number,
    maxConcurrency: number,
): void {
    if (
        !Number.isSafeInteger(maxConcurrency)
        || maxConcurrency <= 0
        || !Number.isSafeInteger(defaultConcurrency)
        || defaultConcurrency <= 0
        || defaultConcurrency > maxConcurrency
    ) {
        throw new Error(
            "Workflow concurrency policy requires 1 <= "
            + "defaultConcurrency <= maxConcurrency.",
        );
    }
}

export function bindExternalAbort(
    run: RunRecord,
    signal: AbortSignal | undefined,
    clock: Clock,
    cancel: () => Promise<unknown>,
    onError: (error: unknown) => void,
): void {
    if (!signal) {
        return;
    }
    const onAbort = () => {
        void cancel().catch((error: unknown) => {
            try {
                onError(error);
            } catch {
                // Background AbortSignal callbacks cannot propagate errors.
            }
        });
    };
    if (signal.aborted) {
        run.abortRequested = true;
        run.cancelRequestedAt = clock.now().toISOString();
        run.abortController.abort(signal.reason);
        return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    run.removeExternalAbort = () =>
        signal.removeEventListener("abort", onAbort);
}

export function unbindExternalAbort(run: RunRecord): void {
    run.removeExternalAbort?.();
    run.removeExternalAbort = undefined;
}

export async function archiveEphemeralSessions(
    run: RunRecord,
    ports: {
        sessions?: {
            archive(sessionId: SessionId): Promise<void>;
        };
    },
): Promise<void> {
    if (run.ephemeralSessions.size === 0) {
        return;
    }
    if (!ports.sessions) {
        throw new Error(
            "Agent Session extension disappeared during execution.",
        );
    }
    for (const sessionId of run.ephemeralSessions) {
        await ports.sessions.archive(sessionId);
    }
    run.ephemeralSessions.clear();
}
