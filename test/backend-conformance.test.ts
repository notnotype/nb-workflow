import { describe, expect, test } from "bun:test";

import {
    MemoryWorkflowBackend,
    MemoryValueStore,
    WorkflowBackendCapabilityError,
    assertBackendCapabilities,
    deferredActivityConformanceCases,
    valueStoreConformanceCases,
    workflowBackendConformanceCases,
    workflowRunnerBackendConformanceCases,
} from "../src/index";

describe("MemoryWorkflowBackend conformance", () => {
    for (const conformanceCase of workflowBackendConformanceCases) {
        test(conformanceCase.name, async () => {
            await conformanceCase.run(() => new MemoryWorkflowBackend());
        });
    }

    for (const conformanceCase of workflowRunnerBackendConformanceCases) {
        test(conformanceCase.name, async () => {
            await conformanceCase.run(() => new MemoryWorkflowBackend());
        });
    }

    test("truthfully declares in-process-only durability", () => {
        const backend = new MemoryWorkflowBackend();

        expect(backend.capabilities).toEqual({
            durability: "memory",
            processRestart: false,
            concurrentExecution: false,
            multiWorker: false,
            leases: false,
            durableSignals: false,
            durableTimers: false,
            childWorkflows: false,
            externalReceipts: false,
            outbox: false,
            valueReferences: true,
        });
    });

    test("rejects unmet requirements before execution", () => {
        const backend = new MemoryWorkflowBackend();

        expect(() => assertBackendCapabilities(
            backend.capabilities,
            {
                durability: "durable",
                processRestart: true,
                durableSignals: true,
            },
        )).toThrow(WorkflowBackendCapabilityError);
    });

    for (const conformanceCase of deferredActivityConformanceCases) {
        test("Deferred Activity: " + conformanceCase.name, async () => {
            const deferred = {
                startAction: async () => ({
                    status: "pending" as const,
                    receipt: "receipt-" + conformanceCase.name,
                    reason: "conformance",
                }),
            };
            await conformanceCase.run(() => ({
                backend: new MemoryWorkflowBackend(),
                deferredActivities: deferred,
                values: new MemoryValueStore(),
            }));
        });
    }
});

describe("MemoryValueStore conformance", () => {
    for (const conformanceCase of valueStoreConformanceCases) {
        test(conformanceCase.name, async () => {
            await conformanceCase.run(() => new MemoryValueStore());
        });
    }
});
