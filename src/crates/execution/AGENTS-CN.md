**中文** | [English](AGENTS.md)

# 执行原语层

本层负责可复用的 agent、命名工作流、stream、插件运行时客户端、typed-service 和 tool 执行原语。它不是完整 Agent Runtime SDK，也不是组装后的产品 runtime。由产品组装决定某个交付形态启用哪些 execution primitive、tool provider group、工作流能力、adapter 和 service。

## 模块

| Crate | 职责 | 本地文档 |
|---|---|---|
| `agent-runtime` | 可移植 Agent / Session / Turn 生命周期事实、调度与取消决策、prompt/cache/context facts、hooks、goal、扩展契约和 port-backed `AgentRuntime` facade | [AGENTS.md](agent-runtime/AGENTS.md) |
| `agent-workflows` | 与 UI、协议和具体 I/O 无关的命名产品工作流策略；当前承载 DeepResearch 报告后处理 | [AGENTS.md](agent-workflows/AGENTS.md) |
| `agent-stream` | Provider-neutral stream DTO、tool-call 累积和 replay 契约 | [AGENTS.md](agent-stream/AGENTS.md) |
| `tool-contracts` | Tool 契约、execution gate、input validation 和 result presentation 契约；Cargo package 仍为 `openbitfun-agent-tools` | [AGENTS.md](tool-contracts/AGENTS.md) |
| `plugin-runtime-client` | `PluginRuntimeClient` 的默认实现，负责派发、重复请求结果和故障诊断；JS/TS Plugin Host 是经服务端口管理的子进程 | [AGENTS.md](plugin-runtime-client/AGENTS.md) |
| `runtime-services` | Typed runtime service assembly 和 service availability facts | [AGENTS.md](runtime-services/AGENTS.md) |
| `tool-provider-groups` | Tool provider group facts 和 product-full tool group composition；Cargo package 仍为 `openbitfun-tool-packs` | [AGENTS.md](tool-provider-groups/AGENTS.md) |
| `tool-execution` | 底层 file/search/tool IO helper、ExecCommand presentation facts、Computer Use loop/retry policy、prompt-safe tool context facts 和 provider-neutral tool runtime policy；Cargo package 仍为 `tool-runtime` | [AGENTS.md](tool-execution/AGENTS.md) |

## 放置规则

- 可移植 execution 编排、agent lifecycle 契约、`PluginRuntimeClient` 可靠性逻辑、tool 契约、provider-neutral stream 契约和 execution facts 放到这里。
- 具体 filesystem、git、terminal、MCP server、remote SSH、OS 行为应放到 `services`，除非只是纯底层 tool primitive。
- 协议 projection 与外部 provider 请求整形放到 `adapters`。
- 产品 feature 选择和 delivery-profile 决策放到 `assembly`，不要放入 execution primitive。
- 命名产品工作流策略放到 `agent-workflows`；Agent Runtime 不得依赖命名工作流。产品产物和呈现生命周期留在产品 owner。
- Tool packs 只描述 provider group 和所需服务；具体服务访问应通过 port 或 typed runtime service。

## 依赖边界

- Execution primitive crate 可以依赖 `contracts`，也可以依赖本层拥有的窄 provider-neutral DTO。
- Execution primitive crate 不得依赖 `assembly/core`、`src/apps`、前端代码、Tauri API 或产品形态 lifecycle。
- 本层不得依赖 `adapters`。新增对 `services` 的依赖时，必须在最近的模块文档或 PR 描述里说明边界原因。
