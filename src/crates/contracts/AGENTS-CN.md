**中文** | [English](AGENTS.md)

# 稳定契约与产品领域层

本层负责可被 execution、services、adapters、assembly 和 interfaces 共享的稳定契约与产品领域模型，不向上携带具体实现细节。

## 模块

| Crate | 职责 | 本地文档 |
|---|---|---|
| `core-types` | 共享 DTO、错误、session/surface 数据和小型 value type | [AGENTS.md](core-types/AGENTS.md) |
| `config-contracts` | 持久化配置记录、默认值、校验和纯模型转换 | [AGENTS.md](config-contracts/AGENTS.md) |
| `events` | 事件 payload 和 emitter 契约 | [AGENTS.md](events/AGENTS.md) |
| `product-domains` | 产品领域 DTO、规则、策略和窄 port | [AGENTS.md](product-domains/AGENTS.md) |
| `runtime-ports` | runtime owner crate 使用的 trait 和 port | [AGENTS.md](runtime-ports/AGENTS.md) |

## 放置规则

- 只有跨多个 owner layer 稳定复用的类型、领域规则或 port 才放到这里。
- 契约层应保持轻行为：允许少量校验 helper，不放 runtime、filesystem、network、UI 或平台行为。
- 优先定义窄 DTO 或 trait，不引入宽泛 facade object。
- 如果类型只服务单个 runtime、service 或 adapter crate，先留在所属 crate 内，等出现第二个 owner 再提取。

## 依赖边界

- 本层可以依赖 workspace 基础库和其他 contract crate。
- 本层不得依赖 `execution`、`services`、`adapters`、`assembly`、`interfaces`、`src/apps`、前端包、Tauri 或 OS adapter。
- 新依赖必须服务契约形状本身，而不是为了实现层使用方便。
