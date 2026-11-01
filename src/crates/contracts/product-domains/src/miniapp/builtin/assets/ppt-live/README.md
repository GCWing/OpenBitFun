# PPT Live MiniApp — Developer Guide

PPT Live 是 OpenBitFun 的内置 MiniApp，用于 AI 驱动的 PPT 生成、编辑和导出。

## Agentic MiniApp 样板间：复用悬浮会话气泡

PPT Live 同时是 OpenBitFun **Agentic MiniApp** 的样板间：它自己**没有输入框，也没有
过程显示**——右侧栏只有样式设置和一张引导卡。用户在右下角的悬浮会话气泡里描述
需求，链路如下：

```
用户在悬浮气泡输入
  → PPT Live 初始化/新建/恢复主题时先用 app.agent.ensureSession
    为该主题创建或重新绑定专属隐藏会话
  → app.chat.focusSession 将主题会话绑定到当前 composer claim
  → FloatingMiniChat 把 claim 注册为共享 ChatInput 的内容与提交路由
    （不会替换或复制 ChatInput）
  → window CustomEvent 'miniapp-composer-message'
  → useMiniAppBridge 转成 iframe 事件 'chat:userMessage'
  → ui.js submitInstruction(text, displayText)：把原始用户文案作为 displayText，
    同时包装独立的 ppt-design 内部协议 prompt，走原有
    app.agent.run 在该主题的隐藏会话中执行（生成与后续编辑复用同一 sessionId）
  → executeBackendTurn 用返回的 sessionId 再确认气泡绑定
  → 气泡的 ChatPane 切到该会话——agent 的执行过程直接显示在气泡里
  → agent 按文件协议写 project.json / slides/*.html，PPT Live 渐进式读文件上屏
```

涉及的 `app.chat.*` API（`bridge_builder.rs` 生成，宿主端在
`web-ui/src/app/scenes/miniapps/hooks/useMiniAppBridge.ts`，需要
`permissions.agent.enabled = true`）：

| API | 作用 |
|-----|------|
| `app.agent.ensureSession(options)` | 在主题打开时创建或重新绑定专属隐藏会话；PPT Live 用 `agentSession.id` 恢复老主题，用新的 appdata 工作目录初始化新主题 |
| `app.agent.run(prompt, options)` | `prompt` 承载 MiniApp 内部任务协议；`options.displayText` 单独承载会话框中显示的用户原始输入，避免把内部 prompt 或通用占位文案展示给用户 |
| `app.chat.claimComposer(options)` | 注册到标准气泡聊天窗；本应用 tab 激活时用户输入改送本应用。可声明 `title`、`composer.placeholder` 与 `welcome`（标题、说明、工作区标签、示例 prompt），由宿主在共享组件内按主题安全渲染。不能修改面板尺寸、输入器布局或控件。幂等 upsert，locale 变更时重调可更新文案 |
| `app.chat.onUserMessage(fn)` | 接收共享 ChatInput 或实时语音的提交，payload 至少含 `{ text }`，并可包含 `displayText`、`contexts`、`imageContexts`、`composerPresentation`、`sessionId`、`workspacePath`、`requestId` 与 `source`。回调应返回覆盖完整处理周期的 Promise，宿主据此等待 MiniApp 后处理完成 |
| `app.chat.focusSession(sessionId)` | 把经校验的本应用 Agent 会话绑定到气泡；气泡打开时临时展示该会话，关闭后恢复用户原来的普通会话 |
| `app.chat.clearSession()` | 新建或切换主题时先清除旧绑定，避免准备新会话期间短暂显示上一个主题 |
| `app.chat.setComposerDraft(text)` | 展开气泡并预填输入框，**不发送**——欢迎页的示例 prompt 用它，用户仍可编辑后再发 |
| `app.chat.releaseComposer()` | 主动释放；iframe 卸载时宿主自动释放 |

每个主题各自保存 `agentSession.id` 和工作目录。初始化按主题合并并发请求；“新主题”先解除旧绑定，
一次创建一个新会话，历史主题恢复原会话。切换期间暂停提交，旧主题的迟到初始化和消息不能绑定新主题。
会话恢复失败会保留历史引用并显示错误，用户可以重试；不会用新空白会话替换旧记录。

主题生命周期回归检查：

```bash
node --test src/crates/contracts/product-domains/src/miniapp/builtin/assets/ppt-live/test/topic-sessions.test.mjs
node --test src/crates/contracts/product-domains/src/miniapp/builtin/assets/ppt-live/test/image-input.test.mjs
```

Hi 气泡与普通会话共用 ChatInput，支持文字加最多五张粘贴或选择的图片，也支持仅图片提交。
图片沿用普通会话的模型配置：多模态主模型直接接收图片；文本主模型通过 `analyze_image`
调用已配置的读图模型。prompt 中直接写文件路径仍按原有 Agent 工具权限读取。
宿主先复用聊天图片处理器，把用户选中的图片转换为
`imageContexts`（`id`、`data_url`、`mime_type`、可选 `metadata`），再交给 MiniApp；
模型输入会移除 `#img:` 展示标记，`displayText` 保留原始输入。PPT Live 将图片放在
`app.agent.run(prompt, { imageContexts })` 的选项中，包括同一次生成的恢复重试，不能把
base64 拼进 prompt / input JSON。Runtime 负责落盘、模型输入和会话图片历史。

兼容旧 MiniApp：返回的 `onUserMessage` Promise 未完成期间，SDK 会把该消息图片自动带到
同一会话首次成功接受的 Agent turn；后续 turn 复用已持久化上下文。消息完成后不再继承。
并发处理同一会话的多条消息时，应传 `chatRequestId: payload.requestId` 或明确传
`imageContexts`，SDK 不会猜测图片归属。首次成功提交时显式传入的图片（包括禁用继承的
空数组）也会记录为该会话的附件选择，后续调用不会再自动附上同一批图片。

图片必须携带像素，MiniApp 不能通过 `image_path` 获取额外的宿主文件权限。读取失败会
保留输入草稿，不能退化为仅发送文字。Peer Device Mode 在投递消息及调用 Agent 两处检查
`miniapp_agent_images_v1`；旧 Desktop 或无 MiniApp runtime 的 CLI peer 明确返回不支持。
普通无图消息保持旧协议兼容。独立 MiniApp Shell 的输入器仍是文本输入，本文的附件入口是主窗口 Hi 气泡。

> 认领是按 **runner 实例**（token）而不是 appId 记账的：AI 定制时同一个 appId 会同时挂载
> 已安装实例和草稿预览实例，若按 appId 路由，一条气泡消息会让两个 iframe 各跑一次 agent。

为什么这是好实践：PPT Live 在用户输入需求后本来就是启动一个 agent 会话去完成
任务——与其在 MiniApp 里再造一套输入框和过程流水线，不如把输入和过程都交给宿主
现成的会话表面，MiniApp 只专注于自己的领域视图（画布、样式、导出）。

气泡空态同样属于 MiniApp 的 Agentic 入口。PPT Live 只声明文案和示例 prompt；
标准输入器、附件、模型、语音、权限、停止、图标布局、主题和 HTML 始终由宿主管理。
宿主使用当前主题专属
Agent 会话的 `workspacePath`，不会泄露或展示用户普通会话的全局项目工作区。
当应用持有 composer claim 时，宿主也会用 manifest 的 `icon` 替换普通聊天气泡
图标；PPT Live 无需在宿主层复制一套品牌色或按钮样式。

## 目录结构

```
ppt-live/
├── index.html              # MiniApp 入口 HTML（由 builtin.rs 加载）
├── style.css               # 全局样式
├── ui.js                   # UI 入口 JS（build-openbitfun.mjs 的打包入口）
├── worker.js               # 空文件（PPT Live 不使用 worker）
├── build-openbitfun.mjs        # 唯一的构建脚本 → 产出 dist/ui.bundle.js
├── meta.json               # MiniApp 元数据（含 version）
├── bundle.json             # bundle 标识（含 version）
├── source_manifest.json    # 构建产物清单
├── esm_dependencies.json   # ESM 依赖声明（当前为空数组）
├── dist/
│   └── ui.bundle.js        # 唯一的运行时 JS（由 builtin.rs 加载）
└── src/
    ├── export-deck-host.js       # 导出函数的 re-export 壳（ui.js 通过它引入导出能力）
    ├── export-deck-browser.js    # EditableSlideScene/PDF/PNG 导出实现
    ├── export-slide-browser.js   # 幻灯片预处理编排（挂载 DOM → sanitize → scene）
    ├── export-degrade.js         # 导出降级层（剥样式 / 移除元素 / 简化页面，代替阻断）
    ├── editable-slide-normalize.js # HTML/SVG/table → EditableSlideScene
    ├── editable-slide-scene.js   # 可编辑场景契约、校验与结构化错误
    ├── html2pptx-dom-core.js     # DOM 几何与原生元素提取辅助
    ├── pptx-html-build.js        # 唯一 EditableSlideScene→PPTX serializer
    ├── sanitize-slide-html.js    # 导出前 HTML 净化/修复
    ├── render.js                 # 幻灯片渲染（编辑器、缩略图、预览）
    ├── deck-ai.js                # AI 生成对接
    ├── state.js                  # 应用状态管理
    ├── style-presets.js          # 样式预设定义
    ├── i18n.js                   # 国际化
    ├── export-html.js            # HTML 导出
    ├── export-format-icons.js    # 导出格式图标
    ├── flat-select.js            # 自定义下拉组件
    └── openbitfun-backend-adapter.js # OpenBitFun 后端适配器
```

## 构建

### ⚠ 重要：`pnpm run desktop:dev` 不会构建 PPT Live 的 JS

PPT Live 的 JS 是**预构建的静态资源**，通过 Rust 的 `include_str!` 在编译时
直接嵌入到二进制中。`desktop:dev` 只提供 web-ui 前端的 Vite HMR 和 Rust 代码的
自动重新编译，**不会运行 `build-openbitfun.mjs`**。

修改 PPT Live 的 JS 源码后，必须**手动**运行构建脚本。

### 改了什么文件 → 要做什么

| 修改的文件 | 需要重新构建 JS？ | 需要 bump 版本号？ | 说明 |
|---|---|---|---|
| `ui.js` | ✅ 是 | ✅ 是 | UI 入口，改动直接影响运行时 |
| `src/*.js`（所有子文件） | ✅ 是 | ✅ 是 | 打包源码，改动直接影响运行时 |
| `build-openbitfun.mjs` | ❌ 否（本身是构建工具） | ❌ 否 | 下次构建时自动生效 |
| `index.html` | ❌ 否 | ✅ 是 | 由 `include_str!` 直接嵌入，bump 版本触发 Rust 重编译即可 |
| `style.css` | ❌ 否 | ✅ 是 | 同上 |
| `worker.js` | ❌ 否 | ✅ 是 | 同上 |
| `meta.json` / `bundle.json` | ❌ 否 | — | 本身就是版本号文件 |
| `README.md` / `source_manifest.json` / `esm_dependencies.json` | ❌ 否 | ❌ 否 | 文档/清单，不影响运行时 |

### 构建命令

```bash
# 从 repo 根目录
node src/crates/contracts/product-domains/src/miniapp/builtin/assets/ppt-live/build-openbitfun.mjs

# 或进入 ppt-live 目录后运行
cd src/crates/contracts/product-domains/src/miniapp/builtin/assets/ppt-live
node build-openbitfun.mjs
```

产出：`dist/ui.bundle.js`（未压缩，可读，开源项目不需要压缩 JS）。

### 完整操作流程（修改 JS 源码后）

```
1. 编辑 ui.js 或 src/ 下的 .js 文件
2. 运行构建：
   node src/crates/contracts/product-domains/src/miniapp/builtin/assets/ppt-live/build-openbitfun.mjs
3. bump 版本号（三处必须一致，当前 +1）：
   - meta.json:   "version": N
   - bundle.json: "version": N
   - builtin.rs:  version: N,  （路径: src/crates/contracts/product-domains/src/miniapp/builtin.rs）
4. cargo check -p openbitfun-product-domains
5. 重启 pnpm run desktop:dev（或 touch builtin.rs 触发 Rust 重编译）让新 bundle 生效
```

### 构建原理

`build-openbitfun.mjs` 使用 esbuild 从 `ui.js` 入口打包所有 `src/*.js` 和 npm 依赖
（`pptxgenjs`、`pdf-lib`、`jszip`），单次产出最终的 `dist/ui.bundle.js`。

**不存在中间 bundle**。历史上曾有一个 `vendor/ppt-export.bundle.mjs` 中间产物
和单独的 `build-vendor-bundle.mjs` 脚本，已于 2025 年移除。现在所有依赖在
`build-openbitfun.mjs` 单次构建中统一解析和内联。

> **为什么需要 bump 版本号？**
> `builtin.rs` 用 `include_str!` 将 `dist/ui.bundle.js` 嵌入 Rust 二进制。
> 版本号变化会触发 Rust 重新编译，从而重新读取更新后的 JS 文件。
> 如果只改了 JS 但不 bump 版本号，Rust 可能不会重新编译，运行时仍用旧 JS。

## 导出管线

PPT Live 只有一条 PPTX 导出管线：HTML 幻灯片和旧 element-model 幻灯片都先归一化为
`EditableSlideScene`，再由 `buildSlideFromScene(scene, pres)` 这个唯一 serializer
映射为 PowerPoint 原生文本、形状、线、表格和有明确用户图片意图的 picture。

`EditableSlideScene` 不接受栅格兜底、整页截图、SVG 图片层或降级成功状态。可确定重写的
CSS/SVG 构造会转换为原生节点；其余无法表示的输入由导出降级层（`export-degrade.js`）处理：
不支持的样式（box-shadow、text-shadow、filter、mask、background-image、动画等）被剥离，
无法表示的元素被移除，仍失败的页面被替换为简化可编辑场景——所有降级都会记录在导出摘要中，
单个元素或单页问题不再阻断整个导出。表格通过 `addTable` 写为原生 `a:tbl`，生成的几何不得产生
`p:pic` 或媒体关系。

DOM 几何来自 `getBoundingClientRect()`（border-box），以 `px / 96` 转换为英寸。
CSS padding 会成为文本框或表格单元格 inset；垂直对齐由可表示的布局属性推导。

关键设计：
- `WIDTH_SAFETY_IN = 0.15"` — 文本框加宽 0.15 英寸以吸收浏览器与 PowerPoint
  之间的字体度量差异，防止 CJK 文字错误换行
- `safeTextBoxGeometry()` — 根据文字对齐方式调整 x 坐标：
  - `left`: x 不变（多出的宽度在右侧）
  - `right`: x 左移 safety（保持右边缘不变）
  - `center`: x 左移 safety/2（保持中心不变）

### 编排流程（`export-slide-browser.js`）

```
prepareEditableSlides(slides, options)
  → loadHtmlInExportRoot(html)     // 挂载到离屏 shadow-DOM div (1280×720)
  → sanitizeSlideDocumentRoot(doc) // 净化 HTML
  → waitForExportPaint()           // 等待两帧渲染
  → normalizeWithDegradation(...)  // 严格 normalize + 有界降级修复循环
  → buildSimplifiedEditableScene() // 单页最终兜底（保留页数与文字）
  → 返回 EditableSlideScene[]
```

`options.onDegrade(record)` 逐条收集降级记录（剥样式 / 移除元素 / 简化页面），
由 `summarizePptxExportDiagnostics(scenes, degradations)` 合并进导出摘要展示给用户。

旧 element-model 页面通过 `normalizeElementSlideToEditableScene` 进入同一 scene 契约。
`exportEditablePptx(deck, scenes)` 逐页调用唯一 serializer 生成最终 PPTX；流程为顺序执行，
不插入人工延时。

## 版本号协议

修改任何源码或资源后必须 bump 版本号。三个文件必须同步更新：

| 文件 | 字段 |
|------|------|
| `meta.json` | `"version": N` |
| `bundle.json` | `"version": N` |
| `builtin.rs` (Rust) | `version: N,` |

## npm 依赖

| 包 | 用途 |
|----|------|
| `pptxgenjs` | PPTX 生成 |
| `pdf-lib` | PDF 合并 |
| `jszip` | PNG 打包 |

这些包在 `build-openbitfun.mjs` 打包时从 `node_modules` 解析并内联到最终 bundle 中。
运行时不需要 `node_modules`——所有依赖已经编译进 `dist/ui.bundle.js`。

## 单位换算速查

| 换算 | 公式 |
|------|------|
| px → inch | `px / 96` |
| px → pt | `px * 0.75` |
| inch → EMU | `inch * 914400` |
| 幻灯片尺寸 | 1280×720 px = 13.333"×7.5" (LAYOUT_WIDE) |
