import type { ActivityRecord } from "../types";

export type TraceNode = {
    key: string;
    path: string;
    seq: number;
    kind: string;
};

export type TraceGraph = { nodes: TraceNode[]; edges: [string, string][]; mermaid: string };

/**
 * 投影三：动态 trace。journal 本身就是精确执行图：
 * 同路径 Activity 顺序连边；子路径（map 分支）从父路径的派生点接入、汇合回派生点之后的下一个 Activity。
 */
export function traceGraph(journal: ActivityRecord[]): TraceGraph {
    const byPath = new Map<string, ActivityRecord[]>();
    for (const rec of journal) {
        const list = byPath.get(rec.path) ?? [];
        list.push(rec);
        byPath.set(rec.path, list);
    }
    for (const list of byPath.values()) list.sort((a, b) => a.seq - b.seq);

    const nodes: TraceNode[] = journal.map((r) => ({ key: r.key, path: r.path, seq: r.seq, kind: r.kind }));
    const edges: [string, string][] = [];

    // 同路径顺序边
    for (const list of byPath.values()) {
        for (let i = 1; i < list.length; i++) edges.push([list[i - 1].key, list[i].key]);
    }
    // 分支边：子路径 parent/<mapSeq>:<i> 从父路径中 seq < mapSeq 的最后一个 Activity 接入
    for (const [path, list] of byPath) {
        const m = path.match(/^(.*)\/(\d+):\d+$/);
        if (!m || list.length === 0) continue;
        const parentList = byPath.get(m[1]) ?? [];
        const mapSeq = Number(m[2]);
        const anchor = [...parentList].reverse().find((r) => r.seq < mapSeq);
        if (anchor) edges.push([anchor.key, list[0].key]);
        const join = parentList.find((r) => r.seq > mapSeq);
        if (join) edges.push([list[list.length - 1].key, join.key]);
    }

    const idOf = new Map(nodes.map((n, i) => [n.key, `t${i}`]));
    const labelOf = (n: TraceNode) => {
        const label = `${n.kind} @${n.key}`;
        // ask 节点用体育场形突出人类参与点；其余方框
        return n.kind === "ask" ? `${idOf.get(n.key)}(["${label}"])` : `${idOf.get(n.key)}["${label}"]`;
    };
    // 并行分支组：同一 map/all 派生的子路径圈进 subgraph，图上明示并发结构
    const groupOf = (path: string) => path.match(/^(.*\/\d+):\d+$/)?.[1] ?? null;
    const groups = new Map<string, TraceNode[]>();
    const plain: TraceNode[] = [];
    for (const n of nodes) {
        const group = groupOf(n.path);
        if (group === null) { plain.push(n); continue; }
        const list = groups.get(group) ?? [];
        list.push(n);
        groups.set(group, list);
    }
    const lines: string[] = plain.map((n) => `    ${labelOf(n)}`);
    let groupIndex = 0;
    for (const [group, members] of groups) {
        const branchCount = new Set(members.map((m) => m.path)).size;
        lines.push(`    subgraph g${groupIndex++}["并行 ×${branchCount}（${group}）"]`);
        for (const m of members) lines.push(`        ${labelOf(m)}`);
        lines.push("    end");
    }
    const edgeLines = edges.map(([a, b]) => `    ${idOf.get(a)} --> ${idOf.get(b)}`);
    return { nodes, edges, mermaid: ["graph TD", ...lines, ...edgeLines].join("\n") };
}
