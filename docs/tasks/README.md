# nb-workflow Task Walkthroughs

重大功能、公共合同、运行时恢复和发布使用持续 Task 记录目标、范围、实现、验证、偏差和后续门禁。用户 dirty master 和外部 worktree 属于保护区；历史 Spike 证据与本轮验证必须分开。

- [`01-kernel-stabilization/`](01-kernel-stabilization/)：已合并的通用脚本 Kernel 稳定化。
- [`02-audit-hardening/`](02-audit-hardening/)：已合并的审计修复与 0.1.2 发布。
- [`03-deferred-activity/`](03-deferred-activity/)：Deferred Activity `0.2.0` 已发布并完成 Registry consumer 验证；Cosmos 下游仍保持停止。

每个执行轮次必须回写同一 Task 的 walkthrough，至少记录：目标、修改文件、责任/子代理、关键决定、逐项验证结果、历史证据与当前证据的区别、未验证风险、leader 判定和本地 checkpoint。执行代理不得并行修改同一公开合同或文件；只读规划可以并行。
