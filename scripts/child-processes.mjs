import {
    execFileSync,
} from "node:child_process";
import {
    existsSync,
} from "node:fs";
import {
    dirname,
    join,
    resolve,
} from "node:path";

/**
 * Calling npm.cmd with shell:false is not portable on Windows. Invoke the
 * npm CLI through the current Node executable instead, so package scripts do
 * not depend on cmd.exe quoting or PowerShell command resolution.
 */
export function execNpm(args, options = {}) {
    const node = resolveNodeExecutable();
    const command = process.platform === "win32" ? node : "npm";
    const commandArgs = process.platform === "win32"
        ? [resolveNpmCli(node), ...args]
        : args;
    return execFileSync(command, commandArgs, {
        ...options,
        shell: false,
    });
}

function resolveNodeExecutable() {
    const configured = process.env.npm_node_execpath;
    if (configured) {
        const configuredPath = resolve(configured);
        if (existsSync(configuredPath)) {
            return configuredPath;
        }
    }

    const executableName = process.execPath.toLowerCase();
    if (executableName.endsWith("node.exe") || executableName.endsWith("/node")) {
        return process.execPath;
    }

    if (process.platform === "win32") {
        for (const directory of (process.env.PATH ?? "").split(";")) {
            if (!directory) {
                continue;
            }
            const candidate = join(directory, "node.exe");
            if (existsSync(candidate)) {
                return candidate;
            }
        }
    }

    return "node";
}

function resolveNpmCli(nodeExecutable) {
    const configured = process.env.npm_execpath;
    if (configured) {
        const configuredPath = resolve(configured);
        if (configuredPath.endsWith(".js") && existsSync(configuredPath)) {
            return configuredPath;
        }
    }

    const sibling = join(
        dirname(nodeExecutable),
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
    );
    if (existsSync(sibling)) {
        return sibling;
    }

    throw new Error(
        "Cannot locate npm CLI next to the current Node executable.",
    );
}
