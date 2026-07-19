import type { JsonValue } from "./types";

/**
 * 参数规范化指纹：键排序后的 JSON 字符串。
 * spike 不做哈希，保留原文便于测试断言与 journal 调试。
 */
export function fingerprint(value: JsonValue | undefined): string {
    return JSON.stringify(canonicalize(value ?? null));
}

function canonicalize(value: JsonValue): JsonValue {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value !== null && typeof value === "object") {
        const out: { [key: string]: JsonValue } = {};
        for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
        return out;
    }
    return value;
}
