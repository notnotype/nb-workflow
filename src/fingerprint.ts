import { createHash } from "node:crypto";

import type { JsonValue } from "./types";

export class NonJsonValueError extends Error {
    constructor(readonly path: string, readonly reason: string) {
        super(`Workflow value at ${path} is not valid JSON: ${reason}.`);
        this.name = "NonJsonValueError";
    }
}

/** 验证并返回键排序后的 JSON；错误不回显原始值，避免泄露 payload。 */
export function canonicalJson(value: unknown): string {
    const canonical = canonicalize(value, "$", new WeakSet(), 0);
    return JSON.stringify(canonical);
}

/** Activity fingerprint 只保存 SHA-256，不把输入正文复制进 journal。 */
export function fingerprint(value: unknown): string {
    const canonical = canonicalJson(value);
    return `sha256:${
        createHash("sha256").update(canonical).digest("hex")
    }`;
}

export function assertJsonValue(value: unknown): asserts value is JsonValue {
    canonicalJson(value);
}

function canonicalize(
    value: unknown,
    path: string,
    ancestors: WeakSet<object>,
    depth: number,
): JsonValue {
    if (depth > 100) {
        throw new NonJsonValueError(path, "maximum depth exceeded");
    }
    if (
        value === null
        || typeof value === "string"
        || typeof value === "boolean"
    ) {
        return value;
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new NonJsonValueError(path, "number must be finite");
        }
        return value;
    }
    if (typeof value !== "object") {
        throw new NonJsonValueError(path, `unsupported ${typeof value}`);
    }
    if (ancestors.has(value)) {
        throw new NonJsonValueError(path, "cyclic reference");
    }
    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            const output: JsonValue[] = [];
            for (let index = 0; index < value.length; index += 1) {
                if (!Object.hasOwn(value, index)) {
                    throw new NonJsonValueError(
                        `${path}[${index}]`,
                        "sparse array entry",
                    );
                }
                output.push(canonicalize(
                    value[index],
                    `${path}[${index}]`,
                    ancestors,
                    depth + 1,
                ));
            }
            return output;
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new NonJsonValueError(
                path,
                "object must have a plain prototype",
            );
        }
        const symbols = Object.getOwnPropertySymbols(value);
        if (symbols.length > 0) {
            throw new NonJsonValueError(path, "symbol keys are unsupported");
        }
        const output: Record<string, JsonValue> = Object.create(null);
        for (const key of Object.getOwnPropertyNames(value).sort()) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (
                !descriptor
                || !descriptor.enumerable
                || !("value" in descriptor)
            ) {
                throw new NonJsonValueError(
                    `${path}.${key}`,
                    "properties must be enumerable data properties",
                );
            }
            output[key] = canonicalize(
                descriptor.value,
                `${path}.${key}`,
                ancestors,
                depth + 1,
            );
        }
        return output;
    } finally {
        ancestors.delete(value);
    }
}
