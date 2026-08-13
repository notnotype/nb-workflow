import {
    execFileSync,
    spawnSync,
} from "node:child_process";
import {
    mkdtempSync,
    mkdirSync,
    existsSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execNpm } from "./child-processes.mjs";

/**
 * 在仓库外、无 typescript 依赖的干净目录验证发布产物：
 * - 主入口 import 必须成功（typescript 是 optional，不能成为加载依赖）；
 * - extractCfg 缺失 typescript 时必须给出清晰错误而不是 MODULE_NOT_FOUND。
 */
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const tempRoot = mkdtempSync(join(tmpdir(), "nbwf-isolated-"));
const consumerRoot = join(tempRoot, "consumer");
try {
    const pack = execNpm(
        ["pack", "--silent", "--pack-destination", tempRoot],
        {
            cwd: repoRoot,
            encoding: "utf8",
        },
    ).trim();
    const tarball = join(tempRoot, pack);
    mkdirSync(consumerRoot, { recursive: true });
    writeFileSync(
        join(consumerRoot, "package.json"),
        JSON.stringify({ private: true, type: "module" }) + "\n",
    );
    execNpm(
        [
            "install",
            "--ignore-scripts",
            "--no-save",
            "--no-package-lock",
            "--omit=peer",
            tarball,
        ],
        {
            cwd: consumerRoot,
            stdio: "pipe",
        },
    );
    if (existsSync(join(consumerRoot, "node_modules", "typescript"))) {
        throw new Error("isolated consumer unexpectedly installed typescript");
    }
    const smoke = join(consumerRoot, "smoke.mjs");
    writeFileSync(smoke, `
import {
    DeferredActivityCompletionConflictError,
    DeferredActivityLateCompletionError,
    WorkflowRunner,
    extractCfg,
} from "@notnotype/nb-workflow";

const runner = new WorkflowRunner();
const result = await runner.start({
    key: "isolated-smoke",
    manifestHash: "sha256:isolated-smoke-v1",
    run: async (workflow) => ({
        now: await workflow.now(),
    }),
}, null);
if (
    result.status !== "completed"
    || typeof result.result?.now !== "string"
) {
    throw new Error("isolated package run failed");
}

const deferred = {
    startAction: async () => ({
        status: "pending",
        receipt: "tarball-receipt-1",
        reason: "waiting for isolated smoke completion",
    }),
};
const deferredRunner = new WorkflowRunner(
    {},
    {},
    { deferredActivities: deferred },
);
const waiting = await deferredRunner.start({
    key: "isolated-deferred-smoke",
    version: "1",
    manifestHash: "sha256:isolated-deferred-smoke-v1",
    run: async (workflow) => await workflow.callAction(
        "source.fetch@1",
        { sourceId: "isolated-source" },
    ),
}, null);
if (waiting.status !== "waiting" || waiting.pendingActivities.length !== 1) {
    throw new Error("isolated Deferred Activity did not enter waiting");
}
const pending = waiting.pendingActivities[0];
const completion = {
    activityKey: pending.key,
    receipt: pending.receipt,
    reference: pending.reference,
    fingerprint: pending.fingerprint,
    status: "completed",
    result: { entries: 2 },
};
const completed = await deferredRunner.completeActivity(
    waiting.runId,
    completion,
);
if (completed.status !== "completed" || completed.result?.entries !== 2) {
    throw new Error("isolated Deferred Activity did not resume");
}
const duplicate = await deferredRunner.completeActivity(
    waiting.runId,
    completion,
);
if (duplicate.status !== "completed" || duplicate.result?.entries !== 2) {
    throw new Error("isolated duplicate completion was not idempotent");
}
try {
    await deferredRunner.completeActivity(waiting.runId, {
        ...completion,
        result: { entries: 3 },
    });
    throw new Error("isolated conflicting completion was accepted");
} catch (error) {
    if (!(error instanceof DeferredActivityCompletionConflictError)) {
        throw error;
    }
}

const lateRunner = new WorkflowRunner(
    {},
    {},
    { deferredActivities: deferred },
);
const lateWaiting = await lateRunner.start({
    key: "isolated-deferred-late-smoke",
    version: "1",
    manifestHash: "sha256:isolated-deferred-late-smoke-v1",
    run: async (workflow) => await workflow.callAction(
        "source.fetch@1",
        { sourceId: "isolated-source" },
    ),
}, null);
const latePending = lateWaiting.pendingActivities[0];
await lateRunner.cancel(lateWaiting.runId);
try {
    await lateRunner.completeActivity(lateWaiting.runId, {
        activityKey: latePending.key,
        receipt: latePending.receipt,
        reference: latePending.reference,
        fingerprint: latePending.fingerprint,
        status: "completed",
        result: { late: true },
    });
    throw new Error("isolated late completion was accepted");
} catch (error) {
    if (!(error instanceof DeferredActivityLateCompletionError)) {
        throw error;
    }
}

let message = "";
try {
    extractCfg("const x = 1;");
} catch (error) {
    message = error.message;
}
if (!message.includes("optional 'typescript'")) {
    throw new Error(
        "extractCfg without typescript must fail with a clear "
        + "message, got: " + message,
    );
}
console.log("ISOLATED_PACKAGE_SMOKE_OK");
`);

    const hostileNodePath = join(tempRoot, "empty-node-path");
    mkdirSync(hostileNodePath, { recursive: true });
    const env = {
        ...process.env,
        NODE_PATH: hostileNodePath,
    };
    const run = spawnSync(
        process.execPath,
        ["smoke.mjs"],
        {
            cwd: consumerRoot,
            env,
            encoding: "utf8",
            timeout: 60_000,
        },
    );
    if (run.status !== 0) {
        throw new Error(
            "Isolated package smoke failed:\n"
            + `${run.stdout}\n${run.stderr}`,
        );
    }
    if (!run.stdout.includes("ISOLATED_PACKAGE_SMOKE_OK")) {
        throw new Error(
            "Isolated package smoke did not report success:\n"
            + run.stdout,
        );
    }
    console.log(run.stdout.trim());
} finally {
    rmSync(tempRoot, { recursive: true, force: true });
}
