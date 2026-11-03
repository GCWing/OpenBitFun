# MiniApp 通用 Web Agent 操作方案

## 目标

让主 Agent 能像操作一个 Web 页面一样操作任意 MiniApp，重点是：

```text
打开 MiniApp
→ 读取当前页面/组件状态
→ 定位元素
→ 点击、输入、按键、滚动
→ 等待页面更新
→ 再次读取状态
```

本方案**不负责修改 MiniApp 源码**，也不建设 MiniApp 编辑器、草稿系统、版本控制、发布系统或复杂的远程 Job 平台。现有 MiniApp 的源码、编译、存储和运行逻辑保持不变。

## 核心判断

MiniApp 本质上是 Web 页面，因此优先复用 BrowserUse 的 Web 操作语义，而不是让 Agent 通过本地文件或 Tauri 专用命令操作：

- 对普通 DOM/UI MiniApp：读取 DOM、文本、属性和可访问性信息，执行 click/type/key/scroll 等操作。
- 对 iframe：由宿主创建一个绑定到指定 MiniApp 的 Web 操作会话，将操作转发到 iframe。
- 对 Canvas 或自定义渲染 MiniApp：通用 Web 层只能发送键盘/鼠标事件，无法凭空知道 Canvas 内部状态；需要 MiniApp 可选地注册一个只读状态与动作 bridge。
- 不把截图和视觉识别作为主协议；截图最多作为未来调试或降级能力，不作为 Agent 操作闭环的必要条件。

因此，“任意 MiniApp 都能操作”的正确含义是：

1. 所有 MiniApp 都获得一套通用 Web 操作能力，不需要逐个实现专用工具。
2. 需要读取内部状态的 Canvas/游戏类 MiniApp，可以额外实现同一个可选 bridge；没有 bridge 时仍可接收通用输入，但不能声称宿主能读取其内部变量。

## 推荐架构

```text
主 Agent
   ↓
BrowserUse 风格的 MiniApp Web Tool
   ↓
MiniApp Web Surface Adapter
   ↓
MiniApp iframe / WebView
   ↓
DOM、可访问性树，或可选 Agent Bridge
```

### 1. MiniApp Web Tool

新增一个面向 Agent 的轻量工具，名称可以是 `MiniAppBrowser` 或 `MiniAppWeb`。它不是 CRUD 工具，不暴露源码和宿主路径，只提供当前 MiniApp Web surface 的操作。

推荐操作：

```text
open
close
inspect
find
read
click
type
key
scroll
wait
observe_bridge
act_bridge
```

主 Agent 的典型使用方式：

```text
open(appId)
inspect()
find(role/text/testId)
click(target)
read(target)
type(target, text)
wait()
inspect()
```

### 2. Web Surface Adapter

Desktop 宿主负责把 MiniApp iframe 当作一个受控 Web surface：

- 根据 `appId` 打开或定位 MiniApp iframe；
- 创建 `sessionId`，将会话绑定到一个 `appId` 和一个具体 iframe；
- 将 BrowserUse 风格的定位、读取和输入操作转发到 iframe；
- 返回结构化 DOM/可访问性结果，而不是宿主绝对路径；
- 会话结束后释放 iframe 引用和输入状态。

Adapter 可以复用现有 MiniApp iframe/runtime 宿主实现，但不能把 `PathManager`、源码目录或 `draftRoot` 作为操作接口的一部分。

### 3. 可选 Agent Bridge

普通 DOM MiniApp 不需要修改代码即可使用通用操作。对于 Canvas、WebGL、游戏或状态主要存在 JavaScript 内存中的 MiniApp，提供一个统一的可选 bridge：

```text
observe -> 读取经过筛选的 JSON 状态
act     -> 执行 MiniApp 注册的语义动作
```

bridge 通过 `postMessage` 或 `MessageChannel` 通信，不能依赖宿主猜测 iframe 内部变量名，也不能让 Agent 直接执行任意 JavaScript。

## 通用操作契约

### 会话

```json
{
  "action": "open",
  "appId": "demo-app"
}
```

```json
{
  "sessionId": "miniapp-session-123",
  "appId": "demo-app",
  "surface": {
    "kind": "iframe",
    "width": 800,
    "height": 600
  },
  "capabilities": [
    "dom",
    "accessibility",
    "input"
  ]
}
```

`sessionId` 必须绑定一个 MiniApp。后续操作只能作用于该 session，不能用一个应用的句柄操作另一个应用。

### 读取页面结构

```json
{
  "action": "inspect",
  "sessionId": "miniapp-session-123"
}
```

返回结构化页面信息：

```json
{
  "url": "miniapp://demo-app",
  "title": "Demo",
  "tree": {
    "role": "main",
    "children": [
      {
        "role": "button",
        "name": "开始",
        "testId": "start-button",
        "enabled": true
      }
    ]
  }
}
```

默认返回可供 Agent 定位的摘要，不直接返回完整 HTML、脚本、宿主路径或内部对象。需要详细内容时，通过明确的 `find/read` 请求读取目标节点。

### 定位元素

优先级建议：

```text
稳定 testId
→ accessibility role/name
→ label/name
→ 文本
→ CSS selector（仅作为兼容 fallback）
```

例如：

```json
{
  "action": "find",
  "sessionId": "miniapp-session-123",
  "locator": {
    "testId": "start-button"
  }
}
```

返回一个短生命周期的 `targetId`，后续点击或读取使用 `targetId`，而不是让 Agent 自己拼接宿主选择器。

### 输入与读取

第一版支持：

```text
click
 type
 keyDown
 keyUp
 pointerDown
 pointerUp
 pointerMove
 scroll
 readText
 readValue
 getAttribute
 wait
```

示例：

```json
{
  "action": "click",
  "sessionId": "miniapp-session-123",
  "targetId": "target-1"
}
```

```json
{
  "action": "type",
  "sessionId": "miniapp-session-123",
  "targetId": "target-2",
  "text": "北京"
}
```

```json
{
  "action": "keyDown",
  "sessionId": "miniapp-session-123",
  "key": "ArrowLeft"
}
```

```json
{
  "action": "wait",
  "sessionId": "miniapp-session-123",
  "durationMs": 200
}
```

`wait` 不是为了做持久化 Job，只是给页面动画、网络请求和游戏循环一个稳定的观察间隔。

## 可选 Bridge 契约

### 能力声明

MiniApp 如果需要让 Agent 读取内部状态或使用语义动作，可以在 iframe 内发送：

```javascript
window.parent.postMessage({
  type: "openbitfun:miniapp-agent-ready",
  appId: "demo-app",
  schemaVersion: "agent.v1",
  capabilities: ["observe", "act", "restart"]
}, expectedOrigin);
```

### 读取状态

```json
{
  "method": "observe"
}
```

返回任意符合约束的 JSON 状态，例如：

```json
{
  "phase": "playing",
  "score": 1200,
  "selectedItem": "item-3",
  "player": {
    "x": 380,
    "y": 520
  }
}
```

状态必须是：

- JSON 可序列化；
- 有大小上限；
- 不包含函数、Window、DOM 节点、文件句柄、宿主路径和凭据；
- 由 MiniApp 自己决定哪些状态对 Agent 可见。

### 语义动作

```json
{
  "method": "act",
  "action": {
    "type": "restart"
  }
}
```

或：

```json
{
  "method": "act",
  "action": {
    "type": "move",
    "direction": "left",
    "durationMs": 200
  }
}
```

不同 MiniApp 可以声明不同的动作，但协议外壳保持一致：

```text
capabilities
observe
act
requestId
response
error
```

这样雷霆战机可以声明 `move/fire/restart`，音乐播放器可以声明 `play/pause/next`，表格可以声明 `selectRow/addRow`，而 Agent 使用的工具不需要变化。

## 不采用的方式

### 不把源码编辑作为主控制面

不通过：

```text
InitMiniApp
Read/Write/Edit
FinalizeMiniApp
```

来完成日常操作。它们继续作为开发/兼容工具，但不能成为 Agent 使用 MiniApp 的必要步骤。

### 不让宿主猜测 iframe 内部变量

不依赖：

```javascript
iframe.contentWindow.gameState
iframe.contentWindow.somePrivateVariable
```

这类做法受打包、压缩和实现细节影响，无法成为通用 MiniApp 协议。

### 不开放任意 JavaScript evaluate

不提供：

```json
{
  "action": "evaluate",
  "code": "..."
}
```

否则 Agent 可以绕过页面行为直接修改内部状态、读取凭据或访问宿主能力。调试阶段可以保留开发者专用通道，但不能进入主 Agent 工具契约。

### 不把视觉作为必要依赖

截图可以作为未来的调试或降级能力，但通用主路径使用：

```text
DOM / Accessibility / Bridge State
```

对于纯 Canvas MiniApp，如果没有可选 bridge，系统必须明确返回“只能发送通用输入，无法读取内部状态”，而不是伪装成已经理解了游戏。

## 代码落点

- **Agent 工具**：在 `src/crates/assembly/core/src/agentic/tools/implementations` 增加 MiniApp Web 操作工具，并在 `product_runtime/materialization.rs` 注册；工具契约只包含 Web surface 操作。
- **共享契约**：在 `src/crates/contracts/product-domains/src/miniapp` 增加 session、locator、DOM/accessibility 摘要、输入事件和 bridge 消息 DTO；不把 Tauri 类型下沉。
- **Desktop Adapter**：在 `src/apps/desktop` 的 MiniApp iframe/runtime 宿主中实现 Web surface 绑定、iframe 消息转发和输入事件分发。
- **BrowserUse 集成**：复用 BrowserUse 的 locator、inspect、input、wait 语义；如果现有 BrowserUse 只支持外部浏览器，则增加 `miniapp` target adapter，不要求把 MiniApp 伪装成公网 URL。
- **现有反向 bridge**：`src/crates/contracts/product-domains/src/miniapp/agent_bridge.rs` 处理的是 MiniApp 调 Agent，不能直接当作主 Agent 调 MiniApp 的协议；可以借鉴其 session/request/event 组织方式，但保持权限域独立。
- **现有 Tauri API**：复用 `src/apps/desktop/src/api/miniapp_api.rs` 的 runtime/iframe 基础能力；不要新建一套与 iframe runtime 平行的业务 owner。

## MVP 顺序

### MVP-1：通用 DOM/Web 操作

1. 建立 `open/close/inspect/find/read/click/type/key/scroll/wait` 工具。
2. 为每个 MiniApp 创建绑定 `appId` 的 Web surface session。
3. 返回 DOM/accessibility 摘要和短生命周期 targetId，不返回宿主路径。
4. 复用现有 BrowserUse 的 locator/input 语义。

验收：不修改 MiniApp 源码，Agent 可以打开任意 DOM 型 MiniApp，定位按钮/输入框/文本，完成点击、输入、键盘和滚动操作。

### MVP-2：通用 iframe Bridge

1. 增加 `agent-ready/request/response` 的 `postMessage` 或 `MessageChannel` 协议。
2. 增加可选 `observe` 和 `act` bridge 能力声明。
3. 将 bridge 返回的 JSON 状态和语义动作接入同一个 MiniApp Web session。
4. 对没有 bridge 的 MiniApp 返回能力缺失，不静默猜测内部状态。

验收：同一个 Agent 工具可以操作 DOM MiniApp、Canvas MiniApp 和游戏 MiniApp；DOM MiniApp 不需要额外适配，Canvas/游戏通过可选 bridge 读取内部状态。

### MVP-3：稳定性和安全收敛

1. 增加 target stale、iframe reload、页面导航、操作超时和 bridge 断开错误。
2. 增加 selector/role/testId 的定位优先级和大小限制。
3. 限制 bridge origin、session、capability 和消息大小。
4. 保留开发者调试接口，但主 Agent 不开放任意 JavaScript evaluate。

## 验证清单

- DOM：按钮、输入框、列表、表单、滚动区域、键盘快捷键和异步页面更新均可操作。
- iframe：session 只能操作绑定的 appId；iframe reload 后能返回明确的 stale/reconnect 状态。
- bridge：observe/act requestId 配对、能力声明、消息来源校验、超时和错误返回稳定。
- 通用性：普通 DOM MiniApp 不需要修改；Canvas/游戏 MiniApp 只需实现统一可选 bridge，不增加专用 Agent 工具。
- 安全：不能通过 selector、targetId 或 bridge 访问宿主路径、凭据、其他 MiniApp 或任意 JavaScript。
- 视觉独立：主 Agent 的成功验收不依赖截图、OCR 或视觉模型；纯 Canvas 且无 bridge 时明确报告能力不足。
- 兼容：现有 `agent_bridge.rs` 的 MiniApp -> Agent 能力、runtime、worker 和 UI 操作继续工作，不与新的主 Agent -> MiniApp Web 操作混淆。
- E2E：`open -> inspect -> find -> read/click/type/key -> wait -> inspect`，以及 `open -> bridge observe -> bridge act -> bridge observe`。
