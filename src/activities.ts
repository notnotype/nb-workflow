import type {
    ActivityExecutionContext,
    ActivityExecutionRequest,
    ActivityExecutor,
} from "./ports";
import type {
    ActivityCallOptions,
    JsonValue,
} from "./types";
import { fingerprint } from "./fingerprint";

export class ActivityExecutorNotConfiguredError extends Error {
    constructor(readonly operation: "action" | "query") {
        super(`No ActivityExecutor is configured for ${operation}.`);
        this.name = "ActivityExecutorNotConfiguredError";
    }
}

export class ActivityDefinitionNotFoundError extends Error {
    constructor(
        readonly operation: "action" | "query",
        readonly reference: string,
    ) {
        super(`Unknown ${operation} definition: ${reference}`);
        this.name = "ActivityDefinitionNotFoundError";
    }
}

export class ActivityExecutionConflictError extends Error {
    constructor(readonly idempotencyKey: string) {
        super(`Activity execution conflict: ${idempotencyKey}`);
        this.name = "ActivityExecutionConflictError";
    }
}

export class UnsupportedActivityExecutor implements ActivityExecutor {
    async callAction(): Promise<JsonValue> {
        throw new ActivityExecutorNotConfiguredError("action");
    }

    async query(): Promise<JsonValue> {
        throw new ActivityExecutorNotConfiguredError("query");
    }
}

export type MemoryActivityHandler = (
    input: JsonValue,
    context: ActivityExecutionContext,
    options: ActivityCallOptions,
) => Promise<JsonValue> | JsonValue;

/** 测试/demo Executor；不提供进程重启、重试、lease 或外部副作用保证。 */
export class MemoryActivityExecutor implements ActivityExecutor {
    private readonly actions = new Map<string, MemoryActivityHandler>();
    private readonly queries = new Map<string, MemoryActivityHandler>();
    private readonly outcomes = new Map<
        string,
        { requestFingerprint: string; value: JsonValue }
    >();

    registerAction(
        reference: string,
        handler: MemoryActivityHandler,
    ): void {
        assertVersionedReference(reference);
        register(this.actions, "action", reference, handler);
    }

    registerQuery(
        reference: string,
        handler: MemoryActivityHandler,
    ): void {
        assertVersionedReference(reference);
        register(this.queries, "query", reference, handler);
    }

    async callAction(request: ActivityExecutionRequest): Promise<JsonValue> {
        return await this.execute(this.actions, "action", request);
    }

    async query(request: ActivityExecutionRequest): Promise<JsonValue> {
        return await this.execute(this.queries, "query", request);
    }

    private async execute(
        registry: ReadonlyMap<string, MemoryActivityHandler>,
        operation: "action" | "query",
        request: ActivityExecutionRequest,
    ): Promise<JsonValue> {
        const cacheKey =
            `${operation}:${request.context.idempotencyKey}`;
        const requestFingerprint = fingerprint({
            reference: request.reference,
            input: request.input,
            options: {
                key: request.options.key ?? null,
                timeoutMs: request.options.timeoutMs ?? null,
                metadata: request.options.metadata ?? null,
            },
        });
        const cached = this.outcomes.get(cacheKey);
        if (cached) {
            if (cached.requestFingerprint !== requestFingerprint) {
                throw new ActivityExecutionConflictError(cacheKey);
            }
            return structuredClone(cached.value);
        }
        const value = await execute(registry, operation, request);
        this.outcomes.set(cacheKey, {
            requestFingerprint,
            value: structuredClone(value),
        });
        return structuredClone(value);
    }
}

export function assertVersionedReference(reference: string): void {
    const separator = reference.lastIndexOf("@");
    if (
        separator <= 0
        || separator === reference.length - 1
        || reference.trim() !== reference
    ) {
        throw new Error(
            `Activity reference must include an explicit version: ${reference}`,
        );
    }
}

function register(
    registry: Map<string, MemoryActivityHandler>,
    operation: "action" | "query",
    reference: string,
    handler: MemoryActivityHandler,
): void {
    if (registry.has(reference)) {
        throw new Error(`Duplicate ${operation} definition: ${reference}`);
    }
    registry.set(reference, handler);
}

async function execute(
    registry: ReadonlyMap<string, MemoryActivityHandler>,
    operation: "action" | "query",
    request: ActivityExecutionRequest,
): Promise<JsonValue> {
    const handler = registry.get(request.reference);
    if (!handler) {
        throw new ActivityDefinitionNotFoundError(
            operation,
            request.reference,
        );
    }
    return await handler(
        structuredClone(request.input),
        request.context,
        structuredClone(request.options),
    );
}
