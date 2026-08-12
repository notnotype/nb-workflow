# Task 02 Walkthrough：审计修复与 0.1.2 发布

> 状态：Implementation complete / delivery pending
>
> Task：[`README.md`](README.md)

## Round 0：基线、worktree 与范围

日期：2026-08-12

- 基线：`origin/master@d5ff6ea`（含 PR #1-#4 与 0.1.1 发布）。
- 新建 worktree `nb-workflow-t02-audit-hardening`，分支
  `codex/fix-t02-audit-hardening`。
- 用户本地 dirty master（`cf34d156`，6 个文件）继续只读保护。
- 范围来自上一轮 5 agent 审计 + 人工复核，决策点经用户确认（全量修复、
  rerun 收紧、0.1.2 + deprecate）。

## Round 1：Runner 语义修复（TDD）

- rerun 门控：拒绝带 ask 的 waiting 与 running（无 processRestart）；允许
  completed/failed 与纯 wait 的 waiting（timer/child 恢复原语）。
- checkpoint 确定性：终态投影从 journal 按 `(path, seq)` 重算。
- child 启动窗口：`children.start` 返回后检查取消并补 `cancelForParent`。
- ephemeral 归档：集合移到 RunRecord（进程内），所有终态归档；waiting 取消
  也归档。
- `agents.invoke` options 白名单；`InvokeOptions.message` 允许 null。
- `SessionPort.acquireByTag` 原子 find-or-create；Memory 同步实现。

## Round 2：边界与持久化（TDD）

- persistence poisoned：保存首次失败原因，后续 save 拒绝；工作流吞错不能
  伪装 completed。
- fingerprint 数组：索引 descriptor 检查、symbol 键拒绝；错误消息转义与截断。
- `begin()` 同步校验 callerSessionId/defaultModel；hydrate 复查 requires。
- ask 缓存命中路径补取消检查；AskSpec/emit 形状校验。
- capability 参数化测试补齐四项。

## Round 3：发布链路与收口（TDD）

- `extractCfg` 惰性加载 typescript + optional peerDependency。
- 隔离目录 smoke（tarball 安装 + hostile NODE_PATH + extractCfg 错误断言），
  `verify:package` 与 CI 共用。
- `prepublishOnly` gate（README/package.json/LICENSE 无未提交差异）。
- cancel 事件在持久化后发出；resume/signal 执行收尾期预检；persist 失败后
  view/loadView 一致；traceGraph 嵌套分支解析。

## 当前验证

```text
bun test            -> 99 tests / 279 assertions / 0 failures
bun run typecheck   -> passed
bun run verify:package
  -> NODE_PACKAGE_SMOKE_OK
  -> ISOLATED_PACKAGE_SMOKE_OK
```

## 下一步

- commit、push、PR、CI、合并；
- 创建 `chore/release-0.1.2`（版本号 0.1.2、README 版本行、walkthrough
  Round 记录），CI 绿后合并；
- `npm publish`（需用户 2FA）与 `npm deprecate @notnotype/nb-workflow@0.1.1`。
