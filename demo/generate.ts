/**
 * nb-workflow 三种投影演示页生成器。
 *
 * 跑一遍「拆书」workflow（挂起 → resume），把三种投影 + journal + 运行状态
 * 渲染成一个自包含 HTML（mermaid 走 CDN）。
 *
 * 运行：bun demo/generate.ts → 打开 demo/index.html
 */
import { AgentRegistry, SessionStore, WorkflowRunner, extractCfg, skeletonMermaid, traceGraph } from "../src/index";
import type { JsonValue, RunView, Wf, WorkflowDefinition } from "../src/index";

// ---------- 场景搭建（与 scenario-split-book 同构） ----------

const book = [
    "# 第一章\n主角出场，捡到神秘玉佩。",
    "# 第二章\n玉佩引来追杀，主角初显身手。",
    "# 第三章\n拜入宗门，结识挚友。",
    "# 第四章\n宗门大比，一鸣惊人。",
].join("\n---\n");

const store = new SessionStore();
const agents = new AgentRegistry();
const runner = new WorkflowRunner(store, agents, { files: { "manuscript/book.md": book } });

agents.register("summarizer.chapter", ({ input }) => ({
    message: "已摘要",
    data: { brief: (input as { text: string }).text.split("\n")[0] },
}));
agents.register("plot.analyst", ({ input }) => ({
    message: "剧情分析完成",
    data: { arcs: (input as { briefs: unknown[] }).briefs.length, theme: "逆袭" },
}));
agents.register("style.extractor", ({ input }) => ({
    message: "文风提取完成",
    data: { from: (input as { chapter: string }).chapter, style: "白描" },
}));

const splitBook: WorkflowDefinition = {
    key: "split-book",
    phases: [
        { key: "brief", title: "逐章摘要（小模型 ×N 并发）" },
        { key: "plot", title: "剧情分析（高性能模型吃 brief）" },
        { key: "pick", title: "人工圈选章节" },
        { key: "style", title: "文风提取（高性能模型）" },
    ],
    run: async (wf: Wf) => {
        const raw = await wf.workspace.read("manuscript/book.md");
        const chapters = raw.split("\n---\n").map((text, i) => ({ id: `ch${i + 1}`, text }));

        wf.progress({ phase: "brief", total: chapters.length });
        const briefs = await wf.map(chapters, async (ch) => {
            const s = await wf.agents.create("summarizer.chapter", { ephemeral: true });
            const r = await s.invoke({ input: { text: ch.text } });
            return { chapter: ch.id, brief: (r.result.data as { brief: string }).brief };
        }, { concurrency: 2 });

        wf.progress({ phase: "plot" });
        const analyst = await wf.agents.create("plot.analyst", { ephemeral: true });
        const plot = await analyst.invoke({ input: { briefs } });

        const picks = await wf.ask({
            kind: "select", multi: true, title: "选择要提取文风的章节",
            options: chapters.map((ch) => ({ id: ch.id, label: ch.id })),
        });

        wf.progress({ phase: "style" });
        const styles = await wf.map(picks as string[], async (chapterId) => {
            const s = await wf.agents.create("style.extractor", { ephemeral: true });
            const r = await s.invoke({ input: { chapter: chapterId } });
            return r.result.data;
        });

        return { briefs, plot: plot.result.data, styles } as JsonValue;
    },
};

// ---------- 执行：挂起态 + 完成态两个快照 ----------

const waitingView = await runner.start(splitBook, null);
const waitingTrace = traceGraph(waitingView.journal);
const journalSizeAtWaiting = waitingView.journal.length;

const answers = { [waitingView.pendingAsks[0].key]: ["ch2", "ch4"] as JsonValue };
const doneView = await runner.resume(waitingView.runId, answers);
const doneTrace = traceGraph(doneView.journal);
const replayedHits = journalSizeAtWaiting; // resume 时这些记录全部命中缓存

const skeleton = skeletonMermaid(splitBook);
const cfg = extractCfg(splitBook.run.toString());

// ---------- 渲染 HTML ----------

const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const journalRows = doneView.journal.map((r) =>
    `<tr><td><code>${esc(r.key)}</code></td><td>${esc(r.kind)}</td><td class="fp">${esc(r.fingerprint)}</td><td class="fp">${esc(JSON.stringify(r.result))}</td></tr>`
).join("\n");

const cfgRows = cfg.nodes.map((n) =>
    `<tr><td>c${n.id}</td><td><code>${esc(n.call)}</code></td><td>${n.controls.map((c) => `<span class="chip">${esc(c)}</span>`).join(" ")}</td><td class="fp">${esc(n.hint)}</td></tr>`
).join("\n");

const askCard = waitingView.pendingAsks.map((a) => `
        <div class="ask-card">
            <div class="ask-title">⏸ ${esc(a.spec.title)}</div>
            <div class="ask-opts">${(a.spec.options ?? []).map((o) => `<span class="chip">${esc(o.label)}</span>`).join(" ")}</div>
            <div class="ask-meta">ask key = <code>${esc(a.key)}</code>　应答：<code>${esc(JSON.stringify(answers[a.key]))}</code></div>
        </div>`).join("");

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>nb-workflow · 三种投影演示</title>
<style>
    body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; background: #12141a; color: #d8dce6; }
    header { padding: 24px 32px 8px; border-bottom: 1px solid #262b36; }
    h1 { margin: 0 0 4px; font-size: 22px; } h1 small { color: #7a8399; font-weight: normal; font-size: 13px; }
    section { padding: 20px 32px; border-bottom: 1px solid #1d212b; }
    h2 { font-size: 16px; color: #8ab4ff; margin: 0 0 6px; }
    .note { color: #9aa3b5; font-size: 13px; margin: 0 0 14px; max-width: 72em; line-height: 1.6; }
    .graph { background: #f7f8fa; border-radius: 8px; padding: 12px; overflow-x: auto; }
    .cols { display: flex; gap: 16px; flex-wrap: wrap; } .cols > div { flex: 1 1 420px; min-width: 0; }
    table { border-collapse: collapse; font-size: 12px; width: 100%; }
    th, td { border: 1px solid #2a3040; padding: 4px 8px; text-align: left; vertical-align: top; }
    th { background: #1a1e28; color: #8ab4ff; }
    code { color: #ffcf87; } .fp { color: #7a8399; font-family: Consolas, monospace; max-width: 34em; word-break: break-all; }
    .chip { display: inline-block; background: #223; border: 1px solid #354060; border-radius: 10px; padding: 1px 8px; font-size: 11px; color: #a9c4ff; }
    .ask-card { background: #1c1a12; border: 1px solid #5c4a1e; border-radius: 8px; padding: 12px 16px; max-width: 40em; }
    .ask-title { color: #ffd479; font-weight: 600; margin-bottom: 8px; }
    .ask-meta { color: #9aa3b5; font-size: 12px; margin-top: 8px; }
    .stat { display: inline-block; margin-right: 18px; color: #9aa3b5; font-size: 13px; }
    .stat b { color: #7ee787; font-size: 16px; }
</style>
</head>
<body>
<header>
    <h1>nb-workflow 三种投影 <small>Task 110 spike · 「拆书」场景实跑产物（挂起 → resume）</small></h1>
    <p class="note">
        <span class="stat">run 状态流转 <b>running → waiting → completed</b></span>
        <span class="stat">journal 记录 <b>${doneView.journal.length}</b> 条</span>
        <span class="stat">resume 时缓存命中 <b>${replayedHits}</b> 条（摘要/分析零重跑）</span>
        <span class="stat">最终结果 styles <b>${(doneView.result as { styles: unknown[] }).styles.length}</b> 章</span>
    </p>
</header>

<section>
    <h2>投影一 · 声明骨架（运行前）</h2>
    <p class="note">来自 workflow 元数据 phases，不执行、不解析代码。回答"这个 workflow 大概长什么样"，也是 UI 进度分组的依据。</p>
    <div class="graph"><pre class="mermaid">${skeleton}</pre></div>
</section>

<section>
    <h2>投影二 · AST 近似控制流图（静态，尽力而为）</h2>
    <p class="note">解析脚本源码，识别 wf.* / handle 编排调用点；虚线 = 被 if/for/map 回调包裹、静态无法断言必经。允许漏报误报——这是"程序"的近似图。</p>
    <div class="cols">
        <div class="graph"><pre class="mermaid">${cfg.mermaid}</pre></div>
        <div><table><tr><th>节点</th><th>调用</th><th>控制结构</th><th>首参摘要</th></tr>${cfgRows}</table></div>
    </div>
</section>

<section>
    <h2>投影三 · 动态 trace（精确执行图）</h2>
    <p class="note">journal 本身就是图：节点 = Activity，同路径顺序连边，map 分支从派生点接入并汇合。左：挂起态（跑到 ask 停下，4 条摘要分支已完成入账）；右：resume 后完成态（新增圈选章节的 style 分支）。体育场形节点 = ask 人类参与点。</p>
    <div class="cols">
        <div>
            <p class="note">⏸ waiting 快照（${journalSizeAtWaiting} 条记录）</p>
            <div class="graph"><pre class="mermaid">${waitingTrace.mermaid}</pre></div>
            ${askCard}
        </div>
        <div>
            <p class="note">✅ completed 快照（${doneView.journal.length} 条记录，前 ${replayedHits} 条为缓存命中）</p>
            <div class="graph"><pre class="mermaid">${doneTrace.mermaid}</pre></div>
        </div>
    </div>
</section>

<section>
    <h2>Journal 明细（ActivityKey = 路径 # 序号 · kind · 参数指纹）</h2>
    <p class="note">重放规则：四元组全匹配 = 命中返回记录值；首次不匹配 = 本路径后缀失效转真跑，兄弟路径不受影响。</p>
    <table><tr><th>key</th><th>kind</th><th>参数指纹</th><th>记录结果</th></tr>${journalRows}</table>
</section>

<script type="module">
    import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
    mermaid.initialize({ startOnLoad: true, theme: "neutral", flowchart: { curve: "basis" } });
</script>
</body>
</html>
`;

await Bun.write(new URL("./index.html", import.meta.url), html);
console.log(`demo 已生成: demo/index.html`);
console.log(`  waiting 快照: ${journalSizeAtWaiting} 条 journal，pendingAsk = ${waitingView.pendingAsks[0]?.spec.title}`);
console.log(`  completed:    ${doneView.journal.length} 条 journal，结果 = ${JSON.stringify(doneView.result).slice(0, 80)}...`);
