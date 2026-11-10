**中文** | [English](AGENTS.md)

# 适配层

本层负责协议、transport、外部 provider 与宿主通信相关的 adapter crate。Adapter 在产品/runtime 契约与具体协议之间做转换，不拥有产品策略，也不承载可复用 OS service 实现。

## 模块

| Crate | 职责 | 本地文档 |
|---|---|---|
| `agent-runtime-ipc` | 不发布的私有本机 IPC adapter，为可选的第一方 Shared TUI Runtime 提供封闭交互操作 | [AGENTS.md](agent-runtime-ipc/AGENTS.md) |
| `miniapp-ipc` | Desktop 与轻量 MiniApp Shell 共用的私有本机启动记录、有界分帧和发现；不承载执行 owner | [AGENTS.md](miniapp-ipc/AGENTS.md) |
| `ai-adapters` | AI provider 请求/响应 adapter 与 stream protocol glue | [AGENTS.md](ai-adapters/AGENTS.md) |
| `opencode-adapter` | OpenCode 用户 Instructions 的来源语义，以及实时 Command、standalone Tool、Subagent、MCP 和静态 Hook provider；受管包静态预览 | [AGENTS.md](opencode-adapter/AGENTS.md) |
| `opencode-plugin-host` | 连接 OpenCode extension-host 进程的私有分帧 loopback JSON-RPC transport，以及 OpenCode Client 路由匹配、wire DTO 和协议错误映射；不负责产品配置选择、workspace/session 策略或插件信任决策 | [AGENTS.md](opencode-plugin-host/AGENTS.md) |
| `dsh-adapter` | DeepSeek Harness（`dsh`）bundle/profile 投影、静态 Hook bridge 发现和显式 MCP 声明 | [AGENTS.md](dsh-adapter/AGENTS.md) |
| `pi-adapter` | PI settings/package 扩展选择和静态原生事件发现；不执行 | [AGENTS.md](pi-adapter/AGENTS.md) |
| `claude-code-adapter` | 不含 runtime 的 Claude Code 用户 Instructions、Command、Subagent、MCP 和 Hook 来源语义，投影经脱敏 | [AGENTS.md](claude-code-adapter/AGENTS.md) |
| `codex-adapter` | 不含 runtime 的 Codex 用户 Instructions、Subagent、MCP 和 Hook 来源语义，投影经脱敏 | [AGENTS.md](codex-adapter/AGENTS.md) |
| `cursor-adapter` | 只读 Cursor CLI 快照、Desktop composer 和回退 JSONL 会话历史 | [AGENTS.md](cursor-adapter/AGENTS.md) |
| `zcode-adapter` | 只读 Zcode SQLite 任务发现和会话历史转换 | [AGENTS.md](zcode-adapter/AGENTS.md) |
| `static-hook-support` | 各生态 adapter 共用的有界、脱敏静态来源工具和 JSON/TOML Hook 解析器；不含生态策略或 runtime | 继承本指南 |
| `transport` | Event transport adapter，以及当前各宿主共用的协议中立有界 JSON 编码和 TypeScript message/JSON-RPC 机制 | [AGENTS.md](transport/AGENTS.md) |
| `webdriver` | Embedded WebDriver protocol 与浏览器自动化 adapter | [AGENTS.md](webdriver/AGENTS.md) |

## 放置规则

- 协议序列化、transport projection、外部 provider 请求整形、宿主通信 adapter 放在这里。
- OS、filesystem、terminal、MCP、remote、git、watch 等可复用实现放在 `services`，除非代码只是协议转换。
- 交付 profile 选择和 adapter 注册属于 `assembly`。
- 不要为单一宿主或未来协议预建共享 API crate。只有相邻设计明确首个 consumer、稳定测试合同、集成检查和删除条件时，才允许保留不发布且仅 crate 内可见的预集成边界；后续只提升真实 consumer 使用的 API。

## 依赖边界

- Adapter 可以依赖 `contracts`、`execution`，必要时可窄依赖 `services` 以通过协议暴露 service 能力。
- Adapter 不得依赖 `assembly/core`、产品 UI、app command handler 或 Tauri API，除非该宿主边界有明确 feature gate。
- 优先通过稳定契约解耦 adapter。Adapter 之间直接依赖必须有明确边界理由。
