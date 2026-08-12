import type {
    ActivityExecutor,
    ChildWorkflowStore,
    Clock,
    EventSink,
    RandomSource,
    SignalStore,
    TimerStore,
    WorkflowPorts,
} from "./ports";
import { assertJsonValue } from "./fingerprint";
import { runRecordToView, type RunRecord } from "./run-record";
import { WorkflowPersistenceError } from "./runner-run-store";
import {
    archiveEphemeralSessions,
    markCancelled,
    resetExecutionProjection,
    unbindExternalAbort,
} from "./runner-support";
import {
    ExecutionState,
    Runtime,
    SuspendSignal,
    WorkflowCancelledError,
    runAtWorkflowRoot,
} from "./runtime";
import {
    emitWorkflowEvent,
    type RunEnv,
} from "./runtime-events";
import type { RunView } from "./types";
import type { WorkflowValueCodec } from "./values";
import { createWorkflowContext } from "./workflow-context";

export type WorkflowRunExecutionOptions = {
    run: RunRecord;
    ports: WorkflowPorts;
    env: RunEnv;
    activities: ActivityExecutor;
    children: ChildWorkflowStore;
    events: EventSink;
    signals: SignalStore;
    timers: TimerStore;
    values: WorkflowValueCodec;
    clock: Clock;
    random: RandomSource;
    defaultConcurrency: number;
    maxConcurrency: number;
    persist(): Promise<void>;
};

export async function executeWorkflowRun(
    options: WorkflowRunExecutionOptions,
): Promise<RunView> {
    const { run } = options;
    resetExecutionProjection(run);
    try {
        await options.persist();
    } catch (error) {
        await options.ports.sessions?.releaseAll(run.runId);
        throw error;
    }
    emitWorkflowEvent(options.env, {
        type: "status",
        runId: run.runId,
        status: "running",
    });
    const execution = new ExecutionState();
    const runtime = new Runtime(
        run,
        execution,
        options.ports,
        options.activities,
        options.children,
        options.events,
        options.signals,
        options.timers,
        options.values,
        options.clock,
        options.random,
        options.defaultConcurrency,
        options.maxConcurrency,
        options.env,
        options.persist,
    );
    let persistenceFailure: WorkflowPersistenceError | undefined;
    try {
        const executionArgs = structuredClone(run.args);
        const result = await runAtWorkflowRoot(
            () => run.def.run(
                createWorkflowContext(runtime, executionArgs),
                executionArgs,
            ),
        );
        await completeRun(options, execution, result);
    } catch (error) {
        if (isPersistenceFailure(error)) {
            persistenceFailure = error;
        } else {
            reduceExecutionError(run, error);
        }
    } finally {
        await options.ports.sessions?.releaseAll(run.runId);
        if (!persistenceFailure) {
            await options.persist();
            emitWorkflowEvent(options.env, {
                type: "status",
                runId: run.runId,
                status: run.status,
            });
            if (run.status !== "waiting") {
                unbindExternalAbort(run);
            }
        }
    }
    if (persistenceFailure) {
        throw persistenceFailure;
    }
    return runRecordToView(run);
}

async function completeRun(
    options: WorkflowRunExecutionOptions,
    execution: ExecutionState,
    result: unknown,
): Promise<void> {
    const { run } = options;
    assertJsonValue(result);
    if (run.abortRequested) {
        markCancelled(run);
        return;
    }
    const storedResult = await options.values.encode(result);
    if (run.abortRequested) {
        markCancelled(run);
        return;
    }
    await archiveEphemeralSessions(execution, options.ports);
    if (run.abortRequested) {
        markCancelled(run);
        return;
    }
    run.status = "completed";
    run.result = result;
    run.storedResult = storedResult;
}

function reduceExecutionError(run: RunRecord, error: unknown): void {
    if (error instanceof SuspendSignal) {
        if (run.abortRequested) {
            markCancelled(run);
        } else {
            run.status = "waiting";
        }
        return;
    }
    if (
        error instanceof WorkflowCancelledError
        || run.abortRequested
    ) {
        markCancelled(run);
        return;
    }
    run.status = "failed";
    run.error = error instanceof Error
        ? error.message
        : String(error);
    run.pendingAsks = [];
    run.pendingWaits = [];
}

function isPersistenceFailure(
    error: unknown,
): error is WorkflowPersistenceError {
    return error instanceof WorkflowPersistenceError;
}
