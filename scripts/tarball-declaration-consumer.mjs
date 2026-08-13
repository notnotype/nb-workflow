import {
    execFileSync,
} from "node:child_process";
import {
    mkdtempSync,
    mkdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import {
    tmpdir,
} from "node:os";
import {
    join,
} from "node:path";
import {
    fileURLToPath,
} from "node:url";
import { execNpm } from "./child-processes.mjs";

/**
 * 在真实 npm tarball 上运行 strict NodeNext declaration consumer。
 * 这条检查不能使用仓库 dist 的相对 import，否则 package exports、
 * tarball files 和声明中的 Deferred Activity API 都没有被验证。
 */
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const tempRoot = mkdtempSync(join(tmpdir(), "nbwf-declaration-"));
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
        JSON.stringify({
            private: true,
            type: "module",
        }) + "\n",
    );
    const source = join(consumerRoot, "consumer.mts");
    writeFileSync(source, `
import {
    DeferredActivityCompletionConflictError,
    DeferredActivityLateCompletionError,
    WorkflowRunner,
    type DeferredActivityCompletionInput,
    type DeferredActivityExecutor,
    type PendingActivity,
    type RunView,
    type WorkflowDefinition,
} from "@notnotype/nb-workflow";

const deferred: DeferredActivityExecutor = {
    startAction: async () => ({
        status: "pending",
        receipt: "declaration-receipt",
        reason: "waiting",
    }),
};
const definition: WorkflowDefinition = {
    key: "declaration-consumer",
    version: "1",
    manifestHash: "sha256:declaration-consumer-v1",
    run: async (workflow) => await workflow.callAction(
        "source.fetch@1",
        { sourceId: "source-1" },
    ),
};
const runner = new WorkflowRunner({}, {}, { deferredActivities: deferred });
const waiting: RunView = await runner.start(definition, null);
const pending: PendingActivity = waiting.pendingActivities[0]!;
const completion: DeferredActivityCompletionInput = {
    activityKey: pending.key,
    receipt: pending.receipt,
    reference: pending.reference,
    fingerprint: pending.fingerprint,
    status: "completed",
    result: { entries: 1 },
};
const completed = await runner.completeActivity(waiting.runId, completion);
if (completed.status !== "completed") {
    throw new Error("declaration consumer did not resume");
}
void DeferredActivityCompletionConflictError;
void DeferredActivityLateCompletionError;
`);

    execNpm(
        [
            "install",
            "--ignore-scripts",
            "--no-save",
            "--no-package-lock",
            "--no-audit",
            "--no-fund",
            "--omit=peer",
            "--prefix",
            consumerRoot,
            tarball,
        ],
        { cwd: consumerRoot, stdio: "pipe" },
    );
    const typecheck = join(
        repoRoot,
        "node_modules",
        "typescript",
        "bin",
        "tsc",
    );
    execFileSync(
        process.execPath,
        [
            typecheck,
            "--noEmit",
            "--strict",
            "--skipLibCheck",
            "false",
            "--target",
            "ES2022",
            "--module",
            "NodeNext",
            "--moduleResolution",
            "NodeNext",
            source,
        ],
        {
            cwd: consumerRoot,
            stdio: "pipe",
        },
    );
    console.log("TARBALL_DECLARATION_CONSUMER_OK");
} finally {
    rmSync(tempRoot, { recursive: true, force: true });
}
