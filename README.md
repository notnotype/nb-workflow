# nb-workflow

脚本优先、宿主可组合的 Workflow Kernel。

`nb-workflow` 负责确定性的脚本执行语义，不拥有 Cosmos 的 Job/Lease，也不依赖
NeuroBook、Harness、Prisma、Redis 或某一种数据库：

```text
Workflow script
  -> path + sequence + kind + fingerprint
  -> Activity journal / replay / suffix invalidation
  -> bounded map/all
  -> wait / signal / timer / child / cancel
  -> optional Backend and Host ports
```

当前版本 `0.1.2` 已发布到 npm。Memory 组合用于测试、demo 和 Backend
conformance；它不支持进程重启或多 Worker。

## 安装

```bash
npm install @notnotype/nb-workflow
```

也可以从源码使用固定 commit 的 Git 依赖：

```bash
bun add github:notnotype/nb-workflow#<40-char-commit-sha>
```

Git 依赖方式需要先为固定 SHA 执行包构建（bundle 与 declarations 不提交到
仓库）：在 `nb-workflow` 检出目录运行 `bun run build`。

## Core 与宿主边界

Kernel 拥有：

- Workflow Definition、输入快照和 manifest identity；
- 版本化、不可变的 Extension 启动上下文；
- Activity identity、SHA-256 fingerprint 和 replay；
- 同路径后缀失效、稳定分支和有界并发；
- Signal、Timer、Child Workflow 的等待投影；
- 取消传播、受控时钟/随机数和 ValueRef journal。

宿主通过 Port 提供：

- `WorkflowBackend`：Run、journal 和 CAS revision；
- `ActivityExecutor`：版本化 Action 与 Query；
- `DefinitionRegistry`：精确 key/version/manifest 解析；
- `ValueStore`：大值内容寻址；
- `EventSink`：幂等事件发布；
- `SignalStore`、`TimerStore`、`ChildWorkflowStore`；
- 可选 Agent/Session extension。

能力协商使用 Backend 声明与实际注入 Port 的交集。例如 Backend 声称支持
durable Signal，但没有注入 `SignalStore` 时，Run 会在脚本执行前被拒绝。

Cosmos 等 durable host 继续拥有 TaskStore、Job、Attempt、Lease、Heartbeat、Retry、
Outbox 和领域事务。Memory Backend 不会伪装成这些能力。

## Core 示例

```ts
import {
    MemoryActivityExecutor,
    WorkflowRunner,
    type WorkflowDefinition,
} from "@notnotype/nb-workflow";

const activities = new MemoryActivityExecutor();
activities.registerAction("math.double@1", (input) => ({
    value: (input as { value: number }).value * 2,
}));

const definition: WorkflowDefinition = {
    key: "example",
    version: "1",
    manifestHash: "sha256:example-v1",
    run: async (workflow) => {
        const result = await workflow.callAction<{ value: number }>(
            "math.double@1",
            { value: 21 },
        );
        await workflow.checkpoint({ completed: true });
        return result;
    },
};

const runner = new WorkflowRunner(
    {},
    {},
    { activities },
);

const run = await runner.start(definition, null);
```

`query()` 与 Action 一样进入 journal；replay 不会重新读取已经变化的外部状态。
`now()` 和 `random()` 也进入 journal。Workflow 代码不应直接使用 `Date.now()` 或
`Math.random()`。

## 等待与恢复

Core 提供：

```ts
await workflow.waitForSignal("approval");
await workflow.sleep(5_000);
await workflow.startChildWorkflow(
    "research.deep@1",
    { topic: "DeepSeek outage" },
    { wait: true, cancelPolicy: "propagate" },
);
```

- Signal consumption 绑定稳定 Activity idempotency key。
- Timer 首次计算的 `dueAt` 在 replay 中保持不变。
- Child Store 稳定绑定 parent Activity 与 child Run；实际调度和执行由宿主负责。
- `MemorySignalStore`、`MemoryTimerStore` 和 `MemoryChildWorkflowStore` 只在当前
  进程内保存状态。

等待恢复：`rerun` 只允许 `failed`/`completed` 状态，以及"没有未应答 ask"的
`waiting`（timer/child 等待的宿主恢复入口）；带未应答 ask 的 waiting 与
running（除非 Backend 声明 `processRestart`）都会被拒绝。

## ValueStore

Activity output 小于 inline 上限时直接进入 journal；大值必须写入 ValueStore：

```ts
const runner = new WorkflowRunner(
    {},
    {},
    {
        values: new MemoryValueStore(),
        inlineValueLimitBytes: 64 * 1024,
    },
);
```

journal 只保存：

```ts
type WorkflowValue =
    | { kind: "inline"; value: JsonValue }
    | { kind: "ref"; ref: ValueRef };
```

没有 ValueStore 且超过上限时，Run 会明确失败，不会把无界 payload 塞入 Backend。

## Agent Extension

Agent、Session、Workspace 和 Caller 不属于 Core `WorkflowContext`。需要这些能力时
显式使用：

```ts
import type {
    AgentWorkflowDefinition,
    AgentWorkflowContext,
} from "@notnotype/nb-workflow";
```

并向 Runner 注入 `SessionPort` 与 `AgentPort`。Caller 与默认模型会进入版本化
Extension 启动上下文，可在另一个 Runner 上恢复。当前 Memory Agent 仅用于兼容
既有拆书、写作、RP 和 sidecar 场景；真实 Harness Adapter 后置。

`agents.acquire` 使用 `SessionPort.acquireByTag` 的原子 find-or-create；宿主
adapter 必须保证同一 `(profileKey, tag)` 并发调用恰好创建一个 session。
ephemeral session 在 Run 的任何终态（completed/failed/cancelled）都会归档。

## 开发与生产构建

```text
bun install --frozen-lockfile
bun test
bun run typecheck
bun run verify:package
```

- 开发与测试使用 Bun。
- `bun run build` 生成 bundled `dist/index.js` 和 TypeScript declarations。
- `bun run verify:package` 额外运行 NodeNext declaration consumer、纯 Node
  import/execute smoke，以及隔离目录 smoke（在系统临时目录安装 tarball、
  hostile `NODE_PATH`，验证主入口不依赖可选依赖）。
- `npm publish` 会先运行 `prepublishOnly` gate，拒绝 README/package.json/LICENSE
  存在未提交差异的发布。
- 生产消费者使用 Node.js 20+ 加载 `dist`。
- 构建通过不等于可运行；Task 01 还使用纯 Node import/execute smoke 验证产物。

## 当前明确限制

- Memory Backend 不支持进程重启、多 Worker、lease、durable signal/timer 或
  durable Child Workflow。
- Kernel 只 journal 成功的 Activity；失败 Activity 在恢复时重新执行，宿主需要
  按 idempotency key 提供安全重试。
- Backend save 失败以 `WorkflowPersistenceError` reject，不伪装成业务
  `failed`；`RunEnv.onEvent` 观察者失败也不会改变 Workflow 结果。
- 本包不提供脚本沙箱、Graph UI、Worker queue、Redis、数据库 Adapter 或远程
  Worker Gateway。
- `startChildWorkflow()` 只定义稳定 binding/wait/result 语义，不在 Kernel 内启动
  Worker。
- Agent/Session 仍是兼容扩展，尚未接入 `neuro-agent-harness`。
- Run 级 `workspace` 对象是进程内覆盖项；跨 Runner 恢复应由新 Runner 的
  `RunEnv.workspace` 重新注入。
- `extractCfg`（投影二）需要可选的 `typescript` peer dependency；未安装时
  调用它会得到明确错误，不影响主入口加载。
- Signal 记录没有内置回收：durable `SignalStore` 宿主需要自行定义消费后的
  TTL/清理合同。

## Public API

入口是 `WorkflowRunner`，其余公共能力从 `@notnotype/nb-workflow` 顶层导出：

- **Runner**：`WorkflowRunner`；`start`/`begin` 启动，`resume`/`rerun`/`cancel`/`signal`/`completeActivity` 控制，`view`/`loadView`/`list`/`listStored` 查询。
- **定义类型**：`WorkflowDefinition`（Core）、`AgentWorkflowDefinition`（Extension）、`WorkflowContext`、`AgentWorkflowContext`、`RunView`、`WorkflowValue`、`ValueRef`、`PendingActivity`、`ActivityCompletionRecord`、`DeferredActivityStartResult`、`DeferredActivityCompletionInput`、`BackendCapabilities`、`BackendRequirements`。
- **Host Port**：`WorkflowBackend`、`ActivityExecutor`、`DeferredActivityExecutor`、`DefinitionRegistry`、`ValueStore`、`EventSink`、`SignalStore`、`TimerStore`、`ChildWorkflowStore`、`Clock`、`IdGenerator`、`RandomSource`，以及可选 `SessionPort`、`AgentPort`、`WorkspacePort`。
- **Memory 实现**：`MemoryWorkflowBackend`、`MemoryActivityExecutor`、`MemoryDefinitionRegistry`、`MemoryValueStore`、`MemoryEventSink`、`MemorySignalStore`、`MemoryTimerStore`、`MemoryChildWorkflowStore`、`MemorySessionStore`、`MockAgentPort`、`createMemoryWorkspace`。
- **Deferred Activity 错误**：`DeferredActivityNotFoundError`、`DeferredActivityCompletionConflictError`、`DeferredActivityLateCompletionError`、`DeferredActivityFailedError`。
- **Conformance**：`deferredActivityConformanceCases`、`workflowBackendConformanceCases`、`workflowRunnerBackendConformanceCases`、`valueStoreConformanceCases`；Cosmos 等宿主 Backend 可以直接复用 Deferred Activity conformance，但必须自行提供 durable completion/receipt 能力。
- **工具**：`fingerprint`、`canonicalJson`、`assertJsonValue`、`definitionReference`、`definitionManifestHash`、`assertVersionedReference`、`validateSignalReference`、`validateTimerDuration`、`validateWorkflowEvent`。
- **投影**：`skeletonMermaid`、`extractCfg`、`traceGraph`。

`DeferredActivityExecutor` 是可选宿主端口：`startAction()` 返回已完成结果，或返回不透明 `receipt` 使 Run 进入 waiting。宿主必须按 `context.idempotencyKey` 幂等创建外部工作，或能用该 key 重新发现已有工作，因为 Kernel 可能在 receipt 落库前崩溃。宿主随后通过 `WorkflowRunner.completeActivity()` 提交包含 activity key、receipt、reference 和 fingerprint 的 completion。成功结果写入原 Activity journal；相同 completion 幂等，不同 completion 冲突，取消或终态后的迟到 completion 被拒绝。Memory Backend 仍不支持真实进程恢复、多 Worker 或 durable external receipt。

错误类型（`WorkflowPersistenceError`、`WorkflowBackendConflictError`、`WorkflowDefinitionConflictError`、`DeferredActivityCompletionConflictError` 等）全部从顶层导出，可按 `instanceof` 区分基础设施错误、Activity completion 冲突和业务失败。

实施记录见
[`docs/tasks/01-kernel-stabilization/`](docs/tasks/01-kernel-stabilization/README.md) 和
[`docs/tasks/03-deferred-activity/`](docs/tasks/03-deferred-activity/README.md)。

## License

[MIT](LICENSE)
