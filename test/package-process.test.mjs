import { expect, test } from "bun:test";

import { execNpm } from "../scripts/child-processes.mjs";

test("package helpers invoke npm without a shell on the host platform", () => {
    const version = execNpm(["--version"], {
        encoding: "utf8",
    }).trim();

    expect(version).toMatch(/^\d+\.\d+\.\d+(-.*)?$/);
});
