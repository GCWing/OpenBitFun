# OpenCode 配置与声明式资产适配设计

本文定义 OpenCode 配置、规则、Agent、Skill、Command、MCP、LSP、Formatter、Theme、Keybind 和模型配置
进入 OpenBitFun 的兼容路径。可执行工具与服务插件见
[`opencode-plugin-runtime-adapter-design.md`](opencode-plugin-runtime-adapter-design.md)，终端界面插件见
[`opencode-tui-plugin-adapter-design.md`](opencode-tui-plugin-adapter-design.md)，完整状态以
[`opencode-extension-compatibility.md`](opencode-extension-compatibility.md) 的能力矩阵为准。
外部来源的统一产品体验、风险分级和变化提示见
[`external-ai-work-sources-design.md`](external-ai-work-sources-design.md)。

其中 LSP 仅作为 OpenCode 上游配置事实进入清单：OpenBitFun LSP Runtime 已退役，这类声明固定为 `unsupported`，
不得导入、应用或执行，也不进入后续兼容阶段。

配置字段与来源以 [OpenCode 配置文档](https://opencode.ai/docs/config/)和稳定提交中的主/TUI 配置实现为准。

本文同时记录当前可用切片与后续目标。OpenBitFun 已实现本地用户全局/项目 Prompt Command 的来源发现、
JSON/JSONC/Markdown 解析、参数展开、运行时刷新和冲突选择，也已接入全局/项目 Subagent 声明的安全子集与
本地 MCP 配置。三类 provider 复用 adapter 内部的路径候选与监听根基础设施，但各自保留与资产语义匹配的
来源顺序；当前尚未实现本文定义的完整 OpenCode 配置来源序列、全部合并语义和其他资产映射。

## 1. 目标与边界

目标：

1. OpenCode 用户可以直接打开已有项目，常用配置和声明式资产无需手工转换即可生效。
2. 保留 OpenCode 的来源使用范围、合并顺序、冲突和相对路径语义，并能解释最终值来自哪里。
3. 尽量复用 OpenBitFun 已有配置、Agent、Skill、MCP、主题等归属模块，不复制第二套产品内核。
4. 未知字段和未支持资产局部降级，不导致整个配置、项目启动或界面卡死。
5. 低风险内容默认无感应用并可撤销；可执行、联网、凭据或外部进程能力在首次启用和能力扩大时等待非阻塞确认。
6. 本地激活后的运行语义以兼容优先；用户或组织可以收紧权限，策略差异必须与解析或插件错误分开显示。

非目标：

- 不把 OpenCode 配置对象提升为 OpenBitFun 内部通用配置模型。
- 不要求用户先执行一次性导入才能使用已有 `.opencode` 项目。
- 不对 OpenCode 配置进行双向写回或自动改写原文件。
- 不把运行时主题、快捷键、命令或终端界面插件错归为构建期产品与终端界面布局。
- 不在配置解析器中执行插件代码；可执行内容交给独立插件执行进程。

## 2. 两种消费方式

同一 OpenCode 来源可以有两种明确消费方式：

| 方式 | 写入位置 | 是否立即生效 / 是否执行代码 | 停用或撤销 | 来源变化后 |
|---|---|---|---|---|
| 兼容来源 | 不写 OpenBitFun 配置，也不写回源文件 | OC-R1 的 L1 内容按用户偏好自动应用或先询问；L2/L3 内容只发现，首次启用、更新策略要求或能力扩大时确认 | 按当前项目或执行域抑制来源/资产，或分别停用 server/tui 入口；watcher 更新不得绕过该偏好重新应用 | 重新解析候选；低风险变化自动切换，能力/权限扩大等待确认，失败时保留仍合规的上一结果 |
| 显式导入（目标） | 用户选择的 OpenBitFun 用户层、项目层或更窄工作区层 | 写入成功后由目标层正常生效；Plugin/Tool 不经导入执行 | 按字段撤销；冲突字段先预览，不自动覆盖后续修改 | 只提示重新导入，不双向写回，也不自动覆盖 OpenBitFun 值 |

当前显式导入仅落地 MCP C0a 窄切片：复用现有来源解析，在 Desktop 与 `openbitfun mcp import` 中预览
OpenCode / Claude Code 的等价安全声明；显式 apply 只向现有用户级 MCP 配置原子写入 disabled 条目。它不复制
header、env、cwd 或凭据，不支持 Codex 投影、通用目标层选择、逐字段导入记录或 undo。下述通用导入与撤销语义
仍是目标设计，不能由 MCP C0a 推导为已实现。

“只读”只表示源文件不被 OpenBitFun 改写，不表示结果仅供预览。兼容来源不是 OpenBitFun 内部权威模型，但它是合法
运行输入；达到对应阶段后，适配器把有效值映射到归属模块，归属模块仍负责最终持久化、运行时状态和错误语义。
R1 的“自动应用”仅包含不启动外部进程、不 import 第三方 module、不读取凭据且不主动联网的 L1 字段；用户可
切换为“低风险内容也先询问”。其他合法配置必须显示“已发现，当前阶段未激活”或“需确认”，不能因解析成功
提前执行。自动应用不绕过已有工作区来源校验、组织上限或归属模块校验，也不能扩大工具和权限。当前只能静态
预览的插件/工具名称属于 L0 清单，进入来源视图不等于配置或能力已经应用。

导入成功后，已选字段以 OpenBitFun 原生配置为准，不再同时应用原 OpenCode 值；原来源继续被观察，变化时提示“来源
已变化，是否重新导入”。未选择字段仍按兼容来源生效。导入记录按字段保存目标层、导入前值及其版本/摘要、导入
值和来源摘要。撤销只自动恢复“当前值仍等于导入值”的字段；若用户后来修改 OpenBitFun 值、来源也发生变化或只重新
导入部分字段，则进入冲突预览，并逐字段选择“保留 OpenBitFun 值 / 重新导入外部值 / 手工处理”，不得整批覆盖。

## 3. 配置层级与来源

### 3.1 OpenCode 来源顺序

本节的来源顺序是解释 OpenCode 覆盖行为的概念模型，不要求实现公共 Graph DTO、缓存、Coordinator 或产品协议。
当前生产切片只在 `opencode-adapter` 内部按需生成有序本地路径，各能力 provider 继续分别拥有解析、合并和物化；
候选版本与原子替换仍由现有 `ExternalSourceControlPlane` 持有。只有完整配置消费方落地后，才评审是否需要更丰富的
内部来源事实，不能为目标矩阵预建公共“来源图”基础设施。

稳定版配置按“后加载覆盖前加载、非冲突字段合并”处理：

```text
远程 `.well-known/opencode` 的内联配置和远程配置
  < 用户全局配置
  < OPENCODE_CONFIG 指定配置
  < 项目配置
  < ConfigPaths.directories（全局配置目录、项目 .opencode、~/.opencode、OPENCODE_CONFIG_DIR）中的配置与目录资产
  < OPENCODE_CONFIG_CONTENT 内联配置
  < 当前账户组织 /api/config
  < 系统管理员配置
  < macOS MDM 配置
```

适配器必须记录每个值的来源、使用范围、文件或远程标识、覆盖关系和策略限制。数组、对象和插件列表使用
OpenCode 当前版本的真实合并/去重语义，不用 OpenBitFun 常规配置合并规则猜测。

来源发现包括：

- 远程 `.well-known/opencode` 中的 `config`，以及 `remote_config` 指向的 URL/Headers；本地只先记录远程引用，
  主动联网获取前按 L2 处理；组织已批准且已有连接的执行位置，可以由对应归属模块自动允许。
- XDG 用户配置根（默认 `~/.config/opencode`，Windows 也不改用 AppData）中的 `config.json`、`opencode.json` 和
  `opencode.jsonc`。
- `OPENCODE_CONFIG` 指定的配置文件。
- 从工作树根到当前目录按 root-first 顺序发现项目 `opencode.json/jsonc`。
- `.opencode`、`~/.opencode`、全局配置目录和 `OPENCODE_CONFIG_DIR` 中的 `agents/`、`commands/`、`modes/`、
  `plugins/`、`skills/`、`tools/`、`themes/`；兼容旧 singular 目录名。
- `OPENCODE_CONFIG_CONTENT` 内联配置。
- 当前账户所选组织的 `/api/config`、各平台系统管理员目录与 macOS MDM 设置。

所有来源合并后再应用 `OPENCODE_PERMISSION`、旧 `tools` 到 permission 的迁移，以及关闭自动压缩/裁剪的环境覆盖。这些属于固定版本的后处理，不是新的配置来源。

当前 Prompt Command、Subagent 与 MCP 子集只实现上述本地来源的一部分，并复用 creation-safe 监听根与路径候选
基础设施；来源顺序仍由各资产 provider 按当前生产配置 owner 的阶段定义，不能抽象成所有未来资产都必须复用的
通用顺序。Subagent 先应用用户 JSON/JSONC、`OPENCODE_CONFIG` 与 project direct config（root-to-nearest），再进入
目录阶段：用户 Agent Markdown、project `.opencode` config/Markdown（opened-to-root）、兼容 `~/.opencode`，最后是
未与前述目录重合的 `OPENCODE_CONFIG_DIR`。物理 alias 保留首次出现的位置，只更新该位置的加载语义和来源标签，
不移动到末尾。`OPENCODE_DISABLE_PROJECT_CONFIG` 会关闭项目配置、项目目录资产和对应监听根；显式目录不替换
XDG 用户根，并在 OpenBitFun 来源标签中保持 `WorkspaceLocal`。

当前 References 切片按审计时 OpenCode Core V2 `e4bd9757` 的配置插件顺序独立组装：
`OPENCODE_CONFIG_DIR` 存在时替换默认全局配置根，而不是追加更高优先级目录；随后依次应用 project direct config
（root-to-nearest）和 project `.opencode` config（root-to-nearest）。该生产路径不读取 `OPENCODE_CONFIG`、旧用户目录
或 `config.json`，也不复用 Command/Subagent 的目录资产顺序。相同 alias 由后出现的有效声明覆盖；不同 alias 即使指向
同一路径也保留。若总量超过 1024，先完成全部覆盖，再保留最高优先级声明，不能让低优先级填满限额而屏蔽项目声明。

`OPENCODE_CONFIG_CONTENT`、远程、组织、系统管理员与 MDM 来源尚未接入，不能因三类本地候选可运行就把目标来源
序列标记为完整实现。

### 3.2 TUI 独立来源顺序

`tui.json/jsonc` 不是主配置来源顺序的附属字段。稳定版使用独立顺序：

```text
用户全局 TUI 配置
  < OPENCODE_TUI_CONFIG
  < 项目 TUI 配置（root-first）
  < .opencode / OPENCODE_CONFIG_DIR 中的 TUI 配置
```

TUI 适配器必须单独记录顺序、插件来源和解析错误；不能把主配置的内联、组织或系统管理员来源套用到 TUI 配置。

### 3.3 OpenBitFun 策略关系

OpenCode 来源顺序决定兼容输入如何合并；OpenBitFun 产品能力上限和组织策略决定合并结果能否执行。二者不能混写：

- 来源发现默认无感；L1 内容默认应用，L2/L3 内容首次启用或能力扩大时确认。确认后的本地兼容策略不额外
  收紧 OpenCode 行为，但每次实际启动前仍重新计算当前策略。
- 用户或组织策略可以禁止特定来源、网络范围、凭据、进程或覆盖能力。
- 策略拒绝不回退到更早、更宽松的 OpenCode 值，而是保留最终来源并标记 `policy-limited`。
- 产品定义不参与 OpenCode 文件优先级，只定义产品明确保护的少量能力。

### 3.4 变化与切换

完整配置目标中，每次解析生成不可变候选版本，包含有序来源事实、有效值、未知字段、诊断、内容摘要和风险摘要。
当前本地 Command/Subagent/MCP 切片则继续发布各自既有 provider snapshot，不新增聚合配置对象。文件变化时：

1. 后台重新解析，不阻塞 TUI 或 Agent 主循环。
2. L1 新结果完整校验后在同一次状态提交中替换；失败时保留仍合规的上一份有效结果并显示更新失败原因。
3. L2/L3 的能力、凭据范围或执行域扩大时不激活候选；健康旧结果仍合规时继续服务，等待用户确认。
4. 与插件执行相关的入口或依赖变化只使对应执行版本候选失效，不清空无关配置和会话。
5. 文件观察事件先聚合并在稳定窗口后重扫来源顺序；稳定重扫确认删除、停用、来源撤销、权限收紧或安全策略
   失效时撤下旧结果并重新计算下一来源，不能以缓存绕过。显式停用和安全撤销不等待文件稳定窗口。
6. 暂时不可读与明确删除分开表达；只有无安全影响且可验证的上一结果可在有界宽限期内标记为“暂时过期”。
7. 安全相关配置解析失败时不自动放宽已生效策略。

### 3.5 开发视图

| 开发部分 | 负责 | 不能承担 |
|---|---|---|
| 外部来源目录 | 聚合来源身份、使用范围、资产清单、用户加载偏好和可读状态 | 解析 OpenCode 格式、保存凭据、决定字段语义或执行插件 |
| OpenCode 来源发现器 | 在本地或 Remote 执行域寻找主配置、独立 TUI 配置、目录资产、环境指定来源和组织默认 | 合并配置、执行插件、保存最终产品状态 |
| OpenCode 配置解析器 | JSON/JSONC、变量引用、字段版本、来源位置和未知字段保留 | 使用 OpenBitFun 默认值猜测 OpenCode 语义 |
| 来源合并器 | 按固定 OpenCode 版本合并并记录每个最终值的来源和覆盖关系 | 应用 OpenBitFun 产品或组织策略 |
| 资产适配器 | 把 Rule、Agent、Skill、Command、MCP、Formatter、Theme、Keybind、Reference 和模型配置分别交给已存在或阶段内补齐的真实消费接口；LSP 只输出 L0 `unsupported` 诊断 | 因“看起来已有”而跳过基础能力或边界整理，创建第二套 Agent、MCP、Formatter 或主题运行时，或为已退役的 LSP 建立 DTO/进程/执行路径 |
| 策略检查 | 在 OpenCode 合并结果上应用用户、产品和组织上限，生成可解释差异 | 改写原始 OpenCode 文件或伪装成解析错误 |
| 状态与诊断服务 | 原子发布新结果、保留上一有效结果、聚合错误并区分已发现/已应用/需确认/暂时过期/已移除 | 在界面线程同步解析远程来源或安装依赖 |

来源目录、解析、合并、资产映射和策略检查必须能分别测试。不要建立一个同时扫描目录、修改环境、执行命令、加载插件
并写入 OpenBitFun 配置的“大导入器”。插件和 tool 入口在本流程中只形成有序来源清单，真实代码加载交给插件执行
服务。

## 4. 解析与鲁棒性

固定版 OpenCode 使用完整配置 schema 解码来源；字段类型错误并没有“只忽略单字段”的稳定契约。等价解码基线是：

- 同时支持 JSON 和 JSONC，不要求 `$schema` 字段存在或等于固定字符串。
- 支持 OpenCode 文档化的环境变量和文件变量替换；解析报告只显示引用，不泄漏替换后的凭据值。

以下是 OpenBitFun 的局部恢复增强，不标为 OpenCode 完整等价：

- 原始未知字段保存在来源记录中，并按“来源 + 字段路径 + 版本”聚合诊断，供版本升级后重新解释。
- 非安全、非执行控制的独立顶层字段发生类型错误时，可以只停用对应映射并继续使用已验证字段；状态页必须显示
  “OpenBitFun 局部恢复”，不能标为 OpenCode 等价解析。
- permission、来源启停、插件/工具执行、凭据或组织上限等安全/执行字段无效时，不激活受影响的整项执行结果；
  重载场景保留上一份仍符合当前策略的有效结果，首次加载则明确不可用，不能用宽松默认值替代。

两类行为共同遵守以下可靠性要求：

- 未知枚举值不映射为默认值，避免产生看似成功但行为不同的配置。
- 远程配置超时、无效或不可达时保留本地来源，明确显示组织默认未加载。
- 大文件、递归引用和远程 URL 仍有解析期限与大小上限；超限返回稳定错误，不无限等待。
- 插件列表、命令、Agent 等数组的去重和覆盖按固定版本样例验证，不自行排序。
- 每次重载只产生一条摘要通知；详细错误进入诊断视图，避免日志和 Toast 风暴。

## 5. 声明式资产映射

下表的“默认行为”是对应交付阶段完成后的目标行为。当前已接入本地 Prompt Command（含静态文件与经审阅的 shell
上下文）和 Subagent 安全子集。
OpenCode adapter 在来源发现、解析和审批前不 import module、不读取来源凭据、不主动联网；用户确认模型、工具和
执行位置后，Subagent 归属模块才通过现有 Task 执行链发起 fresh single-run 调用。激活后的模型、工具、权限与凭据
使用仍由对应归属模块按用户已经确认的运行条件控制。除已完整流程的 standalone Tool 外，其余尚未完整流程的远程或可执行资产仍只
解析、展示来源与诊断。

| 资产 | OpenCode 输入 | OpenBitFun 归属模块 / 适配方式 | 默认行为 | 降级条件 |
|---|---|---|---|---|
| Rules / Instructions | 项目/全局 `AGENTS.md`、Claude fallback、`instructions` glob、本地文件、远程 URL | 各生态 adapter 保留原生用户来源语义；Workspace Instructions owner 解析项目来源；Product Assembly 有序合成 | 当前支持 OpenCode 用户 `AGENTS.md`/Claude fallback、三份全局配置的最终本地 `instructions`，以及既有项目根与 `.opencode` 本地精确文件/glob；不获取远程 URL | 单个用户生态的无效配置、glob 或文件 I/O 失败会隔离该生态，保留其他用户生态与项目来源，并使本次构建不可缓存；项目配置继续按项目解析器的逐项降级语义处理。 |
| Agents / Modes | 当前生产 V1 `agent/prompt/disable/permission`、Core V2 `agents/system/disabled/permissions` 输入形状，以及 Markdown、description、mode、model、variant、temperature、top_p、steps、deprecated `maxSteps`、deprecated `tools`、options、hidden、color | Agent 归属模块创建兼容定义和使用范围视图；OpenCode adapter 只翻译来源语义 | 当前支持静态 Agent 安全子集、`primary/subagent/all` role 投影、Agent-local 权限约束和不透明 `variant` profile；V1 是生产兼容主路径，Core V2 字段只按已验证安全子集解析；variant 不映射为 reasoning 或请求 options，需显式绑定现有模型配置；首次按行为、来源、模型/profile、工具与权限范围确认，主 Turn 与 fresh Task 共用 generation lease | legacy mode、options、采样、steps、Task target 过滤与续接保持诊断或阻断；root ambient 权限和 V1 嵌套 resource map 尚不激活，不影响其他 Agent。 |
| Skills | `.opencode/.claude/.agents` 项目与用户根、`SKILL.md`、`skills.paths/urls` | OpenCode adapter 只由 `openbitfun-core/external_sources` 组合并投影有序本地配置根；Skill 归属模块负责有界递归、解析、覆盖与按需加载 | 标准根及 V1 `skills.paths`/当前本地字符串数组可用；项目配置限项目根，用户配置限项目根或用户目录；配置根最多 64 个、每根 512 个 Skill、单文件 256 KiB、可选策略 64 KiB，实际加载再次执行有界非链接读取；配置根在同 scope 覆盖标准 OpenCode 根，但不重排更早的 OpenBitFun/Claude/Codex/Cursor 来源 | URL、下载/缓存、脚本与外部依赖不加载；无效根不影响标准 Skill。 |
| References | `references` / 旧 `reference`，本地 path 或 Git repository/branch/description/hidden | OpenCode adapter 输出来源无关的 Reference provider snapshot；Product Assembly 生命周期协调器与 OpenBitFun 原生关联目录合成唯一有效引用目录；关联目录视图和既有目录选择器消费 | 当前支持本地声明路径、description/hidden、异步刷新和 `@alias` 展示；原生关联目录始终在 OpenCode 引用之前，外部引用只读、不自动进入 Prompt 且不改变权限 | Git 引用、Remote 发现和下载/缓存不实现；无效高优先级 entry 阻断同 alias 的旧值并给出诊断，不回退到更宽松来源。 |
| Commands | JSON/JSONC、Markdown、`$ARGUMENTS`、位置参数、`@file`、`!shell`、agent/model/variant/subtask | Prompt Command 专属契约；adapter 提取静态文件引用与 shell 计划，Product Assembly 负责审批指纹和装配，Terminal owner 负责进程执行 | prompt 与静态 workspace 相对 UTF-8 `@file` 可发送；`!shell` 展示精确命令、工作目录与绝对 shell 路径，经重新校验后以不加载 profile 的隔离式 argv 执行，并仅把 stdout 按模板顺序加入 Prompt。为保持 OpenCode 语义，正常退出后的非零退出码仍使用 stdout。静态计划可记住，参数相关计划仅可单次运行；显式 agent 加缺省/true subtask 可走 approved fresh Subagent，其余 agent/model/variant/subtask 组合以及 shell 与委派的组合整体受限 | 任一文件读取、进程启动、超时或超限失败时不发送部分 Prompt；进程副作用不可回滚。最多 8 文件、单文件 64 KiB、文件总量 128 KiB；最多 8 条 shell 指令、单条 64 KiB、总计 128 KiB、每条 stdout 256 Ki 字符、30 秒；最终命令 1 MiB。安全模式禁用，Remote 不回退到本机。 |
| MCP | local 的 command/environment/cwd/timeout，remote 的 URL/headers/oauth/timeout，Agent 选择 | MCP 归属模块创建兼容配置视图 | 当前支持 local stdio 和 HTTPS remote 的静态发现、首次/行为变化审批、冲突选择与 workspace 隔离的运行期接纳；显式 V1 `timeout` 作为毫秒值约束启动、目录读取和执行，并在 GUI/TUI 审阅详情中可见；快照导入保留可表达的 command/args、cwd、超时与动态 OAuth 开关，写入的原生副本默认 disabled；V1/V2 独立解析，V2 使用整条覆盖及分阶段 timeout | `{env:NAME}` 当前只允许用于运行期兼容来源的 environment/Header 值，不进入 C0a 快照；SSE、OpenCode OAuth client 配置、Agent 范围与 Remote 执行域保持明确不支持；凭据、超时或网络失败只影响单个 Server。 |
| LSP | command、extensions、env、initialization | **Runtime 已退役**：adapter 只保留来源位置与字段存在事实，不创建运行时 DTO | 固定显示 `unsupported`；永不导入、应用或执行 | 不启动本地或 Remote 进程，不安装 Server，不回退到控制端本机；该项不进入任何 OC-R 阶段。 |
| Formatters | command、environment、extensions、`$FILE` | **基础能力缺失**：先补文件写入后的 Formatter 执行消费点，再做格式转换 | 首次确认命令后执行匹配 Formatter | 超时后标记未格式化，文件写入结果保留。 |
| Themes | builtin/user/project/cwd JSON | **部分已有**：GUI Theme 已有；TUI 主题消费边界在终端阶段补齐 | 保留覆盖顺序和语义角色 | 颜色能力不支持时做可见降级。 |
| Keybinds | `tui.json` 的 leader、组合键、禁用和命令标识 | **已有行为、边界未抽取**：从现有 TUI 输入/命令路径提取最小接口 | 保留用户和项目覆盖 | 平台冲突时显示最终绑定与原因。 |
| Models / Providers | `model`、`small_model`、`default_agent`、provider options/variants，以及 `enabled_providers` / `disabled_providers` | Model/Provider 与 Agent 归属模块 | 静态选择按 L1 映射；新增 Provider 连接、网络、凭据或动态适配器按 L2/L3 确认 | 动态软件包适配器交给插件运行时，未知 Provider 只禁用对应选择。 |
| Permissions / Policies | 工具、Skill、Agent 等 allow/deny/ask pattern | OpenCode adapter 生成来源无关约束；Permission 归属模块保持最终裁决 | 当前只接入外部 Subagent 的 Core V2 有序 `permissions` 安全子集与生产 V1 Agent-local 扁平 `permission`；约束参与行为审批并随 Agent 固定到执行链 | 约束只能收紧，不能覆盖 OpenBitFun 用户/项目/组织策略；root ambient、V1 嵌套 resource map 和其他资产权限保持明确不支持。 |
| Plugins / Tools | config plugin 列表、`plugins/`、`tools/` | 只生成执行来源和顺序，交给 OpenCode adapter 与 `PluginRuntimeClient` | 自动发现；首次确认后才准备和 import 当前执行版本 | 不在配置解析线程加载代码。 |

### 5.1 Rules 与 Instructions

规则内容尽量原地引用，不复制成第二份文件。组合结果保留原始段落来源和顺序。OpenCode 与 OpenBitFun 原生规则
同时存在时，配置视图展示实际进入模型的顺序；不能把冲突文本自动改写成“合并后的真相”。

当前 runtime-free 子集不建立通用配置来源图，也不进入 `ExternalSourceControlPlane`。OpenCode adapter 负责用户级原生
来源语义：先选 `$XDG_CONFIG_HOME/opencode/AGENTS.md`（默认 `~/.config/opencode/AGENTS.md`），不存在时回退
`~/.claude/CLAUDE.md`；再按 `config.json`、`opencode.json`、`opencode.jsonc` 顺序合并，后出现的 `instructions`
数组覆盖前者。最终数组支持 workspace 相对、`~/`、绝对本地精确文件和有界 glob；HTTP/HTTPS 项直接拒绝，不下载、
缓存或探测网络。Product Assembly 依次合成 OpenCode、OpenBitFun 原生或 Codex、Claude Code 用户来源，再追加项目来源，并按 canonical path
保留首项。OpenBitFun 从既有 product home（默认 `~/.openbitfun`，遵循 `OPENBITFUN_HOME`）读取 `AGENTS.md`：非空时跳过
整个 Codex 用户指令来源，缺失或仅含空白时回退 Codex 原有的 override/base 选择。原生文件读取失败时隔离该来源、记录诊断并禁止缓存，
不静默替换成 Codex 指令；下次消息重试。来源目录复用同一选择逻辑，原生来源标记为 `openbitfun`。
非递归 glob 只遍历模式所需层级；递归 glob 超出固定扫描预算时只跳过该项，保留此前已读取的用户来源。
用户与项目来源最终进入模型前还共享既有 256 文件、2 MiB 渲染上限，避免两个独立来源预算叠加扩大固定提示词。

Workspace Instructions owner 继续读取项目根 `opencode.json`、`opencode.jsonc`、`.opencode/opencode.json` 和
`.opencode/opencode.jsonc` 中的 `instructions` 数组，只接受工作区内相对精确文件与 glob，并确定性排序。
项目来源按 `AGENTS > Claude > OpenCode` 选择唯一指令族：AGENTS 在 `AGENTS.override.md`、`AGENTS.md` 中选首个非空文件；
Claude 在 `CLAUDE.md`、`.claude/CLAUDE.md` 中选首个非空文件，再追加 `CLAUDE.local.md` 与 `.claude/rules/**/*.md`。
不存在或仅含空白的文件不阻断回退；Claude 仅有 local 或 path-scoped rule 时也算有效指令族。选中上层后不再读取下层族，
包括下层无效配置的诊断；启动上下文、来源目录和条件规则延迟激活共用该选择，避免 `Read` 后重新混入已被 AGENTS 屏蔽的 Claude 规则。
Product Assembly 同时关闭 OpenCode 用户读取器的自动项目配置发现，避免该兼容入口重新混入被屏蔽的项目 `instructions`；
全局配置中用户显式指定的工作区相对路径仍按原语义解析。
Remote 只执行这条端口可见的项目路径，不读取控制端的用户目录。文件变更不启动
watcher；用户通过统一的 `/reload instructions`（或默认 `/reload`）失效当前 Session 的 `UserContext` 缓存，下一条
消息重新读取。用户生态失败不会吞掉项目 instructions，但会阻止本次 user context 写入缓存，因而下一条消息自动重试。

### 5.2 Agents、Modes 与 Skills

标准 Skill 根使用有界递归发现（包括 Codex 的 `.system` 等容器目录），遇到 `SKILL.md` 后将该目录视为包边界，不继续收集其示例中的 Skill。
本地扫描跟随目录链接并按规范路径防环；远程扫描通过 workspace filesystem 跟随链接，以深度和目录预算终止循环。远程项目根与本地项目根采用相同的项目优先、用户次之顺序。
直接子目录保留原有 `scope::source-slot::directory` key；嵌套目录以根内 POSIX 相对路径作为末段，避免不同容器内同名目录冲突。
按名称的默认选择维持现有覆盖规则；Web UI 的 `@`、`/`、`$` 和输入框加号菜单中的技能列表只显示当前模式按覆盖规则选出的名称赢家；选择后插入 `[$技能名]`，仍受全局、模式和作者的用户调用可见性约束。已有的完整 key 引用继续兼容解析与调用。
扫描诊断与可用清单分别返回。Desktop 现有列表命令通过可选 `includeDiagnostics` 返回报告；参数缺省仍返回数组，新客户端接受旧主机的数组并标明诊断不可用。单个目录或文件失败不清空已发现技能。


兼容定义进入现有 Agent 归属模块，而不是新建 OpenCode Agent Runtime。当前已实现范围按是否能保持行为等价划分：

- 可等价映射并激活：名称、description、生产 V1 `prompt/disable` 与 Core V2 `system/disabled` 安全子集、`primary|subagent|all`、隐藏状态、
  可精确解析的 model，以及能映射到当前有效 Tool route 的明确工具选择；缺省工具使用 OpenBitFun 保守 Agent
  默认集并展示在确认摘要中。
- Agent-local 权限：Core V2 有序 `permissions: [{ action, resource, effect }]` 保留顺序；生产 V1 扁平精确 action map
  `permission: { action: allow|ask|deny }` 转换为 `resource="*"`，并把 `write/edit/patch/apply_patch` 归一为
  OpenBitFun `edit` action。同一来源层内仍是 last-match-wins；它作为独立约束与宿主策略取最严格结果，不能授予工具，
  也不能放宽用户、项目、组织或父 Agent 的限制。deny/ask 若命中已选中但当前没有对应 PermissionIntent 的工具，
  整个 Agent 保持阻断；只对未激活的未知 action 做可见降级。
- 文件资源坐标在 adapter 边界转换：Core V2 `read/edit` 的 active-Location-relative resource 映射到 OpenBitFun 实际
  使用的 canonical workspace 绝对资源，`read/edit/external_directory` 的 `~`/`$HOME` 按 OpenCode 规则展开；bash
  resource 保留原始命令文本。若 action pattern 同时跨越路径与非路径工具、workspace/home 坐标不可得，或前导
  wildcard 可能同时匹配 OpenCode 的相对 workspace 与绝对 external resource，则阻断 Agent，不以“未命中即 Allow”继续。
- action pattern 保持 OpenCode 的平台大小写语义：Windows 导入时归一为小写 OpenBitFun action，其他平台保持大小写
  敏感。主 Agent 委派时会把外部定义的 ask/deny 约束并入现有 parent runtime ceiling；外部 Agent 仍不开放 `Task`，
  因为 OpenCode 的 task target 过滤和委派权限尚未等价映射，不能把工具名存在误当成完整委派语义。
- 仅当 Agent 显式声明 `model` 时，`variant` 才保留为不透明模型 profile；未声明模型的 variant 与 OpenCode 一样不生效。
  保留的 variant 不能映射为 reasoning effort 或任意请求 options，并要求用户显式绑定到现有模型配置。
  可识别但不激活的仍包括 legacy mode、root ambient permission、V1 action pattern 或嵌套 resource pattern、options、
  temperature/top_p、steps/deprecated maxSteps，以及不能精确解析的模型或工具。当前不能把这些字段静默忽略后宣称兼容。
- 展示映射：color 等只影响来源 Surface，不进入运行时权威事实。
- 未知字段：进入来源限定诊断，不作为任意数据传给 core；后续版本支持时由 OpenCode adapter 更新解释。

每份 JSON/JSONC 配置文档和 Agent Markdown frontmatter 先独立按 OpenCode V1 key 判型并迁移到统一字段，再参与
合并；不能把跨文档的 `prompt/system`、`disable/disabled` 或 `permission/permissions` 误判为单份文档冲突。
本地生产来源依次应用用户 JSON/JSONC、`OPENCODE_CONFIG`、project direct config（root-to-nearest）、用户 Agent
Markdown、project `.opencode` config/Markdown（opened-to-root）、兼容用户目录与显式目录；物理 alias 保留所在
位置而不因 scope 重排。生产 V1 `disable` 按普通字段 deep-merge，后续来源省略它时仍保持禁用，只有显式
`disable:false` 才重新启用且不清空已合并字段；Core V2 `disabled:true` 才按逐文档 remove 形成 tombstone，后续
同名非 disabled 文档（包括逐文档迁移后的 V1 定义）从空定义重建。
Core 只消费来源无关候选，按当前
模型、工具、执行位置和本地/其他 provider 同名项生成审批与冲突内容摘要。无冲突候选首次确认一次；只有目录文案
变化不重问，prompt 行为、来源或实际模型、工具、权限约束与执行范围变化重新确认；Core 的审批 envelope 也直接
包含约束摘要，不能依赖 provider 正确更新行为版本。当前 `permissions` 数组按文档来源顺序追加，V1 扁平对象按
归一化 action 做确定性去重；同义 action 给出冲突效果时阻断，不能依赖 JSON 对象键序裁决。冲突未选择时逻辑名不可用，候选
变化后不静默回退。

OpenCode adapter 负责把 `provider/model` 语法解析成来源无关的 provider 提示与模型名；Core 不解释 OpenCode 字符串
格式。未声明 model 的 `Default` 与显式 `inherit` 都保留为继承意图：主 Agent 使用当前 Session 模型，Subagent 在调用开始时
继承父 Session 模型，不根据同名 OpenBitFun Agent 猜测默认值。显式引用必须在审批前解析为唯一、已启用的具体模型，并把
配置 ID 与运行配置内容摘要写入决策和版本内容摘要；歧义匹配或已停用模型保持不可用。同一 ID 下的 provider、模型名、
endpoint 或其他运行身份变化会异步重建后续调用使用的版本并要求重新确认。运行中的旧调用继续使用其启动时的绑定；
执行时若内容摘要已不匹配则拒绝执行，不静默改变模型。

通用诊断携带 `Source / Command / Tool / Subagent` 资源类型，产品入口只按该类型路由；`opencode.*` 诊断码仅用于技术详情，
不能成为 Core、GUI 或 TUI 的业务分支条件。能力 provider 契约限制来源、定义、provenance 和诊断集合，校验诊断码、
可见文本、资源类型及来源归属，异常快照整体拒绝。Adapter 不把原始绝对路径写入诊断文本；产品快照边界还会把结构化
位置及诊断中的已知路径统一转换为 `<workspace>/…`、`~/…`、`<remote>/…` 等安全标签，`.opencode` 路径识别仍只属于
本 adapter。

Agent Registry 按 role 从同一个 workspace route 和 generation registry 投影主 Agent 选择器与 Task 列表。主 Session、Turn
和界面只保存稳定 logical id；Session 额外持久化 provider-neutral 的 `Local|External` route owner，避免重启后缺失的外部定义被
同名本地模式静默接管，但不持久化 provider、generation 或 `runtime_agent_key`。每个主 Turn 或 fresh Task 在执行前取得运行租约，
固定 `runtime_agent_key`、prompt、工具、权限与模型绑定直到结束，更新和撤下只影响下一次调用；外部 route 不可用时保持失败关闭，
只有用户显式选择当前冲突候选才会改变 route owner。显式模型只作为新 Session 无显式选择时的 profile 默认值，后续用户模型
选择仍归 Session owner。Shared TUI 通过既有私有 Agent Runtime IPC 读取执行宿主的同一主 Agent 投影视图，协议只携带选择器所需
摘要，不携带来源状态或 prompt；Embedded TUI、Desktop 和 Peer Host 仍消费同一个 Agent Registry owner。当前不支持外部 session
follow-up、OpenCode 会话内核、完整 permission DSL 或 package plugin。Desktop/TUI 摘要不包含 prompt
正文，静态 system prompt 也不因该适配而改写。来源 `description` 只进入审批和管理界面；已批准 Agent
进入现有 `<available_agents>` 动态视图时使用 OpenBitFun 生成的稳定摘要，避免只改目录文案就绕过行为重批并改变模型上下文。

OpenCode 本地配置 Skill 根不是新的外部资产生命周期。Adapter 按已实现的本地配置来源顺序累加每份有效文档中的
V1 `skills.paths` 和当前 `skills: string[]`；字段类型错误只拒绝该文档的 Skill 根贡献，不影响同文档 Command 等其他能力。
`skills.urls` 与 HTTP(S) 项不获取；相对路径只从当前本地 workspace 解析，项目配置根必须留在项目内，用户配置根必须
留在项目或当前用户目录内，远程 workspace 的相对根不回退到本机解释。

`openbitfun-core/external_sources` 是唯一构造 adapter 并投影本地根事实的组合边界，Skill Registry 不 import 生态 adapter，继续
拥有递归发现、解析、覆盖、模式开关与实际加载。配置项最多保留 64 个；每根扫描深度 16、最多访问 4096 个条目和
2048 个目录、接纳 512 个 `SKILL.md`，单个 Skill 限制 256 KiB，可选 `agents/openai.yaml` 限制 64 KiB。扫描和实际加载都
拒绝符号链接/reparse point；加载时重新校验规范化根及其稳定 source slot，防止目录整体替换改变已发现来源身份。同 scope
内配置根位于标准 OpenCode 根之前，较后的不同配置根覆盖同名 Skill，但不重排更早的 OpenBitFun/Claude/Codex/Cursor 来源。

Skill Registry 只为与 workspace 无关的标准用户根维护进程级版本化候选快照，具体文件观察复用 File Watch Service。
相关文件变化只使快照失效，下一次 Agent/Skill 查询重建，不改变正在执行的 Turn；瞬时读取失败或观察器无法覆盖任一目标根时
不发布缓存，后续查询保持原有重扫行为。OpenCode 配置根的作用域取决于当前 workspace，因此继续在每次请求中按完整配置来源
顺序统一发现和扫描，避免把项目内绝对路径误缓存为用户来源，也保证 64 根上限只计算一次。标准项目根与 Remote 项目来源同样
按请求读取，后者继续通过 `WorkspaceFileSystem` 访问且不回退到控制端同名目录。

### 5.2.1 References

Workspace Reference 不是第二套 Workspace，也不是文件权限入口。OpenCode adapter 只解析有界 JSON/JSONC 配置，
把相对 path 固定到声明它的配置文档目录；`~/` 与绝对路径保留 OpenCode 语义。与 OpenCode 相同，声明路径不要求
发现时已经存在：存在路径用规范身份，尚未创建的路径保留词法绝对路径，因此目标目录创建/删除不需要另一套生命周期。
Provider snapshot 经过 `ExternalSourceControlPlane` 的独立 Reference 生命周期通道发布。配置文件临时 I/O 失败可保留
上一代结果；稳定的 JSON/UTF-8/大小错误按本次静态诊断处理，明确删除、策略禁用或不支持的 Git entry 不借旧值放宽结果。
配置枚举阶段只有 `NotFound` 表示来源不存在，权限或其他元数据错误同样按临时 I/O 失败处理。Provider 最多发布
256 条诊断（含一条截断汇总），避免单个有界配置文件放大为无界 IPC/DOM 内容。

Product Assembly 生成唯一的有效引用目录：OpenBitFun `WorkspaceInfo.related_paths` 按用户顺序在前，OpenCode 引用按其
最终 alias 顺序在后。工作树以会话实际根发现 OpenCode 配置，同时用稳定 workspace id 取得主工作空间的原生关联目录；
会话根必须等于已注册根，或由服务端现有 Git worktree owner 实时解析为同一 repository 的 live worktree 根；缓存中的
prunable 路径不能授权扫描。缺少注册元数据、id 失效、
路径不匹配或元数据标记为 Remote 时整体 fail closed，不按前缀或同名控制端路径猜测本地工作空间。不同 alias
指向同一路径不会去重，因为 alias 本身是用户可见身份。只有策略为 `Auto`/`AskBeforeUse` 的生态进入有效快照；
`DiscoverOnly` 可以刷新来源但不能投影为可用目录。关联目录弹窗只读展示可见外部项，现有 `@` 目录选择器直接导航
同一快照；`hidden` 项不进入这些消费点。

本切片不下载 Git repository、不创建缓存目录、不接入 Remote workspace，也不启动任何 plugin host runtime。
Git/裸 repository 形状返回稳定的 `git_unsupported` 诊断；本地引用只提供目录发现和用户显式导航，不自动写入
Agent Prompt，不把配置声明解释成工作区外文件授权。只有用户在现有目录选择器中显式选择后，才沿用既有 context/tool
权限裁决。

### 5.3 Commands

当前 Prompt Command 子集展开 `$ARGUMENTS` 与 `$1`、`$2` 等位置参数，并支持模板中可静态确认的 workspace 相对 UTF-8
`@file`。OpenCode adapter 只从原模板提取引用，不扫描用户参数；Product Assembly 在 stale/冲突校验后通过共享本地文本服务
原子读取并追加内容。动态占位、绝对/`~`/URL/越界路径仍进入目录但整体受限。包含 `{env:...}`、`{file:...}`、
`model`、`variant`、`subtask: false` 或仅有 `subtask: true` 而没有显式 `agent` 的命令同样保持受限，不能删除不支持的部分后继续发送。

显式 `agent` 且 `subtask` 缺省或为 `true` 的命令携带来源无关的 fresh external subagent 执行目标；该字段只描述本次
Prompt Command 的执行意图，不公开新的 Subagent API。Product Assembly 仅在同 workspace 存在同 OpenCode 生态、逻辑 ID
精确匹配、已审批且当前 generation 有效的 External route 时保留命令可用性。提交后，Scheduler 要求本地 Session 处于 Idle，
Coordinator 复用既有 Task、Subagent Registry、generation lease、权限上限、取消、事件与会话持久化链路创建一次 fresh child；
任何失配或状态竞争都整次失败，不回退到当前 Agent、其他生态同名 Agent、旧 generation、Remote 或本机替代执行。包含
`!shell` 的委派命令在目录阶段整体受限，避免在 Session/界面准入失败前产生不可回滚的进程副作用。GUI 的附件/
引用上下文与 Shared TUI 在该路径明确拒绝，因为当前 Task 输入契约不能无损表达它们；普通 inline command 行为不变。

每次调用最多接纳 8 个不同文件，单文件 64 KiB、文件总量 128 KiB、最终命令 1 MiB。共享服务对每级路径执行
workspace 规范化包含校验并拒绝符号链接/reparse point；任一引用缺失、越界、超限或不是 UTF-8 时整次调用失败，不返回
部分装配结果。Adapter 在分配参数展开结果前先执行保守上界检查，Product Assembly 再按实际最终长度复核。规范化后再打开
仍存在同一用户并发替换文件的本地 TOCTOU 窗口；读取始终受大小限制，且不会因此放宽到任意宿主机绝对路径。

Markdown front matter 的 `description`、`agent`、`model`、`variant`、`subtask` 按当前 OpenCode schema 校验；
已知字段类型错误使该命令不可用，不能当作缺省值继续执行。初次 YAML 解析失败时，adapter 按 OpenCode 当前规则将
未引用且包含冒号的顶层值改写为 block scalar 后重试，避免拒绝 OpenCode 自身可加载的文件。

配置文件限制为 1 MiB，单个 Markdown 命令限制为 256 KiB，单个目录来源最多扫描 2048 个 Markdown 文件，且单个
provider 的模板正文总量限制为 8 MiB；超过限制进入明确诊断，不能无界占用内核目录或 TUI 刷新。Desktop 设置页只接收命令摘要，模板
正文不进入 IPC。执行前以来源限定命令 ID 和命令内容版本校验当前菜单项；若文件在菜单展示后更新，旧菜单项必须返回
stale selection 并等待重新选择，不能直接执行刚刷新的新内容。

后续阶段接通 shell 输出时仍按 OpenCode 顺序展开。`!shell` 必须进入脚本执行域，不另建绕过可靠性控制
的同步 shell 路径；展开有期限、取消和输出大小限制，大输出保存后只把引用交给命令模板。

OpenCode 生态内部仍按其规则覆盖同名内置命令，但跨独立 provider 或与 OpenBitFun 本地命令同名时不得静默覆盖。
发生冲突后，兼容视图和 slash picker 保留普通 `/name` 心智，以来源标签展示全部候选；不公开
`/builtin:<name>`、`/external:<name>` 或任何生态前缀命令。直接输入未解决的同名 `/name` 时拒绝执行，并引导用户从候选菜单选择；选择按候选身份和
`content_version` 形成的冲突内容摘要持久化，同一内容摘要只询问一次；任一外部候选更新、删除或参与集合变化后内容摘要变化并
重新询问，即使变化后只剩一个外部或内建候选也不能静默切换实现。持久化只保留每个执行域/命令族的当前内容摘要和
去重后的曾冲突候选身份，不累计每次内容版本的完整历史。

### 5.4 MCP、LSP 与 Formatter

这些能力使用 OpenBitFun 原生归属模块，但“原生已有”不自动等于兼容：

- MCP 当前覆盖 local 的 `command/environment/cwd/enabled` 与 remote 的 HTTPS URL、Headers、动态 OAuth 开关和
  `enabled`，并在批准后按 workspace 交给现有 MCP 归属模块；工具在调用前复核 workspace route，Remote 不回退到本机实例。
  远端静态摘要只展示 HTTPS origin，环境引用只展示变量名；为避免审批后通过环境变量改变已经确认的运行条件，`{env:NAME}` 仅
  支持 environment/Header 值，展开后重新校验大小和协议。未配置 `cwd` 时遵循 OpenCode，使用当前 workspace。
  外部本地进程默认不继承 OpenBitFun 的完整父进程环境。显式 V1 `timeout` 通过现有 MCP runtime owner 分别约束启动、目录读取
  和执行；缺省值继续使用 OpenBitFun 既有行为。当前是每次请求的硬期限，不因 progress 重置；超时只停止 OpenBitFun 的当前等待，
  不承诺服务端工作已经取消，也不自动重放或重启。SSE、OpenCode
  `clientId/clientSecret/scope/callbackPort/redirectUri`（V2 对应 snake_case 字段）和 Agent 范围仍需后续接入，不能静默忽略。
  V2 由独立解析模块读取 `mcp.servers` 与 `disabled`，同名条目整条替换，`mcp.timeout` 和服务器 timeout 按阶段继承；
  默认 startup/catalog 为 30 秒、execution 为 12 小时。V1 保持递归合并与标量 timeout，同一来源链混用 V1/V2 时明确报错。
  外部禁用不阻止有效声明的显式导入；导入预览说明启停、登录、重连、Code Mode 与工具权限由 OpenBitFun 管理。
- LSP 只解析到来源清单和 `unsupported` 诊断。OpenBitFun LSP Runtime 已退役，因此 command、extensions、env、
  initialization 不进入产品 DTO，不触发审批、安装或进程启动，在本地、Remote Workspace、Peer Device 和 Detached
  Dispatch 中都不得执行或回退。
- Formatter 必须覆盖写入后时机、`$FILE` 替换、`environment`、多个 Formatter 顺序和失败行为。

### 5.5 其他稳定配置项

OpenCode 配置文档还包含下列不属于声明式目录资产、但会改变运行行为的稳定字段。它们不能因“OpenBitFun 已有
类似功能”而被遗漏：

| 配置项 | 适配方式 | 明确边界 |
|---|---|---|
| 独立 TUI 配置 | 按独立来源顺序处理 `$schema/theme/keybinds/plugin/plugin_enabled/leader_timeout/attention/prompt/scroll_speed/scroll_acceleration/diff_style/mouse` | 主配置来源顺序和构建期 TUI 布局选择不参与其运行时优先级。 |
| `shell` | 交给实际执行域的 Terminal/Tool Runtime，保留短名称、绝对路径和平台默认发现 | 命令不存在时只使相关 shell/工具调用不可用，不阻止项目启动。 |
| `logLevel`、`username` | 分别进入日志配置和会话展示身份 | 不改变插件权限或系统账户。 |
| `tools` | 映射到 Tool 归属模块的模型可见性和启用状态 | 不能用“隐藏工具”代替真实权限控制，也不能启用产品未提供的工具。 |
| `attachment.image` | 映射到 Message/Model 输入处理的自动缩放和大小上限 | 模型或入口不支持图像时明确降级，不发送被静默修改的无效附件。 |
| `share` | `manual/auto/disabled` 映射到 OpenBitFun 会话分享归属模块 | OpenBitFun 没有等价分享后端的产品形态只能显示不支持，不能伪造分享 URL。 |
| `snapshot` | 映射到 Workspace snapshot/checkpoint provider，并保持关闭后不可通过 UI 回滚的提示 | 只有行为等价测试通过的 provider 才能标记兼容；不要求复制 OpenCode 内部 Git 实现。 |
| `tool_output` | `max_lines/max_bytes` 映射到工具结果截断和完整内容保存 | 必须返回可访问的完整结果引用，不能只丢弃超限内容。 |
| `compaction` | `auto/prune/tail_turns/preserve_recent_tokens/reserved` 映射到 Agent Runtime 的压缩和工具输出裁剪策略 | OpenBitFun 的会话持久化事实不变；无法等价的字段单独降级。 |
| `watcher.ignore` | 映射到实际工作区执行域的文件观察器 glob | Remote 在远端应用，不能只过滤本机观察器。 |
| `enterprise.url` | 作为企业配置与身份服务入口交给对应归属模块 | 没有等价企业服务时保留并显示未支持，不能当作普通 Provider URL。 |
| `server` | 仅在显式 OpenCode 外部协议兼容服务中映射 port/hostname/mDNS/CORS | 插件 worker 的回环 `serverUrl` 由 Runtime 管理；普通 OpenBitFun 启动不读取该字段改变自身监听地址。 |
| `autoupdate` | 保留来源并显示“不适用于 OpenBitFun 产品更新” | 它控制 OpenCode 自身更新，不能让项目配置改变 OpenBitFun 安装器或更新通道。 |
| 旧 `autoshare`、`layout`、`mode`、`reference` | 按稳定版迁移到 `share`、固定布局、`agent`、`references` | 诊断显示迁移结果，不把旧字段静默解释成 OpenBitFun 自有语义。 |
| `experimental` | 分别记录 `disable_paste_summary/batch_tool/openTelemetry/primary_tools/continue_loop_on_deny/mcp_timeout/policies` | 未知实验字段保留并告警，不自动发布为稳定 OpenBitFun 接口。 |

`server` 和 `autoupdate` 的降级是产品归属不同，不是解析失败。兼容报告必须显示原值、未生效范围和可选替代
入口；其他可独立生效的配置继续使用。

## 6. 冲突、覆盖与加载顺序

- OpenCode 配置来源顺序和插件加载顺序分别维护；配置归属模块不重新排列插件。
- 同名配置键按来源覆盖；非冲突键合并。
- 生态 adapter 只执行本生态规范明确规定的覆盖；独立生态/产品本地能力的同名候选交给通用冲突契约，不按 adapter 注册顺序决胜。
- 同名命令、Theme、Keybind 和插件条目按各自 OpenCode 规则处理，不能使用一个通用“后者覆盖”规则猜测。
- 用户/组织保护项是一层显式策略，不改写来源顺序；兼容报告同时展示“OpenCode 结果”和“策略后结果”。
- 产品定义只给出构建期默认和明确保护的产品能力，不参与项目运行时资产的同名冲突。

## 7. 凭据与敏感信息

- 配置解析可以发现凭据引用、Headers 名称和认证方法，但不把值写入普通状态记录、诊断或导入报告。
- 仓库当前没有横跨 Provider、MCP、插件和 Remote 的通用凭据归属模块；不能在 OpenCode Adapter 内补一个
  隐式通用凭据库。
- OC-R3 先补本地“执行域凭据访问”窄接口：请求只携带执行域、领域（Provider/MCP/plugin auth）、来源引用和
  用途，再路由到现有 AI adapter credential resolver、MCP OAuth vault 或对应插件 auth 流程。值只在同一执行域
  的实际调用中提供，不写入兼容结果、普通状态或诊断。
- 显式导入不复制 OpenCode 私有凭据文件到 OpenBitFun 配置。
- `auth` 插件、Provider Headers 和 MCP OAuth 的运行期调用见插件执行设计；配置文档只保存引用和来源。

## 8. Remote 与多执行域

- 项目 `.opencode` 在实际工作区所在执行域发现、解析和监听；远程项目不回到本机扫描同名路径。
- 用户全局根必须明确属于本地用户还是远程用户，不能按路径字符串猜测。
- 本地界面可以展示远程兼容结果和诊断，但依赖安装、Formatter、local MCP、Command shell 和插件 worker
  在远程执行域运行。
- 远程来源中的 LSP 字段仍只显示 `unsupported`；不在远端启动，也不回退到本机。
- OC-R5 在远端实现同一窄访问接口，并路由到远端已有领域存储或执行环境；R5 之前远程插件路径返回明确
  `unsupported`。不存在通用 Remote credential broker，也不从本机静默复制原值。
- 两端先交换兼容版本和能力；远端不支持的资产局部降级，不能把整个会话标记为失败。

## 9. 验证要求

每类资产至少覆盖：

1. 主配置完整来源序列、后处理，以及 TUI 独立来源序列。
2. JSON/JSONC、未知字段、无 `$schema`、无效局部字段和变量替换。
3. 从子目录启动时的项目根发现和相对路径解析。
4. 来源变化后的后台重载、上一有效结果保留和同一次状态提交切换。
5. 首次发现、L1 自动应用/撤销、L2/L3 待确认、能力扩大和聚合提示。
6. 删除、暂时不可读、重新出现和用户/组织策略收紧后的不同降级，不误报为解析错误。
7. Windows、macOS、Linux 路径和命令差异。
8. References 本地/Git 来源、Skills paths/urls、旧字段迁移和所有稳定顶层键。
9. Remote 执行域不静默回本机。

完整样例集固定到 OpenCode `v1.18.9` release commit
`4da7bb44c84e013fa53e9c5d02ac753d1435c81a`；开发分支变化只触发差异报告，不能静默改变稳定兼容行为。
