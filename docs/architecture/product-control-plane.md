# OpenBitFun 产品控制平面

本文定义用户手动操作、Agent 自行控制、全局搜索和 OpenBitFun Playbook 之间的
一致性边界。它只描述稳定所有权与运行约束；具体页面文案和能力清单由生成的
`ResolvedProductCapabilityGraph` 承载。

## 1. 不变量

OpenBitFun 对一项用户可见功能或设置只允许一个业务 owner。该 owner 提供类型化
Query/Command，持有校验、状态写入、运行时副作用、回读和错误语义。不同入口只做
参数与展示适配：

```text
owner Query / Command
        |
        +-- Desktop Tauri adapter <-- GUI / Desktop Agent / Peer
        +-- direct owner adapter  <-- CLI / Headless Agent
        |
        +-- ResolvedProductCapabilityGraph
                +-- global search
                +-- OpenBitFunControl discovery
                +-- Playbook
```

因此以下行为是禁止的：

- GUI 组件和 Agent 分别实现同一配置校验或副作用；
- Agent 按任意配置路径或任意 Tauri command 执行；
- 搜索、说明书或 Agent 工具手工复制枚举、默认值、路由与可用性；
- 把打开页面报告为已经执行功能；
- Remote/Peer/Detached 场景在目标能力不可用时静默回退到控制端本机。

## 2. 事实所有权与解析图

事实可以有不同 owner，但每项事实只能编辑一次。构建解析器将这些 owner 投影合并
为一张带 schema version、内容 digest 和来源证明的只读图：

| 事实 | 唯一 owner |
|---|---|
| Query/Command ID、输入输出、风险、执行宿主、handler | 对应产品域或配置 owner |
| 设置页、子视图、场景、产品动作 | 各自运行时注册表 |
| 主题、语言及其他枚举 | 实际 provider/registry |
| 中英文标题、关键词、教程和说明 | capability authoring overlay |
| Tauri/源码证据 | 实际注册与源码扫描结果 |

解析结果同时生成 Rust、TypeScript、搜索和 Playbook 投影。生成物的 digest 必须相同；
任何引用不存在的 handler、页面、场景、provider、工具或证据都会阻断生成。authoring
overlay 不得重新声明 handler、配置路径或由真实 registry 提供的动态枚举。

## 3. 稳定契约

稳定 DTO 位于 product-domain contracts：

- `ProductControlDefinition`：一个公开 Query/Command 的身份、schema、风险、可用性和
  presentation target；
- `ProductControlQueryRequest/Result`：读取当前有效状态与动态选项；
- `ProductControlExecuteRequest/Outcome`：执行命令并返回回读状态和单调 revision；
- `PresentationTarget`：设置页、子视图、场景、产品动作或事件入口；
- `ResolvedProductCapabilityGraph`：供发现与静态投影使用的版本化解析图。

`OpenBitFunControl` 使用 `list/search/get/open/configure/execute` 的当前 wire shape。完整能力
不会进入 system prompt；模型先发现或搜索，再按 `get` 返回的精确 schema 调用。已经退休的
产品控制 ID 在正常运行时直接拒绝，不提供旧名称 alias；未来如需导入旧数据，由独立迁移边界完成。

Product Control Registry 是闭集路由，不是第二个业务 owner，也不是通用 RPC。它只能
注册已有 owner 的 Query/Command；来源字段只参与审计和权限提示，不得改变业务结果。

## 4. 状态事务与宿主效果

设置命令按同一事务边界执行：校验、读取旧状态、提交 owner 状态、执行必需宿主效果、
回读并发布 revision。Desktop 存在活动 Web UI 时，主题、语言等展示效果必须由界面
确认；失败时 owner 状态与已应用效果都回滚并返回失败。CLI 或没有活动界面时，展示
偏好写入成功即成功，后续界面启动按持久化状态初始化。

文件选择器、确认框和权限 UI 只负责采集输入或授权。获得结构化参数后，GUI 与 Agent
必须进入同一 Command。破坏性命令继续经过现有权限系统；密码、token 等 secret 不得
出现在发现结果、日志或工具回读中。

兼容 Tauri command 可以保留为薄 adapter。对已经纳管的配置路径，旧 `set_config`
必须转入相同 owner transaction；未纳管的内部路径保持兼容但不进入公开解析图。

浏览器展示与浏览器自动化采用两段明确语义：没有 URL 的“显示内置浏览器”是
`feature.browser` 的 ProductControl presentation command；携带 URL 的打开、导航和页面
操作由 `ControlHub` 委托同一 `BrowserActions` owner。Desktop `BuiltInBrowserHost` 必须用
请求 ID 将 presentation 事件与实际创建、激活的原生 WebView 关联，只有该精确 target
注册为 Agent 可控后才能报告 `open_builtin` 成功。禁止通过 URL、target 数量或固定延时
猜测就绪，也禁止把“面板已收到打开事件”冒充为“页面已可自动化”。

## 5. 控制分类

每个用户条目必须具有机器可检查的控制分类：

- `direct`：OpenBitFunControl 可直接调用 Query/Command；
- `delegate`：专用 Agent 工具是该能力的现有执行 adapter，且最终调用同一 owner；
- `open`：必须由用户完成外部登录、secret 录入、视觉选择或无法结构化的实时交互；
- `unsupported`：当前交付形态明确不支持，并提供恢复建议。

文件路径、稳定 ID、确认或一般权限不构成 `open` 理由：GUI 可以用 picker/对话框取得
参数，Agent 可以提供明确参数并走同一 Command。所有 `open` 条目必须声明枚举原因码，
不能只写泛化说明。

## 6. 远程与版本兼容

产品设置默认在持有 OpenBitFun 产品状态的 host 执行，不随 Remote Workspace 路径迁移。
Peer Device Mode 将命令代理到 peer host；Remote Control 使用目标 OpenBitFun host；Detached
Dispatch 只允许目标 CLI profile 明确支持的 headless 命令。每种 delivery profile 在
解析图中给出 availability，缺少能力时返回 typed unsupported。

`product_control_invoke` 随当前产品数据面发送到 peer；界面 ready/unready 与事务效果 ACK
只描述发出它们的窗口，因此保持 controller-local。需要运行时效果的 peer 命令由 peer
自己的界面确认，没有可用界面时明确失败并回滚，禁止转而修改 controller 本地状态。
Peer 握手必须至少协商 `product_control_v1`；依赖本机 provider 或活动界面的定义还必须
分别声明 `product_control_native_v1` 或 `product_control_presentation_v1`。Desktop host
声明三者，CLI host 只声明共享配置契约。旧 peer 或缺少专用能力时在发送前或目标 host
处明确返回 unsupported，绝不在 controller 本地代执行。

CLI Agent、CLI 自身和 CLI Peer HostInvoke 共享同一个进程级
`SharedProductControlExecutor`、mutation lock 和 revision。CLI Peer 的兼容
`set_config` 也必须进入该执行器；纳管路径按 typed schema 翻译，未知内部路径只保留
升级兼容且不得进入 Agent、搜索或说明书。

跨版本边界使用 schema version、稳定 ID、alias 和 capability negotiation。持久化配置键
保持兼容，新增字段带默认值，旧数据不可因解析失败被删除或重置。

MCP 用户服务器由 `setting.tools.mcp` 的结构化操作列出、增量配置、启停和删除。
Desktop provider 调用共享 MCPService；GUI JSON 保存也复用该服务的持久化和运行时
协调路径。每服务器修改携带读取时的配置 fingerprint，经现有 CAS owner 提交，保留
其他服务器、未提供字段、已有凭据和未知扩展字段。读取仅返回 ID、结构、有效性和
状态，不回传命令参数、URL 或秘密值；新增凭据与 OAuth 同意继续使用受保护的用户流程。
配置提交与连接结果分开返回，运行时失败不回滚或重放已经保存的用户决定。

这些操作修改执行端的 OpenBitFun 产品配置，不修改 SSH 工作区配置。需要产品宿主
目录的参数在远程工作区拒绝；纯结构化配置可由 Desktop 上的远程会话调用。Peer
沿用目标端能力发现和 `product_control_native_v1` 检查；CLI 与 Detached Dispatch
未安装该 provider，明确返回 unsupported，不调用控制端界面或文件系统代执行。

## 7. 防腐门禁

CI 必须结构性证明以下闭包，而不是依赖人工更新数量基线：

1. 每个公开设置页、子视图、产品动作和场景均被解析图引用；
2. 每个 direct/delegate binding 均解析到真实 handler/provider/tool；
3. 每个纳管配置写入口均经过 owner transaction；
4. Rust、TypeScript、搜索与 Playbook 投影 digest 完全一致；
5. 每个 `open` 都有合法原因码，每个静态枚举来自真实 registry；
6. GUI 与 Agent adapter 的差分用例产生相同状态、效果、事件、回读与错误；
7. CI workflow 必须执行生成检查、契约测试、CLI 自控测试和 Playbook 构建。

新增用户功能时，维护者先在真实 owner/registry 注册业务事实，再补充说明 overlay；其余
投影由生成器更新。禁止通过修改 reviewed count、digest baseline 或宽泛 allowlist 绕过
闭包检查。

## 8. 创造模式的运行时扩展

创造模式使用两类边界。已有产品能力仍由 `OpenBitFunControl` 的闭集 owner 图控制；
用户新建的命令由 `infrastructure/creation/creationCapabilities.ts` 中的激活期注册表持有。
后者不向 ProductControl 注入任意 RPC，也不修改全局 Agent 工具表。Agent 使用
`FrontendWorkbench inspect/invoke` 发现和调用当前自定义模块的命令；调用经过原有工具
权限管线，每次 invoke 都要求新授权。命令描述和结果始终是用户数据。

运行时提供命令参数声明与执行前校验、JSON 状态、事件订阅和诊断。命令、界面挂载点
和事件可以共用状态；能力无需对应一个可见组件。Shell adapter 另外提供语义化 UI
选择器、三个持久挂载槽、场景查询/事件和已有产品控制接口。`inspect` 回报真实存在的
部件与槽、命令 schema、状态键和错误，而非仅回报静态文档。状态保存在本地 WebView
的独立版本化命名空间；不承担 MiniApp KV、secret、跨设备同步或后台调度。不可读记录
不被隐式重置；运行时事件不承诺持久重放。

打包客户端保留不可变产品 bundle，自定义草稿只包含 CSS、浏览器 ES module 和自有
assets。模块在真实 Shell 与产品控制桥就绪后激活，调用显式版本的 API；不再要求 Agent
修改压缩 bundle 或依赖源码构建。预览成功才启动原生确认倒计时，激活异常的实际错误
返回到工具。过期草稿拒绝覆盖新版本。确认后的 overlay 在兼容升级中使用新产品 bundle，
旧完整前端版本继续可读。卸载激活实例会撤销命令、事件订阅与托管 DOM；代码回滚不
删除持久状态。

MiniApp 的 list/inspect/create/update/delete 经 Desktop ProductControl adapter 调用同一
`MiniAppManager` 和 worker lifecycle owner。源文件内容以结构化数据传递并由产品编译，
增量更新保留未提供的字段与 KV，`expectedVersion` 检查过期编辑；不把 host 路径当作
Remote Workspace 文件路径。此类路径无关的结构化操作可由远程 workspace 会话使用
其 Desktop 产品宿主；文件式 Init/Finalize 在远程 workspace 明确拒绝。

UI 激活与动态命令需要可见的本地 Desktop：Remote Workspace、手机/机器人控制、
Peer 控制与 Detached Dispatch 均明确拒绝，不在控制端兜底。Peer 表面切换撤销本机
扩展 API；产品控制桥就绪时显式声明 `creationApiVersion`，旧 readiness 请求仍然有效，
但不声明运行时扩展能力，避免向旧完整前端发送无人响应的命令。无窗口/旧宿主通过
发现或 readiness 边界返回不可用。动态注册不构成后台
Agent、插件权限或持久任务 owner 的迁移。
