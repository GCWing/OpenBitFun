**中文** | [English](AGENTS.md)

# Core Agent 指南

## 适用范围

本文件适用于 `src/crates/assembly/core`。仓库级规则请看顶层 `AGENTS.md`；进入更具体目录后，优先遵循更近的局部指南。

## 定位

`openbitfun-core` 是共享产品 runtime facade。它仍承载兼容路径和 `product-full` 组装边界，但新的拆解工作应优先遵循
`docs/architecture/product-architecture.md` 与
`docs/architecture/agent-runtime-services-design.md` 中定义的 owner crate 边界。

主要区域：

- `src/agentic/`：agents、prompts、tools、sessions、execution、persistence
- `src/service/`：config、filesystem、terminal、git、MCP、remote connect、AI memory
- `src/infrastructure/`：AI clients、app paths、event system、storage、debug log server
- `src/product_runtime/`：Core Agent Runtime 兼容 adapter 与 runtime service provider wiring

Agent 运行时心智模型：

```text
SessionManager -> Session -> DialogTurn -> ModelRound
```

## 边界规则

- 共享 core 必须保持平台无关。避免引入 `tauri::AppHandle` 等宿主 API；优先使用
  `openbitfun_events::EventEmitter` 等共享抽象。
- 桌面端专属集成应放在 `src/apps/desktop`，再通过类型化能力接口连接回来；需要事件投递时使用已有生产 transport adapter。
- 不要在没有窄 port/interface 边界的情况下新增 `service` 到 `agentic` 的跨层引用。
- 不要把平台专属逻辑、构建脚本行为、产品能力选择或 provider-specific AI 序列化写进 shared core。
- owner 从 core 外移时，在下游调用点被有意迁移前，用 facade 或 re-export 保持旧 import path。

## 拆解规则

- 将 `openbitfun-core` 视为兼容 facade 与完整产品组装点，而不是新稳定契约的默认归属。
- 稳定 DTO、facts、ports 和纯决策应放到有明确边界的 owner crate；具体 manager、IO、平台 adapter 和产品执行在没有评审过的
  port/provider 设计与行为等价测试前继续留在 core。
- Tool 改动必须保持 expanded/collapsed exposure、prompt-visible manifest、`GetToolSpec`、权限行为、
  `ToolUseContext` 语义，以及 desktop/MCP/ACP catalog 行为等价。
- Runtime owner 迁移在目标 owner 具备评审过的 port/provider 设计和行为等价测试前，不应移动 concrete lifecycle、IO、event delivery、permission orchestration 或 remote/platform implementation。
- Product-domain 改动可以在有等价保护时迁移纯产品领域计划；filesystem writes、worker/host side effect、
  Git/AI concrete calls、marker IO 和 path-manager integration 仍留在 core，除非有经过评审的 owner 设计。
- `plugin_source` 只注入产品目录并保留兼容接口；受管插件包发现与信任持久化归 `services-integrations`，生态适配解析与 `PluginRuntimeClient` 行为分别归对应的适配器层和执行层。
- `plugin_runtime`、`external_sources` 与 `instruction_sources` 是经过评审、可分别为对应能力契约选择生态适配器的
  owner-feature 组装文件。产品入口只消费产品级视图，不得导入适配器或原始插件运行时 client 类型。
- Remote/service 改动必须保持 external protocol lifecycle、workspace projection、scheduler/session restore、
  terminal pre-warm 和 product execution 边界清晰。
- Feature 改动必须保持 `product-full` 作为兼容产品组装边界；默认能力选择只有在单独的 product matrix review 后才能变化。
- `agent-runtime` 只负责 Core Agent 生命周期基线、原生 Hook runtime、基础文件/进程工具和
  Agent-control 工具。`mcp-runtime`、`remote-connect`、`workspace-search` 等具体网络或产品能力
  保持独立 owner；`external-sources` 增加第三方发现/导入 adapter，`plugin-runtime` 增加可执行
  plugin client wiring。不得把这些能力藏回 `agent-runtime`，
  它们也都不得启用 `product-full`。
- CLI/ACP 的闭包检查遵循 Cargo resolver-v2，保持 normal 与 host（build/proc-macro）feature context 相互隔离；
  但同一 context 内的所有 target-specific 声明都属于同一个已评审架构边界。平台确实需要不同 owner 时，应拆分清晰的
  package/module 归属；不得用互斥 Cargo `cfg` 隐藏未评审的 Core 能力。
- 保持轻量兼容 feature 可独立编译。本地服务 profile 为 `dispatch-store`、`terminal`、
  `workspace-runtime` 和 `workspace-watch`；`remote-workspace` 只增加远程工作区 facade，
  `ssh-remote` 才增加具体 SSH transport。`announcement`、`file-watch`、`git`、
  `review-platform` 也保持独立，`service-integrations` 只是其兼容聚合。任何窄 feature 都不得直接或间接启用 `product-full`。
- `product-full` 必须显式组合自身消费的每个能力，包括 `permission`、`session-git`、
  `runtime-ownership` 等产品专属 `services-core` feature。不得把这些 feature 写在依赖声明上，
  否则 Cargo feature union 会迫使所有 core consumer 编译它们。
- Core 的默认 feature 集合为空。`product-full` 是由真实产品入口显式选择的兼容组装，不能再作为
  library 的隐式默认值。能力内部使用的工具依赖必须保持 optional 并由 owner feature 激活；
  `base64`、`futures`、`regex`、`tokio-util` 与 `openbitfun-agent-tools` 分别归实际使用它们的
  Agent Runtime、local-storage 或 dispatch-store 闭包。Core 的 feature-free 直接 Tokio
  依赖只保留 config 与 app-path 状态所需的文件系统和同步能力；被显式选择的 Services Core
  `json-io` owner 另外持有受限原子 JSON 写入所需的 runtime/time capability。
- 后端 Fluent bundle 与可变翻译状态归 `i18n-runtime`；locale id、别名、fallback、metadata 与
  面向模型的语言文案仍是 feature-free 契约。调用 `I18nService` 的 host 必须显式选择
  `i18n-runtime`。
- 可复用诊断脱敏和本地 Diff 实现分别通过精确的 `diagnostics`、`diff` feature 保留兼容 facade。
  Agent Runtime 为受限异步 workspace 读取选择 `openbitfun-services-core/workspace-text-runtime`；
  contract-only consumer 使用同步路径规范化时不需要 Tokio。
- 平台 transport emitter 属于 host adapter。Desktop 直接导入
  `openbitfun_transport::TransportEmitter`；Core 只暴露稳定的
  `openbitfun_events::EventEmitter` 契约，不得重新导出 host adapter。
- 保持 `cargo check -p openbitfun-core --no-default-features` 可用。产品专属模块必须由 owner feature 控制；轻量 facade
  操作在缺少产品 owner 时若无法安全完成，应明确 fail-closed 并保留持久化恢复状态，不得隐式启用 `product-full`。

## 归属参考

归属细节放在下列文件中，不要继续扩写本指南：

- `docs/architecture/product-architecture.md`
- `docs/architecture/agent-runtime-services-design.md`
- `src/crates/execution/agent-runtime/AGENTS.md`
- `src/crates/execution/tool-contracts/AGENTS.md`
- `src/crates/execution/agent-workflows/AGENTS.md`
- `src/crates/contracts/product-domains/AGENTS.md`
- `src/crates/contracts/runtime-ports/` 与 `src/crates/execution/runtime-services/` 源码说明
- `src/crates/services/services-core/AGENTS.md`
- `src/crates/services/services-integrations/AGENTS.md`
- `src/crates/execution/tool-provider-groups/AGENTS.md`

部分子目录已有更细指南：

- `src/crates/adapters/ai-adapters/AGENTS.md`
- `src/crates/assembly/core/src/agentic/execution/AGENTS.md`
- `src/crates/assembly/core/src/agentic/deep_review/AGENTS.md`

## 验证

Core 验证由本指南维护。每次只选择与改动匹配的一种命令模式，不要依次运行所有 feature 变体：

```bash
cargo check -p openbitfun-core --no-default-features
cargo check -p openbitfun-core --no-default-features --features <touched-owner-feature>
cargo test -p openbitfun-core --no-default-features --features <minimal-features> --lib <module>::<test>
```

feature-free facade 改动使用第一种，单一 feature 边界改动使用第二种，行为改动使用第三种。
只有 Cargo feature、依赖方向或 test-target 布局变化时才运行 `pnpm run check:core-boundaries`。
workspace check 与产品全量测试由 CI 兜底，不是 Core 默认预检。仅改文档时运行 `git diff --check`。

助理发现、打开状态持久化和按工作区 ID 重新打开的聚焦验证：
`cargo test --locked -p openbitfun-core --no-default-features --features agent-runtime,git --lib service::workspace::service::tests::assistant_`。
