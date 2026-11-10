**中文** | [English](AGENTS.md)

# AGENTS-CN.md

OpenBitFun 由 Rust workspace 与 React 前端组成，通过多种宿主交付（Desktop/Tauri、CLI/TUI、server、mobile、mobile-web、installer）。

仓库核心原则：**先保持产品逻辑平台无关，再通过平台适配层对外暴露能力**。

## 规则在哪里

- 本文件维护仓库级规则。离改动文件最近的 `AGENTS.md` 负责局部边界、命令和 focused 验证；与本文件冲突时，以更近的指南为准。
- 提交与 PR 约定见 [`CONTRIBUTING_CN.md`](CONTRIBUTING_CN.md)。

## 分层

依赖方向自上而下：crate 可以依赖更低层，不得依赖更高层，同层依赖保持最小。各层指南列出该层的 crate 和确切允许的依赖边。下表是物理 crate 布局；概念架构（4+1 视图）见 [`docs/architecture/product-architecture.md`](docs/architecture/product-architecture.md)。

| # | 层级 | 路径 | 负责 | 不得 | 指南 |
|---|---|---|---|---|---|
| 1 | 接口与入口层 | `src/apps/*`, `src/web-ui`, `src/mobile-web`, `src/*-market-web`, `OpenBitFun-Installer`, `tests/e2e`, `src/crates/interfaces` | 产品宿主、命令、UI 入口、协议接口和跨形态测试 | 保留可复用行为；应下移 | 最近的本地 `AGENTS.md`；[interfaces](src/crates/interfaces/AGENTS.md) |
| 2 | 产品组装层 | `src/crates/assembly` | 兼容导出、产品能力选择、product-full 接线、不可变内置 Agent 内容、adapter/service 注册和生态无关的来源协调 | 实现具体 adapter、OS 或 service 细节 | [AGENTS.md](src/crates/assembly/AGENTS.md) |
| 3 | 适配层 | `src/crates/adapters` | 协议、transport、本地 IPC、WebDriver、AI provider 和外部 AI work source 的 adapter；外部 provider 转换 | 拥有产品能力选择或可复用 OS service 行为 | [AGENTS.md](src/crates/adapters/AGENTS.md) |
| 4 | 服务实现层 | `src/crates/services` | 可复用的 OS、filesystem、terminal、MCP、remote、git、watch、process、network、session persistence 和 MiniApp runtime IO 实现 | 拥有协议/transport 投影或产品能力选择 | [AGENTS.md](src/crates/services/AGENTS.md) |
| 5 | 执行原语层 | `src/crates/execution` | 可移植 Agent Runtime、命名工作流策略、stream、插件运行时客户端、typed-service、tool-contract、tool-group 和 tool-execution 构件 | 拥有宿主专属或交付形态行为 | [AGENTS.md](src/crates/execution/AGENTS.md) |
| 6 | 稳定契约与产品领域层 | `src/crates/contracts` | 跨层共享 DTO、事件形状、runtime port、产品领域契约和策略 | 承载运行时行为或向上依赖 | [AGENTS.md](src/crates/contracts/AGENTS.md) |

- 产品特性只组装用户侧命令、UI contribution、设置和默认策略。长程任务、scheduler、permission、session/workspace、memory、DFX、hook 和 event 事实留在各自既有的 owner。
- 外部系统是边界资源，不是层级。只有已注册的 adapter、service 或 app-local provider 可以调用它们；其他代码消费 port 和稳定契约。

## 命令

```bash
pnpm install
pnpm run desktop:dev               # 主要开发循环：Vite HMR + Rust 自动重编译并重启
pnpm run fmt:rs                    # 修改 Rust 后运行；只格式化已改动 / 已暂存的 .rs 文件
pnpm run check:repo-hygiene        # 仓库内容与文件名规则
pnpm run check:github-config       # GitHub workflow / 配置规则
pnpm run check:core-boundaries     # Cargo feature、依赖方向、模块 owner
```

只有明确需要更大范围格式化时才使用 `cargo fmt`。各 surface、打包及 focused test 命令见最近的指南；完整脚本注册表见 [`package.json`](package.json)。

## 验证

验证范围由 owner 决定，不使用全仓测试矩阵：

1. 运行最近的 `AGENTS.md` 中能覆盖该行为的最窄命令。
2. 优先选择单 package、单 test target 或 module filter，并使用最小 feature。不要把 `product-full`、`all-features` 或 workspace 全量测试当成捷径。
3. 只有对应契约变化时才运行仓库级检查：布局/内容规则用 `check:repo-hygiene`，workflow 用 `check:github-config`，Cargo feature、依赖方向或 test-target 布局用 `check:core-boundaries`。
4. 大范围 build、workspace suite、打包和平台矩阵交给 CI，除非改动影响这些路径或需要复现 CI 故障。

## 每次改动都适用的规则

### 修复 bug

修改 bug 相关代码前，只检查相关的本地代码和本地 Git 历史中是否已有修复，并结合已知的反馈版本和复现条件判断。开始前先说明检查结论。若已有修复，给出对应的代码或提交依据，不要重复实现。

### 平台边界

- UI 组件不直接调用 Tauri API；通过 adapter / infrastructure 层访问。
- 桌面端专属宿主 adapter 放在 `src/apps/desktop`，经类型化能力接口回流；需要事件投递时使用生产 transport adapter。
- 共享 core 避免使用 `tauri::AppHandle` 等宿主专属 API；使用 `openbitfun_events::EventEmitter` 等共享抽象。

### Tauri command

command 名称使用 `snake_case`，并接收一个结构化 `request`。TypeScript 包装可以使用 `camelCase`。

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

### 非交互子进程

- 可能运行在 GUI、无界面、后台或重定向宿主下的非交互子进程（包括可被其他宿主调用的 CLI 模式），不得直接使用裸 `std::process::Command` 或 `tokio::process::Command`。使用 `openbitfun_services_core::process_manager::{create_command, create_tokio_command}` 或该层既有的 facade。
- 确实无法避免直接创建命令时，Windows 代码必须显式设置 `CREATE_NO_WINDOW`，Node 子进程必须设置 `windowsHide: true`。
- 测试 fixture 遵循同样的策略，避免测试时闪现控制台窗口。

### Rust 依赖

- `[workspace.dependencies]` 只统一兼容版本，不提供宽泛的能力并集。每个 crate 只选择自身实际使用的 feature，仅测试所需的 feature 放入 `[dev-dependencies]`，受 feature 控制的服务能力挂在所属 crate 的 feature 上。
- 第三方依赖的默认 feature 若不是所有 consumer 的契约，在 `[workspace.dependencies]` 统一关闭；成员继承该策略，只增加自身需要的切片。
- 仓内 crate 的受保护 `default` 为空时，不在每条依赖边重复写 `default-features = false`。ACP 这类有意保留兼容默认的 crate，窄 consumer 仍需显式关闭。
- 被复制到独立 Docker 构建上下文的 manifest 无法继承 workspace 根，必须保留显式版本和默认策略。
- 根 workspace 和 workspace 成员禁止使用 `tokio/full`。
- 细则见 [`docs/architecture/rust-build-dependency-boundaries.md`](docs/architecture/rust-build-dependency-boundaries.md)。修改 manifest 后用 `pnpm run check:core-boundaries` 验证。

### 日志

日志只用英文，且不使用 emoji。前端：[`src/web-ui/LOGGING.md`](src/web-ui/LOGGING.md)。后端：[`src/crates/LOGGING.md`](src/crates/LOGGING.md)。

### 国际化

- `src/shared/i18n/contract/locales.json` 统一管理 locale id、alias、fallback 规则和各形态默认语言。修改后运行 `pnpm run i18n:generate`。
- 跨形态稳定标签放在 `src/shared/i18n/resources/shared/<locale>/terms.json`；流程文案留在所属产品形态。
- 任何形态都不得导入其他形态的 locale catalog。`src/mobile-web`、`OpenBitFun-Installer` 和静态页面不得导入 Web UI locale 资源；静态自包含页面使用生成的 page-scoped shared-term 文件。
- 用户可见的日期、时间和数字使用共享 i18n 格式化 helper，不直接调用 `Intl.*` 或 `toLocale*`。
- 修改 locale 资源或用户可见文案后运行 `pnpm run i18n:audit`。它检查 key / 占位符一致性、静态与动态 key 证明，以及 literal fallback、直接 locale 格式化和源码硬编码 CJK 文案的零增长基线。
- 细则见 [`docs/architecture/i18n.md`](docs/architecture/i18n.md)。

### 主题与颜色 Token

- 主题与颜色 baseline（`scripts/theme-color-governance-baseline*.json`）是 ratchet 契约，不是可随意修改的测试期望。不得通过提高 baseline、放宽 fixture/assertion 数量、增加宽泛 allowlist 或移除 CI 审计来让失败的审计通过。
- 实际债务减少时同步下调 baseline。确需新增颜色或 key 时，只增加最小 owner contract，并说明现有 semantic、component 或专用域 Token 为什么不能覆盖。
- 修改 theme、CSS variable、widget payload、mobile、installer 或 CLI/TUI 颜色后，运行 `pnpm run theme:color-audit:all`。
- 细则见 [`docs/architecture/theme-token-optimization.md`](docs/architecture/theme-token-optimization.md)。

### Agent loop

不要把硬编码限制或模式判断作为处理 agent loop 循环问题的第一反应，例如仅按字符串或次数阻止重复工具调用；这会把 agent loop 变成脆弱的 workflow 引擎。应先定位根因：工具行为、模型交互、会话上下文封装、prompt/tool schema 设计，或状态同步问题。

### 文档与流程产物

- 不要新增或更新 `docs/superpowers/**` 下的文件；`pnpm run check:repo-hygiene` 会拒绝它们。
- 临时计划、设计和实现过程文档仅保留在本地。需要长期维护的架构或功能事实合并到对应的已有文档，用户使用说明放到所属应用的 README。

## 远程场景

工作区、执行这一轮的 runtime、以及正在操作的人，可能分别位于不同机器。下面四种场景是每次改动都要一并覆盖的一等目标，不是事后再补的适配。

| 场景 | 含义 | 设计入口 |
|---|---|---|
| 远程工作区 | 当前工作区位于 SSH 主机、跳板机链路或 Docker 容器；文件、终端、搜索和 Agent 子进程都必须在那一侧执行 | [remote-workspace-transport.md](docs/architecture/remote-workspace-transport.md)、[remote-workspaces.md](docs/features/remote-workspaces.md) |
| 远程控制 | 手机端 mobile web，或飞书 / Telegram / 微信 Bot，通过 Remote Connect relay 驱动 Desktop 或 CLI 宿主上的会话 | [`src/mobile-web`](src/mobile-web/AGENTS.md)、[services-integrations](src/crates/services/services-integrations/AGENTS.md) 的 `remote_connect`、[relay-service](src/crates/services/relay-service/AGENTS.md) |
| 多端互控（Peer Device Mode） | 同账号的一台设备成为另一台的数据平面：控制端外壳仍在本地，invoke 和事件来自 peer | [peer-device-mode.md](docs/architecture/peer-device-mode.md)、[peer-device README](src/web-ui/src/infrastructure/peer-device/README.md) |
| Dispatch 分离任务 | 控制端把持久化任务提交到另一台 OpenBitFun 宿主后即可断开；目标端拥有 job、session、worktree、事件日志和权限信箱 | [detached-task-dispatch.md](docs/architecture/detached-task-dispatch.md) |

四种场景共同适用的规则：

- **远程路径要和功能一起设计。** 默认 UI、进程和文件系统在同一台机器上的能力属于未完成，而不是“第一阶段”。
- **不支持要显式暴露。** 无法支持某个场景时，屏蔽入口或返回明确的不支持状态。静默回落本地、假成功、空载荷和通用错误都算回归；回落本地还会把本地内容泄露给远端控制方。
- **阻塞式交互必须可以远程应答。** 新增的权限确认、对话框和选择器都要经既有的 dialog / 权限信箱编排送达当前操作端。只能靠桌面窗口解除的阻塞会让远程控制和 Dispatch 任务死锁。
- **要能扛断线。** 远程形态会重连、按 cursor 重放并重新 hydrate；优先使用可恢复 cursor 和幂等变更，不要依赖“客户端恰好在线”才存在的状态。
- **远程工作区路径在任何客户端 OS 上都是 POSIX 路径。** 不得用宿主 `std::path` 语义切分或拼接，也不得把控制端的路径直接拿到 peer 宿主上复用。

各场景的具体约束：

- **远程工作区**：每个桌面端 Tauri 命令在 Product Operation Registry（[`remote_surface/table.rs`](src/crates/contracts/product-domains/src/remote_surface/table.rs)）中有且只有一行，声明其远程工作区立场。桌面端闭包测试与能力生成器会拒绝没有对应行的命令，新行不得使用 `Unaudited`（该存量清单只减不增）。修改该表后运行 `pnpm run capabilities:generate`。见 [remote-surface-contract.md](docs/architecture/remote-surface-contract.md)。
- **远程控制**：mobile web 和 IM Bot 通过 `RemoteCommand` wire 协议和 bot command router / menu 触达会话，不走 Web UI。新增或迁移会话级能力时（工作区或助手选择、会话生命周期、模式、模型、审批、附件），要同步扩展这些形态，或让它们给出明确的不支持回复。
- **多端互控**：产品命令默认代理到 peer 执行。必须留在控制端的命令（窗口装饰、更新器、账号身份、本地 OS 自动化）在同一注册表行中声明为 `ControllerLocal`；桌面端 peer host、CLI peer host 和 Web UI transport adapter 都从它派生拒绝集合，`pnpm run check:core-boundaries` 会拒绝手写清单。CLI host 要执行的命令需要处理分支加行内 `cli_peer: HANDLED`；`src/apps/cli/src/peer_host/commands/mod.rs` 的闭包测试保持两者一致。Peer 能力是类型化的 `PeerHostCapability`，由注册表发布。改动 session、account 或 hydrate 路径前，先读 peer-device README 的 invariants。
- **Dispatch 分离任务**：任务在目标端以 CLI delivery profile 无界面运行，没有交互宿主，也不保证控制端在线。控制端只是观察者，不是 runtime 或文件系统代理。不要引入依赖提交方常驻的行为。dispatch 协议版本和目标端必备 capability 属于兼容契约：新的目标端要求要走协商 capability，而不是默认假设。

说明改动在哪些远程场景下验证过。只跑本地测试不能作为远程行为的证据。

## 升级兼容性

用户是原地升级的，而上述远程场景经常让两个不同版本的 OpenBitFun 连在同一条链路上。任何改动都必须保证已有安装无需手工修复即可继续工作。

- **落盘结构会被新旧两侧代码同时读取。** 对配置、设置、会话、连接配置、worktree 和 dispatch 记录：新增字段要带默认值，反序列化保持容错，绝不重新定义或收窄已落盘字段的语义，也绝不把旧数据给不出的字段变成必填。
- **不要用删除或重置用户数据的方式来“恢复”解析不了的内容。** 保留记录、降级功能并给出明确状态。凭证缺失、配置读不出、超时或主机离线，都不构成丢弃会话、工作区或连接的理由。销毁性删除只能是用户的显式操作。
- **跨版本边界要协商，不能假设。** Peer HostInvoke、dispatch 协议、relay 与 mobile web、IM Bot，对面都是你控制不了的构建版本。先声明 capability 并在使用前检查（包版本相同不等于行为相同），并让旧版本一侧留在可用路径上，而不是直接判失败。
- **改名就是一次迁移。** 在所有受支持的对端都不可能再发送旧名称、旧 id 或旧结构之前，必须继续兼容读取；被改名对象所引用的数据（vault 条目、工作区指针）要一并迁移。
- **用测试证明。** 覆盖旧数据反序列化和旧载荷往返，而不只是新结构。只验证当前代码自己写出的数据，不算升级兼容性覆盖。

## 修改前必读

在下列范围修改前，先阅读所列文档。子项是硬性约束。

- **`openbitfun-core` 拆解、feature 或依赖边界、Rust 构建提速**：[`docs/architecture/product-architecture.md`](docs/architecture/product-architecture.md) 和 [`docs/architecture/rust-build-dependency-boundaries.md`](docs/architecture/rust-build-dependency-boundaries.md)。
  - 不要把 DTO / contract 抽取误判为 runtime owner 已迁移。
  - 产品表面可以有差异；共享稳定 facts 或 ports，不共享 UI、protocol、lifecycle 或平台实现。
  - 迁移 runtime owner 必须有评审过的 port/provider 设计、旧路径兼容、行为等价测试；可能改变行为边界时还需要明确确认。
- **Agent Runtime 部署、多 GUI/TUI/Remote 实例、共享 Session 控制、进程拓扑**：[`docs/architecture/agent-runtime-deployment-design.md`](docs/architecture/agent-runtime-deployment-design.md)。
  - Rust Runtime 或 Node/Bun Plugin Host 不得默认按 client、workspace、session 或 plugin 分进程；依据负责的状态模块、执行与安全条件以及测量后的容量来决定。
- **CLI/TUI 能力对齐、非交互输出契约、外部配置导入、插件管理体验、CLI Agent 行为、CLI 白标发行**：[`docs/architecture/cli-product-line-design.md`](docs/architecture/cli-product-line-design.md) 和 [`src/apps/cli/AGENTS.md`](src/apps/cli/AGENTS.md)。
  - CLI/TUI 展示留在 app；可复用产品行为通过 Product Assembly、Agent Runtime、Tool/Harness、Runtime Services 或既有扩展边界承接。
- **HarmonyOS PC CLI/TUI**：[`docs/architecture/platform-portability-design.md`](docs/architecture/platform-portability-design.md)。
  - 这是未来平台目标，不是已实现支持。产品目标是真实 PC 系统终端；HAP、`hdc shell`、手机 Remote App 和远端代执行都不能替代。每项具体适配另立专题设计，现有移动端能力保持不变。
- **产品定义、品牌发行、GUI/TUI 布局选择、产品内置扩展、定制构建任务**：[`docs/architecture/product-customization-blueprint.md`](docs/architecture/product-customization-blueprint.md)。
  - 产品定制与用户运行时配置和插件分开。GUI 和 TUI 可以共享稳定产品事实，但不共享布局、组件、主题键、键位或 renderer schema。
  - 产品组装结果和布局选择可以携带少量不可变的产品身份、数据隔离、故障恢复、升级完整性或法律保护项 ID。不得承载用户/来源级插件策略、安装、激活、更新、权限或动态健康状态。
  - Product Profile、Brand Pack、GUI/TUI Surface Blueprint 和 Resolved Product Manifest 是已退役的设计术语，不是生产对象。不要为它们新建兼容格式；只实现被真实构建和运行时消费方使用的最小产品定义与组装结果字段。
- **OpenCode 实时配置或插件执行**：[`docs/architecture/extensions/opencode-extension-compatibility.md`](docs/architecture/extensions/opencode-extension-compatibility.md) 和 [`src/crates/adapters/opencode-adapter/AGENTS.md`](src/crates/adapters/opencode-adapter/AGENTS.md)。
  - 兼容矩阵描述的是目标与差距；不要把设计目标当成已可用能力。
  - 不要把旧受管包路径（P0 静态预览入口）扩张为 OpenCode 目标运行模型。
- **Agent Hooks**：[`docs/features/agent-hooks.zh-CN.md`](docs/features/agent-hooks.zh-CN.md)（[English](docs/features/agent-hooks.md)）。
  - 原生用户 Hooks 实现 Codex Hook 契约，因此 <https://learn.chatgpt.com/docs/hooks> 是事件、载荷字段与决策结构的参考来源。不要另起炉灶。功能文档只覆盖 OpenBitFun 特有部分（文件位置、`app.hooks` 开关和差异表），新增或消除差异时必须同步更新。
  - 引擎、Registry、Hook 来源与分发的归属见 [`agent-runtime`](src/crates/execution/agent-runtime/AGENTS.md) 和 [`core`](src/crates/assembly/core/AGENTS.md) 指南。
- **生命周期证据、门禁、Artifact Graph、Project Profile、Deep Review 策略、OpenCode 兼容、目标项目治理**：先读 [`docs/sdlc-harness/README.md`](docs/sdlc-harness/README.md)，再读 [`docs/sdlc-harness/design.md`](docs/sdlc-harness/design.md)。变更影响模块边界或行为时，继续遵循 `docs/sdlc-harness/architecture/` 或 `docs/sdlc-harness/features/` 下的对应设计。
  - 不要把 OpenBitFun 仓库自身的假设硬编码成目标项目规则；质量保护行为保持面向目标项目、基于证据、按风险分级、成本可控并可审计。

## 维护这些指南

- 本文件只保留跨模块规则和稳定的仓库级入口。模块 ownership 细节、surface 或 crate 专属命令和 focused test 清单属于最近的指南；只有真实开发流程需要时才在那里补充命令。
- crate 清单由各层指南维护；不要在这里枚举 crate。
- `AGENTS.md` 与 `AGENTS-CN.md` 在同一次改动中同步更新。
