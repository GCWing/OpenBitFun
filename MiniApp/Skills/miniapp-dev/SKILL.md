---
name: miniapp-dev
description: Develops, maintains, and generates OpenBitFun MiniApps (Zero-Dialect Runtime). Use when (1) working on miniapp framework code under src/crates/assembly/core/src/miniapp/ or src/web-ui/src/app/scenes/miniapps/; or (2) generating / creating / designing a NEW MiniApp for the user — including any request like "做一个小应用 / 生成 MiniApp / 写个 OpenBitFun 小工具 / 创建 mini app". Also triggers on MiniApp, miniapps, bridge, zero-dialect, InitMiniApp, app.fs / app.shell / app.storage, or any work under MiniApp/Demo/ and MiniApp/Skills/.
---

# OpenBitFun MiniApp V2 指南

> **本 Skill 服务两类工作**：
>
> - **维护框架本身** → 阅读下方"代码架构 / Bridge / 权限模型 / window.app API"等章节。
> - **生成一个新的 MiniApp** → **必读** [`design-playbook.md`](design-playbook.md)，并遵循下方"生成新 MiniApp 必读（速查）"章节的硬约束。详细 API 见 [`api-reference.md`](api-reference.md)。

---

## 生成新 MiniApp 必读（速查）

> 完整指南见 [`design-playbook.md`](design-playbook.md)。这里是**不可妥协**的硬约束，AI 在用 `InitMiniApp` 工具创建骨架后**必须**遵守。

### 流程
1. **先问，再做**：用户的目标 / 受众 / 是否需要 node mode / 权限边界 / 是否需要 Tweaks 变体 / 是否多语言 / 是否有视觉参考——任何一项含糊就用 `AskUserQuestion` 问。**不要替用户决定**。
2. **找设计上下文**：先读 `MiniApp/Demo/` 与 `src/crates/contracts/product-domains/src/miniapp/builtin/assets/` 中**最贴近形态**的内置应用，复刻它的视觉语言（间距 / 圆角 / 卡片密度 / motif）。**从零 mock 是最后选择**。
3. **声明设计系统**：`style.css` 顶部用注释钉住 palette / typography / radius / motif（参见 playbook §1.3 模板），后续全应用复用。
4. **占位先行 → 早预览**：第一版用占位文本 / 占位图框 / fixture 数据，先在 Toolbox 里跑给用户看，再迭代。
5. **验证**：light/dark × zh/en 共 4 套截图都过；过 playbook §8 的 QA Checklist。

### 反 AI 味（默认禁用，除非用户明确要求）
- ❌ 蓝紫渐变 / "Aurora" 风背景
- ❌ Emoji 当主图标（用描边 SVG 或字母圆形容器）
- ❌ 左侧色条 + 圆角卡片组合
- ❌ 标题下加 1-2px 装饰横线
- ❌ 硬画复杂插画 SVG（用占位框，标注 "Image TBD"）
- ❌ Inter / Roboto 兜底就完事（用 `var(--openbitfun-font-sans)` 优先）
- ❌ 12px 以下文字 / hit target < 32px
- ❌ 圆角混用 4/8/12/16（钉 1-2 档全应用统一）
- ❌ 用装饰性 stats / icon / sparkline 填空白（空白是排版问题，不是内容问题）

### 颜色与字体
- **首选** `var(--openbitfun-*)` 系列 + fallback，与宿主主题协同（见下文"主题集成"章节的完整变量清单）。
- 一个颜色占视觉权重 60-70%（dominant），1-2 个 supporting，1 个 accent——**禁止给所有色块同等权重**。
- 字号：标题 18-22px / Section 14-15px / 正文 13-14px / Caption 11-12px。

### Tweaks 变体（推荐做法）
对外观/密度/字号/布局的多种合理选择，做成运行时可切换、写入 `app.storage('tweaks')`、右下角浮动小面板"Tweaks"——一份代码服务多种偏好是 MiniApp 的天然优势。详细约定见 playbook §4。

### 占位优于劣质实现
没图标 / 没数据 / 没素材时，用明确的占位（标注尺寸或 "TBD"），并在 README 里登记待补清单——**不要硬画一个糟糕的真实物**。

### 工具型 vs 展示型
绝大多数 OpenBitFun MiniApp 是**工具型**——信息密集、操作短、配色冷静，仿照 `regex-playground` / `coding-selfie` / `git-graph` 的克制感。只有用户明确要"对外展示 / 灵感型 / 作品集"时才放飞视觉。

### 内容守则
- 不为填空白而加内容——空白说明结构应被简化。
- 每个元素都要能回答"为什么在这里"，回答不了就删掉。
- 加新 section / page / 功能前**先问用户**——你不比用户更懂他的目标。

---

## 核心哲学：Zero-Dialect Runtime

MiniApp 使用 **标准 Web API + window.app**：UI 侧为 ESM 模块（`ui.js`），后端逻辑在独立 JS Worker 进程（Bun 优先 / Node 回退）中执行。Rust 负责进程管理、权限策略和 Tauri 独占 API；Bridge 从旧的 `require()` shim + `__OPENBITFUN__` 替换为统一的 **window.app** Runtime Adapter。

## 代码架构

### Rust 后端

```
src/crates/assembly/core/src/miniapp/
├── types.rs               # MiniAppSource (ui_js/worker_js/esm_dependencies/npm_dependencies), NodePermissions
├── manager.rs             # CRUD + recompile() + resolve_policy_for_app()
├── storage.rs             # ui.js, worker.js, package.json, esm_dependencies.json
├── compiler.rs            # Import Map + Runtime Adapter 注入 + ESM
├── bridge_builder.rs      # window.app 生成 + build_import_map()
├── permission_policy.rs   # resolve_policy() → JSON 策略供 Worker 启动 / host_dispatch 复用
├── host_dispatch.rs       # 宿主直连分发 fs/shell/os/net（无需 Bun/Node Worker）
├── runtime_detect.rs      # detect_runtime() Bun/Node
├── js_worker.rs           # 单进程 stdin/stderr JSON-RPC
├── js_worker_pool.rs      # 池管理 + install_deps
├── exporter.rs            # 导出骨架
└── mod.rs
```

### Tauri Commands

```
src/apps/desktop/src/api/miniapp_api.rs
```

- 应用管理: `list_miniapps`, `get_miniapp`, `create_miniapp`, `update_miniapp`, `delete_miniapp`
- 存储/授权: `get/set_miniapp_storage`, `grant_miniapp_workspace`, `grant_miniapp_path`
- 版本: `get_miniapp_versions`, `rollback_miniapp`
- Worker/Runtime: `miniapp_runtime_status`, `miniapp_worker_call`, `miniapp_host_call`, `miniapp_worker_stop`, `miniapp_install_deps`, `miniapp_recompile`
- 对话框由前端 Bridge 用 Tauri dialog 插件处理，无单独后端命令

### Agent 工具

```
src/crates/assembly/core/src/agentic/tools/implementations/
└── miniapp_init_tool.rs   # InitMiniApp — 唯一工具，创建骨架目录供 AI 用通用文件工具编辑
```

注册在 `registry.rs` 的 `register_all_tools()` 中。AI 后续用 Read/Edit/Write 等通用文件工具编辑 MiniApp 文件。

### 前端

```
src/web-ui/src/app/scenes/miniapps/
├── MiniAppGalleryScene.tsx / .scss
├── MiniAppScene.tsx / .scss
├── miniAppStore.ts
├── views/ MiniAppGalleryView
├── components/ MiniAppCard, MiniAppRunner (iframe 带 data-app-id)
├── hooks/
│   ├── useMiniAppBridge.ts        # worker.call → workerCall() + dialog.open/save/message
│   └── useMiniAppCatalogSync.ts   # 列表与运行态同步
└── utils/ miniAppIcons.tsx, buildMiniAppThemeVars.ts

src/web-ui/src/infrastructure/api/service-api/MiniAppAPI.ts  # runtimeStatus, workerCall, workerStop, installDeps, recompile
src/web-ui/src/flow_chat/tool-cards/MiniAppToolDisplay.tsx   # InitMiniAppDisplay
```

### Worker 宿主

```
src/apps/desktop/resources/worker_host.cjs
```

Node/Bun 标准脚本：从 `BITFUN_WORKER_POLICY` 环境变量读策略 JSON（argv[2] 仅作手动运行兜底），stdin 收 RPC、stderr 回响应，内置 fs/shell/net/os/storage dispatch + 加载用户 `source/worker.js` 自定义方法。

## MiniApp 数据模型 (V2)

```rust
// types.rs
MiniAppSource {
  html, css,
  ui_js,           // 浏览器侧 ESM
  esm_dependencies,
  worker_js,       // Worker 侧逻辑
  npm_dependencies,
}
MiniAppPermissions { fs?, shell?, net?, node? }  // node 替代 env/compute
```

## 权限模型

- **permission_policy.rs**：`resolve_policy(perms, app_id, app_data_dir, workspace_dir, granted_paths)` 生成 JSON 策略，传给 Worker 启动参数；Worker 内部按策略拦截越权。
- 路径变量同前：`{appdata}`, `{workspace}`, `{user-selected}`, `{home}` 等。

## Bridge 通信流程 (V2)

```
iframe 内 window.app.call(method, params)
  → postMessage({ method: 'worker.call', params: { method, params } })
  → useMiniAppBridge 监听
  ├─ 框架原语 (fs.* / shell.* / os.* / net.*)：
  │   ├─ node.enabled = false  → miniAppAPI.hostCall → Tauri invoke('miniapp_host_call')
  │   │                          → openbitfun_core::miniapp::host_dispatch（纯 Rust，无需 Bun/Node）
  │   └─ node.enabled = true   → miniAppAPI.workerCall → Tauri invoke('miniapp_worker_call')
  │                              → JsWorkerPool（保留旧路径，允许 worker.js 覆写 fs/shell 等）
  ├─ 自定义方法：始终走 worker.call → JsWorkerPool（要求 node.enabled = true 且 worker.js 导出）
  └─ storage.* (node.enabled = false 时)：直接走 get/set_miniapp_storage 命令

dialog.open / dialog.save / dialog.message
  → postMessage → useMiniAppBridge 直接调 @tauri-apps/plugin-dialog
```

### 何时使用「无 Node 模式」（推荐）

只要小应用的后端能力可以用 `fs.*` / `shell.*` / `os.*` / `net.*` 完成（例如调用 `git` 拉数据、读写工作区文件、抓取 HTTP API），就把 `permissions.node.enabled` 设为 `false`：

- 不依赖 Bun/Node 安装环境，bundle 后即点即用，避免 "JS Worker pool not initialized" 类问题；
- 安全与性能与 Worker 路径完全等价（同一份 `permission_policy`，Rust 直接执行）；
- 仍然可以使用 `app.shell.exec / fs.* / net.fetch / os.info / storage.get|set` 全部框架原语。

什么时候需要 `node.enabled = true`：

- 需要写 `worker.js` 自定义方法（CPU 密集 / 长流程 / 复杂解析等）；
- 需要 `npm_dependencies` 安装第三方 npm 包；
- 需要在 worker 内长期持有连接、缓存、状态。

> 走「无 Node 模式」时，**禁止** 调用 `app.call('myCustomMethod', …)`，宿主会显式报错；只能调用框架原语和 `app.storage.*`。

## 能力边界（重要）

MiniApp 框架**只暴露下列能力**，没有任何"通用 OpenBitFun 后端通道"。设计 / 生成新小应用前请先比对，能力不在表内的需求请走相应替代方案，**不要假设有 `app.openbitfun.*` / `app.workspace.*` / `app.git.*` / `app.session.*` 之类的接口存在。**

| 能力 | 入口 | 说明 |
|---|---|---|
| 文件系统 | `app.fs.*` | 受 `permissions.fs.read/write` 路径白名单限制 |
| 子进程 / 命令行 | `app.shell.exec` | 受 `permissions.shell.allow` 命令名白名单限制 |
| HTTP | `app.net.fetch` | 受 `permissions.net.allow` 域名白名单限制 |
| 系统信息 | `app.os.info` | 仅 platform / cpus / homedir / tmpdir 等只读字段 |
| KV 存储 | `app.storage.get/set` | 每个小应用独立的 `storage.json`，跨会话保留 |
| AI | `app.ai.complete / chat / cancel / getModels` | 复用宿主 AIClient，受 `permissions.ai`（含 `allowed_models` / 速率限制） |
| 对话框 | `app.dialog.open/save/message` | Tauri dialog 插件 |
| 剪贴板 | `app.clipboard.readText/writeText` | 宿主 navigator.clipboard |
| Agent 会话 | `app.agent.run / cancel / turnText / cancelStaleRuns / onEvent` | 受 `permissions.agent.enabled` 限制；启动小应用自己的隐藏 agent 回合，事件只回流到发起的小应用。工具集按运行时档位收敛：市场小应用（`runtime_profile = market_strict`）保留 `WebSearch` / `WebFetch`，并可通过 `options.contextFiles` 注入有大小上限的只读上下文；宿主在 Agent Runtime 内为每次运行发布独立、不可变的 `.miniapp-context/<opaque-scope>` 虚拟快照、向 prompt 注入精确路径和“不可信数据”提示，并仅在本次请求有上下文时开放限定到该快照的 `Read` / `Grep`。虚拟路径不会落盘或回退到同名物理文件，Agent 仍碰不到其他文件、命令行和宿主控制面。内置 / `compatibility` 档位保留完整的 headless 工具集 |
| 悬浮会话气泡 | `app.chat.claimComposer / releaseComposer / focusSession / setComposerDraft / onUserMessage` | 受 `permissions.agent.enabled` 限制；把内容和提交路由注册进右下角的标准悬浮聊天窗（输入器、附件、模型、权限、停止等仍由宿主共享组件拥有），并展示小应用自己的 Agent 过程。用户从该气泡启动实时语音时，未显式指定其他工作区的任务也经同一个 `onUserMessage` 路由进入小应用会话（Agentic MiniApp 模式，样板间：`builtin-ppt-live`） |
| 幻灯片栅格化 | `app.deck.renderPage` | 在隐藏宿主 WebView 中渲染单页 HTML，返回 base64 PNG/PDF（导出用） |
| 自定义后端 | `app.call('xxx', …)` + `worker.js` | 仅 `node.enabled = true` 时可用，自己实现业务逻辑 |
| 主题 / i18n | `app.appearanceMode` / `app.locale` / `app.onAppearanceChange` / `app.onLocaleChange` / `app.t(...)` | 见对应章节 |

### 框架**不**直接暴露的 OpenBitFun 后端能力（截至本文档）

下面这些 OpenBitFun 内部服务，目前**没有**给小应用开放调用通道：

- WorkspaceService（结构化工作区索引、统一搜索）
- GitService（结构化 status / diff / blame，区别于裸 `git` 命令）
- TerminalService（创建/读写交互式终端）
- Session / AgenticSystem 的**通用**会话管理（任意会话的创建、接管、读写）——小应用只能通过 `app.agent.*` 启动**自己的**隐藏会话并消费其事件，再通过 `app.chat.*` 借用悬浮会话气泡做输入与过程展示；不能访问其他会话
- Snapshot / Mermaid / Skills / Browser API / Computer Use / Config 等

需要这类能力时的合规姿势：

1. **能用裸命令行解决的**（如 git）→ 在 `permissions.shell.allow` 里加命令名，用 `app.shell.exec` 包一层（参考 `builtin-coding-selfie/ui.js` 的 `scanGitWorkspace`）；
2. **只是要读 OpenBitFun 工作区内的文件**（如某些项目元数据） → 把 `{workspace}` 加到 `permissions.fs.read`，自己用 `app.fs.*` 读 + 在前端解析；
3. **必须真调用某个内部服务** → 暂不支持，先记录到需求池。**不要**自己起一个 worker 去模拟服务行为，会和真正的 service 行为漂移。

> 维护者：以后若新增 `app.openbitfun.*` / `app.workspace.*` 这类宿主直通通道，请同步更新本节，避免"文档说没有、代码偷偷加了"的不一致。

### 内置产品私有扩展

源码、来源和运行域都由宿主验证的内置产品界面可以获得私有 namespace，但它不属于
MiniApp 公共 API，也不会注入普通、导入或市场 MiniApp。当前仅
`builtin-bitfun-loopx` 使用私有 `app.loopx` 连接持久宿主控制器；每次调用仍由宿主
复核原始 bundle、非 draft、非本地覆盖和本地执行域。生成 MiniApp 不得探测、声明或
模拟这些私有 namespace；需要复用的能力必须先形成产品无关、带权限合同的公开 API。

## window.app 运行时 API

MiniApp UI 内通过 **window.app** 访问：

| API | 说明 |
|-----|------|
| `app.call(method, params)` | 调用 Worker 方法（含 fs/shell/net/os/storage 及用户 worker.js 导出） |
| `app.fs.*` | 封装为 worker.call('fs.*', …) |
| `app.shell.*` | 同上 |
| `app.net.*` | 同上 |
| `app.os.*` | 同上 |
| `app.storage.*` | 同上 |
| `app.dialog.open/save/message` | 由 Bridge 转 Tauri dialog 插件 |
| `app.agent.*` | 隐藏 agent 回合（`permissions.agent.enabled`），事件经 `app.agent.onEvent` 回流 |
| `app.chat.*` | 标准悬浮聊天窗集成：`claimComposer({ title, composer: { placeholder }, welcome })` 注册有界内容与提交路由（不能替换/缩放输入器；当前 tab 为本小应用时，共享 ChatInput 和从该气泡启动的实时语音任务均经 `onUserMessage` 送达）、`focusSession(sessionId)` 让气泡展示本小应用的 agent 会话、`setComposerDraft(text)` 展开气泡并预填共享输入器（不发送，供示例 prompt 使用）。`onUserMessage` payload 含唯一 `requestId` 及 `source: 'composer' | 'realtime_voice'`；处理器应返回覆盖 Agent 回合及小应用后处理的 Promise，供语音模式等待最终结果 |
| 生命周期 / 事件 | 见 bridge_builder 生成的适配器 |

## 主题集成

MiniApp 在 iframe 中运行时自动与主应用主题同步，避免界面风格与主应用差距过大。

### 只读属性与事件

| 成员 | 说明 |
|------|------|
| `app.appearanceMode` | 当前主题类型字符串：`'dark'` 或 `'light'`（随主应用切换更新） |
| `app.onAppearanceChange(fn)` | 注册主题变更回调，参数为 payload：`{ mode, id, vars }` |

### data-openbitfun-appearance-mode 属性

编译后的 HTML 根元素 `<html>` 带有 `data-openbitfun-appearance-mode="dark"` 或 `"light"`，便于用 CSS 按主题写样式，例如：

```css
[data-openbitfun-appearance-mode="light"] .panel { background: #f5f5f5; }
[data-openbitfun-appearance-mode="dark"] .panel { background: #1a1a1a; }
```

### --openbitfun-* CSS 变量

宿主会将主应用主题映射为以下 CSS 变量并注入 iframe 的 `:root`。在 MiniApp 的 CSS 中建议用 `var(--openbitfun-*, <fallback>)` 引用，以便在 OpenBitFun 内与主应用一致，导出为独立应用时 fallback 生效。

**背景**

- `--openbitfun-bg` — 主背景
- `--openbitfun-bg-secondary` — 次级背景（如工具栏、面板）
- `--openbitfun-bg-tertiary` — 第三级背景
- `--openbitfun-bg-elevated` — 浮层/卡片背景

**文字**

- `--openbitfun-text` — 主文字
- `--openbitfun-text-secondary` — 次要文字
- `--openbitfun-text-muted` — 弱化文字

**强调与语义**

- `--openbitfun-accent`、`--openbitfun-accent-hover` — 强调色及悬停
- `--openbitfun-success`、`--openbitfun-warning`、`--openbitfun-error`、`--openbitfun-info` — 语义色

**边框与元素**

- `--openbitfun-border`、`--openbitfun-border-subtle` — 边框
- `--openbitfun-element-bg`、`--openbitfun-element-hover` — 控件背景与悬停

**圆角与字体**

- `--openbitfun-radius`、`--openbitfun-radius-lg` — 圆角
- `--openbitfun-font-sans`、`--openbitfun-font-mono` — 无衬线与等宽字体

**滚动条**

- `--openbitfun-scrollbar-thumb`、`--openbitfun-scrollbar-thumb-hover` — 滚动条滑块

示例（在 `style.css` 中）：

```css
:root {
  --bg: var(--openbitfun-bg, #121214);
  --text: var(--openbitfun-text, #e8e8e8);
  --accent: var(--openbitfun-accent, #60a5fa);
}
body {
  font-family: var(--openbitfun-font-sans, system-ui, sans-serif);
  color: var(--text);
  background: var(--bg);
}
```

### 同步时机

- iframe 加载后 bridge 会向宿主发送 `openbitfun/request-appearance`，宿主回推当前主题变量，iframe 内 `_applyAppearanceVars` 写入 `:root`。
- 主应用切换主题时，宿主会向 iframe 发送 `appearanceChange` 事件，bridge 更新变量并触发 `onAppearanceChange` 回调。

## 国际化（i18n）

MiniApp 框架在 V2 之后内置 i18n 支持，开发者**必须**为多语言用户考虑两类文案：

1. **Gallery 元数据**（`name` / `description` / `tags`）—— 在 `meta.json` 顶层加 `i18n.locales` 块，宿主 Gallery / Card / Scene 标题自动按当前语言挑选。
2. **应用内文案**（HTML / JS 中的所有可见字符串）—— 通过 `window.app.locale`、`window.app.onLocaleChange(fn)` 与 `window.app.t(table, fallback)` 实现。

### `meta.json` 多语言示例

```json
{
  "id": "your-app",
  "name": "默认名（兜底）",
  "description": "默认描述",
  "tags": ["默认标签"],
  "i18n": {
    "locales": {
      "zh-CN": { "name": "中文名", "description": "中文描述", "tags": ["中文"] },
      "en-US": { "name": "English Name", "description": "English desc", "tags": ["en"] }
    }
  }
}
```

回退顺序：`current` → `en-US` → `zh-CN` → 顶层默认值。

### `window.app` i18n 运行时 API

| 成员 | 说明 |
|------|------|
| `app.locale` | 当前语言 ID（如 `'zh-CN'` / `'en-US'`），随宿主切换更新 |
| `app.onLocaleChange(fn)` | 注册语言切换回调，参数为新 locale 字符串 |
| `app.t(table, fallback)` | 从 `{ 'zh-CN': '...', 'en-US': '...' }` 表挑选字符串；解析顺序：current → en-US → zh-CN → 表的第一项 → fallback |

### HTML 静态文案：`data-i18n` 约定

宿主不强制要求该写法，但推荐 MiniApp 内部统一约定：

- `<span data-i18n="key">默认</span>` —— 切换语言时 `applyStaticI18n()` 读取 `data-i18n` 并替换 `textContent`
- `<div data-i18n="ariaKey" data-i18n-attr="aria-label">...</div>` —— 设置某个属性而非文本

参考 `builtin/assets/gomoku/ui.js` 等内置应用的 `I18N` 表 + `applyStaticI18n()` + `app.onLocaleChange` 三件套即可复用。

### 编写自检清单

- [ ] `meta.json` 已加 `i18n.locales`（至少 `zh-CN` / `en-US`）
- [ ] HTML 中静态文案均带 `data-i18n` 属性
- [ ] JS 内动态拼接的字符串使用 `app.t()` 或自有 `I18N` 表
- [ ] 注册了 `app.onLocaleChange`，切换语言时重新渲染（包括动态列表、aria-label、title）
- [ ] 持久化数据（`app.storage`）保存语言无关的索引/键，而非已翻译的字符串

## 内置小应用（builtin/assets/*）维护规范

内置小应用通过 `src/crates/contracts/product-domains/src/miniapp/builtin.rs` 中的 `BUILTIN_APPS` 数组以 `include_str!` 方式打包进 Rust 二进制；首次启动 / 升级时由 `seed_builtin_miniapps()` 把资源写入用户的 `miniapps_dir/<app_id>/`，并在该目录下写入 `.builtin-manifest.json` 主标记文件，同时兼容写入 `.builtin-version` legacy 标记。

**只有当 bundled `version` / asset hash 与 on-disk `.builtin-manifest.json` 不一致时才会重新 seed**，否则启动时会跳过、用户看到的还是旧版本。

### 修改流程（强制）

凡是修改了 `src/crates/contracts/product-domains/src/miniapp/builtin/assets/<app>/` 下任何文件（`index.html` / `style.css` / `ui.js` / `worker.js` / `meta.json`），**都必须**同步在 `builtin.rs` 的 `BUILTIN_APPS` 中把对应条目的 `version: N` → `N + 1`。

```rust
// src/crates/contracts/product-domains/src/miniapp/builtin.rs
BuiltinApp {
    id: "builtin-daily-divination",
    version: 14,  // ← 改完资源就把这里 +1
    ...
}
```

未 bump 的后果：
- asset hash 变化仍会触发 reseed，但 bundle version 和 `.builtin-version` legacy 标记无法体现升级批次
- QA / Release 难以用版本号关联资源变更，容易误判资源是否已随包更新

### 自检清单

- [ ] 改完 `assets/<app>/*` 任何文件
- [ ] `builtin.rs` 中对应 `BuiltinApp.version` 已 +1
- [ ] 本地清掉 `~/.openbitfun/miniapps/<app_id>/.builtin-manifest.json` 或直接整目录删，再启动验证 reseed 生效
- [ ] meta.json 中的 `version` 字段（用户可见的元数据版本）按需同步（与 reseed 无关，但展示用）

### 提示

- `meta.json` 里的 `version`（默认 1）是给用户看的版本号，**不**驱动 reseed
- 真正驱动 reseed 的是 `builtin.rs` 中的 `BuiltinApp.version` 字段（u32）和 bundled asset hash
- 二者最好语义一致：资源有重大更新时同步 bump，便于排查

## 开发约定

### 新增 Agent 工具

当前仅 **InitMiniApp**。若扩展：
1. `implementations/miniapp_xxx_tool.rs` 实现 `Tool`
2. `mod.rs` + `registry.rs` 注册
3. `flow_chat/tool-cards/index.ts` 与 `MiniAppToolDisplay.tsx` 增加对应卡片

### 修改编译器

`compiler.rs`：注入 Import Map（`build_import_map`）、Runtime Adapter（`build_bridge_script`）、CSP；用户脚本以 `<script type="module">` 注入 `ui_js`。

### 前端事件

后端 `miniapp-created` / `miniapp-updated` / `miniapp-deleted` / `miniapp-worker-*`，前端 `useMiniAppCatalogSync` 统一监听并刷新 store。

## 场景注册检查清单

同前：`SceneBar/types.ts`、`scenes/registry.ts`、`SceneViewport.tsx`、`NavPanel/config.ts`、`app/types/index.ts`、locales。

## 参考

- 重构计划: `.cursor/plans/miniapp_v2_full_refactor_*.plan.md`
- 架构说明见 plan 内「MiniApp V2 一步到位重构计划」

## 发布到市场

用户明确要求把 MiniApp 发布/上架到市场时，用 `PublishMiniApp` 工具：

- 传 `app_id` 和 `listing_image_paths`：1–5 张市场展示图路径（PNG/JPEG/WebP，
  单张 ≤ 5 MiB）。没有现成图片时先向用户要，或请用户在「市场 → 我的投稿」
  选择图片/使用「截取当前画面」。
- **市场展示图建议 16:9，推荐 1920×1080**。第一张是列表卡片封面；建议画面
  清晰、主体突出，关键信息放在画面中部、不要贴边。市场网页和 OpenBitFun 桌面端
  都会按 16:9 居中裁剪；超过 2560px 的边会被服务端缩到 2560，所以
  2560×1440 是有效上限。显示契约见
  `src/miniapp-market-web/README.md` 的「市场展示图规格」。
- 名称、描述、图标、分类、标签自动取自 `meta.json`；slug 和版本号自动推导。
  发布前确认 `meta.json` 的 `description` 非空、权限是最小集
  （市场会拒绝 `node.enabled=true`、宽泛 fs scope 等）。
- 未登录时工具会返回 GitHub 授权链接：把链接给用户，等用户完成授权后
  用相同参数再调用一次即可继续。
- 提交后进入人工审核；用户可在「市场 → 我的投稿」查看状态。
- 这是对外动作：只在用户明确要求发布时调用，不要主动发布。
