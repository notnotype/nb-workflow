import { describe, expect, test } from "bun:test";

import {
    MemoryActivityExecutor,
    WorkflowRunner,
} from "../src/index";
import type {
    AgentWorkflowDefinition,
    WorkflowContext,
    WorkflowDefinition,
} from "../src/index";

describe("public package API", () => {
    test("Core Workflow runs without Agent or Session ports", async () => {
        const activities = new MemoryActivityExecutor();
        activities.registerAction("public.echo@1", (input) => input);
        const definition: WorkflowDefinition = {
            key: "public-core",
            manifestHash: "sha256:public-core-v1",
            run: async (workflow: WorkflowContext) => (
                await workflow.callAction(
                    "public.echo@1",
                    { ok: true },
                )
            ),
        };
        const runner = new WorkflowRunner(
            {},
            {},
            { activities },
        );

        await expect(runner.start(definition, null)).resolves.toMatchObject({
            status: "completed",
            result: { ok: true },
        });
    });

    test("Agent Workflow is an explicit extension type", () => {
        const definition: AgentWorkflowDefinition = {
            key: "public-agent-extension",
            manifestHash: "sha256:public-agent-extension-v1",
            run: async (workflow) => ({
                hasAgentApi: typeof workflow.agents.create === "function",
            }),
        };

        expect(definition.key).toBe("public-agent-extension");
    });
});
