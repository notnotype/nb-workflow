import { AgentRegistry, SessionStore, WorkflowRunner, type RunEnv, type SessionId } from "../src/index";

/** 组装一套隔离的 spike 环境 */
export function makeEnv(env: RunEnv = {}) {
    const store = new SessionStore();
    const agents = new AgentRegistry();
    const runner = new WorkflowRunner(store, agents, env);
    return { store, agents, runner };
}

/** 模拟用户在 run 之外与某 session 直接对话（普通聊天入口） */
export async function directChat(store: SessionStore, agents: AgentRegistry, sessionId: SessionId, message: string) {
    store.lock(sessionId, "direct");
    try {
        const user = store.append(sessionId, store.activeLeaf(sessionId), {
            type: "message", role: "user", message, origin: "direct",
        });
        const resp = await agents.respond(store, sessionId, user.id, { mode: "prompt", message });
        const asst = store.append(sessionId, user.id, {
            type: "message", role: "assistant", message: resp.message, data: resp.data, origin: "direct",
        });
        store.setActiveLeaf(sessionId, asst.id);
        return resp;
    } finally {
        store.releaseAll("direct");
    }
}
