# Agent Runtime 部署与多实例边界

本文定义 Desktop、TUI、Headless CLI、Agent SDK 与本机控制端并存时，OpenBitFun Agent Runtime 的部署、所有权和隔离边界。

Agent Runtime 的模块职责见 [`agent-runtime-services-design.md`](agent-runtime-services-design.md)，公开 SDK 见
[`agent-sdk-product-architecture.md`](agent-sdk-product-architecture.md)，第三方 JS/TS 进程见
[`extensions/plugin-runtime-design.md`](extensions/plugin-runtime-design.md)。Rich Client 的 Embedded direct-runtime 决策、App Server 协议
和 Shared transport 提案见 [`app-server-architecture.md`](app-server-architecture.md)。Embedded interactive TUI 已完成 direct-runtime
迁移；Shared transport 未通过独立评审前继续使用 v18。

SSH/容器工作区保留轻量 SSH 部署：同一 Agent Runtime 和会话状态仍由 OpenBitFun 主机持有，
只在工作区文件与进程 I/O 边界选择本地或 SSH provider，不要求目标安装 OpenBitFun CLI 或 daemon。
具体收敛范围和验收见
[`remote-workspace-transport.md`](remote-workspace-transport.md#agent-runtime-convergence)。
共用主循环仍不代表所有工具、快照与本地行为已经等价，完成状态以实际接线和测试为准。

## 1. 决策与当前状态

OpenBitFun 只有一套 Agent Runtime 行为。`Embedded` 和 `Shared` 只描述同一套 Runtime 的物理部署方式，不是两套实现。

### 1.1 Current request paths

```mermaid
flowchart TB
  Desktop["Desktop GUI"] --> DesktopAdapter["Desktop / Tauri adapter"]
  Web["Web UI"] --> WebAS["loopback WebSocket App Server"]
  TUI["Interactive TUI"] --> RuntimeClient["CliAgentRuntimeClient"]
  RuntimeClient -->|"Embedded current"| API
  RuntimeClient -->|"--shared"| SharedIPC["private Runtime IPC v18"]
  TUI --> OwnerApis["existing owner/service APIs"]
  OwnerApis --> DomainOwners["existing owners / services"]
  Other["Headless CLI · ACP · Peer Host · SDK Host"] --> Adapter["独立 first-party adapters"]
  DesktopAdapter --> API["Agent Runtime API / owner ports"]
  WebAS --> API
  SharedIPC --> API
  Adapter --> API
  API --> Coordinator["ConversationCoordinator"]
  Coordinator --> Owners["Session / Tool / Permission / MCP owners"]
```

Server bootstrap 是 composition root，不是客户端请求的第二条 Runtime 旁路：

```mermaid
flowchart LR
  Bootstrap["Server bootstrap / product assembly"] -. "constructs" .-> Host["transport + OpenBitFunAppServer"]
  Bootstrap -. "constructs" .-> Runtime["Embedded Runtime / owners"]
  Runtime -. "injects Runtime API and owner ports" .-> Host
```

Current 图只表示已经接线的业务请求路径；下方 composition 图中的虚线只表示启动期构造与依赖注入。

### 1.2 Delivered Embedded composition

```mermaid
flowchart TB
  TUI["Embedded interactive TUI"] --> RuntimeClient["CliAgentRuntimeClient"]
  RuntimeClient --> API["Agent Runtime API / owner ports"]
  TUI --> OwnerApis["existing owner/service APIs"]
  OwnerApis --> DomainOwners["existing owners / services"]
  API --> Owners["Session / Tool / Permission / MCP owners"]
```

这是当前已交付的 Phase 5 Embedded direct-runtime composition。它不改变 Desktop GUI 的独立迁移状态，也不把 Shared v18 替换为 App Server。

### 1.3 Optional Shared App Server proposal

```mermaid
flowchart LR
  C1["Shared Rich Client 1"] --> Transport["candidate private Pipe / UDS"]
  C2["Shared Rich Client 2"] --> Transport
  Transport --> Host["Shared App Server Host"]
  Host --> Runtime["one Agent Runtime owner"]
  Runtime --> Storage["Workspace / Session storage"]
```

这是 Phase 6 的待评审提案，不是当前 Shared TUI 的必经链路，也不改变 Current 图中的 private Runtime IPC v18。只有完成连接治理、安全、恢复、取消、限制、性能和回滚门槛后，才可评审是否替换 v18；评审也可以决定长期保留 v18。

### 1.4 Current implementation facts

| 范围 | 当前状态 |
|---|---|
| Embedded Desktop GUI | 当前继续使用 Desktop 事件投影和 Tauri adapter；按实际打开的本机 workspace 延迟取得并持有 Embedded ownership，不增加后台进程；Embedded direct Runtime 是后续 Host/infrastructure 目标，不在此处宣称已接线 |
| MiniApp 本机独立窗口 | `apps/miniapp-shell` 是单独构建的窗口进程，不链接 Desktop、Core 或 Agent Runtime；通过 `adapters/miniapp-ipc` 的私有 v1 UDS/Named Pipe 使用同一 Desktop host 的实例、Agent、存储、任务与权限 owner。主界面未启动时可后台启动 Desktop host，但不会按 MiniApp 复制 Runtime。窗口／标签页切换期间保留实例，最后一个已提交或待就绪视图关闭后停止该 MiniApp 的 Worker、Agent 和流；断连、刷新或切换设备不等于显式关闭。这不是 Shared TUI v18 或通用 Shared App Server，远程四种场景不提供本机窗口回退 |
| Embedded interactive TUI | 当前直接通过 `CliAgentRuntimeClient` 调用 `AgentRuntime` typed API，并直接调用对应 owner/service API；不创建 App Server client/server、in-memory transport、JSON-RPC handshake 或 App Server 线程 |
| Embedded Headless CLI/Peer Host | 保留各自独立 Runtime adapter、展示和断流策略；不因交互式 TUI 迁移而强制使用 App Server |
| ACP/SDK Host | 使用同一个 Runtime 事件入口的 session-scoped 订阅；各自协议和进程生命周期保持独立 |
| Runtime ownership | Desktop、CLI、ACP、SDK Host 和现有 Server agent bootstrap 共用 Core owner；Embedded 取得共享锁，Shared TUI 取得独占锁，同一 workspace 上两种 deployment 互斥 |
| Session 写入 | OpenBitFun Runtime 的持久化 Session 由 `SessionManager` 管理；同一存储位置中的同一 Session 同时只允许一个本机进程写入，list/view 等只读操作不受影响 |
| 当前 HTTP Server | 已组装 Embedded Runtime 和 `OpenBitFunAppServer`，每个 `/ws` 连接通过 WebSocket transport 运行一条 App Server connection；当前固定 loopback、单用户且缺少连接级身份与作用域绑定，不构成远程或多用户 Server API |
| Shared local IPC | 未发布的 v18 本机协议已有 discovery、实例锁、严格握手、Session 控制权、有界事件流和 cleanup；唯一 consumer 是第一方交互式 TUI compatibility adapter；是否由 Shared App Server 替换仍待评审与等价证据 |
| Shared TUI | `openbitfun --shared` / `openbitfun chat --shared` 可列出、创建、恢复 Session，删除未被控制的空闲非当前 Session，通过 `/fork` 从完整历史或选中提示词之前创建分支，重命名当前 Session，读取 transcript，通过 **View subagents** 只读查看当前根 Session 的子会话并定向取消子会话活动 Turn，切换当前 Session 的 Agent mode/model，通过 `/reload [skills|instructions]` 刷新声明式上下文，通过 `/compact` 或 `/summarize` 压缩当前 Session 上下文，在 Turn 空闲时通过 `/diff` 读取 Runtime 绑定工作区的只读差异，提交/取消 Turn，处理 Permission 和 UserInput；Runtime 行为由 `CliAgentRuntimeClient` 的 Shared backend 映射 v18；Model、Skill、Subagent、MCP、External Source、Hook 和 Worktree 等 Host-local 能力由当前 CLI 进程直接调用对应 owner/service 提供。Account/Settings Sync 和后续 External Application V2 未由当前 Shared Host 提供并返回 typed unsupported；Remote workspace scope 下的 controller-local owner/service 调用明确拒绝执行 |
| Shared GUI/Headless/ACP/SDK Host/Remote | 未交付，也不会由 `--shared` 隐式启用；Replay、Observer、通用 Controller transfer 和 Session archive 同样不在当前协议中 |

因此当前交付的是 Embedded TUI direct Runtime composition 与一条窄的、显式启用的 Shared TUI compatibility deployment；
前者不再经过或启动 App Server，后者仍不是通用本机 Server。
具体 `EventQueue` 仍由 Core 产品装配；当前 Shared IPC 只把 TUI 必需的强类型操作和事件映射到同一个 Runtime owner，
没有公开协议承诺。是否以 App Server Shared transport 替换并删除它，由行为等价、性能、安全和回滚证据决定。

## 2. 最少名词

| 名词 | 唯一含义 | 不等于 |
|---|---|---|
| Agent Runtime | 负责 Session、Turn、Tool、MCP、Permission、Hook、事件和持久化行为的既有模块 | 进程名、Server 或 SDK |
| Embedded deployment | Runtime 与调用入口位于同一 Rust 进程 | 简化版 Runtime |
| Shared deployment | 同一 Runtime 由一个本机进程承载，多个第一方 Client 通过私有 IPC 使用 | 新 Runtime、公开 Server 或 Agent SDK |
| Embedded direct Runtime | Host 通过稳定 Rust typed facade 调用同进程 Runtime owner | 第二套 Runtime、Core singleton 直连或 App Server wire |
| Embedded App Server | 已删除的迁移前基线：同进程 App Server 实例和 in-memory transport | 当前 Embedded 路径、后台进程或网络 Server；不得恢复为 rollback adapter |
| Shared App Server | 独立本机 Host 承载、由多个已认证 Rich Client 通过受控 transport 使用的 App Server | 公网 API 或每个 Client 一个 Runtime |
| Agent SDK Host | 将公开 SDK 合同映射到 Runtime API 的私有进程/adapter | CLI、Shared deployment 或 Plugin Host |
| Plugin Host | 运行 Node/Bun 和第三方插件代码的受监督子进程 | Agent Runtime 或 Rust IPC client |

`Host` 只表示“一个进程承载某些模块”的内部关系，不新增普通用户必须理解或管理的产品入口。

## 3. Logical View · Level 1

```mermaid
flowchart TB
  subgraph "逻辑层：始终只有一套"
    API["Agent Runtime API"] --> Session["Session / Turn"]
    API --> Permission["Permission"]
    API --> Tool["Tool / MCP"]
    API --> Events["Authoritative events"]
  end

  Desktop["Desktop GUI"] --> DesktopAdapter["Desktop / Tauri adapter"]
  Web["Web UI"] --> AppServer["loopback WebSocket App Server"]
  EmbeddedTUI["Embedded TUI"] --> RuntimeClient["CliAgentRuntimeClient"]
  RuntimeClient --> API
  EmbeddedTUI --> OwnerApis["existing owner/service APIs"]
  OwnerApis --> DomainOwners["existing owners / services"]
  DesktopAdapter --> API
  AppServer --> API
  SharedCompat["Shared Runtime IPC · temporary compatibility"] --> API
  Headless["Headless / ACP adapters"] --> API
  SDK["SDK Host adapter"] --> API
  Remote["Remote adapter"] --> API
```

当前复用的是 Runtime API、权威事实和 owner；Web 额外使用 App Server wire，Embedded TUI
使用 direct Runtime adapter，Shared TUI 的共同 Runtime 行为使用
private v18。TUI 管理面由 controller 直接调用现有 owner/service API，不随 Runtime
port 进入 Shared wire。各入口不复用 renderer、CLI 参数、SDK wire、远程认证或平台窗口生命周期。
任何新能力必须先进入既有 Runtime 或 owner service，再由 App Server、direct adapter 或其他独立
adapter 映射，禁止在 Embedded、Shared 或其他入口复制业务实现。

### 3.1 Embedded 事件交付

```mermaid
flowchart LR
  Queue["EventQueue"] --> Owner["Core product event queue owner"]
  Owner -->|"injects read-only AgentEventSource"| Runtime["Agent Runtime API"]
  Runtime --> AppServer["App Server · Web/Shared when needed"]
  Runtime --> Direct["Embedded direct Runtime adapter"]
  AppServer --> TUI["Rich Client connection"]
  Direct --> TUIEmbedded["Embedded TUI client"]
  AppServer --> GUI["Desktop/Web client"]
  Runtime --> Exec["Headless adapter"]
  Runtime --> Peer["Peer fanout adapter"]
  Runtime --> ACP["ACP adapter"]
  Runtime --> SDK["SDK Host adapter"]
```

- Core product assembly 创建事件 source，并维持旧消费队列的排空 task；第一方产品入口不再获得第二个订阅 API。
- App Server server 从注入的 `AgentEventSource` 转发需要连接边界的 Rich Client 权威事件；这些 client 不得绕过 App Server 订阅 Core `EventQueue`。
- `CliAgentRuntimeClient` 的 Embedded backend 通过 `AgentRuntime` 提供的 typed event/Permission subscription 直接订阅同一 Runtime owner；它不得创建第二个 Core `EventQueue` owner 或把 Runtime 内部 receiver 暴露给 TUI controller。
- Headless CLI、Peer Host、ACP 和 SDK Host 从各自独立 Runtime adapter 订阅，不能直接持有 Core-specific event source。
- `openbitfun-core` 的旧 event-source/builder API 仅保留为 deprecated 源码兼容 facade；它们委托给同一个 Core owner，不形成第二套运行时或第一方调用路径。
- Desktop Rich Surface 的 Tauri delivery adapter、CLI Peer Host 的 DeviceEvent adapter 与各自窄 `AgentRuntime` facade 共享一个 Runtime-host-owned `SessionEventJournal`。事件在 host 排序/合并边界后写入，按 Session 获得单调 cursor，并通过 `restore_session_view.runtimeEventSnapshot` 提供当前 Turn 的物化 attach state；CLI 仍先执行 Peer-owned-Turn 边界。客户端用 Runtime-process `streamId` + cursor 对 snapshot 与并发 live events 做 fence。该合同只补足同一 Desktop/Peer Host 上 Rich Surface 的重挂载，不把 App Server 或 Shared Runtime IPC 宣称为已有跨连接 replay。
- 各 adapter 继续拥有自己的失败投影：TUI 标记当前视图不可信，Headless CLI 返回非成功终态，Peer Host 中断其拥有的 turns，ACP 取消 turn 并返回协议错误，SDK Host 终结 Query 并提供 `RestartHost` recovery。
- 当前 App Server 为每条 connection/stream 发送单调 sequence 和 connection-local cursor；`app/syncEvents` 返回当前连接的 cursor
  与 pending Permission snapshot，`session/sync` 恢复 Session state、transcript、workspace binding 和 pending Permission。它没有跨连接
  持久化 replay/resume：重连后的旧 cursor 不能继续消费，client 必须重新 initialize 并执行权威 sync。
- Shared Runtime IPC v18 不复用 App Server cursor。它按自己的有界队列规则处理 lag/closed：Agent 流失效后 fail closed；Permission lag
  尝试从 Runtime 的 pending 集合重建，重建失败或流关闭时取消当前 Turn 并退出。任何路径都不能把流失效伪装成透明恢复。
- 旧 Embedded App Server 链路已删除；当前 direct-runtime 路径不包含 private in-memory transport、App Server task/thread 或 JSON-RPC 编解码，也不增加 SDK Host、跨进程 IPC 或后台进程依赖。

## 4. Process View · Level 1

### 4.1 Runtime ownership

ownership 分成“产品决策”和“文件锁原语”两层；入口不再各自拼 key、目录或锁模式：

```mermaid
flowchart TB
  Entrypoints["Desktop · CLI · ACP · SDK Host · Server bootstrap"]
  Entrypoints --> Core["CoreRuntimeOwnership<br/>deployment · product identity · process-held lock"]
  Core --> Primitive["services-core::runtime_ownership<br/>canonical key · RAII file lock"]
  Primitive --> E["Embedded · shared lock"]
  Primitive --> S["Shared · exclusive lock"]
```

```mermaid
flowchart TD
  Op["Session operation"] --> Read{"read-only view/list?"}
  Read -->|"yes"| NoLock["不取得 ownership"]
  Read -->|"no · attach/mutate/turn"| Remote{"structured remote facts?"}
  Remote -->|"yes"| RemoteHost["由目标 execution host 负责"]
  Remote -->|"no"| Gate["Coordinator → CoreRuntimeOwnership"]
  Gate --> Lock["按 canonical workspace 持有文件锁"]
```

| 场景 | 行为 | 原因 |
|---|---|---|
| 多个 Embedded 进程访问同一 workspace | 共享锁允许并存 | 保持单实例、CI 和隔离测试的既有成本模型 |
| Shared 与任一 Embedded 访问同一 workspace | 后启动者返回稳定错误码和启动建议 | 防止同一 workspace 同时存在两种 Runtime deployment |
| Desktop 打开多个 workspace | 首次 attach/write 时逐个取得并持有文件锁 | 不把窗口数、Session 数等同于 Runtime 进程数 |
| 只读 list/view | 不加锁 | ownership 只管理 Runtime deployment，不扩大成读取权限 |
| 已解析且带有效 `connection_id` 的 remote workspace | 本机不加锁 | 与 Session storage 的远端判据一致；`host` 提示本身不能绕过本地锁 |
| 当前 loopback HTTP Server | 通过 server bootstrap 创建 Embedded Core owner | 只覆盖 Server Host 实际打开的本机 workspace；不因存在 WebSocket route 扩大为远程或多用户 ownership |

`CoreRuntimeOwnership` 只选择 deployment、产品 identity 并在进程存活期间持有锁；`services-core` 只负责 canonical key 和跨进程锁。二者都不选择 workspace、不启动 Runtime，也不替代 Session 单写、数据库事务、文件冲突控制或安全沙箱。

### 4.2 Session 单写

workspace 可以被多个 Embedded 进程同时打开，但持久化 Session 不能被多个进程同时写入。保护粒度是“实际 Session 存储位置 + Session ID”，不是窗口、TUI 实例或 workspace。

```mermaid
flowchart LR
  subgraph W["同一 workspace"]
    A["Session A"]
    B["Session B"]
  end

  GUI["GUI 进程"] -->|"写入"| A
  TUI["TUI 进程"] -->|"写入"| B
  CLI["另一个 CLI 进程"] -.->|"写入 A：session_in_use"| A
  View["任意入口的 list / view"] -.->|"只读"| A
  View -.->|"只读"| B
```

OpenBitFun Runtime Session 只有 `SessionManager` 决定何时开始和结束写入；底层持久化方法复用同一文件锁，不再实现第二套判断。各产品入口只投影同一个 `session_in_use` 事实，不重新判断锁状态：

| 入口 | 冲突呈现 | 恢复方式 |
|---|---|---|
| Agent SDK / OpenBitFun ACP | 结构化 `session_in_use`；SDK Host 映射为可重试的 `action_required` | 调用方在原实例关闭 Session 后重试 |
| Embedded / Shared TUI | 明确提示 Session 已在另一实例打开；切换失败时保留当前 Session | 用户关闭另一实例后再次选择；不自动等待或切换 |
| Desktop / Peer GUI | 历史视图保持只读可见；首次写入显示持久提示和显式“重试”操作 | 用户关闭另一实例后点击重试；不自动提交消息 |
| Headless `json` | 失败结果带 `error_code=session_in_use`，详细说明进入结果和 stderr | 调用方依据稳定码决定是否重试 |
| Headless `stream-json` | 复用已有 `SystemError`，`error=session_in_use`、`recoverable=true` | 调用方结束本次非零退出后重新执行 |

Desktop 作为 ACP client 管理的外部 agent Session 不经过该 Runtime owner，不在本节的 Session 单写范围内。`recoverable` 只表示关闭现有 writer 后可以重新调用，不表示自动等待、自动抢占或恢复当前调用。

| 场景 | 行为 |
|---|---|
| 同一进程重复 restore 同一 Session | 返回已加载的 Session，不重复取得或释放写入权 |
| 另一个进程打开同一存储位置中的同一 Session | 立即返回 `session_in_use`；不等待、不自动抢占 |
| 多个进程打开同一 workspace 中的不同 Session | 允许，各 Session 独立写入 |
| 多个进程更新同一 Session 列表索引 | 按存储位置串行更新共享索引，不影响不同 Session 文件并行写入 |
| `.`、`..`、符号链接或 Windows 路径大小写指向同一存储位置 | 视为同一个 Session 存储位置 |
| 相同 Session ID 位于不同存储位置 | 文件锁相互独立；同一 `SessionManager` 仍按 Session ID 保持唯一绑定，不能同时加载 |
| Session 存储路径无法解析或错误地指向文件系统根目录 | 在发布内存状态前返回错误，不创建可写 Session |
| create/restore 在发布到内存前失败、取消或超时 | 临时文件锁随操作释放；后续进程可以重试 |
| save、cleanup 或 unload 失败 | 已加载 Session 继续持有写入权，避免另一个进程接手不完整状态 |
| unload 或 delete 成功 | 释放写入权 |
| 进程崩溃或被强制结束 | 操作系统释放文件锁；残留锁文件本身不代表 Session 仍在使用 |
| Remote workspace | 在实际 Session 存储所在机器执行同一检查；控制端不得用本机路径替代 |

该机制不增加后台进程、轮询、连接或常驻线程，也不改变 Shared TUI 的连接控制规则。临时 Session 不写入磁盘，因此不参与此检查。

### 4.3 私有本机 IPC

```mermaid
sequenceDiagram
  participant C as Shared TUI client
  participant D as User-private discovery
  participant S as Shared Runtime Host process

  C->>D: read endpoint + token + identity + protocol
  C->>S: connect via Named Pipe / UDS
  C->>S: initialize(identity, protocol, token)
  alt valid
    S-->>C: initialized(health + interactive_tui)
    C->>S: create or restore Session
    S-->>C: Session control + Session facts
    C->>S: rename or update current Session
    C->>S: delete idle non-current Session
    C->>S: reload current Session context
    C->>S: compact current Session context
    C->>S: submit/cancel Turn or answer Permission/UserInput
    S-->>C: Session-filtered authoritative events
  else invalid
    S-->>C: typed error and close
  end
```

当前私有协议（v18）只覆盖 TUI 已有用户旅程需要的窄操作：

| 已支持 | 明确不支持 |
|---|---|
| Health、只读 workspace-scoped main Agent 摘要、Session list/create、原子 restore（含 transcript 与 pending Permission）、删除未被控制的空闲 Session、当前 Session fork（含 transcript）、rename、Agent mode/model update、声明式上下文 reload、根 Session lineage 查询与后代 transcript 读取 | Session archive、跨 workspace attach、transcript 分页、模型目录/默认值和完整 Agent/Subagent 管理 |
| Turn submit/cancel、当前 Session 手动 context compaction、lineage 成员校验后的单个后代执行子树取消 | replay、cursor、resume event stream、独立的根级批量后代取消 API |
| pending/respond Permission、submit UserInput answers、只读 workspace diff | observer、通用 controller transfer、多 Session multiplex |
| 连接断开清理、Session-filtered events | detach/observer/通用 controller transfer、SDK callbacks、GUI/Remote/Peer/ACP/Headless wire |

这些操作先满足以下本机 IPC 地基，而不把协议升级为公开 SDK：

- workspace、产品、release channel、用户和协议版本共同生成实例身份；
- instance lock 而不是 PID/discovery 文件决定唯一 server owner；
- Windows 使用拒绝远程连接的 Named Pipe；Unix 使用短且由 instance identity 决定的稳定 Domain Socket 名称，权限为 `0600`；
- discovery 所在目录必须由未来 composition 选择为当前用户私有目录；
- discovery 通过同目录临时文件原子替换；Unix endpoint 保留原生路径字节，路径过长时在 bind 前返回明确错误；
- 第一帧必须完成 token、instance identity 和 protocol version 校验；
- 未认证握手预算为 2 秒；认证后的单次操作、响应写入和断线取消预算为 120 秒，避免坏客户端长期占用连接或 Runtime handler；
- JSON frame 使用 4-byte 长度前缀；request 在发送前执行 128 KiB 上限（覆盖 TUI 已有的 64 KiB 粘贴输入及类型化信封），response/event 在序列化时执行 8 MiB 上限。超限返回类型化错误，不能进行无界分配；超过该上限的历史 Session 暂由 Embedded TUI 打开，不在本阶段引入分页协议；
- 未认证连接也计入有界 connection budget，单个客户端不能无限制造 server task；
- 未知 frame/operation 信封字段、未知 operation、错误身份和不兼容版本 fail closed；复用的 Runtime DTO 按其既有反序列化契约处理字段；
- v10 增加两个只读、current-controller 限定的工作区引用 operation：按当前 Session 搜索文件/目录，以及按 user message ID 读取已持久化的结构化引用。两者复用 Agent Runtime 的 workspace-reference port，不赋予 IPC adapter 文件系统或 Session 持久化所有权，也不扩展为 Remote 或公开 SDK 协议。
- v11 增加无请求体、无 Session lease 的只读 workspace diff operation。它只在当前连接没有活动 Turn 时查询 Runtime 启动时绑定的 canonical workspace，避免单连接请求排序阻塞流事件或 Turn 控制，并返回 Runtime Port DTO；Git 行为仍由 `services-integrations` provider 持有。文本 patch 总量限制为 3 MiB，为 JSON 转义和 envelope 预留既有 8 MiB response frame 的空间；该 operation 不隐式获得 stage/reset/commit、Remote 或公开 SDK 能力。
- v12 增加用户显式 Shell Turn；v13 增加活动 Turn steering。两者都复用 Agent Runtime 的原有准入、Tool、权限、持久化和取消 owner，不在 IPC 内复制执行状态机。
- v14 增加三个 current-root-controller 限定的 lineage operation：查询 Runtime 归一化后的扁平 lineage、读取已验证后代的权威 transcript，以及取消指定后代的活动执行子树。查询和读取可在根 Turn 活动时执行；取消复用现有 Session abort 语义，但不切换 controller，也不引入 observer、detach、分页或通用 Session RPC。
- v15 为后代 transcript 读取增加 `required_settled_turn_ids` 一致性前置条件：Runtime 必须确认这些 Turn 已由 owner 持久化为终态，否则返回 `outcome_unknown`，由 TUI 在同一绝对期限内退避重试；TUI 只保留事件投影和该读屏障，不合并或重写权威 transcript。后代取消同时携带用户实际看到的 `expected_active_turn_id`，并在 owner 锁内拒绝已经切换的 Turn，避免迟到操作取消后续执行。lineage 查询和 transcript 读取是每连接至多一个的可抢占推测读取；更新的请求会取消旧读取，使后代取消和 Session 切换不会排在慢 transcript I/O 之后。该行为不放宽 controller 校验，不引入 observer 或通用多路复用。
- v16 增加只读、workspace-scoped main Agent 摘要，用于 Shared TUI 与 Runtime host 的 selector 投影一致。启动页以 Runtime 启动工作区查询且不取得 Session lease；已有 Session 由 Runtime owner 解析其执行工作区并要求当前 controller。响应只包含逻辑 ID、描述、可选固定 model ID 与 ecosystem-neutral 的 external-source 分类；发现、审批、冲突消解、generation 与执行仍由既有 Agent Registry 和 external-source owner 负责，不经 IPC 暴露安装、变更、激活、Subagent 管理或 runtime lifecycle API。
- v17 扩展原子 restore，使响应带回 Runtime Session state；增加结构化 Session usage、等待指定 Turn settlement，以及记录本地命令
  transcript turn 的 operation。它补齐当前 Shared TUI 的行为，并为 `CliAgentRuntimeClient` 的 Shared backend 提供 operation 基线；没有增加
  replay、observer、通用 controller transfer、多 Session multiplex 或公开 SDK 能力。
- v18 增加当前 controller 限定的问答首次交互和取消操作，委托同一个 Runtime mailbox；首次交互永久停止无人值守超时，Esc 取消问题而不取消整轮。私有协议版本参与本机实例标识，旧客户端继续连接旧版本实例，新客户端不会向 v17 发送新操作。
- 一个连接最多控制一个 Session、同时最多提交一个活动 Turn；一个 Session 同时只有一个 controller。create/restore/fork 在完整结果通过大小检查后才原子切换控制权，失败时保留原 Session。fork 只接受当前 controller 的空闲 Session；无选中 Turn 时复制到最新持久化 Turn，指定 `before_turn_id` 时只复制该 Turn 之前的历史。活动 Turn 期间不能切换或 fork Session，也不能修改其名称、Agent mode 或 model；删除只作用于非当前且未被任何连接控制的 Session。
- Submit 与手动 context compaction 都使用调用方已有的 `turn_id` 标识不确定结果；若操作超时，返回 `outcome_unknown`、关闭连接并按该 ID 取消。手动 compaction 要求当前 controller 且 Session 空闲，由 Core 通过与普通对话 Turn 共用的原子准入路径创建一个可审计 maintenance Turn，并在取得所有权后读取压缩上下文：planning 阶段允许取消，atomic commit 开始后忽略晚到取消并保持 Processing 直至终态持久化完成。maintenance Turn 保留在权威 transcript 中但不进入模型上下文，live/restored payload 使用同一 compression ID 和 `applied` 事实；commit 后的持久化故障发布明确失败终态而不是遗留 Processing。断连取消只有得到确认后才释放 Session 控制权；无法确认时继续隔离该 Session，直到 Runtime 进程退出。
- Session delete/rename 和 Agent mode/model update 复用既有 Runtime 端口和校验，Runtime 对最终结果保持权威并拒绝无效目标。它们都是有副作用操作；发送前编码或 frame 上限失败表示请求未执行，连接仍可使用。rename 写入失败时恢复旧 metadata：确认恢复后返回明确失败，无法确认时返回 `outcome_unknown`。Shared Client 在请求写入后响应超时或丢失连接时也返回 `outcome_unknown` 并断开连接。两种情况都不自动重试：rename 由用户恢复 Session 并核对当前值；delete 由用户重新打开 `/sessions` 核对目标是否仍存在。模型目录以及完整 Agent/Subagent 管理仍是同版本第一方产品事实，不加入 IPC；v16 的 main Agent 摘要只是 host-owned selector 所需的最小只读投影。
- 声明式上下文 reload 只失效当前 Session 的 instructions 缓存，并按目标复用 Skill Registry 刷新；它可在活动 Turn 中执行但不改写该 Turn，generation 保护保证下一条消息重建上下文。它不引入 watcher、热替换或第二套 Runtime owner。
- v18 保留 `update current Session model` operation 及其 controller/idle/unknown-outcome 合同，但模型目录和默认值不进入该 wire。Shared TUI 的模型目录与配置由 CLI-local Model service 委托现有配置 owner，不属于 v18 或 App Server implementation。该 capability 只描述当前本机 Shared CLI scope，不伪装成 v18 或 Remote capability。
- Agent 事件流 lag/closed 后 fail closed；Permission lag 先从 Runtime 权威 pending 集合重建，重建失败或流关闭时取消当前 Turn 并退出。路由到父 Session 的嵌套 Permission 与 AskUserQuestion 复用现有 TUI 交互，不新增第二套 UI 状态。
- Windows Shared Runtime 在初始化前把自身放入 kill-on-close Job；Unix 仅在应用内优雅退出路径中通过受管子进程组回收后代。Runtime 被 `SIGTERM`、`SIGKILL` 或崩溃直接终止后的 Unix 后代回收不在当前保证内。两者都只负责生命周期，不是安全沙箱。
- 最后一个连接离开后等待 30 秒再退出；新连接会取消 idle 退出。退出只删除自己发布的 discovery；Unix 下继任 owner 会在持有实例锁后清理同一 identity 的陈旧 socket。

这是一条本机同用户边界，不是沙箱、远程协议或公开兼容承诺。

### 4.4 Serialization、并发与性能

```mermaid
flowchart LR
  T1["TUI 1"] --> IPC["有界本机 IPC"]
  T2["TUI 2"] --> IPC
  TN["TUI N"] --> IPC
  IPC --> Runtime["一个 Shared Runtime"]
  Runtime --> Tasks["Tokio tasks"]
  Runtime --> Owner["一个 Session owner"]
```

多个 Shared TUI 复用一个 Runtime 进程。每个连接使用独立异步任务，但连接、命令队列和事件队列都有上限；达到连接上限时暂停接收新连接，慢客户端不能建立无界任务或队列。默认不增加 Runtime 进程池，因为复制 Session 状态、模型连接和缓存会扩大一致性成本。只有经测量证明某类无状态 CPU 工作可独立分片时，才评审额外 worker 进程。

| 路径 | 数据边界 | 性能约束 |
|---|---|---|
| Embedded Rich Client（当前） | TUI controller 通过 `CliAgentRuntimeClient` 调用同进程 Agent Runtime，并直接调用对应 owner/service API | 不初始化 App Server client/server、in-memory transport、跨进程 IPC 或后台进程；Runtime client 保持与 Shared deployment 相同的行为、错误、权限和事件语义，但不要求共享 JSON-RPC；其他 capability 按实际 Host scope 和 owner 可用性验证 |
| Embedded App Server（历史迁移基线） | 迁移前由旧 `AppServerClient` 通过 private in-memory transport 调用同进程 App Server | 已随 Phase 5 切换删除，不保留回滚路径 |
| Embedded non-Rich Client | Headless、ACP、Peer 和 SDK Host 的独立 adapter 以 Rust 类型调用 Runtime API | 不因 Rich Client 合同承担 App Server wire；保持各自协议和生命周期 |
| Shared request | Client 将 operation 编码一次并写入一个长度前缀 frame | 请求保持 128 KiB 上限；业务层只接收类型化 operation |
| Shared response/event | Server 将结果或事件编码一次后写出 | 响应/事件保持 8 MiB 上限；超限使事件流明确失效，不能无界分配 |
| Shared receive | 每个方向只有一个严格 transport decode 边界 | 未知信封字段和不兼容版本 fail closed；严格校验可以检查规范化 JSON，但不能把动态 JSON 传入 Runtime owner |
| 多 TUI | 一个 Runtime、最多 64 个连接；每个 Client 的 command channel 容量为 64、event channel 容量为 256 | request gate 使每个 Client 同时只有一个控制请求进入 channel；lineage 推测读取写入后释放 gate，Server 同时只保留一个且允许更新请求抢占；Client 使用并发 reader 与单一有序 writer，避免大 transcript 响应和后续大请求互相阻塞；事件落后时失效而非无限缓存 |

协议只承载当前交互所需的小型控制请求、受 3 MiB 文本上限保护的 workspace diff 快照和既有事件。大 transcript 继续受 frame 上限约束；本阶段不为假设场景增加通用分页、二进制 side channel、压缩或批处理协议。

## 5. Development and Physical Views · Level 1

### 5.1 Development View

```mermaid
flowchart TB
  GUI["Desktop GUI"] --> DesktopAdapter["Desktop / Tauri adapter"]
  Web["Web UI"] --> AppServer["App Server"]
  EmbeddedTUI["Embedded TUI"] --> RuntimeClient["CliAgentRuntimeClient"]
  EmbeddedTUI --> OwnerApis["existing owner/service APIs"]
  SharedTUI["Shared TUI"] --> SharedCompat["Runtime IPC v18 compatibility"]
  DesktopAdapter --> API["Agent Runtime API / owner ports"]
  AppServer --> API["Agent Runtime API / owner ports"]
  RuntimeClient --> API
  OwnerApis --> DomainOwners["existing owners / services"]
  SharedCompat --> API
  CLI["Headless CLI adapter"] --> API
  SDK["SDK Host adapter"] --> API
  ACP["ACP adapter"] --> API
  Server["Server adapter · when assembled"] --> API
  API --> Coordinator["ConversationCoordinator"]
  Coordinator --> Behavior["single behavior owners"]

  GUI -. "composition" .-> Ownership["CoreRuntimeOwnership"]
  Web -. "composition" .-> Ownership
  EmbeddedTUI -. "Embedded" .-> Ownership
  SharedTUI -. "Shared" .-> Ownership
  CLI -. "Embedded" .-> Ownership
  SDK -. "Embedded" .-> Ownership
  ACP -. "Embedded" .-> Ownership
  Server -. "only when Runtime is assembled" .-> Ownership
  Ownership -. "injected once" .-> Coordinator
```

```mermaid
flowchart LR
  TUI["Interactive TUI · current"] --> RuntimeClient["CliAgentRuntimeClient"]
  RuntimeClient -->|"Embedded default"| Runtime["AgentRuntime typed API"]
  RuntimeClient -->|"Shared compatibility"| IPC["adapters/agent-runtime-ipc v18"]
  TUI --> OwnerApis["existing owner/service APIs"]
  OwnerApis --> DomainOwners["existing owners / services"]
  IPC --> Handler["CLI Shared handler"]
  Handler --> Runtime
```

第二张图描述当前已交付的 TUI composition：Embedded 与 Shared 都使用同一个
`CliAgentRuntimeClient`，其内部 backend 分别调用 `AgentRuntime` typed API 和 Runtime IPC v18。CLI Host 负责命令解析、TUI 状态、
错误文案、Runtime backend 选择和生命周期；
Startup 和 Chat controller 直接调用其实际使用的 owner/service API，并在访问 controller-local owner
前检查 workspace scope。统一 Runtime client 负责 typed
request/result/event 映射及私有 IPC 的协议与连接控制；Agent Runtime 与 owner 负责 Session 校验、
持久化和权威结果。TUI 业务代码不根据部署形态复制 Runtime 分支，Shared 是否替换 v18 仍按独立门槛决定。
这里不存在 catch-all TUI client 或统一 TUI management 模块。

- CLI 不依赖 SDK Host，GUI/TUI 也不依赖公开 SDK package。
- 交互式 TUI 的启动页和会话页直接依赖 `CliAgentRuntimeClient`；Embedded 与 Shared Runtime 调用都进入该 client。TUI controller 不直接依赖 Rust Runtime SDK、Runtime 实现或 IPC operation。
- 非 Runtime 能力由 controller 直接调用 owner-owned 的稳定 service/API；每个使用 controller-local owner 的调用点单独裁剪 Remote workspace scope。CLI 仅在 `openbitfun server` 的独立 stdio Server Host 装配点（`src/apps/cli/src/server_host.rs`）依赖 App Server implementation；该 Host 是独立 Host 表面，注入显式 allowlist 与 canonical workspace scope 收敛能力，而非 TUI/Headless 的默认路径。TUI、controller 与 Headless CLI 仍不依赖 App Server implementation/client，也不复制 management DTO；Headless CLI 默认保持 Embedded。当前可复用 behavior-light protocol 合同，后续若下沉 semantic payload，必须与 JSON-RPC envelope 分离。
- App Server wiring 独立于 TUI composition；TUI 重构不以 App Server parity 或兼容性作为验收条件。
- Web 当前独立使用自己的 loopback WebSocket App Server Host，不进入 TUI backend composition。Shared 当前只有 private Runtime IPC v18；Shared App Server 只存在于第 1.3 节的 Phase 6 candidate 图中。
- Headless CLI 和 Peer Host 使用同一 Runtime 订阅入口，但分别保留确定性退出与 Peer fanout 语义；共享订阅入口不等于共享 renderer 或产品生命周期。
 - TUI 不是 Server；当前 Embedded Host 在同进程直接调用 Runtime，是否连接 Shared deployment 是部署选择，不改变 TUI 的 renderer/键位职责或行为合同。
- Agent SDK Host 只服务外部 SDK 合同，不成为第一方 rich-client 的通用底座。
- Headless CLI 默认继续 Embedded；CI 或测试可保持独立进程和独立 workspace，不承担后台实例成本。
- Tauri 仍负责窗口和桌面能力，并逐步收窄为 product Host adapter；Embedded 产品请求可由 direct Runtime adapter 承载，需要连接边界时再使用 App Server，未来也可以管理 Shared process 的启动/重连，但不拥有 Agent Runtime 业务生命周期。

### 5.2 Physical View

#### 5.2.1 Current production

```mermaid
flowchart TB
  subgraph Embedded["Embedded · current"]
    TUI["Interactive TUI"] --> Direct["direct Runtime adapter"]
    Direct --> Runtime
    AppServer --> Runtime["in-process Agent Runtime"]
    Headless["Headless / CI"] --> Runtime
  end
  subgraph Shared["Shared · current explicit --shared"]
    Clients["one or more TUI processes"] -->|"Named Pipe / UDS · current compatibility"| SharedRuntime["Shared Runtime Host process"]
  end
  Runtime --> Data["workspace + Session storage"]
  SharedRuntime --> Data
```

当前默认交互式 TUI 通过 direct Runtime adapter，Headless CLI 和 CI 通过各自 adapter 调用同进程
Runtime。只有显式 `--shared` 的交互式 TUI 进入 Shared；同一 workspace 的两种部署互斥。
多开 TUI 增加 Client 进程和有界连接，不按 Client 数量复制 Runtime、Session owner 或 Plugin Host。

#### 5.2.2 Delivered Phase 5 Embedded path

```mermaid
flowchart LR
  TUI["Embedded interactive TUI"] --> Direct["Direct Runtime adapter · current"]
  Direct --> Runtime["in-process Agent Runtime"]
  Runtime --> Data["workspace + Session storage"]
```

Phase 5 已把 Embedded interactive TUI 从旧 App Server 一次性切到 direct Runtime adapter，并删除
旧 in-process App Server；Headless/CI 保留独立 adapter，Shared 继续使用前一张 Current 图中的
private Runtime IPC v18。旧 App Server 不作为回滚配置保留。

### 5.3 Scenario (+1) · delivered contract: rename current Session

该场景将已交付的 Embedded direct adapter 与当前 Shared v18 行为放在同一等价合同中。

```mermaid
sequenceDiagram
  participant U as User
  participant T as TUI adapter
  participant C as CliAgentRuntimeClient
  participant R as Agent Runtime

  U->>T: /rename Auth refactor
  T->>T: trim + require idle Session
  T->>C: typed Runtime request
  alt Embedded
    C->>R: AgentRuntime method
    R->>R: validate ownership + persist
    R-->>C: applied / failed / outcome_unknown
  else Shared compatibility
    C->>R: Runtime IPC v18 -> owner port
    R->>R: validate ownership + persist
    R-->>C: applied / failed / outcome_unknown
  end
  C-->>T: typed result
  T-->>U: update name only after applied
```

Embedded 和 Shared 最终调用同一 `AgentRuntime::rename_session`。Runtime 只有在确认旧名称已保留时才返回明确失败；持久化恢复无法确认时，两种部署都返回 `outcome_unknown`。Shared 还会在请求已发送但权威响应丢失时返回该结果并关闭连接。用户恢复 Session、检查当前名称后再决定是否重试。

### 5.4 Scenario (+1) · delivered contract: delete an idle Session

```mermaid
sequenceDiagram
  participant U as User
  participant T as TUI adapter
  participant C as CliAgentRuntimeClient
  participant R as Agent Runtime

  U->>T: /sessions then Ctrl+D
  T->>T: reject current or active target
  T->>C: typed Runtime request
  alt Embedded
    C->>R: AgentRuntime method
    R->>R: existing delete owner
    R-->>C: applied / failed / outcome_unknown
  else Shared compatibility
    C->>R: Runtime IPC v18 -> owner port
    R->>R: existing delete owner
    R-->>C: applied / failed / outcome_unknown
  end
  C-->>T: typed result
  T-->>U: remove only after applied
```

Embedded 和 Shared 最终调用同一个 Agent Runtime。Shared Runtime Host 通过 v18 handler 调用 Runtime；它不是 Shared App Server。Shared Runtime Host 只在请求方没有活动 Turn、目标 Session 未被任何 Client 控制时调用 Runtime owner；`session_in_use` 和 `not_found` 保持结构化错误。TUI 复用现有单个 Session 异步任务槽位，不阻塞事件循环，也不自动重试结果不确定的删除。

## 6. 隔离和生命周期原则

实例身份与 ownership key 分工不同：

| 事实 | 用途 |
|---|---|
| canonical workspace + product | 防止 Embedded 与 Shared 同时拥有同一工作区 Runtime |
| workspace + product + release channel + user + protocol | 定位兼容的本机 Shared instance |
| stable local endpoint + bearer token + owner id | endpoint 定位同一 instance；随机 token 认证本轮 server；owner id 防止旧实例误删新 discovery |
| 实际 Session 存储位置 + Session ID | 限制持久化 Session 的跨进程并发写入；不由 IPC 协议定义 |

当前 Shared TUI 只有 controller，没有 observer 或 detached Query：一个 Client 关闭不会删除 Session；它会取消仍拥有的活动 Turn，只有取消得到确认才释放 Session 控制权，否则继续隔离该 Session，直到 Runtime 退出。最后一个 Client 关闭后，Runtime 进入 30 秒空闲期；期间重连可继续使用，超时后 Runtime 正常关闭。若未来增加后台任务、observer 或 Remote 引用，必须先扩展 Runtime-aware drain，不能把这些引用塞进当前简单连接计数。

对普通单实例用户，未显式启用 Shared deployment 时不增加后台进程、连接、发现扫描或常驻内存。

## 7. 能力扩展原则

未来每增加一类 Shared 能力，都必须同时满足：

1. 已有明确第一方 consumer 和用户旅程；
2. 行为由现有 Runtime owner 提供，IPC 只映射 typed request/result/event；
3. 定义权限、取消、deadline、断线、背压和副作用结果不确定性；
4. Embedded 与 Shared 使用同一行为 fixture；
5. 新能力不被顺带发布为 Agent SDK、Remote 或浏览器 API。

Session/Turn、事件恢复、Permission/UserInput、Controller、配置管理和 Remote 应分别通过上述门槛，不能一次性加入一个“全量 Shared API”。

当前 IPC crate 只是一条可删除的预集成边界：

| 约束 | 当前决定 |
|---|---|
| 当前 consumer | 仅第一方交互式 TUI adapter；不自动包含 GUI、Headless CLI、Remote 或 SDK Host |
| 稳定测试合同 | 本机 endpoint、initialize-first、128 KiB request / 8 MiB response-event 上限、连接上限、owner-checked cleanup、原子 Session controller 切换、单连接单活动 Turn、事件流失效后 fail closed、断连取消、30 秒空闲退出 |
| 当前业务范围 | Session list/create/restore/delete、Turn/transcript、当前 Session name/Agent mode/model、Permission/UserInput 的 TUI 必需子集；任何新增操作都需要真实 consumer 和 owner 等价测试 |
| 协议地位 | crate 保持 `publish = false`；这是 workspace 内私有协议，不是 Agent SDK 或远程兼容承诺 |

架构守卫只允许 CLI 消费该 crate；IPC 可以复用稳定的 Event、Product Domain 与 Runtime Port DTO，但禁止依赖 Runtime 实现、SDK Host、services、Tauri 或远程网络 transport。

## 8. 与竞品的取舍

| 产品 | 已验证做法 | OpenBitFun 采用 | 不照搬 |
|---|---|---|---|
| [OpenCode Server/SDK](https://opencode.ai/docs/server/) | Server-first；类型化 SDK 直接消费 Server API | 一个 Runtime owner 可以服务多个第一方 Client | 不要求 Rich Client 使用 HTTP/OpenAPI，也不把全量 route 固化为私有 Shared wire |
| [Codex App Server](https://developers.openai.com/codex/app-server/) | App Server 为 rich client 和 remote TUI 提供 JSON-RPC；自动化继续使用 SDK；WebSocket transport 仍是实验性接口 | Rich Client 使用 App Server，自动化/公开 SDK 保持独立，并为 Shared 入口保留有界本机 transport | 不复制其完整 schema，也不把实验性远程 transport 当作已交付公网 API |
| [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript) | Agent loop 由长期运行的 CLI 子进程承载，并提供 `startup()` 预热以减少首次请求成本 | 长期 Shared 交互可以复用已启动进程，空闲后回收 | Embedded Rich Client 不增加子进程，多 TUI 也不映射为多个 Runtime |

三种产品说明了不同部署的有效边界：稳定产品行为合同可以分别映射到进程内 direct adapter 和多客户端 transport，长期子进程适合 Shared
交互或语言 SDK，独立强类型 adapter 适合 Headless/ACP 等非 Rich Client。OpenBitFun 采用混合部署，不把 App Server 强制成所有入口的
公共底座；当前也没有为了追赶功能表一次性增加 Session/Tool/Permission 超集。

## 9. 不变量

- 只有一套 Agent Runtime 业务实现；部署差异不能产生第二套 Session、Tool、Permission 或 MCP owner。
- 当前入口使用第 1.1 节列出的 adapter；Embedded TUI 使用 direct Runtime adapter，Web/需要连接边界的 Rich Client 继续使用 App Server。
- Client、窗口、Session 或 workspace 数量不会自动等量增加 Runtime 或 Plugin Host 进程。
- 当前 Shared Runtime IPC 是第一方 TUI 的 private compatibility transport，不成为公开 SDK、Remote、Peer、HTTP 或浏览器协议；是否由 App Server Shared transport 替换仍待评审。
- Shared TUI 的 Model、Skill、Subagent、MCP、External Source V1、Hook 和 Worktree 管理由 controller 直接调用现有 owner/service。这些 capability 不进入 `CliAgentRuntimeClient` 或 v18 wire。Account/Settings Sync 和后续 External Application V2 未由当前 Shared Host 提供并返回 typed unsupported；Remote workspace scope 明确 fail closed，不回落控制端本机。MCP service 的进程状态和 tool registry 只属于当前 CLI 进程，不即时重配已经运行的 Shared Runtime Host；跨进程 MCP 管理需要单独的同步/restart contract。
- 默认 GUI/TUI/Headless CLI、ACP 与 SDK Host 保持 Embedded；其中交互式 TUI 的 Embedded 请求使用 direct Runtime adapter，旧 Embedded App Server 已删除。Desktop direct Runtime 是独立的已批准迁移步骤，不由 TUI Phase 5 的完成状态代替；Headless CLI、ACP 与 SDK Host 继续使用各自 adapter。只有交互式 TUI 的显式 `--shared` 选择 Shared。互斥按 `workspace + product` 生效，不再按入口名称缩窄。
- Account/session cloud sync 仍使用既有 Core compatibility 边界，不属于 Shared Runtime 支持。
- Remote workspace 的文件、凭据、进程和 Runtime 位于目标执行域，禁止静默回落本机。
- 未经真实 consumer 验证的接口不进入 wire；当前 wire 只包含表中列出的 Shared TUI 操作。
