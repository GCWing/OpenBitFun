**中文** | [English](AGENTS.md)

# 服务实现层

本层负责接触本地系统或 runtime infrastructure 的可复用具体实现：filesystem、git、file watch、terminal、MCP、remote connectivity、process lifecycle、session persistence primitives、MiniApp runtime/import IO 以及类似 OS/network 能力。

## 模块

| Crate | 职责 | 本地文档 |
|---|---|---|
| `computer-use` | Desktop 与 CLI 共用的原生截图、无障碍、输入、权限和控制会话服务 | [AGENTS.md](computer-use/AGENTS.md) |
| `services-core` | 不包含产品组装决策的本地 service primitive，包括 session storage、metadata store CRUD/index rebuild、metadata 构造/计数/索引/字段 mutation、lineage 规则和 JSON file IO | [AGENTS.md](services-core/AGENTS.md) |
| `services-integrations` | MCP、git、remote、file watch、MiniApp runtime、产品领域 port 具体实现，以及平台无关的 Remote Connect primitives | [AGENTS.md](services-integrations/AGENTS.md) |
| `legacy-migration` | 离线旧产品发现、加锁、一致性 SQLite 快照、暂存、journal 恢复和 owner adapter 编排 | — |
| `relay-service` | standalone 与 embedded 宿主共享的 Remote Connect relay 状态、存储及 HTTP/WebSocket 路由 | [AGENTS.md](relay-service/AGENTS.md) |
| `page-function-runtime` | OpenBitFun Pages 嵌入式 JS Page Function runtime（rquickjs） | [AGENTS.md](page-function-runtime/AGENTS.md) |
| `terminal` | PTY、shell integration 与 terminal session infrastructure | [AGENTS.md](terminal/AGENTS.md) |

## 放置规则

- 具体 OS、process、filesystem、git、terminal、MCP、remote SSH、file watch、session persistence primitives、MiniApp runtime IO 和 network service 实现放在这里。
- 需要具体依赖的 `contracts`、`execution` 或 `contracts/product-domains` port 实现在这里。
- 协议/transport projection 放在 `adapters`，产品能力选择放在 `assembly`。

## 依赖边界

- Services 可以依赖 `contracts`，实现 runtime port 时可以窄依赖 provider-neutral 的 `execution` crate。
- Services 不得依赖 `assembly/core`、interface crate、产品 UI 或 app command handler。
- Service 之间直接依赖必须保持窄边界；可复用契约应下沉到 `contracts` 或 `execution`，避免形成大范围耦合。
