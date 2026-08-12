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

当前版本仍处于 API 稳定化阶段，尚未发布 npm 正式版。Memory 组合用于测试、demo
和 Backend conformance；它不支持进程重启或多 Worker。

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
    input,
    { wait: true, cancelPolicy: "propagate" },
);
```

- Signal consumption 绑定稳定 Activity idempotency key。
- Timer 首次计算的 `dueAt` 在 replay 中保持不变。
- Child Store 稳定绑定 parent Activity 与 child Run；实际调度和执行由宿主负责。
- `MemorySignalStore`、`MemoryTimerStore` 和 `MemoryChildWorkflowStore` 只在当前
  进程内保存状态。

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

## 开发与生产构建

```text
bun install --frozen-lockfile
bun test
bun run typecheck
bun run verify:package
```

- 开发与测试使用 Bun。
- `bun run build` 生成 bundled `dist/index.js` 和 TypeScript declarations。
- `bun run verify:package` 额外运行 NodeNext declaration consumer 和纯 Node
  import/execute smoke。
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

实施记录见
[`docs/tasks/01-kernel-stabilization/`](docs/tasks/01-kernel-stabilization/README.md)。
