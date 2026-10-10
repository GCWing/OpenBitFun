**中文** | [English](AGENTS.md)

# AGENTS-CN.md

OpenBitFun 是一个由 Rust workspace 与 React 前端组成的项目。

仓库核心原则：**先保持产品逻辑平台无关，再通过平台适配层对外暴露能力**。

## 快速开始

1. 在修改架构敏感代码前，先阅读 `README.md` 和 `CONTRIBUTING.md`。
2. 日常开发使用下方主要产品循环；surface 专属的替代命令由最近的应用指南维护。
3. 修改 Rust 文件后，优先使用 `pnpm run fmt:rs`，只格式化已改动或已暂存的 `.rs` 文件。只有在你明确需要更大范围格式化时才使用 `cargo fmt`。
4. 改完后从离改动最近的 `AGENTS.md` 选择 focused 验证命令；下方仓库级验证章节只维护跨模块检查原则。
5. Rust workspace 依赖应在根清单中统一版本，而由消费 crate 按自身职责声明所需 feature；仅测试所需的 feature 应放入 `dev-dependencies`，受 crate feature 控制的服务能力应只在对应 feature 中启用。第三方依赖的默认 feature 若不是所有 consumer 的稳定契约，应在 `[workspace.dependencies]` 统一关闭，成员只增加自身需要的切片。仓内 crate 的 `default` 已由边界契约保证为空时，不在每条依赖边重复写 `default-features = false`；ACP 这类有意保留兼容默认的 crate 仍由窄 consumer 显式关闭。被单独复制到 Docker 构建上下文的 manifest 无法继承 workspace 根，必须继续维护显式版本和默认策略。禁止使用 `tokio/full` 绕过依赖边界设计。

## 分层模块索引

依赖关系按自上而下读取。下表是物理 crate 布局，不是完整概念架构；Product Surface、Product Assembly、
Product Feature、Agent Kernel、Execution、Extension、Cross-platform Adapter、
Stable Contracts and Security Control Plane 的边界以
[`docs/architecture/product-architecture.md`](docs/architecture/product-architecture.md)
为准。同层 crate 也应保持最小依赖。

| # | 层级 | 路径 | 职责 | 模块 / 入口 | 层级文档 |
|---|---|---|---|---|---|
| 1 | 接口与入口层 | `src/apps/*`, `src/web-ui`, `src/mobile-web`, `OpenBitFun-Installer`, `tests/e2e`, `src/crates/interfaces` | 产品宿主、命令、UI 入口、协议接口和跨形态测试 | desktop、CLI、server、relay、Web UI、mobile web、installer、E2E、`acp`、`sdk-host` | 最近的本地 `AGENTS.md`；[interfaces](src/crates/interfaces/AGENTS.md) |
| 2 | 产品组装层 | `src/crates/assembly` | 兼容导出、产品能力选择、product-full 接线、不可变内置 Agent 内容、adapter/service 注册和生态无关的来源协调 | `agent-content`, `core`, `external-sources`, `product-capabilities` | [AGENTS.md](src/crates/assembly/AGENTS.md) |
| 3 | 适配层 | `src/crates/adapters` | AI/transport/WebDriver 协议 adapter、外部 AI work source adapter（OpenCode/Claude Code/Codex）和外部 provider 转换 | `agent-runtime-ipc`、`ai-adapters`, `opencode-adapter`, `claude-code-adapter`, `codex-adapter`, `static-hook-support`, `transport`, `webdriver` | [AGENTS.md](src/crates/adapters/AGENTS.md) |
| 4 | 服务实现层 | `src/crates/services` | 可复用 OS、filesystem、terminal、MCP、remote、git、watch、process、session persistence primitives、network 和 MiniApp runtime IO 实现 | `services-core`, `services-integrations`, `relay-service`, `page-function-runtime`, `terminal` | [AGENTS.md](src/crates/services/AGENTS.md) |
| 5 | 执行原语层 | `src/crates/execution` | 可移植 Agent Runtime、命名工作流策略、stream、插件运行时客户端、typed-service、tool-contract、tool-group 和 tool-execution 构件 | `agent-runtime`, `agent-workflows`, `agent-stream`, `tool-contracts`, `plugin-runtime-client`, `runtime-services`, `tool-provider-groups`, `tool-execution` | [AGENTS.md](src/crates/execution/AGENTS.md) |
| 6 | 稳定契约与产品领域层 | `src/crates/contracts` | 跨层共享 DTO、事件形状、runtime port、产品领域契约和策略 | `core-types`, `events`, `runtime-ports`, `product-domains` | [AGENTS.md](src/crates/contracts/AGENTS.md) |

边界规则：

- 接口与入口层暴露选定产品行为；可复用行为应下移。
- 组装层只接线下层并选择产品能力事实，不实现具体 adapter、OS 或 service 细节。
- 产品特性只在内核能力之上组装用户侧命令、UI contribution、设置和默认策略；长程任务、scheduler、permission、session/workspace、memory、DFX、hook 和 event 事实属于 Agent Kernel owner。
- 适配层翻译协议和外部 provider 形状，不拥有产品能力选择或可复用 OS service 行为。
- 服务实现层负责可复用的 OS、process、terminal、MCP、remote、git、filesystem、session persistence primitives 和 MiniApp runtime IO 能力。
- 外部系统是边界外资源，不是仓库内层级。只有已注册的 adapter、service 或 app-local provider 应调用它们；其他层消费 port 和稳定契约。
- 执行原语层只放可移植运行时构件，不拥有宿主或交付形态。
- 契约层保持轻行为，不得向上依赖。

## 常用命令

这里只保留稳定的仓库级入口。具体 surface/crate 的测试命令由最近的本地 `AGENTS.md` 维护，
不要在根文档重复抄写。

```bash
# 安装与主要产品开发循环
pnpm install
pnpm run desktop:dev               # 完整热更新：Vite HMR + Rust 自动重编译并重启

# 仓库级检查
pnpm run fmt:rs                    # 只格式化已改动 / 已暂存的 Rust 文件
pnpm run check:repo-hygiene        # 仓库内容与文件名规则
pnpm run check:github-config       # GitHub workflow / 配置规则
pnpm run check:core-boundaries     # Cargo / 模块 owner 边界
```

Web UI、mobile、CLI、Desktop、Installer、打包及 focused test 命令由最近的本地指南维护；
完整脚本注册表仍见 [`package.json`](package.json)。

## 全局规则

### 流程产物

- 不要新增或更新 `docs/superpowers/**` 下的文件。临时计划、设计和实现过程文档仅保留在本地；
  需要长期维护的架构或功能事实应合并到对应的已有文档，用户使用说明应放到所属应用的 README。

### 国际化

- Locale id、alias、fallback 和各形态默认语言统一由
  `src/shared/i18n/contract/locales.json` 管理；修改后运行
  `pnpm run i18n:generate`。
- 跨形态稳定标签放在
  `src/shared/i18n/resources/shared/<locale>/terms.json`；流程文案留在所属
  产品形态资源中。
- 不要把 Web UI locale 资源导入 `src/mobile-web`、`OpenBitFun-Installer` 等较小形态；
  完整规则见 `docs/architecture/i18n.md`。
- 静态自包含页面只能使用生成的 page-scoped shared-term 文件，不得导入 Web UI locale catalog。
- Web UI 只急切加载 bootstrap namespace；路由或功能文案使用
  `useI18n(namespace)`，直接 `i18nService.t(...)` 只用于 bootstrap namespace。
- 用户可见的日期、时间和数字应通过共享 i18n 格式化 helper 处理，避免在产品代码中直接
  使用 `Intl.*` 或 `toLocale*`。
- `pnpm run i18n:audit` 会检查 key / 占位符一致性、直接静态 key、dynamic key
  source proof、literal fallback / locale-format 零增长基线、shared-term / l10n
  治理基线、非阻断 same-text locale 盘点，以及 source 中不再新增硬编码 CJK 文案。

### 主题与颜色 Token

- 主题与颜色 baseline 是 ratchet 契约，不是可随意修改的测试期望。不得通过提高
  `scripts/theme-color-governance-baseline*.json`、放宽 fixture/assertion、扩大 allowlist
  或移除 CI 审计来让失败检查通过。
- 实际债务减少时应同步下调 baseline。确需新增颜色或 key 时，只增加最小 owner contract，
  并说明现有 semantic、component 或专用域 Token 为什么不能覆盖。
- 修改 theme、CSS variable、widget payload、mobile、installer 或 CLI/TUI 颜色时，运行
  `pnpm run theme:color-audit:all`。

### 日志

日志必须只用英文，且不能使用 emoji。

- 前端：[src/web-ui/LOGGING.md](src/web-ui/LOGGING.md)
- 后端：[src/crates/LOGGING.md](src/crates/LOGGING.md)

### Tauri command

- command 名称：`snake_case`
- TypeScript 可以用 `camelCase` 包装，但调用 Rust 时要传结构化 `request`

```rust
#[tauri::command]
pub async fn your_command(
    state: State<'_, AppState>,
    request: YourRequest,
) -> Result<YourResponse, String>
```

```ts
await api.invoke('your_command', { request: { ... } });
```

### 平台边界

- 不要在 UI 组件里直接调用 Tauri API；应通过 adapter / infrastructure 层访问。
- 桌面端专属集成应放在 `src/apps/desktop`，再通过类型化能力接口回流；需要事件投递时，使用已有生产 transport adapter。
- 在共享 core 中避免使用 `tauri::AppHandle` 等宿主 API；优先使用 `openbitfun_events::EventEmitter` 等共享抽象。

### 远程场景

OpenBitFun 不是只在本地运行的桌面应用：工作区、执行这一轮的 runtime、以及正在操作的人，
可能分别位于三台机器。下面四种场景是每次改动都要一并覆盖的一等目标，不是事后再补的适配。

| 场景 | 含义 | 设计入口 |
|---|---|---|
| 远程工作区 | 当前工作区位于 SSH 主机、跳板机链路或 Docker 容器；文件、终端、搜索和 Agent 子进程都必须在那一侧执行 | [remote-workspace-transport.md](docs/architecture/remote-workspace-transport.md)、[remote-workspaces.md](docs/features/remote-workspaces.md) |
| 远程控制 | 手机端 mobile web，或飞书 / Telegram / 微信 Bot，通过 Remote Connect relay 驱动 Desktop 或 CLI 宿主上的会话 | [`src/mobile-web`](src/mobile-web/AGENTS.md)、[services-integrations](src/crates/services/services-integrations/AGENTS.md) 的 `remote_connect`、[relay-service](src/crates/services/relay-service/AGENTS.md) |
| 多端互控（Peer Device Mode） | 同账号的一台设备成为另一台的数据平面：控制端外壳仍在本地，invoke 和事件来自 peer | [peer-device-mode.md](docs/architecture/peer-device-mode.md)、[peer-device README](src/web-ui/src/infrastructure/peer-device/README.md) |
| Dispatch 分离任务 | 控制端把持久化任务提交到另一台 OpenBitFun 宿主后即可断开；目标端拥有 job、session、worktree、事件日志和权限信箱 | [detached-task-dispatch.md](docs/architecture/detached-task-dispatch.md) |

四种场景共同适用的规则：

- 远程路径要和功能一起设计。默认 UI、进程和文件系统在同一台机器上的能力属于未完成，
  而不是“第一阶段”。
- 不支持要显式暴露。确实无法支持时，应屏蔽入口或返回明确的不支持状态；静默回落本地、
  假成功、空载荷和通用错误都算回归，其中回落本地还会把本地内容泄露给远端控制方。
- 阻塞式交互必须可以远程应答。新增的权限确认、对话框和选择器都要经既有的 dialog /
  权限信箱编排送达当前操作端；只能靠桌面窗口解除的阻塞会让远程控制和 Dispatch 任务死锁。
- 要能扛断线。远程形态会重连、按 cursor 重放并重新 hydrate，因此优先使用可恢复 cursor
  和幂等变更，不要依赖“客户端恰好在线”才存在的状态。
- 远程工作区路径在任何客户端 OS 上都是 POSIX 路径。不得用宿主 `std::path` 语义切分或
  拼接，也不得把控制端的路径直接拿到 peer 宿主上复用。

各场景的具体约束：

- **远程工作区**：每个桌面端 Tauri 命令在 Product Operation Registry
  （[`remote_surface/table.rs`](src/crates/contracts/product-domains/src/remote_surface/table.rs)）
  中有且只有一行，声明其远程工作区立场。桌面端闭包测试与能力生成器会拒绝没有对应行的
  新命令，注册表的 ratchet 禁止 `Unaudited` 存量清单增长。见
  [remote-surface-contract.md](docs/architecture/remote-surface-contract.md)。
- **远程控制**：mobile web 和 IM Bot 是通过 `RemoteCommand` wire 协议和 bot command
  router / menu 触达会话的，不走 Web UI。新增或迁移会话级能力时——工作区与助手选择、
  会话生命周期、模式、模型、审批、附件——要同步扩展这些形态，或让它们给出明确的
  不支持回复。
- **多端互控**：产品命令默认代理到 peer 执行。必须留在控制端的命令（窗口装饰、更新器、
  账号身份、本地 OS 自动化）在同一注册表行中声明为 `ControllerLocal`；桌面端 peer host、
  CLI peer host 和 Web UI transport adapter 都从它派生拒绝集合，
  `pnpm run check:core-boundaries` 会拒绝手写清单。CLI host 要执行的命令需要处理分支加
  行内 `cli_peer: HANDLED`（`src/apps/cli/src/peer_host/commands/mod.rs` 的闭包测试保持
  两者一致）。Peer 能力是类型化的 `PeerHostCapability`，由注册表发布。改动 session、
  account 或 hydrate 路径前，先读 peer-device README 的 invariants。
- **Dispatch 分离任务**：任务在目标端以 CLI delivery profile 无界面运行，没有交互宿主，
  也不保证控制端在线。控制端只是观察者，不是 runtime 或文件系统代理。不要引入依赖提交方
  常驻的行为；dispatch 协议版本和目标端必备 capability 属于兼容契约——新的目标端要求要走
  协商 capability，而不是默认假设。

改动说明中要写清楚在哪些远程场景下验证过。只跑本地测试不能作为远程行为的证据。

### 升级兼容性

用户是原地升级的，而上述远程场景经常让两个不同版本的 OpenBitFun 连在同一条链路上。
任何改动都必须保证已有安装在升级后无需手工修复即可继续工作。

- **落盘结构会被新旧两侧代码同时读取。** 配置、设置、会话、连接配置、worktree 和
  dispatch 记录：新增字段要带默认值，反序列化要保持容错，绝不重新定义或收窄已经落盘
  字段的语义。旧数据给不出的字段，不能变成必填。
- **不要用删除或重置用户数据的方式来“恢复”解析不了的内容。** 应保留记录、降级功能并
  给出明确状态。凭证缺失、配置读不出、超时或主机离线，都不构成丢弃会话、工作区或连接
  的理由；销毁性删除只能是用户的显式操作。
- **跨版本边界要协商，不能假设。** Peer HostInvoke、dispatch 协议、relay 与 mobile web、
  IM Bot，对面都是你控制不了的构建版本。要先声明 capability 再使用——包版本相同不等于
  行为相同——并且要让旧版本一侧留在可用路径上，而不是直接判失败。
- **改名就是一次迁移。** 在所有受支持的对端都不可能再发送旧名称、旧 id 或旧结构之前，
  必须继续兼容读取；被改名对象所引用的数据（vault 条目、工作区指针）要一并迁移。
- **用测试证明。** 要覆盖旧数据反序列化和旧载荷往返，而不只是新结构。只验证当前代码
  自己写出的数据，不算升级兼容性覆盖。

### Agent loop 行为

- 不要把硬编码限制或模式判断作为处理 agent loop 循环问题的第一反应，例如仅按字符串或次数阻止重复工具调用。
- 过多硬编码会把 agent loop 变成脆弱的 workflow。应先定位根因：工具行为、模型交互、会话上下文封装、prompt/tool schema 设计，或状态同步问题。

### Agent Hooks

- OpenBitFun 的原生用户 Hooks 实现 Codex Hook 契约，因此 <https://learn.chatgpt.com/docs/hooks> 是其事件、载荷字段与决策结构的参考来源，不要另起炉灶。[`docs/features/agent-hooks.zh-CN.md`](docs/features/agent-hooks.zh-CN.md)（[English](docs/features/agent-hooks.md)）只覆盖 OpenBitFun 特有部分 —— 文件位置、`app.hooks` 开关和差异表 —— 新增或消除差异时必须同步更新。
- 可移植引擎（配置解析、载荷构造、进程执行、决策合并）位于 `openbitfun-agent-runtime::native_hooks`。`openbitfun-core::native_hooks` 负责配置发现、开关门控和按事件的分发辅助函数；各分发点调用这些辅助函数，不要就地执行 Hook。
- 可执行 Hooks 可以来自原生用户配置、生态插件或 OpenBitFun 内置实现（包括当前编译期 `post_call_hooks`）。这些来源保持各自的信任、配置、契约和执行策略语义，但可以统一注册到共享的 `HookRegistry`，并由 `AgentHookEngine` 调度。其他 AI 应用的外部 Hook 目录（`external_hooks`）仍只用于只读发现，不得进入可执行 Registry。

## 架构

### 产品架构护栏

任何 `openbitfun-core` 拆解、feature 边界、依赖边界或 Rust 构建提速重构，
都必须先阅读
[`docs/architecture/product-architecture.md`](docs/architecture/product-architecture.md)。
顶层文档只作为入口；模块级 ownership 细节应放到离代码最近的模块 `AGENTS.md`。

仓库级拆解规则：

- 不要把 DTO / contract 抽取误判为 runtime owner 已迁移。
- 产品表面可以有差异；共享稳定 facts 或 ports，不共享 UI、protocol、lifecycle 或平台实现。
- 迁移 runtime owner 必须有评审过的 port/provider 设计、旧路径兼容、行为等价测试；如果可能改变行为边界，还需要先确认。

涉及 Agent Runtime 部署、多 GUI/TUI/Remote 实例、共享 Session 控制或进程拓扑时，还必须阅读
[`docs/architecture/agent-runtime-deployment-design.md`](docs/architecture/agent-runtime-deployment-design.md)。
Rust Runtime 或 Node/Bun Plugin Host 不得默认按 Client、workspace、session 或 plugin 分进程；进程边界必须来自真实状态
owner、execution/security domain、可兼容的安全条件和测量后的容量事实。

### CLI 产品线护栏

涉及 CLI/TUI 能力对齐、非交互输出契约、外部配置导入、插件管理体验、CLI Agent 行为或 CLI
白标发行时，先阅读
[`docs/architecture/cli-product-line-design.md`](docs/architecture/cli-product-line-design.md) 和
[`src/apps/cli/AGENTS.md`](src/apps/cli/AGENTS.md)。CLI/TUI 展示留在 app；可复用产品行为通过
Product Assembly、Agent Runtime、Tool/Harness、Runtime Services 或既有扩展边界承接。

### HarmonyOS PC CLI/TUI 护栏

涉及 HarmonyOS PC CLI/TUI 支持时，还必须阅读
[`docs/architecture/platform-portability-design.md`](docs/architecture/platform-portability-design.md)。
这是未来平台目标，不是已实现支持。目标是真实 PC 系统终端；HAP、`hdc shell`、
手机 Remote App 和远端代执行都不能替代。具体适配必须另立专题，现有移动端能力保持不变。

### 产品定制护栏

涉及产品定义、品牌发行、GUI/TUI 布局选择、产品内置扩展或定制构建任务时，先阅读
[`docs/architecture/product-customization-blueprint.md`](docs/architecture/product-customization-blueprint.md)。
产品定制必须与用户运行时配置和插件分开；GUI/TUI 只共享稳定产品事实，不共享布局、组件、主题键、键位、
renderer schema。产品组装结果和布局选择只能携带少量不可变的产品身份、数据隔离、故障恢复、升级完整性或
法律保护项 ID；不得承载用户/来源级插件策略、安装、激活、更新、权限或动态健康状态。Product Profile、
Brand Pack、GUI/TUI Surface Blueprint 和 Resolved Product Manifest 是已退役的设计术语，并非当前生产对象；
不得为这些术语新建兼容格式，只实现被真实构建和运行时消费的最小产品定义与组装结果字段。

涉及 OpenCode 实时配置或插件执行时，还要阅读
[`docs/architecture/extensions/opencode-extension-compatibility.md`](docs/architecture/extensions/opencode-extension-compatibility.md)。
在对应 OC-R 阶段实现并通过验证前，当前 P0 适配器仍只是受管包/静态预览路径。不得继续把旧受管包路径扩张为
OpenCode 目标运行模型，也不得把设计目标描述成已可用能力。

### SDLC 质量护栏

涉及生命周期证据、门禁、Artifact Graph、Project Profile、Deep Review 策略、
OpenCode 兼容或目标项目治理的变更，先阅读
[`docs/sdlc-harness/README.md`](docs/sdlc-harness/README.md)，再阅读
[`docs/sdlc-harness/design.md`](docs/sdlc-harness/design.md)。如果变更影响模块边界或行为，
继续参考 `docs/sdlc-harness/architecture/` 或 `docs/sdlc-harness/features/` 下的对应设计。

不要把 OpenBitFun 自身验证假设硬编码成目标项目通用规则；质量保护行为必须保持面向目标项目、
基于证据、按风险分级、成本可控并可审计。

## 验证

验证范围由 owner 决定，不在根文档维护全仓测试矩阵：

1. 阅读离改动最近的本地 `AGENTS.md`，运行能够覆盖该行为的最窄命令。
2. 优先选择单 package、单 test target 或 module filter，并使用最小 feature；不要把
   `product-full`、`all-features` 或 workspace 全量测试当成捷径。
3. 只有对应契约变化时才运行仓库级检查：布局/内容规则使用 repository hygiene，
   workflow 变更使用 GitHub config，Cargo feature、依赖方向或 test-target 布局使用 core boundaries。
4. 大范围 build、workspace suite、打包和平台矩阵默认交给现有 CI；只有改动影响这些路径或需要复现
   CI 故障时才在本地运行。

如果某个模块缺少有效的 focused 命令，应补充到该模块自己的指南，而不是继续扩张根文档。
不要预先对齐所有模块的 test 清单；只有真实开发流程需要时才记录命令。

## Agent 文档优先级

进入具体目录后，优先遵循离目标文件最近的 `AGENTS.md` / `AGENTS-CN.md`。如果局部文档与本文件冲突，以更具体、更近的文档为准。
