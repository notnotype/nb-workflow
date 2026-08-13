# Task 03 Walkthrough：Deferred Activity

> 状态：Round 2 implementation + governance reconciliation；Deferred Activity 已通过本地完整 package 门禁，Cosmos 仍未进入实现。
>
> Task：[`README.md`](README.md)

## Round 0：基线和只读可行性审查

日期：2026-08-13

目标：在不触碰用户 dirty master 和其它 worktree 的前提下，建立 Deferred Activity 独立 Task，并确认现有 Kernel 是否能承载目标行为。

基线：

```text
repository: C:/Users/notnotype/Documents/CodeRepository/GithubProjects/nb-workflow
origin/master: cb4c8146684185971c8d9f02367811456471bcbd
implementation worktree: C:/Users/notnotype/Documents/CodeRepository/GithubProjects/nb-workflow-t03-deferred-activity
branch: feat/t03-deferred-activity
protected dirty master: cf34d1567181f77b49f12721648f8f73c3385120
package latest: @notnotype/nb-workflow@0.1.2
```

受保护 worktree：本地 dirty master、nb-workflow-t01-kernel-stabilization、nb-workflow-t02-audit-hardening 和 neuro-book 外部 worktree。

### 审查结论

现有 Kernel 已具备 Activity identity、fingerprint、journal replay、Run CAS、waiting、cancel、ValueRef 和可复用 conformance 基础。当前 `ActivityExecutor` 仍只返回同步 `Promise<JsonValue>`，没有 pending Activity、外部 completion reference、completion 路由、duplicate/conflict/late completion 语义。

结论：Deferred Activity 可在 Core 内实现，但必须先增加行为合同和 conformance；不能用 `waitForSignal()` 作为长期替代，也不能先进入 Cosmos Host。

证据来自 `origin/master@cb4c814` 静态代码检查；本轮没有修改代码、没有运行测试、typecheck、build、package smoke 或真实进程恢复。

### 实际修改

新增：

- `docs/tasks/README.md`
- `docs/tasks/03-deferred-activity/README.md`
- `docs/tasks/03-deferred-activity/walkthrough.md`

未修改：

- `src/`、`test/`、`package.json`、`bun.lock`、发布配置和用户 dirty worktree。

### 下一步

先增加行为测试，确定最小 Port 扩展，再实现 Memory 参考语义和 Backend/Runner conformance。Kernel 门禁通过前不进入 Cosmos。

## Round 1：Deferred Activity 实现现状与治理收敛

日期：2026-08-13

目标：接手目标 worktree 中已存在的 Deferred Activity 实现，核对公开合同、治理文档、保护边界与当前聚焦门禁；不把 dirty 实现误报为已验收，也不进入 Cosmos。

负责人/子代理：集成负责人；三个只读 scout 分别审查 Deferred 合同、治理文档和验证命令。scout 不修改文件、不运行项目级验证。

保护边界复核：

- nb-workflow 主 dirty master：`cf34d15`，保护；
- `nb-workflow-t01-kernel-stabilization`、`nb-workflow-t02-audit-hardening`：保护；
- NeuroBook `nb-workflow-contract` 外部 worktree：保护；
- Cosmos 主工作区及 `.worktree/*`：保护；
- 本轮只修改 `nb-workflow-t03-deferred-activity` 的 Task 文档，不修改用户 dirty 文件。

### 实际代码现状

当前 worktree 已包含 Deferred Activity 纵切实现：`DeferredActivityExecutor`、`PendingActivity`、`ActivityCompletionRecord`、`WorkflowRunner.completeActivity()`、completion CAS/幂等/conflict/late 处理、ValueRef completion、`resumeRequired` 恢复标记、可复用 conformance 和 7 条直接行为测试。这些是当前 worktree 事实，不等同已提交或已发布产物。

### 本轮只读审查结论

- 未发现 P0/P1。
- P2-1：`cancel()` 未经过 `withControl()`；取消与执行期最终 persist 之间可能出现 CAS 竞态，留下 `running + cancelRequestedAt` 的不可操作投影。尚未用测试复现，不在本轮宣称已修复。
- P2-2：同一 Runner 同一 Run 的并发控制命令会立即抛泛型错误；当前没有排队合同或专门测试。
- P2-3：Activity-level `cancelled` completion 在 replay 时复用 Run-level `WorkflowCancelledError`，语义边界未单独定义。
- P2-4：普通 workflow failure 可能保留 pending Activity，但 terminal Run 会拒绝后续 completion；外部工作是否由宿主补偿尚无 Core 合同。
- P3：`PendingActivity.stateRevision` 当前只写入、不被 completion 合同消费；completion tombstone 无界增长；pending timeout/lease 留给宿主，当前无测试或 durable 合同。

上述是源码审查结论；未把它们自动升级为产品决策。若下一轮要改变取消、并发或失败后 pending 的公开语义，先补 red test，再记录决定。

### 当前验证（本轮）

```text
bun test test/deferred-activity.test.ts
  7 pass / 0 fail / 18 expect calls

bun test test/deferred-activity.test.ts test/backend-conformance.test.ts
  28 pass / 0 fail / 20 expect calls

bun run typecheck
  passed

git diff --check
  passed（仅 Windows LF/CRLF 转换提示）
```

`goal:check` 不存在于 `package.json`、Task、CI 或 scripts；当前 Task 的 package 门禁是 `bun run build` 和 `bun run verify:package`。本轮没有运行 build 或 verify:package，因此 Deferred Activity 尚未达到进入 Cosmos 的门禁。

### 历史证据与当前证据

- Round 0 的 `origin/master@cb4c814` 是实现前静态基线，不能证明当前 dirty 实现。
- Round 1 的 7 条行为测试、7 条可复用 conformance case 和 typecheck 是当前 worktree 证据。
- Memory Backend 的跨 Runner 测试不是真实进程恢复；package smoke 不触碰 Deferred API；真实 durable Backend、外部 Worker、Cosmos Host/Worker 和生产 CI 仍未验证。

### Leader 判定

**继续：先完成 package/build 门禁；在这些门禁和独立审查完成前停止 Cosmos 下游实施。**

## Round 2：取消竞态收口与完整包门禁

日期：2026-08-13

目标：用确定性 red test 复现执行期最终 terminal persist 与并发 cancel 的 CAS 竞态；修复后验证 Deferred Activity、完整测试、typecheck、build 和 package consumer，不进入 Cosmos 实现。

范围：`src/runner-execution.ts`、`test/deferred-activity.test.ts`、Task 03 状态文档；保留所有 sibling、Cosmos worktree 与目标外 dirty 文件。

负责人/子代理：集成负责人实现和验证；`DeferredContractScout` 只读审查 P2-1，确认这是会留下 `running + cancelRequestedAt`、需要第二次 cancel 才能收口的真实 stuck-state bug，并给出 provider-neutral 修复边界。

实际修改：

- `persistExecutionProjection()` 识别 RunnerRunStore 已回滚的非 poison CAS 冲突；若 reload 后已有终态则返回权威终态，否则在 `abortRequested` 下标记 cancelled 并以最新 revision 重试一次。
- 新增 `terminal execution persist loses concurrent cancel and closes the Run` 回归测试，以 Backend 一次性外部更新确定命中 terminal persist 冲突；断言完成结果、持久状态和无需第二次 cancel。
- README 同步公开 API、验证矩阵和当前宿主边界；没有新增 Cosmos Job、Attempt、Lease、idempotency 或 provider-specific schema。

关键决定：

1. 修复 P2-1，而不是把 `cancel()` 纳入控制命令排队；cancel 仍先 abort 正在运行的外部调用，再由执行期最终 persist 收口，避免取消等待长执行。
2. 只在 `persistencePoisoned` 未设置且 `abortRequested` 已持久化的窗口重试；真实持久化错误继续抛出，非终态二次冲突仍保留为可由后续 cancel 收口的窄兜底。
3. P2-2、P2-3、P2-4 和 P3 不扩展为新公开合同：同 Runner 控制命令不排队；Activity-level cancelled 是 completion tombstone；失败 Run 的外部补偿、timeout/lease 和 tombstone retention 由宿主负责。

验证命令与结果：

```text
bun test test/deferred-activity.test.ts
  9 pass / 0 fail / 24 expect calls

bun test test/backend-conformance.test.ts
  21 pass / 0 fail / 2 expect calls

bun test
  117 pass / 0 fail / 305 expect calls

bun run typecheck
  passed

bun run build
  passed；生成 bundle 与 declarations

bun run verify:package
  passed；NODE_PACKAGE_SMOKE_OK
  passed；ISOLATED_PACKAGE_SMOKE_OK

git diff --check
  passed；仅报告 Windows LF/CRLF 转换提示
```

偏差：完整门禁已通过，但没有运行远端 CI、真实 durable Backend、真实外部 Worker、真实进程恢复、Cosmos Host/Worker 或生产 Provider。`verify:package` 的 Node smoke 只验证当前包导出和安装边界，不验证 Deferred Activity 的真实远程消费者。

未验证风险：Cosmos 当前仍是设计同步/实现暂停；其 Task 06 明确要求先完成独立 `nb-workflow` Kernel API、Memory Backend 和 conformance，再实现 Cosmos Durable Host/Worker convergence。当前 worktree 没有发布版本、远端依赖或稳定 commit 可供 Cosmos 接入。

Leader 判定：`nb-workflow` Deferred Activity 实现和本地包门禁完成；停止 Cosmos 下游实现，等待本地 checkpoint 和用户决定是否授权后续发布/接入任务。

## 后续轮次模板

```text
### Round N：标题

目标：
范围：
负责人/子代理：
实际修改：
关键决定：
验证命令与结果：
偏差：
未验证风险：
leader 判定：继续 / 停止 / 请求决策
```
