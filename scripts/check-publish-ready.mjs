import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { execNpm } from "./child-processes.mjs";

/**
 * npm publish 先执行 bun run build；本 gate 再检查发布元数据、产物和 tarball 内容，
 * 防止把旧文档、旧版本号或不完整 dist 打进 npm tarball。
 */
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const metadata = ["README.md", "package.json", "LICENSE"];
for (const args of [
    ["diff", "--quiet", "--", ...metadata],
    ["diff", "--cached", "--quiet", "--", ...metadata],
]) {
    execFileSync("git", args, {
        cwd: repoRoot,
        stdio: "pipe",
    });
}
for (const file of ["dist/index.js", "dist/index.d.ts"]) {
    if (!existsSync(`${repoRoot}/${file}`)) {
        throw new Error(`Publish artifact is missing: ${file}`);
    }
}
const dryRun = execNpm(
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    },
);
const packReport = JSON.parse(dryRun);
const packedFiles = new Set(
    packReport[0]?.files?.map(({ path }) => path) ?? [],
);
for (const file of ["dist/index.js", "dist/index.d.ts", "README.md", "LICENSE"]) {
    if (!packedFiles.has(file)) {
        throw new Error(`Publish tarball is missing: ${file}`);
    }
}
console.log("PUBLISH_READY_OK");
