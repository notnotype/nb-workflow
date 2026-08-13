# Task 03 Walkthrough：Deferred Activity

> 状态：Round 4 documentation/audit reconciliation；本地候选实现和 package gates 已通过，Cosmos 仍未进入实现。
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

## 历史快照：Round 1：Deferred Activity 实现现状与治理收敛

> 本节保留当时的审计和验证数字，仅作为历史快照；当前证据以 Round 2、Round 3 和 Round 4 为准。

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

### 历史验证（Round 1）

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

## 历史快照：Round 2：取消竞态收口与完整包门禁

> 本节保留当时的验证边界；Round 3 已补上真实 tarball 的 Deferred Activity 行为与 declaration consumer。

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

## 历史快照：Round 3：真实 tarball consumer 与发布边界收口

日期：2026-08-13

目标：补齐上一轮 package smoke 的证据缺口，让验证真正消费 `npm pack` 生成的 tarball；同时强化发布前元数据和产物检查。仍不发布、不 push、不创建 PR，不进入 Cosmos Host。

范围：`package.json`、`scripts/isolated-package-smoke.mjs`、`scripts/tarball-declaration-consumer.mjs`、`scripts/check-publish-ready.mjs`、本 Task 文档。没有修改 Cosmos、nb-workflow 其它 worktree、领域代码或数据库。

实际修改：

- `verify:package` 的 declaration consumer 只检查从真实 tarball 解包出的声明可被 strict NodeNext consumer 导入；隔离 tarball smoke 单独执行同一 tarball 的 Deferred Activity runtime 行为。
- 发布 gate 由 `prepublishOnly` 先重跑 `bun run build`，再检查 metadata、dist 和 pack 内容；两个 tarball 脚本改用 Windows `npm.cmd` 选择，不再使用 `shell: true`。
- 根 README 明确 npm `0.1.2` 尚未包含本 worktree 的 Deferred Activity。

验证命令与结果：

```text
node scripts/tarball-declaration-consumer.mjs
  TARBALL_DECLARATION_CONSUMER_OK

bun run verify:package
  passed
  NODE_PACKAGE_SMOKE_OK
  TARBALL_DECLARATION_CONSUMER_OK
  ISOLATED_PACKAGE_SMOKE_OK
  无 DEP0190 shell 警告

git diff --check
  passed（仅 Windows LF/CRLF 转换提示）
```

未验证：远端 CI、真实 durable Backend、真实跨进程恢复、真实外部 Worker、Cosmos Host/Worker、浏览器、Docker、真实 Provider，以及 npm 发布后的外部消费者。发布 gate 的成功路径仍需在 metadata 干净的提交/发布 worktree 中验证；当前 dirty worktree 的 gate 拒绝路径仍是预期行为。

偏差：本轮补强了包边界、构建新鲜度和 Windows 子进程调用，但没有创建新版本，也没有改变 npm `0.1.2`。Deferred Activity 仍只存在于本地 Task 03 worktree。

Leader 判定：本地 Kernel 与 tarball package gates 通过；在用户授权独立发布前，保持暂停，不开始 Cosmos Host。

## Round 4：Windows/npm 发布边界与候选合同收口

日期：2026-08-13

目标：处理只读审查发现的 Windows 发布阻断、tarball 手动解压假绿灯、声明 consumer 安装边界和 stale `dist` 风险；同时把当前证据与 npm Registry `0.1.2`、Cosmos 前置条件分开。仍不发布、不 push、不创建 PR，不进入 Cosmos Host。

范围：`package.json`、`scripts/child-processes.mjs`、`scripts/check-publish-ready.mjs`、`scripts/tarball-declaration-consumer.mjs`、`scripts/isolated-package-smoke.mjs`、`test/package-process.test.mjs`、Task 文档。没有修改 `src/`、Cosmos、nb-workflow 其它 worktree、数据库或 migration。

只读审查发现：

- Windows 的 `execFileSync("npm")` 可能找不到命令，直接使用 `npm.cmd` 且 `shell:false` 又会在当前 Node 24 环境返回 `EINVAL`；通过当前 Node 加载 npm CLI，并保持 `shell:false` 才能跨 Bun/Node 开发环境工作。
- 手动把 tarball 解压到 `node_modules` 不能证明真实安装；两个 consumer 改为在临时项目执行真实 `npm install`。
- declaration consumer 使用真实 npm 安装后的 package tree 验证公开 Deferred Activity 类型；TypeScript 编译器使用仓库开发依赖，内嵌 start/complete 代码只用于类型检查，runtime 由 isolated smoke 执行。
- `prepublishOnly` 现在先执行 `bun run verify:package`（包含构建），再检查 metadata、`dist` 和 pack 清单，避免源代码变化后直接发布 stale `dist`。

实际修改：

- 新增 shell-safe 的 `execNpm` helper，Windows 使用同一 Node 进程加载 npm CLI，POSIX 直接执行 npm；新增 focused helper test。
- 隔离 runtime smoke 通过真实 npm 安装后验证普通 Workflow、Deferred Activity pending→completion、duplicate、conflict、cancel/late，以及 optional TypeScript peer 不被自动安装。
- declaration consumer 通过真实 npm 安装后的 package tree 验证公开 Deferred Activity 类型。
- 保留 release gate 对当前 dirty metadata 的拒绝行为，不在 dirty worktree 伪造成功发布证据。

验证快照：

```text
Deferred Activity implementation base: 1caeecb (feat: add deferred activity contract)
工作树：dirty
Registry latest: @notnotype/nb-workflow@0.1.2
Node: v24.13.0
npm: 11.6.2
Bun: 1.3.14
```

验证命令与结果：

```text
`bun test test/deferred-activity.test.ts`
  9 pass / 0 fail / 24 expect calls

`bun test test/backend-conformance.test.ts`
  21 pass / 0 fail / 2 expect calls
bun test test/package-process.test.mjs
  1 pass / 0 fail / 1 expect calls

bun test
  118 pass / 0 fail / 306 expect calls

bun run typecheck
  passed

node scripts/tarball-declaration-consumer.mjs
  TARBALL_DECLARATION_CONSUMER_OK

bun run verify:package
  passed
  NODE_PACKAGE_SMOKE_OK
  TARBALL_DECLARATION_CONSUMER_OK
  ISOLATED_PACKAGE_SMOKE_OK

git diff --check
  passed（仅 Windows LF/CRLF 转换提示）
```

`prepublishOnly` 在当前 dirty metadata 下按预期拒绝（先完成 verify:package，再因 README/package.json dirty 停止）；成功路径未在 clean commit 上运行。远端 CI、Windows Node 20、真实 npm Registry 下载包、npm publish、真实 durable Backend、真实跨进程恢复、多 Worker fencing、Cosmos Host/Worker、浏览器、Docker 和真实 Provider 仍未验证。

重要边界：Round 4 的 tarball 是从当前 worktree 本地生成的候选包，不是 npm Registry 的 `0.1.2`，不改变 Registry 版本；“本地候选实现/候选 public API”也不等同正式发布或 durable host 合同。

Leader 判定：nb-workflow 本地 Kernel 与 package gates 已达到继续下游只读审查的门禁；在形成稳定 commit、完成独立发布授权和 Cosmos PR 基于当前 master 的验证前，不实现 Cosmos Host。


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
