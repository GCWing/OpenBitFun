[中文](AGENTS-CN.md) | **English**

# Execution Primitives Layer

This layer owns reusable agent, named-workflow, stream, plugin runtime client, typed-service, and tool
execution primitives. It is not the complete Agent Runtime SDK and not the
assembled product runtime. Product assembly decides which primitives, tool
provider groups, workflow capabilities, adapters, and services are active for a
delivery form.

## Modules

| Crate | Responsibility | Local doc |
|---|---|---|
| `agent-runtime` | Portable Agent / Session / Turn lifecycle facts, scheduling and cancellation decisions, prompt/cache/context facts, hooks, goals, extension contracts, and the port-backed `AgentRuntime` facade | [AGENTS.md](agent-runtime/AGENTS.md) |
| `agent-workflows` | Named product workflow policy that is independent of UI, protocol, and concrete I/O; currently DeepResearch report post-processing | [AGENTS.md](agent-workflows/AGENTS.md) |
| `agent-stream` | Provider-neutral stream DTOs, tool-call accumulation, and replay contracts | [AGENTS.md](agent-stream/AGENTS.md) |
| `tool-contracts` | Tool contracts, execution gates, input validation, and result presentation contracts. Cargo package remains `openbitfun-agent-tools`. | [AGENTS.md](tool-contracts/AGENTS.md) |
| `plugin-runtime-client` | Default `PluginRuntimeClient` implementation for dispatch, duplicate-request results, and fault diagnostics; the JS/TS Plugin Host remains a child process managed through service ports | [AGENTS.md](plugin-runtime-client/AGENTS.md) |
| `runtime-services` | Typed runtime service assembly and service availability facts | [AGENTS.md](runtime-services/AGENTS.md) |
| `tool-provider-groups` | Tool provider group facts and product-full tool group composition. Cargo package remains `openbitfun-tool-packs`. | [AGENTS.md](tool-provider-groups/AGENTS.md) |
| `tool-execution` | Low-level file/search/tool IO helpers, ExecCommand presentation facts, Computer Use loop/retry policies, prompt-safe tool context facts, and provider-neutral tool runtime policies. Cargo package remains `tool-runtime`. | [AGENTS.md](tool-execution/AGENTS.md) |

## Placement Rules

- Put portable execution orchestration, agent lifecycle contracts,
  `PluginRuntimeClient` reliability logic, tool contracts, provider-independent stream
  contracts, and execution facts here.
- Keep concrete filesystem, git, terminal, MCP server, remote SSH, and OS
  behavior in `services` unless the code is a pure low-level tool primitive.
- Keep protocol projection and external provider request shaping in `adapters`.
- Keep product feature selection and delivery-profile decisions in `assembly`,
  not in execution primitives.
- Keep named product workflow policy in `agent-workflows`; Agent Runtime must
  never depend on named workflows. Product artifact and presentation lifecycle
  stays in its product owner.
- Tool packs should describe provider groups and required services; concrete
  service access should flow through ports or typed runtime services.

## Dependency Boundaries

- Execution primitive crates may depend on `contracts` and narrowly scoped
  provider-neutral DTOs owned by this layer.
- Execution primitive crates must not depend on `assembly/core`, `src/apps`,
  frontend code, Tauri APIs, or product-surface lifecycle.
- Dependencies on `adapters` are not allowed from this layer. New dependencies
  on `services` need an explicit boundary reason in the nearest module doc or
  PR description.
