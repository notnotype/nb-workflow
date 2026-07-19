import type { EntryId, SessionEntry, SessionId, SessionMeta } from "./types";

/** session 被其他持有者占用（workflow run 或用户直接对话） */
export class SessionBusyError extends Error {
    constructor(sessionId: SessionId, holder: string) {
        super(`session ${sessionId} 正被 ${holder} 占用`);
        this.name = "SessionBusyError";
    }
}

type SessionRecord = {
    meta: SessionMeta;
    entries: Map<EntryId, SessionEntry>;
    activeLeaf: EntryId | null;
};

/**
 * 内存版 append-only session 树存储。
 * 对应 NeuroBook 的 JsonlSessionRepository（forkSession/moveLeaf 已有），spike 只建模验证 API 所需子集。
 */
export class SessionStore {
    private sessions = new Map<SessionId, SessionRecord>();
    private nextSessionId = 1;
    private nextEntryId = 1;
    /** 排它锁：sessionId -> 持有者标识（runId 或 "direct"） */
    private locks = new Map<SessionId, string>();

    createSession(meta: Omit<SessionMeta, "sessionId" | "archived">): SessionMeta {
        const full: SessionMeta = { ...meta, sessionId: this.nextSessionId++, archived: false };
        this.sessions.set(full.sessionId, { meta: full, entries: new Map(), activeLeaf: null });
        return full;
    }

    meta(sessionId: SessionId): SessionMeta {
        return this.record(sessionId).meta;
    }

    /** 持久参与者寻址：按 (profileKey, tag) 找未归档 session */
    findByTag(profileKey: string, tag: string): SessionMeta | null {
        for (const rec of this.sessions.values()) {
            if (!rec.meta.archived && rec.meta.profileKey === profileKey && rec.meta.tags.includes(tag)) return rec.meta;
        }
        return null;
    }

    /** 唯一的生长原语：在 parent 后追加；parent 非端点时自然开叉 */
    append(sessionId: SessionId, parentId: EntryId | null, entry: Omit<SessionEntry, "id" | "parentId">): SessionEntry {
        const rec = this.record(sessionId);
        if (parentId !== null && !rec.entries.has(parentId)) throw new Error(`entry ${parentId} 不存在`);
        const full: SessionEntry = { ...entry, id: this.nextEntryId++, parentId };
        rec.entries.set(full.id, full);
        return full;
    }

    activeLeaf(sessionId: SessionId): EntryId | null {
        return this.record(sessionId).activeLeaf;
    }

    /** 唯一的游标原语（= moveLeaf）：rewind / 切分支 / 恢复现场都是它 */
    setActiveLeaf(sessionId: SessionId, entryId: EntryId | null): void {
        const rec = this.record(sessionId);
        if (entryId !== null && !rec.entries.has(entryId)) throw new Error(`entry ${entryId} 不存在`);
        rec.activeLeaf = entryId;
    }

    /** 从某 leaf 向根回溯的线性视图（时间正序） */
    transcript(sessionId: SessionId, fromLeaf: EntryId | null): SessionEntry[] {
        const rec = this.record(sessionId);
        const out: SessionEntry[] = [];
        let cursor = fromLeaf;
        while (cursor !== null) {
            const entry = rec.entries.get(cursor);
            if (!entry) break;
            out.push(entry);
            cursor = entry.parentId;
        }
        return out.reverse();
    }

    /** 全树 entry（投影 / 测试断言旁支存在性用） */
    allEntries(sessionId: SessionId): SessionEntry[] {
        return [...this.record(sessionId).entries.values()];
    }

    archive(sessionId: SessionId): void {
        this.record(sessionId).meta.archived = true;
    }

    /** 尝试加锁；已被其他持有者占用则抛 SessionBusyError；同持有者重入幂等 */
    lock(sessionId: SessionId, holder: string): void {
        const current = this.locks.get(sessionId);
        if (current !== undefined && current !== holder) throw new SessionBusyError(sessionId, current);
        this.locks.set(sessionId, holder);
    }

    releaseAll(holder: string): void {
        for (const [sessionId, current] of this.locks) {
            if (current === holder) this.locks.delete(sessionId);
        }
    }

    private record(sessionId: SessionId): SessionRecord {
        const rec = this.sessions.get(sessionId);
        if (!rec) throw new Error(`session ${sessionId} 不存在`);
        return rec;
    }
}
