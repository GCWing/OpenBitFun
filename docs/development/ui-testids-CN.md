[English](ui-testids.md) | **中文**

# UI Test IDs

本文档记录 OpenBitFun UI 自动化使用的稳定 `data-testid` 值。
测试 ID 按产品区域分组，只应在自动化流程确实需要稳定定位点时添加。

规则：

- `data-testid` 只能作为测试定位器使用。不要让产品逻辑依赖它。
- 优先标记真实可交互元素：`button`、`input`、可编辑区域或对话框根节点。
- `data-testid` 必须保持稳定、小写，并使用连字符分隔。
- 对重复项使用一个共享 `data-testid`，再配合稳定的 `data-*` 属性区分。
- 不要把可见文案、CSS class、坐标、截图或 XPath 路径作为主定位方式。
- 优先在配套 `data-*` 属性中使用稳定产品标识，例如 `data-workspace-id`、`data-session-id`、`data-agent-id`、`data-skill-key` 或 `data-settings-tab`。

## 覆盖规划

### 必须补

这些区域是 UI 自动化的高价值入口。在新增或扩展跨平台 pytest 用例前，
应优先提供稳定 ID。

| 区域 | 范围 | 原因 |
|---|---|---|
| App shell | App 根节点、主内容区、场景视口 | App 加载和路由就绪锚点。 |
| Navigation | 顶部动作、底部菜单、工作区菜单、工作区行、会话行 | 打开设置、会话、项目、Agents、Skills 和工作区级动作的主路径。 |
| Welcome scene | 场景根节点、打开/新建项目按钮、最近工作区列表 | OH 当前默认启动后会落在这里。 |
| Notifications | 通知按钮、通知中心根节点、关闭按钮、活动区块 | 当前 smoke 覆盖和异步任务可见性。 |
| Settings | 场景根节点、导航 tab、活动内容 | 当前 smoke 覆盖和后续配置测试。 |
| Session and Flow Chat | Session 场景、聊天/辅助面板、消息列表、输入区 | 会话创建稳定后的核心产品路径。 |
| Agents and Skills | 场景根节点、区域/tab、过滤器、卡片、关键动作 | Agent 设置和技能市场流程的高价值入口。 |

### 可选补

这些区域等到有具体测试需要时再补。

| 区域 | 范围 | 原因 |
|---|---|---|
| Deep Review / BTW 详情面板 | Review 操作栏、评审成员详情、报告导出动作 | 对深入行为测试有价值，但不是 app smoke 必需。 |
| Tool cards | 特定 approve/retry/open-detail 控件 | 按具体工具流程添加，不要给每个渲染字段都打点。 |
| File、Git、Terminal、Browser 面板 | 面板根节点、主工具栏动作、选中列表行 | 等面板专项 pytest 覆盖出现后再补。 |
| Settings 表单控件 | 具体模型/Provider 字段、保存/重置按钮 | 配置测试需要时添加；避免标记每个展示型 label。 |
| Mini apps | Gallery 根节点、app 卡片、runner 根节点 | 等 Mini App 流程进入自动化计划后再补。 |

### 不建议补

除非有明确自动化流程，否则避免给这些对象添加 ID。

| 范围 | 原因 |
|---|---|
| 装饰图标、徽章、计数器、阴影、动画 | 不是有意义的交互或状态锚点。 |
| 每个文本节点、段落和静态 label | 增加维护成本，并且重复绑定 i18n 可见文案。 |
| 生成的 markdown/code 内容和模型输出 span | 输出是动态的，应通过更高层状态断言。 |
| 坐标、canvas 像素、仅截图可见标记或原生窗口控件 | 跨平台 WebView 自动化应保持基于 DOM 和 `data-testid`。 |
| 把本地化文案复制到 `data-testid` 或作为主定位方式 | 文案或语言切换会导致定位失效。 |

## 命名

- 使用区域前缀：`app-*`、`scene-*`、`nav-*`、`welcome-*`、`settings-*`、`notification-*`、`session-*`、`chat-*`、`flowchat-*`、`agents-*`、`skills-*`。
- 按动作给按钮加后缀：`*-btn`、`*-toggle`、`*-open`、`*-close`、`*-submit`、`*-cancel`、`*-delete`。
- 按结构给容器加后缀：`*-scene`、`*-panel`、`*-list`、`*-grid`、`*-menu`、`*-content`、`*-zone`。
- 对重复行/卡片，复用一个 `data-testid` 并搭配稳定属性，例如：
  - `nav-workspace-item` + `data-workspace-id`
  - `nav-session-item` + `data-session-id`
  - `settings-nav-tab` + `data-settings-tab`
  - `agent-list-item` + `data-agent-id` / `data-agent-name`
  - `skill-list-item` + `data-skill-id` / `data-skill-name`
  - `skills-market-card` + `data-skill-install-id`

## App Shell

| 元素名称 | data-testid | 说明 |
|---|---|---|
| App 布局根节点 | `app-layout` | App 加载完成锚点。 |
| 主内容区 | `app-main-content` | 主场景内容容器。 |
| 导航面板 | `nav-panel` | 左侧导航容器。 |
| 场景视口根节点 | `scene-viewport` | 场景宿主根节点。 |
| 场景视口裁剪区 | `scene-viewport-clip` | 已挂载场景的裁剪区域。 |
| 空场景视口 | `scene-viewport-empty` | 没有打开 tab 时渲染。 |
| 已挂载场景 wrapper | `scene-viewport-scene` | 重复项。配合 `data-scene-id` 和 `data-scene-active` 使用。 |

## Welcome

| 元素名称 | data-testid | 说明 |
|---|---|---|
| Welcome 场景根节点 | `welcome-scene` | 默认启动场景锚点。 |
| 打开项目按钮 | `welcome-open-project-btn` | 打开文件/文件夹选择器。 |
| 新建项目按钮 | `welcome-new-project-btn` | 打开新建项目流程。 |
| 最近工作区列表 | `welcome-recent-workspace-list` | 有最近工作区时存在。 |
| 最近工作区行 | `welcome-recent-workspace-row` | 重复项。配合 `data-workspace-id` 使用。 |
| 最近工作区打开按钮 | `welcome-recent-workspace-open` | 重复项。配合 `data-workspace-id` 使用。 |
| 最近工作区移除按钮 | `welcome-recent-workspace-remove` | 重复项。配合 `data-workspace-id` 使用。 |
| 最近工作区空状态 | `welcome-recent-workspace-empty` | 没有最近工作区时存在。 |

## Navigation

| 元素名称 | data-testid | 说明 |
|---|---|---|
| 导航搜索触发按钮 | `nav-search-trigger` | 打开导航搜索。 |
| 新建 Code 会话按钮 | `nav-new-code-session-btn` | 为活动项目工作区创建或打开 code 会话。 |
| 新建 Cowork 会话按钮 | `nav-new-cowork-session-btn` | 为活动项目工作区创建或打开 cowork 会话。 |
| Assistant 按钮 | `nav-assistant-btn` | 打开 assistant/persona 场景。 |
| Agent/Skill 入口 | `agent-skill-entry` | 展开 Agents/Skills 导航入口组。 |
| Agent/Skill 面板 | `agent-skill-panel` | Agents/Skills 入口组或当前发现页根节点。 |
| Agent/Skill tabs | `agent-skill-tabs` | Agent 和 Skill 入口 tab 容器。 |
| Agent tab | `agent-tab` | 打开 Agents 发现页。 |
| Skill tab | `skill-tab` | 打开 Skills 发现页。 |
| 导航 sections 容器 | `nav-sections` | 工作区/会话 section 容器。 |
| 导航底部栏 | `nav-bottom-bar` | Mini App/footer 区域容器。 |
| 底部更多按钮 | `nav-footer-more-btn` | 打开底部溢出菜单。 |
| 底部菜单 | `nav-footer-menu` | 由底部更多按钮打开的溢出菜单。 |
| 底部设置菜单项 | `nav-footer-settings-item` | 从底部菜单打开 Settings 场景。 |
| 底部 Shell 按钮 | `shell-panel-entry` | 打开或关闭 shell 场景导航。 |
| 底部 Browser 按钮 | `browser-panel-entry` | 根据当前上下文打开 browser 场景或 browser 面板。 |

## Navigation Workspaces

| 元素名称 | data-testid | 说明 |
|---|---|---|
| 工作区添加按钮 | `nav-workspace-add-btn` | 打开工作区添加/最近工作区菜单。 |
| 工作区添加菜单 | `nav-workspace-menu` | 从添加按钮打开的 portal 菜单。 |
| 工作区菜单打开项目 | `nav-workspace-menu-open-project` | 打开项目选择器。 |
| 工作区菜单新建项目 | `nav-workspace-menu-new-project` | 打开新建项目流程。 |
| 工作区菜单远程 SSH | `nav-workspace-menu-remote-ssh` | 打开 SSH 远程连接流程。 |
| 工作区菜单最近工作区 | `nav-workspace-menu-recent-workspace` | 重复项。配合 `data-workspace-id` 使用。 |
| 工作区列表 | `nav-workspace-list` | 按列表类型重复。配合 `data-workspace-list` 使用。 |
| 工作区列表空状态 | `nav-workspace-list-empty` | 配合 `data-workspace-list` 使用。 |
| 工作区拖拽目标 | `nav-workspace-drop-target` | 重复拖拽目标。配合 `data-workspace-id` 使用。 |
| 工作区行 | `nav-workspace-item` | 重复项。配合 `data-workspace-id`、`data-workspace-kind` 和 `data-workspace-active` 使用。 |
| 工作区卡片 | `nav-workspace-card` | 可点击行主体。配合 `data-workspace-id` 使用。 |
| 工作区会话展开按钮 | `nav-workspace-sessions-toggle` | 展开/折叠会话行。配合 `data-workspace-id` 使用。 |
| 工作区名称按钮 | `nav-workspace-name-btn` | 激活工作区或切换会话展开状态。配合 `data-workspace-id` 使用。 |
| 工作区文件按钮 | `nav-workspace-files-btn` | 打开该工作区的文件查看器。配合 `data-workspace-id` 使用。 |
| 工作区搜索索引按钮 | `nav-workspace-search-index-btn` | 存在时打开搜索索引状态弹窗。配合 `data-workspace-id` 使用。 |
| 工作区行菜单按钮 | `nav-workspace-menu-btn` | 打开行操作菜单。配合 `data-workspace-id` 使用。 |
| 工作区行菜单 | `nav-workspace-item-menu` | 单个工作区的 portal 菜单。配合 `data-workspace-id` 使用。 |
| 工作区创建会话 | `nav-workspace-menu-create-session` | Assistant 工作区会话动作。 |
| 工作区创建 Code 会话 | `nav-workspace-menu-create-code-session` | 普通工作区 code 会话动作。 |
| 工作区创建 Cowork 会话 | `nav-workspace-menu-create-cowork-session` | 普通工作区 cowork 会话动作。 |
| 工作区创建 ACP 会话 | `nav-workspace-menu-create-acp-session` | 重复项。配合 `data-acp-client-id` 使用。 |
| 工作区相关路径 | `nav-workspace-menu-related-paths` | 打开相关路径对话框。 |
| 会话 worktree 开关 | `chat-input-worktree-toggle` | 会话输入框状态条，切换当前会话的 worktree 隔离。配合 `data-worktree-enabled` 使用。 |
| 工作区复制路径 | `nav-workspace-menu-copy-path` | 复制工作区路径。 |
| 工作区 reveal | `nav-workspace-menu-reveal` | 在文件管理器中显示工作区。 |
| 工作区会话存储目录 | `nav-workspace-menu-open-session-storage` | 打开主机管理的会话总目录，包括远程工作区的本机镜像。仅支持本机桌面端。 |
| 工作区关闭 | `nav-workspace-menu-close` | 关闭工作区。 |
| 工作区重置 assistant | `nav-workspace-menu-reset-assistant` | 重置默认 assistant 工作区。 |
| 工作区删除 assistant | `nav-workspace-menu-delete-assistant` | 删除具名 assistant 工作区。 |
| 工作区会话区域 | `nav-workspace-session-region` | 包含单个工作区的会话。配合 `data-workspace-id` 使用。 |

## Navigation Sessions

| 元素名称 | data-testid | 说明 |
|---|---|---|
| 会话列表 | `nav-session-list` | 工作区维度的列表。配合 `data-workspace-id` 使用。 |
| 会话行 | `nav-session-item` | 重复项。配合 `data-session-id`、`data-session-kind`、`data-session-level` 和 `data-session-active` 使用。 |
| 会话菜单按钮 | `nav-session-menu-btn` | 打开行操作菜单。配合 `data-session-id` 使用。 |
| 会话菜单 | `nav-session-menu` | 单个会话的 portal 菜单。配合 `data-session-id` 使用。 |
| 会话重命名项 | `nav-session-menu-rename` | 开始重命名会话。 |
| 会话复制 ID 项 | `nav-session-menu-copy-id` | 复制会话 ID。配合 `data-session-id` 使用。 |
| 会话存储目录 | `nav-session-menu-open-storage` | 打开该会话的存储目录。配合 `data-session-id` 使用。对端设备和 Detached Dispatch 会话不可用。 |
| 会话定时任务项 | `nav-session-menu-scheduled-jobs` | 打开该会话的定时任务。配合 `data-session-id` 使用。 |
| 会话归档项 | `nav-session-menu-archive` | 归档会话。配合 `data-session-id` 使用。 |
| 会话删除项 | `nav-session-menu-delete` | 删除会话。 |
| 会话列表展开按钮 | `nav-session-list-toggle` | 展开/折叠长会话列表。 |

## Session And Chat

| 元素名称 | data-testid | 说明 |
|---|---|---|
| Session 场景根节点 | `session-scene` | Session 场景锚点。 |
| Session 聊天面板 | `session-chat-pane` | Session 场景中的左侧聊天面板。 |
| Session 右侧面板 resizer | `session-right-pane-resizer` | 聊天和辅助面板之间的分隔条。 |
| Session 辅助面板 | `session-aux-pane` | 右侧 content canvas 面板。包含 `data-mode`。 |
| Chat pane 根节点 | `chat-pane` | FlowChat 宿主面板。 |
| FlowChat 容器 | `flowchat-container` | FlowChat 根节点。包含 `data-session-id`。 |
| FlowChat 消息区域 | `flowchat-messages` | 消息列表/welcome panel 宿主。 |
| FlowChat 消息列表 | `flowchat-message-list` | 有消息时的虚拟消息列表根节点。 |
| FlowChat 空消息列表 | `flowchat-message-list-empty` | 空虚拟列表状态。 |
| FlowChat 消息项 | `flowchat-message-item` | 重复的虚拟消息项。配合 `data-turn-id`、`data-item-type` 和 `data-item-index` 使用。 |
| Chat 输入容器 | `chat-input-container` | composer 根容器。 |
| Chat 输入可编辑区域 | `chat-input-textarea` | 富文本可编辑区域。 |
| Chat 发送按钮 | `chat-input-send-btn` | 输入有效时的发送动作。 |
| Chat 取消按钮 | `chat-input-cancel-btn` | 存在时用于取消进行中的发送/生成。 |
| Chat 继续中断任务按钮 | `chat-input-continue-interrupted-btn` | 输入框为空时继续最近一个可恢复的中断 Turn。 |
| Chat 输入工作区条 | `chat-input-workspace-strip` | composer 上方的活动工作区条。 |
| Chat 输入目标切换器 | `chat-input-target-switcher` | 目标/模式切换器。 |
| Chat 输入图片条 | `chat-input-image-strip` | 已附加图片条。 |
| Chat 输入启动 BTW 按钮 | `chat-input-boost-start-btw` | 存在时启动 BTW 流程。 |
| Pending queue 面板 | `pending-queue-panel` | 待处理后台任务队列。 |

| Chat 模型选择按钮 | `chat-model-selector-btn` | 打开当前会话的模型选择器。 |
| Chat 模型选择菜单 | `chat-model-selector-menu` | 模型选择下拉菜单根节点。 |
| Chat 模型选择项 | `chat-model-selector-option` | 重复项。配合 `data-model-id`、`data-model-name` 和 `data-selected` 使用。 |
| Chat 模型选择供应商项 | `chat-model-selector-provider` | 重复项。第一层的供应商行，点击后展开其模型。配合 `data-provider-key` 和 `data-selected` 使用。 |
| Chat 模型选择返回按钮 | `chat-model-selector-back` | 从某个供应商的模型列表返回供应商列表。 |
| Chat 用户消息 | `chat-user-message` | 重复的用户消息。配合 `data-turn-id`、`data-status` 和 `data-failed` 使用。 |
| Chat 用户消息内容 | `chat-user-message-content` | 用户消息文本内容。配合 `data-turn-id` 使用。 |
| Chat assistant 消息 | `chat-assistant-message` | 重复的模型轮次容器。配合 `data-turn-id`、`data-round-id`、`data-status`、`data-model-id`、`data-model-alias` 和 `data-streaming` 使用。 |
| Chat assistant 消息内容 | `chat-assistant-message-content` | assistant 文本块。配合 `data-turn-id`、`data-flow-item-id`、`data-status` 和 `data-streaming` 使用。 |
| Chat explore group | `chat-explore-group` | ExploreGroup 根节点，用于包裹折叠/合并后的工具轮次。包含 `data-group-kind`、`data-expanded`、`data-read-count`、`data-search-count` 和 `data-command-count`。 |
| Chat explore group toggle | `chat-explore-group-toggle` | ExploreGroup 真实展开/收起点击目标。包含 `data-group-kind` 和 `data-expanded`。 |
| Chat explore group content | `chat-explore-group-content` | ExploreGroup 内层内容容器。包含 `data-group-kind` 和 `data-expanded`。 |
| Chat thinking 面板 | `chat-thinking-panel` | thinking/reasoning 面板根节点。包含 `data-status`、`data-streaming` 和 `data-expanded`。 |
| Chat thinking 展开按钮 | `chat-thinking-toggle` | 可点击的 thinking 展开/收起 header。 |
| Chat thinking 内容 | `chat-thinking-content` | thinking/reasoning 文本内容。包含 `data-status` 和 `data-streaming`。 |
| Chat shell 命令卡片 | `chat-shell-command-card` | Shell 命令工具卡根节点。包含 `data-status`、`data-expanded` 和 `data-terminal-session-id`。 |
| Chat shell 命令展开按钮 | `chat-shell-command-toggle` | Shell 命令卡片的展开/收起点击目标。 |
| Chat shell 命令文本 | `chat-shell-command-text` | Shell 命令文本节点。 |
| Chat shell 命令输出 | `chat-shell-command-output` | Shell 命令 stdout/stderr 或实时输出区域。 |
| Chat shell 命令退出码 | `chat-shell-command-exit-code` | 退出码节点。包含 `data-exit-code` 和 `data-status`。 |
| Chat shell 工具卡片 | `chat-shell-tool-card` | ExecCommand 的外层 FlowToolCard wrapper。包含 `data-tool-name` 和 `data-tool-card-id`。 |
| Chat shell 工具打开面板按钮 | `chat-shell-tool-open-panel` | 存在 terminal session 时，从 ExecCommand 卡片打开关联终端面板。 |
| Chat browser 工具卡片 | `chat-browser-tool-card` | WebFetch 的外层 FlowToolCard wrapper。包含 `data-tool-name` 和 `data-tool-card-id`。 |
| Chat 文件变更卡片 | `chat-file-change-card` | 文件操作卡片根节点。包含 `data-status`、`data-action`、`data-path` 和 `data-expanded`。 |
| Chat 文件变更展开按钮 | `chat-file-change-toggle` | 文件操作卡片的展开/收起点击目标。 |
| Chat 文件变更路径 | `chat-file-change-path` | 文件路径/名称节点。包含 `data-path`。 |
| Chat 文件变更动作 | `chat-file-change-action` | 文件操作动作节点。包含 `data-action`。 |
| Chat 文件变更预览 | `chat-file-change-preview` | 文件操作卡片的代码/diff 预览区域。 |
| Chat MiniApp 卡片 | `chat-miniapp-card` | MiniApp 结果卡片根节点。包含 `data-status`、`data-app-id` 和 `data-expanded`。 |
| Chat MiniApp 标题 | `chat-miniapp-title` | MiniApp 标题/名称节点。包含 `data-app-id`。 |
| Chat MiniApp 文件列表 | `chat-miniapp-file-list` | MiniApp 结果文件列表容器。 |
| Chat MiniApp 文件行 | `chat-miniapp-file-row` | MiniApp 结果文件行。包含 `data-path`。 |
| Chat MiniApp 打开按钮 | `chat-miniapp-open-btn` | 打开 MiniApp 场景。包含 `data-app-id`。 |

## Settings

| 元素名称 | data-testid | 说明 |
|---|---|---|
| Settings 场景根节点 | `settings-scene` | Settings 场景的根内容区。包含 `data-settings-tab`。 |
| Settings 场景内容 | `settings-scene-content` | 当前活动 settings tab 的内容 wrapper。 |
| Settings 导航根节点 | `settings-nav` | 左侧 settings 导航。 |
| Settings 导航 tab | `settings-nav-tab` | 重复项。配合 `data-settings-tab` 使用。 |

## Settings Models

| 元素名称 | data-testid | 说明 |
|---|---|---|
| 模型列表 | `settings-model-list` | 已配置模型行的容器。 |
| 创建第一个模型配置按钮 | `settings-model-create-first-config-btn` | 从空状态启动第一个模型提供商配置流程。 |
| 自定义模型配置按钮 | `settings-model-custom-config-btn` | 启动自定义提供商配置。包含 `data-provider-id="custom"`。 |
| 模型提供商选项 | `settings-model-provider-option` | 重复的提供商行。配合 `data-provider-id` 使用，例如 `openbitfun`。列表默认只展示前几项，取用列表外的提供商需先经搜索框或下方展开按钮。 |
| 模型提供商搜索框 | `settings-model-provider-search` | 按提供商名称、id 或模型名称过滤预设提供商列表。 |
| 模型提供商展开按钮 | `settings-model-provider-expand-btn` | 将截断的预设提供商列表展开为全部提供商，再次点击收起。 |
| 模型提供商名称输入框 | `settings-model-provider-name-input` | 提供商/配置展示名称字段，例如 mock LLM 提供商名称。 |
| 模型 API key 输入框 | `settings-model-api-key-input` | 模型配置表单里的 API key 字段。测试中不要硬编码真实 key，应从 local config 读取。 |
| 模型 Base URL 输入框 | `settings-model-base-url-input` | 自定义/OpenAI-compatible 提供商的 API base URL 字段。 |
| 模型请求格式选择器 | `settings-model-request-format-select` | 请求格式选择器，例如 OpenAI-compatible 或 Anthropic。 |
| 模型选择按钮 | `settings-model-select-btn` | 打开模型选择下拉框。 |
| 模型选择菜单 | `settings-model-select-menu` | 模型选择下拉框根节点。 |
| 模型选择项 | `settings-model-option` | 重复的下拉项。配合 `data-model-id`、`data-model-name` 和 `data-selected` 使用。 |
| 手动模型名称输入框 | `settings-model-manual-name-input` | 手动/自定义模型名称输入字段。 |
| 添加自定义模型按钮 | `settings-model-add-custom-btn` | 将手动模型名称加入已选模型列表。 |
| 已选模型列表 | `settings-model-selected-list` | 已选模型草稿列表。包含 `data-selected-count`。 |
| 已选模型空状态 | `settings-model-selected-list-empty` | 已选模型草稿为空时的状态。包含 `data-selected-count="0"`。 |
| 已选模型行 | `settings-model-selected-row` | 重复的已选模型草稿。配合 `data-model-id`、`data-model-name`、`data-selected` 和 `data-expanded` 使用。 |
| 已选模型移除按钮 | `settings-model-selected-remove-btn` | 移除已选模型草稿。配合 `data-model-id` 和 `data-model-name` 使用。 |
| 模型保存按钮 | `settings-model-save-btn` | 保存模型提供商/模型配置表单。 |
| 模型行 | `settings-model-row` | 重复的已保存模型行。配合 `data-model-id`、`data-model-name` 和 `data-config-id` 使用。 |
| 模型测试状态 | `settings-model-test-status` | 重复的已保存模型测试状态。配合 `data-model-id`、`data-model-name`、`data-config-id` 和 `data-status` 使用，`data-status` 可为 `success` 或 `error`。 |

## Settings Appearance

| 元素名称 | data-testid | 说明 |
|---|---|---|
| Appearance 页面根节点 | `appearance-config` | Settings 场景中 Appearance 页面内容根节点。 |
| Appearance 主题区域 | `appearance-theme-section` | 语言和主题配置区域根节点。 |
| Appearance 字体区域 | `appearance-font-section` | 字体偏好配置区域根节点。 |
| Appearance 语言选择器 | `appearance-language-select` | Appearance 中 language Select 的真实触发节点。 |
| Appearance 语言选项 | `appearance-language-option` | 重复的语言下拉选项。包含 `data-locale-id`，并带有 Select 组件提供的 `data-selected`。 |
| Appearance 主题选择器 | `appearance-theme-select` | Appearance 中 theme Select 的真实触发节点。 |
| Appearance 外观选项 | `appearance-palette-option` | 重复的外观下拉选项。包含 `data-appearance-id`，并带有 Select 组件提供的 `data-selected`。 |
| Appearance UI 字号分组 | `appearance-ui-font-level-group` | UI font size 预置级别控件根节点。预置级别渲染为设计系统 SegmentedControl 分段，可通过 `[data-openbitfun-part="segment"][data-openbitfun-value="<level>"]` 定位，选中分段带 `aria-checked="true"`。 |
| Appearance UI 自定义字号控制区 | `appearance-ui-font-custom-controls` | custom UI 字号控制区根节点，仅在 custom 激活时渲染。 |
| Appearance UI 自定义字号输入框 | `appearance-ui-font-custom-input` | custom UI 字号 px 输入框。包含 `data-font-level="custom"`。 |
| Appearance UI 自定义字号减一按钮 | `appearance-ui-font-custom-step-minus` | custom UI 字号减一按钮。 |
| Appearance UI 自定义字号加一按钮 | `appearance-ui-font-custom-step-plus` | custom UI 字号加一按钮。 |
| Appearance UI 字号预览区 | `appearance-ui-font-preview` | UI 字号预览区域。 |
| Appearance 字体重置按钮 | `appearance-font-reset-btn` | 重置字体偏好到默认值。 |

## Shell Panel

| 元素名称 | data-testid | 说明 |
|---|---|---|
| Shell 面板入口 | `shell-panel-entry` | 打开 Shell 场景/导航的底部入口。 |
| Shell 面板 | `shell-panel` | Shell 场景、Shell 导航或 Terminal 场景根节点。 |
| Shell 面板标题 | `shell-panel-title` | Shell 导航标题或当前终端 toolbar 标题。 |
| Shell 命令列表 | `shell-command-list` | Shell 导航终端列表或当前终端容器。 |
| Shell 命令项 | `shell-command-item` | Shell 导航行或当前 xterm 根节点。包含 `data-command-id`，可用时包含 `data-command-status`。 |
| Shell 命令文本 | `shell-command-text` | Shell 导航中的终端/session 标签。 |
| Shell 命令输出 | `shell-command-output` | 当前终端的真实 xterm 输出容器。 |
| Shell 命令退出码 | `shell-command-exit-code` | session 退出后终端状态栏中的退出码。包含 `data-exit-code` 和 `data-status`。 |
| Shell 命令状态 | `shell-command-status` | Shell 导航状态点、终端加载/错误状态或终端状态栏。包含 `data-command-status`。 |
| Shell 命令重新运行 | `shell-command-rerun` | 终端错误状态下的重试按钮，或活动终端 toolbar 上的 Ctrl+C 动作。 |
| Shell 面板关闭 | `shell-panel-close` | 当前终端关闭按钮。 |

说明：

- 独立 xterm 终端没有结构化的逐命令历史 DOM。测试应使用 `shell-command-output` 断言终端渲染输出，使用 `chat-shell-command-*` 断言结构化 ExecCommand 卡片。
- `shell-command-copy` 当前未暴露，因为活动终端复制能力基于选择/右键上下文菜单，并不是稳定可见按钮。

## Browser Panel

| 元素名称 | data-testid | 说明 |
|---|---|---|
| Browser 面板入口 | `browser-panel-entry` | 根据当前上下文打开 Browser 场景或 Browser 面板的底部入口。 |
| Browser 面板 | `browser-panel` | Browser 场景或右侧 Browser 面板根节点。 |
| Browser 面板标题 | `browser-panel-title` | Browser toolbar/form 区域。 |
| Browser URL 输入框 | `browser-url-input` | 真实 URL 输入框。按 Enter 打开输入的 URL。 |
| Browser 页面容器 | `browser-page-frame` | iframe/webview host 内容区域。 |
| Browser 加载状态 | `browser-loading-indicator` | URL 加载中时的刷新/加载图标。 |
| Browser 错误信息 | `browser-error-message` | URL 校验、连通性或 webview 加载失败信息。 |
| Browser 当前 URL | `browser-current-url` | webview placeholder 中展示的当前 URL。 |
| Browser 刷新按钮 | `browser-refresh-button` | 刷新当前 Browser 页面。 |
| Browser 后退按钮 | `browser-back-button` | Browser 历史后退。 |
| Browser 前进按钮 | `browser-forward-button` | Browser 历史前进。 |

说明：

- `browser-open-button` 当前未暴露，因为 URL 导航通过现有地址栏表单按 Enter 提交；当前没有独立可见的打开按钮。
- `browser-panel-close` 属于外层 scene/canvas tab chrome，不在 Browser 组件自身内部。

## Notifications

| 元素名称 | data-testid | 说明 |
|---|---|---|
| 通知按钮 | `notification-button` | 打开或切换通知中心。 |
| 通知中心对话框 | `notification-center` | 通知中心弹窗根节点。 |
| 通知中心关闭按钮 | `notification-center-close-btn` | 关闭通知中心。 |
| 通知中心活动区块 | `notification-center-active-section` | 仅在存在活动任务通知时出现。 |

## Flow Chat Header

| 元素名称 | data-testid | 说明 |
|---|---|---|
| 后台 subagents 按钮 | `flowchat-header-background-subagents` | 打开后台 subagent 活动状态。 |
| Pull requests 按钮 | `flowchat-header-pull-requests` | 打开 pull request 相关 UI。 |
| Turn 列表 | `flowchat-header-turn-list` | Turn 导航列表。 |
| 上一个 turn 按钮 | `flowchat-header-turn-prev` | 切换到上一个可见 turn。 |
| 下一个 turn 按钮 | `flowchat-header-turn-next` | 切换到下一个可见 turn。 |

## Agents

| 元素名称 | data-testid | 说明 |
|---|---|---|
| Agent/Skill 面板 | `agent-skill-panel` | Agents 发现页激活时的场景根节点。 |
| Agent 列表 | `agent-list` | 所有 agent 区域和卡片的容器。 |
| Agent 列表项 | `agent-list-item` | 重复卡片。包含 `data-agent-id`、`data-agent-name` 和 `data-agent-kind`。 |
| Agent 列表项标题 | `agent-list-item-title` | Agent 卡片标题。 |
| Agent 列表项描述 | `agent-list-item-description` | Agent 卡片描述。 |
| Agent 列表空状态 | `agent-list-empty` | Agent 列表区块为空时的状态。 |
| Agent 详情面板 | `agent-detail-panel` | Agent 详情弹窗根节点。 |
| Agent 详情标题 | `agent-detail-title` | Agent 详情弹窗标题。 |
| Agent 详情描述 | `agent-detail-description` | Agent 详情描述。 |
| Agent 详情工具区域 | `agent-detail-tools-section` | Agent 能力/工具区域。 |
| Agent 详情工具项 | `agent-detail-tool-item` | 重复的已启用工具项。包含 `data-tool-name`。 |
| Agent 详情关闭按钮 | `agent-detail-close` | 详情弹窗关闭按钮。 |
| Core 锚点按钮 | `agents-anchor-core` | 滚动到 core agents 区域。 |
| Custom agents 锚点按钮 | `agents-anchor-custom` | 滚动到 custom agents 区域。 |
| Agents 搜索按钮 | `agents-search-btn` | 搜索后缀按钮。 |
| Core agents 区域 | `agents-core-zone` | Core agents section。 |
| Custom agents 区域 | `agents-custom-zone` | Custom/subagent section。 |
| Agent source 过滤器 | `agents-source-filter` | 重复项。配合 `data-agent-source` 使用。 |
| Agent kind 过滤器 | `agents-kind-filter` | 重复项。配合 `data-agent-kind` 使用。 |
| 创建 agent 按钮 | `agents-create-agent-btn` | 打开 custom agent 创建页。 |
| BTW 停止 review 按钮 | `btw-session-panel-stop-review` | 从 BTW 面板停止 review session。 |
| BTW origin 按钮 | `btw-session-panel-origin-button` | 从 BTW 面板打开 origin session。 |

## Skills

| 元素名称 | data-testid | 说明 |
|---|---|---|
| Agent/Skill 面板 | `agent-skill-panel` | Skills 发现页激活时的场景根节点。 |
| Skill 列表 | `skill-list` | 默认安装技能列表网格，也用于 marketplace 搜索结果。 |
| Skill 列表项 | `skill-list-item` | 重复的已安装 skill 卡片。包含 `data-skill-id`、`data-skill-name`、`data-skill-key`、`data-skill-level` 和 `data-skill-builtin`。 |
| Skill 列表项标题 | `skill-list-item-title` | Skill 卡片标题。 |
| Skill 列表项描述 | `skill-list-item-description` | 存在时为 Skill 卡片描述。 |
| Skill 列表空状态 | `skill-list-empty` | 已安装或 marketplace skill 列表为空时的状态。 |
| Skill 详情面板 | `skill-detail-panel` | Skill 详情弹窗根节点。 |
| Skill 详情标题 | `skill-detail-title` | Skill 详情弹窗标题。 |
| Skill 详情描述 | `skill-detail-description` | Skill 详情描述。 |
| Skill 详情能力区域 | `skill-detail-capabilities-section` | 已安装或 marketplace skill 的详情元数据/能力说明区域。 |
| Skill 详情关闭按钮 | `skill-detail-close` | 详情弹窗关闭按钮。 |
| Skills tabs 根节点 | `skills-tabs` | Installed/discover tabs 容器。 |
| Installed tab | `skills-tab-installed` | 包含 `data-skills-tab-active`。 |
| Discover tab | `skills-tab-discover` | 包含 `data-skills-tab-active`。 |
| Installed 面板 | `skills-installed-panel` | 已安装 skills 视图根节点。 |
| Installed 侧边栏 | `skills-installed-sidebar` | 已安装 category 侧边栏。 |
| Installed category | `skills-installed-category` | 重复项。配合 `data-skill-category` 使用。 |
| Installed 内容区 | `skills-installed-content` | 已安装 skills 主内容。 |
| Installed 搜索 | `skills-installed-search` | 已安装 skills 搜索根节点。 |
| 隐藏重复项按钮 | `skills-hide-duplicates-btn` | 包含 `data-active`。 |
| 添加本地 skill 按钮 | `skills-add-local-btn` | 打开添加 skill 表单。 |
| Installed 加载状态 | `skills-installed-loading` | 加载骨架屏容器。 |
| Installed 错误状态 | `skills-installed-error` | 错误状态容器。 |
| Installed 空状态 | `skills-installed-empty` | 空状态容器。 |
| Installed grid | `skills-installed-grid` | 已安装 skill 卡片网格。 |
| Installed skill 卡片 | `skills-installed-card` | 重复项。配合 `data-skill-key`、`data-skill-level` 和 `data-skill-builtin` 使用。 |
| Installed 卡片路径按钮 | `skills-installed-card-path` | 重复项。配合 `data-skill-key` 使用。 |
| Installed 卡片删除按钮 | `skills-installed-card-delete` | 重复项。配合 `data-skill-key` 使用。 |
| Installed 分页 | `skills-installed-pagination` | 已安装列表分页根节点。 |
| Installed 上一页 | `skills-installed-page-prev` | 上一页按钮。 |
| Installed 下一页 | `skills-installed-page-next` | 下一页按钮。 |
| Discover 面板 | `skills-discover-panel` | Marketplace 视图根节点。 |
| Discover 搜索 | `skills-discover-search` | Marketplace 搜索根节点。 |
| Discover 内容区 | `skills-discover-content` | Marketplace 内容区域。 |
| Discover 加载状态 | `skills-discover-loading` | 初始加载骨架屏容器。 |
| Discover 分页加载状态 | `skills-discover-page-loading` | 翻页时的加载状态。 |
| Discover 错误状态 | `skills-discover-error` | 错误状态容器。 |
| Discover 空状态 | `skills-discover-empty` | 空状态容器。 |
| Discover grid | `skills-discover-grid` | Marketplace 卡片网格。 |
| Market skill 卡片 | `skills-market-card` | 重复项。配合 `data-skill-install-id` 和 `data-skill-installed` 使用。 |
| Skill 卡片动作 | `skills-card-action` | 重复卡片动作。配合 `data-skill-action` 使用。 |
| Discover 分页 | `skills-discover-pagination` | Marketplace 分页根节点。 |
| Discover 上一页 | `skills-discover-page-prev` | 上一页按钮。 |
| Discover 下一页 | `skills-discover-page-next` | 下一页按钮。 |
| 详情删除按钮 | `skills-detail-delete-btn` | 删除选中的已安装 skill。 |
| 详情已安装按钮 | `skills-detail-installed-btn` | Marketplace 详情中的 disabled installed 标记。 |
| 详情项目级下载按钮 | `skills-detail-download-project-btn` | 将 market skill 下载到 project scope。 |
| 详情用户级下载按钮 | `skills-detail-download-user-btn` | 将 market skill 下载到 user scope。 |
| 详情路径按钮 | `skills-detail-path-btn` | 显示已安装 skill 路径。 |
| 详情外部链接 | `skills-detail-external-link` | 打开 marketplace 链接。 |
| 添加表单 | `skills-add-form` | 添加本地 skill 弹窗内容。 |
| 添加路径输入框 | `skills-add-path-input` | 本地 skill 路径输入框。 |
| 添加浏览按钮 | `skills-add-browse-btn` | 打开路径选择器。 |
| 添加校验结果 | `skills-add-validation` | 包含 `data-validation-valid`。 |
| 添加取消按钮 | `skills-add-cancel-btn` | 关闭添加表单。 |
| 添加提交按钮 | `skills-add-submit-btn` | 添加已校验的本地 skill。 |
