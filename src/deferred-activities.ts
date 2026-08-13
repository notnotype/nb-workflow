export class DeferredActivityNotFoundError extends Error {
    constructor(readonly activityKey: string) {
        super("Deferred Activity not found: " + activityKey);
        this.name = "DeferredActivityNotFoundError";
    }
}

export class DeferredActivityCompletionConflictError extends Error {
    constructor(readonly activityKey: string) {
        super("Deferred Activity completion conflict: " + activityKey);
        this.name = "DeferredActivityCompletionConflictError";
    }
}

export class DeferredActivityLateCompletionError extends Error {
    constructor(
        readonly runId: string,
        readonly status: string,
    ) {
        super(
            "Deferred Activity completion arrived after Run "
            + runId
            + " entered terminal state "
            + status
            + ".",
        );
        this.name = "DeferredActivityLateCompletionError";
    }
}

export class DeferredActivityFailedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DeferredActivityFailedError";
    }
}
