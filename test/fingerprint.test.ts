import { describe, expect, test } from "bun:test";

import {
    NonJsonValueError,
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

    test("array index accessors are rejected without being invoked", () => {
        let called = false;
        const value: unknown[] = [];
        Object.defineProperty(value, 0, {
            enumerable: true,
            get() {
                called = true;
                return "secret";
            },
        });

        expect(() => canonicalJson(value)).toThrow(NonJsonValueError);
        expect(called).toBe(false);
    });

    test("array symbol keys are rejected", () => {
        const value: unknown[] = [1];
        Object.defineProperty(value, Symbol("hidden"), {
            enumerable: true,
            value: 2,
        });

        expect(() => canonicalJson(value)).toThrow(NonJsonValueError);
    });

    test("error messages escape control characters in payload key names", () => {
        const escape = String.fromCharCode(27);
        const value = {
            [`${escape}[31mRED${escape}[0m`]: undefined,
        };

        let message = "";
        try {
            canonicalJson(value);
        } catch (error) {
            message = (error as Error).message;
        }
        expect(message).toContain("\\u001b");
        expect(message).not.toContain(escape);
    });

    test("error messages cap the length of payload key names", () => {
        const value = JSON.parse(
            `{"${"x".repeat(20_000)}": 1}`,
        );

        let message = "";
        try {
            canonicalJson(value);
        } catch (error) {
            message = (error as Error).message;
        }
        expect(message.length).toBeLessThan(400);
    });
});
