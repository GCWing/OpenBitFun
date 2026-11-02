---
name: miniapp-dev
description: 'Generate, operate, and refine OpenBitFun MiniApps. Use when the user wants a new MiniApp, asks the Agent to inspect or operate a running MiniApp, or wants an existing MiniApp redesigned or extended. Typical triggers: "做一个小应用", "操作这个 MiniApp", "查看小应用当前状态", "改造 mini app".'
---

# OpenBitFun MiniApp 生成与操作指南

本技能用于**为用户生成、操作、改造和完善 MiniApp**：

- 做一个新的 OpenBitFun 小应用
- 结合源码理解并操作用户正在使用的 MiniApp，保留当前草稿与状态
- 修改某个 MiniApp 的交互、界面、能力、数据流
- 把一个想法变成可运行的 MiniApp

开始生成新的 MiniApp 前，先读 [`design-playbook.md`](design-playbook.md)；运行时能力和宿主 API 细节再查 [`api-reference.md`](api-reference.md)。

## 目标

**交付一个能在 OpenBitFun 里运行、风格合适、权限最小、结构清晰的 MiniApp**。

成功标准：

- 用户的问题被这个 MiniApp 直接解决
- 生成结果能在 MiniApp 场景里运行
- 只申请必要权限
- 不假设不存在的宿主 API
- 在 light/dark、zh/en 下都可用
- 新建应用默认提供有界业务状态和核心语义动作，Agent 与 UI 操作同一实例、共用业务函数

操作已有应用时直接进入第 4 节的源码与业务操作流程；下面的设计准备适用于新建或改造应用。

## 先做什么

在写代码前，先完成这 4 件事：

1. 明确用户目标
   这个 MiniApp 是工具型、展示型，还是混合型？核心动作是什么？

2. 找最近的参考
   看 `references/examples/` 中最贴近任务形态的内置/示例 MiniApp 目录

3. 选运行模式
   先判断是否真的需要 `worker.js` 和 `node.enabled = true`。

4. 定最小交付面
   第一版只做最核心路径，不为了“看起来完整”堆功能。

## 生成流程

### 1. 先澄清，再实现

如果下面任一项不清楚，先问清楚，不要替用户脑补：

- 解决什么问题
- 谁使用
- 要读写哪些路径
- 要不要读工作区文件
- 要执行哪些命令
- 要不要执行命令
- 要访问哪些域名
- 要不要联网
- 要不要持久化状态
- 要不要多语言
- 要不要 Tweaks 这类运行时可调变体
- 有没有现成视觉参考

### 2. 优先复用现有 MiniApp 语言

不要从零发明一套 OpenBitFun 风格。先从已有 MiniApp 中借鉴：

- 布局密度
- 圆角和间距
- 卡片和面板结构
- 主题变量使用方式
- i18n 组织方式

默认优先做**工具型**设计：冷静、克制、信息密度高、操作路径短。

### 3. 优先选“无 Node 模式”

如果需求只靠这些能力就能完成：

- `app.fs.*`
- `app.shell.exec`
- `app.net.fetch`
- `app.os.info`
- `app.storage.*`

那么优先使用：

```json
{
  "permissions": {
    "node": { "enabled": false }
  }
}
```

只有在这些场景下才启用 `node.enabled = true`：

- 需要自定义 `worker.js` 方法
- 需要 npm 依赖
- 需要较长链路或较复杂的后台逻辑

### 4. 选择正确的编辑流程

操作已有 MiniApp 的主路径是：`inspect-app` 读源码理解业务函数和参数 →
`MiniAppBrowser.open` 连接当前实例 → `observe_bridge` 读取当前业务状态 →
`act_bridge` 调用语义动作 → 用动作返回的状态确认结果，必要时再次观察。
源码说明实现，不能代替当前状态；观察必须包含用户尚未保存的输入和选择。

日常操作不要通过修改源码、`update-app`、`FinalizeMiniApp`、重载或切换呈现来获得控制能力。
这些动作可能重建文档并丢失内存状态。旧应用缺少接口时，先读源码确认已有能力，使用可用的
DOM/输入作为兼容路径；不可用就说明具体限制，不猜动作名称。
补接口属于应用改造：先明确当前状态如何保存与恢复；无法保留时说明中断并征得用户同意。
改造完成后重新观察业务状态、获取 targetId，不能假设旧草稿或选中项仍存在。

先判断当前任务属于哪一种，不要混用：

#### 已打包客户端的直接管理（优先）

用 `OpenBitFunControl` 的 `get` 查询 `feature.miniapps`，按返回的 schema
调用 `list-apps`、`inspect-app`、`create-app`、`update-app`、`delete-app`。
这些操作直接在持有应用的产品宿主编译、保存和通知界面，不需要源码仓库、
Node.js 或本地目录。更新前先读取应用，使用它的 `appId` 和 `expectedVersion`；
只传要修改的字段，省略的源码、权限和用户存储保持原样。
删除只用于用户明确要求删除，不能用删除重建来实现修改。
远程工作区或控制端不要用本地文件工具编辑宿主路径，使用以上结构化操作；
目标不支持时报告具体限制。

文件较多且当前是本地工作区时，可使用下面的文件编辑流程。

#### 新建 MiniApp

1. 调用 `InitMiniApp`，保存返回的 `app_id` 和根目录。
2. 只在返回的根目录中编辑 `source/index.html`、`source/style.css`、
   `source/ui.js`、按需编辑 `source/worker.js`，以及确有必要的 `meta.json`
   产品字段。
3. 编辑完成后必须调用 `FinalizeMiniApp`，传入刚才的 `app_id`。
4. 只有 `FinalizeMiniApp` 成功后才算交付完成。

#### 更新已有 MiniApp

1. 复用已有应用的 `app_id` 和根目录，不要再次调用 `InitMiniApp` 创建副本。
2. 在已有根目录中完成修改。
3. 每一批文件修改完成后必须调用一次 `FinalizeMiniApp`。
4. 如果预期有修改但返回 `changed: false`，检查文件是否写进了正确的应用根目录；
   不要靠手动增加版本号掩盖问题。

`FinalizeMiniApp` 会重新从磁盘读取源码、编译 `compiled.html`、持久化内容修订，
并通知已经打开的 MiniApp 刷新。版本号由它管理；不要手改 `version`、
`created_at`、`updated_at`、`runtime` 或 `compiled.html`。

#### 定制草稿

如果当前提示明确给出了 `Draft root` / 草稿目录：

- 只编辑草稿目录
- 不调用 `InitMiniApp`
- 不调用 `FinalizeMiniApp`
- 由定制面板负责“刷新草稿预览”和“应用草稿”

### 5. 用 `InitMiniApp` 创建骨架

创建后，围绕这些文件工作：

- `index.html`
- `style.css`
- `ui.js`
- `worker.js`（只有需要时）
- `meta.json`

默认做法：

- `index.html` 只放清晰结构
- `style.css` 先声明设计系统
- `ui.js` 负责状态、渲染、事件、i18n
- `worker.js` 只承载真正需要后台执行的逻辑

#### 默认生成业务状态与语义动作

`InitMiniApp` 骨架包含一个最小 `set-text` 示例。实现应用时替换为真实业务接口，
不要保留无意义示例，也不要为 Agent 复制一套业务逻辑：

- 恢复持久化状态后注册 `app.agent?.expose?.({ observe, actions, act })`，兼容没有此 API 的旧宿主。
- `observe` 返回当前业务状态，包括相关草稿、选择、处理进度、结果或错误；只读，无保存/重载副作用。
- 返回值有界；长文本或列表提供长度与截断标记，不让 Agent 把摘要当完整数据。
- `actions` 声明核心用户意图，如应用筛选、选择记录、更新草稿。参数及返回值在源码中说明。
- UI 事件和 `act` 调用相同业务函数，沿用原有校验、权限、持久化和渲染逻辑。
- 修改前验证全部参数；拒绝未知动作；省略字段保持原值。动作完成后返回真实结果或当前状态。
- 异步动作等待业务完成后返回；长任务返回明确的运行状态并可观察进度，不把“收到请求”当“完成”。
- 纯展示应用至少提供只读状态和空动作列表，不伪造可执行动作。

参考 `references/examples/builtin-regex-playground/ui.js`：
`set-input` 局部更新、`apply-pattern` 保留用户文本、`select-match` 复用 UI 选择函数。
协议兼容允许旧应用没有接口；新应用的交付默认包含这些能力。

窗口控制栏也属于 MiniApp 定制点：在 `meta.json` 的 `chrome.titlebar`
中声明外观、布局和应用动作；在 `source/ui.js` 通过 `app.chrome?.onAction`
处理动作。草稿预览包含独立窗口栏；应用内动作由主顶部栏承载。
系统控件遵循宿主平台：macOS 保留原生红绿灯，Windows 复用主应用右侧窗口按钮。
只定制标题、应用按钮和语义配色，不移动或重绘系统控件。
配置字段与图标列表见 `api-reference.md` 的 MiniApp window chrome。
不要在应用内容中再复制原生窗口按钮，也不要直接调用 Tauri。

### 6. 只使用真实存在的宿主能力

MiniApp 里可用的是 `window.app`。

默认可依赖的能力：

- `app.fs.*`
- `app.shell.exec`
- `app.net.fetch`
- `app.os.info`
- `app.storage.get/set`
- `app.agent.ensureSession / run / cancel / turnText / cancelStaleRuns / onEvent`
- `app.dialog.*`
- `app.clipboard.*`
- `app.ai.*`
- `app.appearanceMode`
- `app.locale`
- `app.onAppearanceChange`
- `app.onLocaleChange`
- `app.t(...)`
- `app.call(...)` 仅在 `node.enabled = true` 时

详细接口查：

- [`api-reference.md`](api-reference.md)

### 7. 不要假设这些 API 存在

默认**不要**写这些不存在的接口：

- `app.openbitfun.*`
- `app.workspace.*`
- `app.git.*`
- `app.session.*`
- `app.terminal.*`
- `app.browser.*`

如果你需要 Git 能力，优先：

```javascript
await app.shell.exec('git ...', { cwd: app.workspaceDir })
```

如果你需要工作区数据，优先：

```javascript
await app.fs.readFile(...)
```

### 8. 从第一版就带上 i18n 和 theme

不要把多语言和主题适配留到最后。

至少做到：

- `meta.json` 带 `i18n.locales`
- 静态文案可重渲染
- 动态文案走 `app.t(...)` 或自有 `I18N` 表
- 样式优先使用 `--openbitfun-*`
- 测试 light/dark + zh/en

### 9. 先做核心体验，不补假内容

如果缺素材、图标、真实数据：

- 用明确占位
- 用 fixture 数据
- 用“待补”标记

不要：

- 硬画劣质插画
- 编造业务数据
- 用装饰性内容填空白

## 硬约束

### 交互

- 首屏就要能理解用途
- 主路径操作数尽量少
- 点击区域至少 32px
- 正文不要小于 13px

### 视觉

- 禁止默认蓝紫渐变 AI 风背景
- 禁止 emoji 充当主图标
- 禁止“每块一个风格”
- 禁止堆无意义 stats、sparkline、装饰 icon

### 代码

- 不需要 `worker.js` 时不要启用 Node
- 不需要的权限不要申请
- 不要把大量逻辑塞进 HTML
- `ui.js` 过长时主动拆成模块化结构

### 内容

- 不为填空白加内容
- 每个 section 都要有明确用途
- 不擅自扩 scope

## 你应该参考什么

生成前优先阅读最贴近的一两个参考，而不是全看：

- `references/examples/demo-git-graph/`
- `references/examples/demo-icon-design-system/`
- `references/examples/builtin-regex-playground/`
- `references/examples/builtin-coding-selfie/`
- `references/examples/builtin-gomoku/`
- `references/examples/builtin-daily-divination/`

生成新的 MiniApp 时，默认先读：

- [`design-playbook.md`](design-playbook.md)

如果任务偏运行时调用，再看：

- [`api-reference.md`](api-reference.md)

## 交付前检查

交付前至少确认：

- MiniApp 能运行
- 主路径可操作
- 权限是最小集
- `node.enabled` 选择合理
- 没有调用不存在的 `app.*` API
- i18n 至少覆盖 `zh-CN` / `en-US`
- light/dark 没有明显样式问题
- 没有遗留 “TODO / 占位 / Lorem ipsum”
- 普通新建/更新流程已成功调用 `FinalizeMiniApp`
- 预期有改动时 `FinalizeMiniApp` 返回 `changed: true`
- 没有手动修改生命周期字段或 `compiled.html`
- 在同一已打开实例中，先由用户输入未保存内容，再经 `observe_bridge` / `act_bridge` 完成业务任务
- 验证没有源码更新、文档重载或实例替换；未修改的输入、草稿和相关选择保持原样
- 动作结果与可见 UI 一致；非法参数/未知动作失败且不部分修改状态
- 验证可读取标签页与不依赖 DOM 的桥接路径；明确区分测试夹具、原生窗口和远程实测证据

## 发布到市场

用户明确要求把 MiniApp 发布/上架到市场时，用 `PublishMiniApp` 工具：

- 传 `app_id` 和 1–5 张截图路径（PNG/JPEG/WebP，单张 ≤ 5 MiB）。
  没有截图时先向用户要，或请用户在「市场 → 我的投稿」用「截取当前画面」生成。
- **截图比例用 16:9，推荐 1920×1080**。市场网页和 OpenBitFun 桌面端都按 16:9
  居中裁剪显示，非 16:9 的图会被切掉边缘。第一张是列表卡片封面，选最能说明
  用途的那张，关键信息放画面中部不要贴边。超过 2560px 的边会被服务端缩到
  2560，所以 2560×1440 是有效上限。
- 名称、描述、图标、分类、标签自动取自 `meta.json`；slug 和版本号自动推导。
  发布前确认 `meta.json` 的 `description` 非空、权限是最小集
  （市场会拒绝 `node.enabled=true`、宽泛 fs scope 等）。
- 未登录时工具会返回 GitHub 授权链接：把链接给用户，等用户完成授权后
  用相同参数再调用一次即可继续。
- 提交后进入人工审核；用户可在「市场 → 我的投稿」查看状态。
- 这是对外动作：只在用户明确要求发布时调用，不要主动发布。
