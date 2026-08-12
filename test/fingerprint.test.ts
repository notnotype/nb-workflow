import { describe, expect, test } from "bun:test";

import {
    canonicalJson,
    fingerprint,
} from "../src/index";

describe("Workflow JSON identity", () => {
    test("an own __proto__ property remains part of canonical identity", () => {
        const value = JSON.parse(
            "{\"__proto__\":{\"polluted\":true}}",
        );

        expect(canonicalJson(value)).toBe(
            "{\"__proto__\":{\"polluted\":true}}",
        );
        expect(fingerprint(value)).not.toBe(fingerprint({}));
        expect(Object.prototype).not.toHaveProperty("polluted");
    });
});
