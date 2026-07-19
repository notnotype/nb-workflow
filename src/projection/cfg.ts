import ts from "typescript";

export type CfgNode = {
    id: number;
    /** wf API 全名（wf.map / wf.ask / xxx.invoke ...） */
    call: string;
    /** 首参摘要，便于人识别 */
    hint: string;
    /** 包裹的控制结构（if / for / while / map-fn），体现"这是近似图"的虚线语义 */
    controls: string[];
};

export type CfgGraph = { nodes: CfgNode[]; mermaid: string };

/** 判定为编排调用的成员方法名（句法尽力而为，不保证完备——这正是近似投影的定位） */
const ORCH_METHODS = new Set([
    "invoke", "create", "acquire", "profile", "open", "checkout", "append", "excursion",
    "transcript", "ask", "map", "all", "read", "caller",
]);

/**
 * 投影二：AST 近似控制流图。解析脚本源码（fn.toString()），
 * 收集 wf.* / handle 方法调用点及其包裹控制结构。静态、best-effort、允许漏报误报。
 */
export function extractCfg(source: string): CfgGraph {
    const sf = ts.createSourceFile("workflow.ts", source, ts.ScriptTarget.ES2022, true);
    const nodes: CfgNode[] = [];

    const controlOf = (node: ts.Node): string[] => {
        const out: string[] = [];
        let cursor: ts.Node | undefined = node.parent;
        while (cursor) {
            if (ts.isIfStatement(cursor)) out.push("if");
            else if (ts.isForStatement(cursor) || ts.isForOfStatement(cursor)) out.push("for");
            else if (ts.isWhileStatement(cursor)) out.push("while");
            else if (ts.isArrowFunction(cursor) || ts.isFunctionExpression(cursor)) {
                // 落在 wf.map/all 的回调里 → 标记为并发分支体
                const call = cursor.parent;
                if (ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression)) {
                    out.push(`${call.expression.name.text}-fn`);
                }
            }
            cursor = cursor.parent;
        }
        return out.reverse();
    };

    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
            const method = node.expression.name.text;
            if (ORCH_METHODS.has(method)) {
                const receiver = node.expression.expression.getText(sf);
                const first = node.arguments[0]?.getText(sf) ?? "";
                nodes.push({
                    id: nodes.length,
                    call: `${receiver}.${method}`,
                    hint: first.length > 40 ? `${first.slice(0, 37)}...` : first,
                    controls: controlOf(node),
                });
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);

    const lines = nodes.map((n) => `    c${n.id}["${n.call}${n.controls.length ? ` (${n.controls.join(">")})` : ""}"]`);
    const edges = nodes.slice(1).map((n, i) => {
        // 有控制结构包裹的用虚线：静态图无法断言必经
        const dashed = n.controls.length > 0 || nodes[i].controls.length > 0;
        return `    c${i} ${dashed ? "-.->" : "-->"} c${i + 1}`;
    });
    return { nodes, mermaid: ["graph TD", ...lines, ...edges].join("\n") };
}
