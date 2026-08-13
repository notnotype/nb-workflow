# Task 03：Deferred Activity

> 状态：本地候选实现已完成；package gates（含真实 tarball consumer）已通过，但仍未提交、发布或接入 durable host。
> 日期：2026-08-13
>
> 分支：`feat/t03-deferred-activity`
>
> 当前基线：`origin/master@cb4c8146684185971c8d9f02367811456471bcbd`
>
> Walkthrough：[`walkthrough.md`](walkthrough.md)

> 保护边界：nb-workflow dirty master、t01/t02 worktree、NeuroBook 外部 worktree 与 Cosmos worktree 均不属于本 Task 修改或提交范围。目标 worktree 中既有实现和未提交文件属于本 Task 候选变更，提交前必须逐文件确认。

## 责任与协作矩阵

| 范围 | 唯一集成负责人 | 允许修改 | 禁止越界 | 交付证据 |
| --- | --- | --- | --- | --- |
| Kernel/Runtime | 本 Task 集成负责人 | `src/runtime.ts`、`src/workflow-context.ts`、相关类型/测试 | Cosmos Job/Worker/Transport 类型 | 行为测试、Deferred conformance |
| Runner/Backend | 本 Task 集成负责人 | `src/runner.ts`、`src/runner-*`、`src/run-record.ts`、相关测试 | 领域数据库或远程 Worker 实现 | CAS、恢复、取消测试 |
| Public Port/Export | 本 Task 集成负责人 | `src/ports.ts`、`src/types.ts`、`src/index.ts` | 未经行为证据冻结额外 API | 类型检查、公开 consumer |
| 文档/Task | 本 Task 集成负责人 | `docs/tasks/`、本 README、walkthrough | 把历史 Spike 当当前验证 | 每轮 walkthrough、门禁矩阵 |
| 外部审查 | 只读 scout/reviewer | 不修改合同或实现 | 不运行全量门禁、不提交 | file:line findings、未验证边界 |

单一公开合同或同一文件不得由多个执行代理并行修改；规划可并行只读，执行由集成负责人收敛。

## 验证矩阵

| 门禁 | 当前命令 | 覆盖范围 | 当前状态 |
| --- | --- | --- | --- |
| Deferred Activity focused | `bun test test/deferred-activity.test.ts` | pending、completion、failed、conflict、cancel、CAS | 已通过：9 pass / 0 fail / 24 expect calls |
| Deferred conformance | `bun test test/backend-conformance.test.ts` | Backend/Runner/ValueStore 与 Deferred cases | 已通过：21 pass / 0 fail / 2 expect calls |
| 全部测试 | `bun test` | 15 个测试文件的完整行为回归 | 已通过：118 pass / 0 fail / 306 expect calls |
| `goal:check` | 不存在于 `package.json`、Task、CI 或 scripts | 不适用 | 无此门禁 |
| Typecheck | `bun run typecheck` | strict TS src/test | 已通过 |
| Build | `bun run build` | bundle + declarations | 已通过 |
| Package/install smoke | `bun run verify:package` | 真实 tarball 的 NodeNext declaration consumer、Node smoke、Deferred Activity 隔离安装 smoke | 已通过：`NODE_PACKAGE_SMOKE_OK`、`TARBALL_DECLARATION_CONSUMER_OK`、`ISOLATED_PACKAGE_SMOKE_OK`（Round 4 dirty worktree 快照） |
| CI 对照 | `.github/workflows/ci.yml` | frozen install、test、typecheck、verify:package、demo、pack dry-run | 未运行远端 CI |

focused/conformance 使用 deterministic Memory fixture；不等同真实 durable Backend、外部 Worker 或 Cosmos 集成。package smoke 也不证明真实 Provider/生产部署。

## 当前实现结果

目标 worktree 已有以下实现，实际状态以当前源码和测试为准：

- `DeferredActivityExecutor.startAction()` 返回 `{status: "completed", result}` 或 `{status: "pending", receipt, reason}`；
- pending Activity 以 `PendingActivity` 持久化，Run 进入 `waiting`；
- `WorkflowRunner.completeActivity()` 校验 activity key、receipt、reference、fingerprint，并通过 Backend revision CAS 接受 completion；
- 成功 completion 写入原 Activity journal；failed/cancelled completion 保存 completion tombstone，并在 replay 时形成确定性结果；
- 相同 completion 重试幂等，不同 completion 冲突，终态或取消后的迟到 completion 被拒绝；
- 大 completion 使用 `ValueStore` 的 `ValueRef`，`resumeRequired` 允许宿主在 completion 持久化后恢复；
- Deferred Activity 是可选 Port，Core 不包含 Cosmos Job、Attempt、Lease、Worker、Outbox、Gateway 或 Transport。

本轮已用行为测试收口 cancel 与执行期最终 persist 的 CAS 竞态、completion 与 cancel 竞争、非法 completion payload、capability gate 和 public error export。以下是有意保留的宿主边界，而不是本 Task 的未完成实现：同一 Runner 的并发控制命令不排队；Activity-level cancelled 只作为内部 completion tombstone，外部 Job 是否真正终止由宿主决定；失败 Run 的外部工作补偿由宿主按 `context.idempotencyKey` 处理；pending timeout/lease 和 tombstone retention 不属于 Kernel。

## 当前验证

本轮验证记录见 [`walkthrough.md`](walkthrough.md) Round 4。当前已验证的是目标 worktree 的 deterministic Memory 行为，以及通过真实 `npm install` 安装当前本地 tarball 后的 Node/TypeScript consumer 行为；这个 tarball 不是 Registry 上的 `@notnotype/nb-workflow@0.1.2`。未验证真实 durable host、外部 Worker、真实进程恢复、Cosmos 或生产 CI。

## 1. 目标

把当前同步 ActivityExecutor 扩展为可被 Cosmos 等 Durable Host 组合的 Deferred Activity 语义，同时保持现有同步 `callAction()` replay 行为。Workflow 作者目标仍是：

```ts
const result = await wf.callAction("source.fetch@1", input);
```

当外部执行不能在当前 continuation 内完成时，Kernel 必须能够保存 pending Activity、让 Run 进入 waiting、释放当前执行，并在外部 completion 被验证后恢复同一个 Activity 调用。

## 2. 当前能力与边界

0.1.2 已提供 Activity identity、fingerprint、journal replay、Run CAS、waiting/signal/timer/child/cancel、ValueRef、Backend/Runner conformance、Node build 和 package smoke。

当前 worktree 已增加可选 `DeferredActivityExecutor`。同步 `ActivityExecutor` 保持原有 `Promise<JsonValue>` 合同；配置 Deferred Port 后，`callAction()` 使用 Deferred Activity 语义，支持 pending receipt、waiting、completion、duplicate/conflict/late completion、ValueRef、cancel tombstone 和 `resumeRequired`。该语义尚未发布，也尚未由真实 durable Backend 验证。

## 3. 范围

本 Task 实现和验证 pending Activity、opaque completion reference、success/failure/cancelled completion、identity/fingerprint/reference 校验、duplicate 幂等、conflict 拒绝、cancel 后迟到 completion 拒绝、completion/cancel CAS 竞争、waiting load/replay/resume、可复用 conformance 和 Node/package 门禁。

## 4. 非目标

不实现 Cosmos、Prisma、SQLite、NestJS、Observation、Entry、Story、Job、Attempt、Lease、Worker、Gateway、Redis、Outbox、Harness、nb-memory、真实 Connector 或第二套 replay Kernel。不能用 `waitForSignal()` 伪装 Deferred Activity；Memory Backend 继续明确不支持真实进程重启和多 Worker。

## 5. 最小行为合同

```text
callAction
→ Activity completed(value) 或 Activity pending(reference)
→ pending 时 Run waiting
→ 外部 completion 校验 Run/Activity/action/fingerprint/reference
→ 写入原 Activity journal并清除 pending
→ Run 可恢复，原 callAction 得到 value 或明确 failure
```

必须保证相同 Activity 的相同 completion 重试幂等；不同结果、fingerprint、reference、未知 Run/Activity、已取消或终止 Run 的 completion 不得覆盖已接受结果或终态。ask、signal、timer、child 和 deferred activity 的等待原因必须可区分。

具体 TypeScript symbol、错误类名、reference wire shape 和 completion 返回值由测试先行后确定，不由 Cosmos 文档提前冻结。

## 6. 实施顺序

1. 增加失败测试和 conformance。已完成。
2. 选择不破坏 0.1.2 同步 ActivityExecutor 的最小 Port 扩展。已完成。
3. 实现 Memory 参考语义和 Runner/Backend 集成。已完成。
4. 完整测试、typecheck、build 和 package smoke 已通过；package smoke 还覆盖真实 npm 安装后的声明解析和 Deferred Activity completion 行为。
5. 候选 public API 已由当前测试和 tarball consumer 固定；正式稳定承诺仍需稳定 commit、发布审查和 durable Backend conformance。当前 npm `0.1.2` 不包含本 worktree 的 Deferred Activity，commit、版本和发布仍需独立授权任务。

## 7. 验收门禁

```text
bun test
bun run typecheck
bun run build
bun run verify:package
```

另行验证首次 pending、completion success/failure、duplicate/conflict、cancel 竞争、迟到 completion、waiting load/replay、ValueRef、capability 拒绝、hostile NODE_PATH 和干净目录 package consumer。Memory 第二个 Runner 测试不得被描述为真实进程恢复。

## 8. 停止与进入 Cosmos 的条件

若必须引入 Cosmos 类型、只能手动拆成 create job + waitForSignal、completion 无法绑定唯一 Activity、重复提交不能幂等、迟到结果能写 cancelled Run、没有 CAS、无法从持久状态发现 pending，或 Memory/durable Backend 不能共享 conformance，立即停止。

进入 Cosmos 前必须提供稳定 commit SHA、最终 public API、Deferred Activity conformance、full test、typecheck、build、package smoke、waiting→completion→resume 和 cancel/late completion 证据。

本 Task 当前不授权 Cosmos Host、Prisma Activity 表、Activity Job、Worker Admin、发布、push、PR 或合并。
