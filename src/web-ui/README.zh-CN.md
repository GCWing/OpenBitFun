# OpenBitFun Web UI

中文 | [English](./README.md)

## 概述

本目录是 OpenBitFun 的 **Web UI**（React + TypeScript）。同一份前端代码会被复用在：

- **Desktop**：通过 **Tauri** 加载运行
- **Server/Web**：构建为静态资源，由后端提供访问

## MCP 配置

在 Desktop 打开 **设置 → 工具 → MCP**，通过表单添加或编辑用户级服务。
可选择服务地址（Streamable HTTP）或启动命令（stdio）；参数逐项填写，环境变量
和请求 Header 使用名称/值表格。已保存的值默认隐藏，未编辑时保留；这些值继续
使用现有配置文件存储，并未引入新的凭据库。

新服务和 JSON 导入默认保存为禁用状态，确认后在列表中点击“启用并启动”。
导入支持 `mcpServers` JSON，预览后按项选择；已有 ID 必须改名后再导入，不会
覆盖现有服务。编辑运行中的服务使用“保存并应用”，可能重新连接；配置保存结果
与连接失败分别反馈。

保留单服务和完整配置的 JSON 编辑入口。编辑会保留未知字段；表单无法安全处理的
配置可继续使用 JSON。并发修改通过版本校验阻止静默覆盖。此管理页编辑本机 Desktop
用户配置，不提供项目级、Peer Device 或独立 Web 端的配置管理入口。

## 浮动会话

右下角窗口默认以文字模式打开持久保存的 OpenBitFun 控制会话。将主标签栏的会话
拖入窗口即可继续交流；通过返回主窗口按钮或拖回主标签栏移出。带 Agent 的 MiniApp
会自动加入对应会话标签。移动会话时保留草稿、附件、执行状态与阅读位置。

MiniApp 页头的「对话」可找回当前主题的原会话，包括已隐藏的小窗标签；小窗的
「打开应用」可返回对应应用页。小窗展开且正在显示 MiniApp 对话时，会跟随主区应用
切换；正在输入、通话或查看普通会话时保留当前选择。后台更新不会重新展开已收起的
小窗或恢复已隐藏的标签。关闭应用标签页会停止其 Agent 任务和 Worker、结束其通话并
移除小窗入口，已保存的历史记录保留；停止失败时保留应用并提示。切换设备仅卸载视图，
不会停止原设备上的应用。

控制会话使用连续的轻量记录，向上滚动自动加载更早记录并保留阅读位置。
文字模式下，记录可滚到固定的顶部操作区下方，离开顶部后操作区渐显透明毛玻璃。
当前用户消息下方用轻微流动的三点表示真实处理状态，等待用户回应或处理结束时停止。
收起动画结束后整个面板隐藏，草稿与记录继续保留。
顶部的新建按钮会在当前主机创建并记住新的操控会话，保留以前的记录；当前任务或通话结束后可新建。
对端主机需要声明 `control_conversation_reset_v1` 能力才显示新建入口。
记录上方的小 Logo 与文字按钮用于开启实时通话，并沿同一中轴展开为
粒子形象；通过原来的左上角返回箭头回到文字，粒子收回为小 Logo，记录、阅读位置与未发送草稿持续保留。执行进展
仅展示实际提供的信息。出现权限确认时会恢复文字输入区，并保持通话。
其他会话标签继续使用原有聊天展示与标题栏语音入口。收起窗口也会保持通话，只有挂断才结束通话。
文字与语音共享保存的会话记录，通话始终绑定开始时的会话与设备。
ACP 和 Detached Dispatch 会话保留文字交互；共享语音历史需要目标主机声明
`control_conversation_v1` 能力。
独立 Web Server 尚未提供该控制会话接口，需要使用 Desktop 或支持该能力的对端主机。

## 技术栈

- React 18.3
- TypeScript 5.8
- Vite 7
- SCSS
- Zustand（状态管理）
- Monaco Editor

## 目录结构

依赖版本统一由仓库根目录的 `pnpm-lock.yaml` 锁定。

```
src/web-ui/
├── README.md                     # 英文版说明
├── README.zh-CN.md               # 本文件（中文版）
├── LOGGING.md                    # 日志与调试说明
├── index.html                    # 入口 HTML
├── package.json                  # 依赖与脚本
├── public/                       # 静态资源
├── src/                          # 前端源代码
│   ├── app/                      # 应用主界面
│   ├── features/                 # 按功能拆分的模块
│   ├── flow_chat/                # 对话/工作流聊天界面
│   ├── generated/                # 生成内容（占位/产物）
│   ├── hooks/                    # 通用 hooks
│   ├── infrastructure/           # 基础设施（API/i18n/主题等）
│   ├── locales/                  # 文案与翻译资源
│   ├── shared/                   # 共享工具与类型
│   ├── tools/                    # 工具 UI（编辑器/终端/Git 等）
│   ├── main.tsx                  # 应用入口
│   └── vite-env.d.ts             # Vite 类型声明
├── tsconfig.json                 # TS 配置
├── tsconfig.node.json            # Node/Vite TS 配置
├── vite.config.ts                # Vite 构建配置
└── vite.config.version-plugin.ts # 版本插件
```

## 前端通信层架构

### 核心设计

同一份 UI 代码支持两种运行形态：

- **Desktop**：Tauri API（`invoke`, `listen`）
- **Server/Web**：WebSocket / Fetch API

### 适配器模式（概念示例）

```ts
const adapter = IS_TAURI ? TauriAdapter : WebSocketAdapter;

await adapter.request("execute_agent_task", params);
adapter.listen("agentic://text-chunk", callback);
```

## 开发指南

### 启动开发服务器

```bash
# Desktop
pnpm --dir src/web-ui run dev

# Server/Web
VITE_BUILD_TARGET=web pnpm --dir src/web-ui run dev
```

### 构建

```bash
# Desktop
pnpm --dir src/web-ui run build

# Server/Web
VITE_BUILD_TARGET=web pnpm --dir src/web-ui run build
# 产物：dist/
```

## 相关文档（本包内）

- [日志说明](LOGGING.md)
- [独立设计系统](../../design-system/README.md)
- [i18n README](src/infrastructure/i18n/README.md)

## 注意事项

打包后的 Desktop 可在创造模式中通过 prompt 控制已有设置、增删改已安装的 MiniApp，
以及持久修改客户端 UI，无需源码或构建工具。修改 UI 时，在原生预览窗口选择保留或
撤销；只有真实界面和自定义代码激活成功才开始确认倒计时，失败或超时恢复原版本。

自定义模块还能注册 Agent 可调用的命令，并通过持久状态与事件组合能力。随客户端
附带的 [Creation API](public/openbitfun-creation-api.md) 说明发现、激活与清理接口。
这些扩展需要可见的本地 Desktop，远程/Peer/无界面场景明确不可用。MiniApp 的结构化
源码操作走已安装产品的生命周期管理器，更新保留未提供的源码字段和已有应用数据。

1. **不要在组件里直接调用 Tauri API**，应通过适配器层统一封装。
2. **注意 Web 兼容性**（浏览器环境不一定具备所有能力）。
3. **优先使用 CSS 变量**，避免硬编码颜色/尺寸。

## 订阅账号与模型列表

在 **设置 → 模型 → 订阅账号** 中登录、选择使用账号，再打开模型选择器。
“刷新模型列表”会重新获取账号当前可用的模型，无需退出登录或重开编辑器。
已保存的模型不会被删除，也可以手动填写服务商支持的模型 ID。

反重力通过账号的 `fetchAvailableModels` 接口获取模型；Codex 使用订阅模型目录，
保留公共 API 不提供的订阅专属模型。OpenCode 只需选择 Go/Zen 和模型，OpenBitFun
根据账号目录自动匹配 Chat Completions、Responses 或 Messages 协议。
xAI、Hermes 查询各自的模型接口。Hermes 所有模型（包括 `anthropic/*`）使用
Chat Completions 和 Nous OAuth Bearer 认证，与上游在原生 Messages 缓存问题解决前的
默认路由保持一致。已保存的模型 ID 和订阅凭据继续有效。

订阅登录会自动提供必需的认证头和账号头，即使旧模型配置使用了“替换自定义请求头”模式，
也无需在模型编辑器中手动粘贴令牌或提供商身份请求头。这些适配仅对订阅模型启用，
API Key 模型继续使用原有请求配置。

模型是否可用以当前账号接口返回的 ID 为准。旧名称不一定代表底层模型没有更新，
服务商公布的新模型也不保证对每种订阅或 OAuth 客户端开放。获取失败时会显示错误，
不会把预设名单当作账号实际支持的模型。反重力浏览器登录需要在本机桌面端完成；
其他平台的设备码流程可以在另一台设备的浏览器中授权。

## 生态兼容状态检查

在本地 Desktop 打开一个临时工作区，从“生态兼容”选择对应 Agent。只使用测试内容或可撤销的副本。
类别的“可发现”表示已接入受支持格式；“暂未支持”及其说明仅表示暂时无法在此页查看该类别内容，不代表产品其他入口不支持该能力。

| 检查 | 操作 | 预期 |
|---|---|---|
| Command 发现 | 在临时项目的 `.claude/commands/status-check.md` 写入 `Reply with STATUS_OK.`，然后刷新目录 | 类别显示发现数量，打开分类弹窗后可查看命令来源。查看不会启用执行，也不提供尚未支持的副本导入；运行启用仍由原有归属模块负责 |
| MCP 保存与连接 | 选择已有的受支持 MCP 声明，审阅后导入；不要启用副本 | 显示“已导入”，说明连接状态尚未确认。去 MCP 管理页可看到禁用副本；启用后的真实连接结果在 MCP 管理页检查 |
| Hook 只读子集 | 选择已配置扩展的 Pi 或 DSH，刷新并打开 Hook 分类弹窗 | 已发现项显示静态查看限制；无单项或分类导入按钮，查看不会执行声明 |
| 未接入类别 | 查看插件、完整设置等类别 | 显示“暂未支持”，说明暂时无法在此页查看该类别内容，不显示整个能力“未适配” |
| 发现与环境 | 在左侧导航搜索框上方切换“自动发现”，悬停或聚焦查看说明，关闭后手动刷新；随后切换工作区或 Peer | 仅暂停目录自动读取，保留上次结果、运行设置与授权。内置模板留在“更多应用”，真实来源、内容或用户配置归入“已识别”；类别展示数量与扫描结果。迟到请求不越过主机和工作区，读取失败不清空结果。旧主机开关只读，远程导入不会回退到控制端 |

扫描失败、旧主机字段缺失和同名冲突用自动化夹具稳定复现；不需要破坏真实设置。仓库根目录执行：

```bash
pnpm --dir src/web-ui run test:run src/app/scenes/ecosystem-compatibility
pnpm run check:web
pnpm run i18n:audit
pnpm run capabilities:check
pnpm run capabilities:test
```

前端远程/Peer 测试只验证显示与导入门禁；实际 SSH、跨设备、IM 远程控制和 Detached Dispatch 要在对应环境另行验证。
