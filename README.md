# nb-workflow

NeuroBook Agent Workflow 编排系统 **spike**（对应主仓 `docs/tasks/110-agent-workflow-orchestration/`）。

验证 Task 110「V1 收敛」的脚本式 durable-execution 核心 API：不接入 NeuroBook，用内存 SessionStore + mock responder 顶替真实 harness/模型，把四个真实场景全流程跑通。

## 结构

```
src/
  types.ts            核心类型：Wf 面 / SessionHandle / ActivityRecord / WorkflowDefinition
  fingerprint.ts      参数规范化指纹（键排序 JSON，spike 不哈希便于调试）
  session-store.ts    内存 append-only session 树 + 排它锁 + tag 寻址（对应 JsonlSessionRepository）
  agents.ts           mock profile 注册表（对应 catalog + invokeCore）
  runner.ts           执行内核：Activity journal 重放 / 分支上下文 / SessionHandle / ask 挂起 / runner
  projection/
    skeleton.ts       投影一：phases 声明骨架（运行前）
    cfg.ts            投影二：AST 近似 CFG（typescript 解析，best-effort）
    trace.ts          投影三：journal 动态 trace（精确执行图，含派生/汇合边）
test/
  kernel.test.ts               journal 缓存 / 崩溃 rerun / 参数失效 / map 并发 / ask 挂起 / excursion
  scenario-split-book.test.ts  拆书：并发摘要→分析→挂起圈选→resume 不重跑
  scenario-write-pipeline.test.ts  写作流水线：writer↔critic 循环 + waiting 转发
  scenario-rp.test.ts          RP 持久参与者：acquire 跨 run 复用 + 轮间用户直聊 + 锁互斥
  scenario-sidecar.test.ts     sidecar 旁路：excursion + 主线 append 替代 merge()
  projection.test.ts           三种投影
```

`bun test`（13 tests / 78 断言）、`bunx tsc --noEmit` 全绿。

## 核心 API（本 spike 固化的形态）

```ts
const wf: Wf; // 宿主注入
wf.args; wf.log(); wf.progress({phase, done, total});
wf.workspace.read(path);                              // journaled
await wf.agents.profile(key);
await wf.agents.create(key, { initial?, tags?, parent?, ephemeral? });   // ephemeral: run 成功后归档
await wf.agents.acquire({ profileKey, tag, parent? }); // 持久参与者：找到复用，没有才建
await wf.sessions.open(id);  await wf.caller();        // 面 B/C
await wf.map(items, fn, { concurrency });              // thunk 化分支，seq 与完成序无关
await wf.all([() => ..., () => ...]);                  // 必须传 thunk（见发现 F3）
await wf.ask({ kind, title, options?, multi? });       // 挂起点

const h: SessionHandle;
h.leaf();                          // 同步派生态游标
await h.transcript({ tail? });
await h.checkout(entryId);         // 唯一游标原语：rewind/切分支/恢复现场
await h.append({ role, message?, input? });
await h.invoke({ mode?, message?, input? });   // waiting 是普通返回值
await h.excursion(at, fn);         // 旁路作用域，异常也恢复游标

const runner = new WorkflowRunner(store, agents, env);
await runner.start(def, args, { callerSessionId? });
await runner.resume(runId, { [askKey]: answer });
await runner.rerun(runId);         // 崩溃恢复：journal 命中不重跑
```

## Spike 发现（写给接入期的自己）

- **F1 · 内核比预想小**：journal 重放 + 分支路径上下文 + 挂起信号 + 锁，全部 ~250 行。复杂度都在语义决策（已在 Task 110 拍板），不在实现。
- **F2 · SessionHandle 必须持显式游标**：append/invoke 锚定 handle 游标而非全局 active leaf。否则挂起期间用户直聊移动了 leaf，resume 重放会把后续写挂错位置。这条要写进接入合同。
- **F3 · `wf.all` 必须收 thunk**：裸 `Promise.all([a(), b()])` 中两个分支在同一路径上争抢 seq，身份键随完成序漂移。接入 NeuroBook 后应在沙盒里把裸 Promise.all 列入 lint/黑名单，或注入受控替身。
- **F4 · spike 只 journal 成功**：Activity 失败不落 journal，rerun 时重执行失败步骤。严格确定性（错误也重放）留给 V2；对"崩溃恢复不重跑已成功步骤"这个 V1 目标已够。
- **F5 · 锁在挂起时释放是对的**：ask 可能等数天，锁死用户对话不可接受；resume 重放时 open/acquire 命中缓存也会重新加锁（锁是运行时态，不进 journal）。
- **F6 · waiting 作为普通返回值的收益真实**：pipeline 场景里子代理反问 → wf.ask 转发 → followup 续跑，一共 6 行脚本。旧 sidecar 合同里这是父 run 直接失败。
- **F7 · trace 投影几乎免费**：journal 自带路径结构，派生/汇合边一个正则就能重建。AST CFG 用 typescript 解析 `fn.toString()` 也够用（识别调用点 + if/for/map-fn 包裹标注），但确实只能 best-effort。
- **F8 · directChat 与 workflow 写入靠 origin 区分**（`workflow` / `direct`），RP 测试证明混排后 transcript 语义仍清晰。接入时对应 entry 的 origin 字段扩展。

## 与真实接入的差距（明确不在 spike 范围）

沙盒化脚本执行（World Engine codeact-sandbox 路线）、journal 持久化为 session entry（`workflow_step` 族）、SSE 投影、waiting 向上穿透、harness 可重入（spike 里 invoke 天然可并发因为是 mock）、schema 校验（argsSchema/resultSchema）。
