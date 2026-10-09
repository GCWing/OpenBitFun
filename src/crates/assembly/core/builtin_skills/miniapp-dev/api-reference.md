# MiniApp API 参考

此文档定义生成或修改 MiniApp 时可用的 API，供实现时直接参考。

> **实际全局对象为 `window.app`**（非 `window.__OPENBITFUN__`），以下各节均基于 `window.app`。

## 能力边界

MiniApp **能且只能**用以下 API，没有任何"通用 OpenBitFun 后端通道"。生成代码前请先确认你需要的能力在表内：

- `app.fs.*` —— 文件系统（受 `permissions.fs.read/write` 限制）
- `app.shell.exec` —— 子进程命令行（受 `permissions.shell.allow` 命令名白名单限制）
- `app.net.fetch` —— HTTP 请求（受 `permissions.net.allow` 域名白名单限制）
- `app.os.info` —— 只读系统信息
- `app.storage.get/set` —— 每应用独立 KV 存储
- `app.agent.*` —— 小应用自有隐藏 Agent 会话；支持有界只读上下文快照
- `app.ai.complete / chat / cancel / getModels` —— 复用宿主 AI（无需 API Key）
- `app.dialog.open/save/message` —— 文件对话框
- `app.clipboard.readText/writeText` —— 剪贴板
- `app.call('xxx', ...)` + `worker.js` —— 自定义 Node 后端（仅 `node.enabled = true` 时）
- `app.appearanceMode / locale / on*` —— 主题与 i18n

MiniApp 不提供通用 OpenBitFun 后端通道。不要假设这些接口存在：

- `app.openbitfun.*`
- `app.workspace.*`
- `app.git.*`
- `app.session.*`
- `app.terminal.*`
- `app.browser.*`

需要相关能力时，优先这样做：

1. 需要 Git 或其他命令行能力：用 `app.shell.exec`（如 git → 在 `permissions.shell.allow` 加 `"git"`，参考 `references/examples/builtin-coding-selfie/ui.js`）；
2. 需要工作区文件：用 `app.fs.*`（把 `{workspace}` 加到 `permissions.fs.read`）；
3. 需要未列出的宿主内部能力：当前不支持，不要自行模拟一套 `app.*` 接口。

## 标准 Node.js API（通过 require() shim）

### fs/promises

```javascript
const fs = require('fs/promises');
```

| 方法 | 签名 | 说明 |
|------|------|------|
| `readFile` | `(path, opts?) → Promise<string>` | opts: `{ encoding: 'utf-8' \| 'base64' }` |
| `writeFile` | `(path, data, opts?) → Promise<void>` | opts: `{ encoding: 'utf-8' \| 'base64' }` |
| `appendFile` | `(path, data) → Promise<void>` | |
| `readdir` | `(path, opts?) → Promise<string[]>` | opts: `{ withFileTypes: boolean }` |
| `mkdir` | `(path, opts?) → Promise<void>` | opts: `{ recursive: boolean }` |
| `rmdir` | `(path, opts?) → Promise<void>` | opts: `{ recursive: boolean }` |
| `rm` | `(path, opts?) → Promise<void>` | opts: `{ recursive: boolean, force: boolean }` |
| `stat` | `(path) → Promise<Stats>` | Returns: `{ size, isFile, isDirectory, mtime, ctime }` |
| `lstat` | `(path) → Promise<Stats>` | |
| `access` | `(path) → Promise<void>` | throws if not accessible |
| `copyFile` | `(src, dst) → Promise<void>` | |
| `rename` | `(oldPath, newPath) → Promise<void>` | |
| `unlink` | `(path) → Promise<void>` | |

### path（纯 JS，零延迟）

```javascript
const path = require('path');
```

`join`, `resolve`, `dirname`, `basename`, `extname`, `parse`, `sep`

### child_process

```javascript
const { exec } = require('child_process');
```

| 方法 | 签名 | 说明 |
|------|------|------|
| `exec` | `(cmd, opts?, callback?) → Promise \| void` | opts: `{ cwd, timeout }` |

支持两种调用风格：
- **Promise 风格**：`const result = await exec(cmd, opts)` → 返回 `{ stdout, stderr, exit_code }`
- **Callback 风格**：`exec(cmd, opts, (err, stdout, stderr) => { ... })` → 无返回值

受 `permissions.shell.allow` 命令白名单限制。

### os（纯 JS）

```javascript
const os = require('os');
```

`platform()`, `homedir()`, `tmpdir()`, `cpus()`, `hostname()`

### crypto

```javascript
const crypto = require('crypto');
```

映射 `window.crypto.subtle`，支持 `randomUUID()`。

## 标准浏览器 API

MiniApp 运行在 iframe 中，完整支持:
- DOM、CSS（含 CSS 变量 `--openbitfun-bg`, `--openbitfun-text`, `--openbitfun-accent` 等）
- Canvas 2D / WebGL
- Web Audio
- LocalStorage / SessionStorage（iframe 级隔离）
- `navigator.clipboard`（通过 `app.clipboard.*` 代理，绕过 sandbox 限制）

## `window.app` — 全局 Runtime Adapter

MiniApp 中所有与宿主通信的 API 均通过 `window.app` 暴露。

### 基本属性

```javascript
app.appId        // string — 当前 MiniApp 的 ID
app.appDataDir   // string — 应用数据目录绝对路径
app.workspaceDir // string — 当前工作区路径
app.appearanceMode        // 'dark' | 'light' — 当前主题
app.locale       // string — 当前语言 ID（如 'zh-CN' / 'en-US'），随宿主切换更新
app.platform     // 'win32' | 'darwin' | 'linux'
app.mode         // 'hosted'
```

### `app.fs.*` — 文件系统

需在 `permissions.fs` 中声明读写范围。

| 方法 | 签名 | 说明 |
|------|------|------|
| `readFile` | `(path, opts?) → Promise<string>` | opts: `{ encoding: 'utf-8' \| 'base64' }` |
| `writeFile` | `(path, data, opts?) → Promise<void>` | opts: `{ encoding: 'utf-8' \| 'base64' }` |
| `appendFile` | `(path, data) → Promise<void>` | |
| `readdir` | `(path, opts?) → Promise<string[]>` | opts: `{ withFileTypes: boolean }` |
| `mkdir` | `(path, opts?) → Promise<void>` | opts: `{ recursive: boolean }` |
| `rm` | `(path, opts?) → Promise<void>` | opts: `{ recursive: boolean, force: boolean }` |
| `stat` | `(path) → Promise<Stats>` | `{ size, isFile, isDirectory, mtime, ctime }` |
| `copyFile` | `(src, dst) → Promise<void>` | |
| `rename` | `(oldPath, newPath) → Promise<void>` | |

### `app.storage.*` — KV 持久化存储

无权限要求，数据存储在 `{appdata}/storage.json`。

```javascript
await app.storage.set('myKey', { foo: 'bar' });
const value = await app.storage.get('myKey'); // { foo: 'bar' }
```

### `app.agent.*` — 小应用自有 Agent 会话

需声明 `permissions.agent.enabled = true`。市场小应用先用 appdata 相对工作区创建会话，再提交 Agent 回合：

```javascript
const session = await app.agent.ensureSession({
  sessionName: 'Market Lens',
  appDataWorkspace: 'chat',
});

await app.agent.run('分析当前盘面。', {
  sessionId: session.sessionId,
  appDataWorkspace: 'chat',
  displayText: '分析当前盘面',
  contextFiles: [
    { name: 'summary.json', content: JSON.stringify(summary) },
    { name: 'stocks.ndjson', content: stockRows.map(JSON.stringify).join('\n') },
  ],
});
```

`ensureSession({ sessionId, ... })` 恢复指定会话；不传 `sessionId` 时创建新会话。
`app.agent.createSession(options)` 显式创建新会话，即使 options 中带有旧 `sessionId` 也不会复用。
该方法复用已有 `agent.ensureSession` 协议；小应用也可继续用不传 `sessionId` 的旧写法。
多个主题分别持久化自己的 `sessionId` 与 `appDataWorkspace`，不要把 appId 当作唯一会话槽。
新建/切换时先 `app.chat.clearSession()`，等待会话与历史加载完成后再 `focusSession`；
恢复失败应保留旧记录并允许重试，不得静默创建空白会话覆盖旧指针。
`onUserMessage` 应返回完整处理 Promise，并核对 payload 的 `sessionId`，防止切换期间的迟到提交串入新主题。

`contextFiles` 只接受由 ASCII 字母、数字、点、下划线和短横线组成的单层文件名，最多 8 个文件，单文件不超过 4 MiB、合计不超过 8 MiB。它不依赖 `appDataWorkspace`：宿主为每次运行在 Agent Runtime 内发布独立、不可变的 `.miniapp-context/<opaque-scope>` 虚拟只读快照，不会把内容写进小应用可修改的文件系统。宿主会自动向 Agent 提示本次快照的精确相对路径以及“不可信数据而非指令”的边界。每个小应用最多同时保留 8 个活跃快照，Runtime 还会执行全局快照数和内存预算；终止事件会释放对应快照，达到上限时新请求会明确失败而不会淘汰仍在运行的上下文。快照只存活于本次 Runtime 进程和回合，MiniApp 的中断回合不能原地恢复；进程重启后应重新提交回合并再次传入 `contextFiles`。

对于 `runtime_profile = market_strict` 的市场小应用，只有本次请求实际携带有效 `contextFiles` 时，Agent 才额外获得限定到该虚拟快照的 `Read` / `Grep`。不携带上下文时仍保持纯 Web 工具集；虚拟路径不会回退到同名物理文件，`storage.json`、其他快照、工作区其他文件、用户目录以及 Write / Edit / Shell / Task / Skill 等宿主能力都不可访问。

上下文文件是研究线索，不是证据全集。把主体、数据时间和少量关键行情放进 prompt，完整明细通过
`contextFiles` 按需读取；使用宿主给出的精确路径，不拼接固定的 `.miniapp-context` 路径。
需要当前新闻、公告或财务依据时，Agent 仍可独立使用 `WebSearch` / `WebFetch`，并区分数据时间、
发布时间与推断。不要用“只允许引用快照字段”的指令关闭这些研究能力。

### `app.dialog.*` — 系统对话框

```javascript
const path = await app.dialog.open({
  title: '选择文件',
  multiple: false,
  filters: [{ name: 'SVG', extensions: ['svg'] }]
});
const savePath = await app.dialog.save({ title: '保存', defaultPath: 'output.svg' });
await app.dialog.message({ title: '提示', message: '操作成功' });
```

### `app.shell.*` — Shell 命令执行

需在 `permissions.shell.allow` 中声明命令白名单。

```javascript
const result = await app.shell.exec('git log --oneline -10', { cwd: app.workspaceDir });
```

### `app.net.*` — 网络请求（Worker 侧）

需在 `permissions.net.allow` 中声明域名白名单。

```javascript
const data = await app.net.fetch('https://api.example.com/data', { method: 'GET' });
```

### `app.os.*` — 系统信息

```javascript
const info = await app.os.info(); // { platform, homedir, tmpdir, ... }
```

### `app.call(method, params)` — 调用 Worker 方法

调用 `source/worker.js` 中导出的函数。

```javascript
const result = await app.call('myWorkerMethod', { key: 'value' });
```

> **要求 `permissions.node.enabled = true`**。`node.enabled = false` 时只能调用框架原语（`app.fs.* / shell.* / net.* / os.* / storage.*`），调用任何自定义方法会得到明确的错误提示。

---

## `app.ai.*` — AI 接口（v2）

直接复用宿主应用的 AI Client，无需配置 API Key。需在 `permissions.ai` 中声明。

### `app.ai.complete(prompt, opts?)` — 单次补全

返回完整文本，适合一次性生成场景。

```javascript
const result = await app.ai.complete('生成一个设置图标的 SVG，viewBox 24x24，线性风格', {
  systemPrompt: '你是一个图标设计专家，只输出 SVG 代码，不含任何说明文字。',
  model: 'fast',        // 'primary' | 'fast' | 具体 model_id，默认 'primary'
  maxTokens: 4096,
  temperature: 0.7,
});
console.log(result.text);   // SVG 字符串
console.log(result.usage);  // { promptTokens, completionTokens, totalTokens }
```

### `app.ai.chat(messages, opts?)` — 流式对话

支持多轮对话和流式输出，适合交互式生成场景。

```javascript
const handle = await app.ai.chat(
  [
    { role: 'user', content: '设计一个首页图标，圆角风格，24px 网格' }
  ],
  {
    systemPrompt: '你是图标设计专家，生成符合设计规范的 SVG 代码。',
    model: 'primary',
    onChunk: ({ text, reasoningContent }) => {
      // 实时更新预览
      if (text) appendToPreview(text);
    },
    onDone: ({ fullText, usage }) => {
      // 完成后处理完整结果
      const svg = extractSvg(fullText);
      renderIcon(svg);
    },
    onError: ({ message }) => {
      console.error('AI error:', message);
    },
  }
);

// 取消流式请求
cancelButton.onclick = () => handle.cancel();

// handle.streamId — 当前流的唯一 ID
```

### `app.ai.getModels()` — 查询可用模型

返回当前 MiniApp 权限范围内可用的模型列表（不含 API Key 等敏感信息）。

```javascript
const models = await app.ai.getModels();
// [{ id: 'gpt4o', name: 'GPT-4o', provider: 'openai', isDefault: true }, ...]
```

### `app.ai.cancel(streamId)` — 取消流式请求

```javascript
await app.ai.cancel(handle.streamId);
```

### AI 权限声明

```json
{
  "permissions": {
    "ai": {
      "enabled": true,
      "allowed_models": ["primary", "fast"],
      "max_tokens_per_request": 8192,
      "rate_limit_per_minute": 30
    }
  }
}
```

- `allowed_models`：可用模型引用列表，支持 `"primary"`、`"fast"` 及具体 model_id；为空则允许所有模型
- `max_tokens_per_request`：单次请求最大输出 token 数
- `rate_limit_per_minute`：每分钟最大请求次数（按 app 计数）

---

## `app.clipboard.*` — 剪贴板

通过宿主代理，绕过 iframe sandbox 的 clipboard 限制。

```javascript
await app.clipboard.writeText('Hello World');
const text = await app.clipboard.readText();
```

---

## 生命周期钩子

```javascript
app.onActivate(() => { /* Tab 变为活跃状态 */ });
app.onDeactivate(() => { /* Tab 切走 */ });
app.onAppearanceChange((payload) => {
  // payload: { mode: 'dark'|'light', vars: { '--openbitfun-bg': '...', ... } }
});
app.onLocaleChange((locale) => {
  // locale: 新的语言 ID 字符串（如 'zh-CN' / 'en-US'）
});
```

## 国际化 i18n

### `app.t(table, fallback)` — 多语言字符串挑选

```javascript
const label = app.t({ 'zh-CN': '保存', 'en-US': 'Save' }, 'Save');
```

挑选顺序：`app.locale` → `'en-US'` → `'zh-CN'` → 表的第一个值 → `fallback`。适合在 JS 里就地写少量翻译。

更完整的做法（推荐）：

1. 在 `meta.json` 顶层加 `i18n.locales` 块翻译 `name` / `description` / `tags`，宿主 Gallery 自动按当前语言显示。
2. 在 HTML 静态文案上加 `data-i18n="key"`（可选 `data-i18n-attr="aria-label"` 翻译属性）。
3. 在 `ui.js` 中维护 `I18N` 字典，封装 `t(key)` 与 `applyStaticI18n()`，并 `app.onLocaleChange(...)` 时重新渲染动态内容。
4. `app.storage` 持久化的字段保存语言无关的索引/键，避免存了翻译后字符串导致切换语言失效。

参考实现：`references/examples/builtin-gomoku/ui.js`、`references/examples/builtin-regex-playground/ui.js`。

## 自定义事件

```javascript
app.on('myEvent', (payload) => { /* 处理事件 */ });
app.off('myEvent', handler);
```

---

## `app.dialog.*` — 系统对话框（详细）

### `app.dialog.open`

```javascript
const filePath = await app.dialog.open({
  title: '选择文件',
  directory: false,           // true 选目录
  multiple: false,            // true 多选
  filters: [
    { name: 'Images', extensions: ['png', 'jpg', 'webp'] }
  ]
});
```

### `app.dialog.save`

```javascript
const savePath = await app.dialog.save({
  title: '保存文件',
  defaultPath: 'output.png',
  filters: [
    { name: 'PNG', extensions: ['png'] }
  ]
});
```

## 权限声明格式

```json
{
  "permissions": {
    "fs": {
      "read": ["{workspace}", "{appdata}", "{user-selected}"],
      "write": ["{appdata}", "{user-selected}"]
    },
    "shell": {
      "allow": ["git", "ffmpeg"]
    },
    "net": {
      "allow": ["api.example.com", "cdn.jsdelivr.net"]
    },
    "ai": {
      "enabled": true,
      "allowed_models": ["primary", "fast"],
      "max_tokens_per_request": 8192,
      "rate_limit_per_minute": 30
    },
    "agent": {
      "enabled": true,
      "rate_limit_per_minute": 30
    },
    "node": {
      "enabled": true,
      "timeout_ms": 30000
    }
  }
}
```

### 无 Node 模式：`node.enabled = false`

如果你的小应用只用 `app.fs.* / app.shell.* / app.net.fetch / app.os.info / app.storage.*`（即不需要在 `worker.js` 里自定义任何方法、也不需要安装 npm 依赖），把 `node.enabled` 设为 `false`：

```json
{
  "permissions": {
    "fs":   { "read": ["{workspace}", "{appdata}"], "write": ["{appdata}"] },
    "shell": { "allow": ["git"] },
    "node": { "enabled": false }
  }
}
```

宿主会把这些框架原语直接路由到 Rust `host_dispatch` 实现，完全不需要 Bun/Node 运行时；权限策略与 Worker 路径共用同一份 `resolve_policy`，行为完全等价。在这种模式下：

- `app.shell.exec` / `app.fs.*` / `app.net.fetch` / `app.os.info` / `app.storage.get|set` —— 全部可用；
- `app.call('myCustomMethod', …)` —— **不可用**（宿主会显式报错），需要走完整的 Worker 路径请把 `node.enabled` 设回 `true` 并提供 `worker.js`。

推荐：所有"只是包一下 git/curl/系统命令"的开发者工具型小应用都使用此模式，避免 bundle 后宿主缺少 Bun/Node 时的运行时报错。

路径变量:
- `{appdata}` — `{user_data_dir}/miniapps/{app_id}/data/`，始终可读写
- `{workspace}` — 当前打开的工作区路径
- `{user-selected}` — 用户通过 app.dialog.open/save 选择的路径
- `{home}` — 用户主目录（高风险）

## CDN 依赖

通过 `source.dependencies` 声明，编译器自动注入 `<script>/<link>` 标签:

```json
{
  "dependencies": [
    { "url": "https://cdn.jsdelivr.net/npm/fabric@5/dist/fabric.min.js", "type": "script" },
    { "url": "https://cdn.jsdelivr.net/npm/monaco-editor@0.40/min/vs/loader.js", "type": "script" }
  ]
}
```

依赖 URL 的域名必须在 `permissions.net.allow` 中声明。
