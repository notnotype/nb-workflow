import type { InvokeOptions, JsonValue, SessionEntry, SessionId } from "./types";
import type { SessionStore } from "./session-store";

/**
 * mock 模型应答：拿到路径 transcript 与本轮输入，返回 message/data。
 * waiting: true 模拟子代理反问（invoke 返回 status:"waiting"，是普通返回值不是失败）。
 */
export type MockResponder = (turn: {
    sessionId: SessionId;
    history: SessionEntry[];
    mode: InvokeOptions["mode"];
    message?: string;
    input?: JsonValue;
}) => Promise<{ message: string; data?: JsonValue; waiting?: boolean }> | { message: string; data?: JsonValue; waiting?: boolean };

/**
 * mock profile 注册表：spike 用确定性 responder 顶替真实模型调用。
 * 对应 NeuroBook 的 profile catalog + harness invokeCore。
 */
export class AgentRegistry {
    private responders = new Map<string, MockResponder>();
    private infos = new Map<string, JsonValue>();

    register(profileKey: string, responder: MockResponder, info?: JsonValue): void {
        this.responders.set(profileKey, responder);
        if (info !== undefined) this.infos.set(profileKey, info);
    }

    profileInfo(profileKey: string): JsonValue {
        if (!this.responders.has(profileKey)) throw new Error(`profile ${profileKey} 未注册`);
        return this.infos.get(profileKey) ?? { profileKey };
    }

    async respond(store: SessionStore, sessionId: SessionId, fromLeaf: number | null, opts: InvokeOptions) {
        const profileKey = store.meta(sessionId).profileKey;
        const responder = this.responders.get(profileKey);
        if (!responder) throw new Error(`profile ${profileKey} 未注册 responder`);
        return await responder({
            sessionId,
            history: store.transcript(sessionId, fromLeaf),
            mode: opts.mode ?? "prompt",
            message: opts.message,
            input: opts.input,
        });
    }
}
