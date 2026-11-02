[中文](AGENTS-CN.md) | **English**

# Service Layer

This layer owns reusable concrete implementations that touch local systems or
runtime infrastructure: filesystem, git, file watch, terminal, MCP, remote
connectivity, process lifecycle, session persistence primitives, MiniApp concrete runtime IO, and similar
OS/network capabilities.

## Modules

| Crate | Responsibility | Local doc |
|---|---|---|
| `computer-use` | Native screenshot, accessibility, input, permission and control-session providers shared by Desktop and CLI | [AGENTS.md](computer-use/AGENTS.md) |
| `services-core` | Reusable local service primitives, process-wide TLS provider selection, managed process-tree lifecycle, filesystem helpers, session storage layout/indexing/deletion, metadata store CRUD/index rebuild, metadata construction/counter/index/field mutation/lineage rules, and JSON file IO without product assembly decisions | [AGENTS.md](services-core/AGENTS.md) |
| `services-integrations` | Concrete MCP, git, remote, file-watch, MiniApp runtime, review-platform provider service, product-domain port implementations, and platform-neutral Remote Connect primitives | [AGENTS.md](services-integrations/AGENTS.md) |
| `legacy-migration-adapters` | Offline legacy-data converters against shared configuration/storage owners, without Core | [AGENTS.md](legacy-migration-adapters/AGENTS.md) |
| `legacy-migration` | Offline retired-product discovery, locking, consistent SQLite snapshots, staging, journal recovery, and owner-adapter orchestration | [AGENTS.md](legacy-migration/AGENTS.md) |
| `miniapp-market-service` | Concrete SQLite, artifact storage, GitHub OAuth, package validation, and HTTP behavior for the MiniApp market | [README.md](miniapp-market-service/README.md) |
| `skin-market-service` | Concrete SQLite, artifact storage, Appearance package validation, review, and HTTP behavior for the Skin market | [README.md](skin-market-service/README.md) |
| `relay-service` | Reusable Remote Connect relay state, storage, and HTTP/WebSocket routes shared by standalone and embedded hosts | [AGENTS.md](relay-service/AGENTS.md) |
| `page-function-runtime` | Embedded JS Page Function runtime (rquickjs) for OpenBitFun Pages | [AGENTS.md](page-function-runtime/AGENTS.md) |
| `terminal` | PTY, shell integration, and terminal session infrastructure | [AGENTS.md](terminal/AGENTS.md) |

## Placement Rules

- Put concrete OS, process-wide TLS provider, process, filesystem, git, terminal, MCP, remote SSH,
  file-watch, MiniApp runtime IO, and network service implementations here.
- Implement `contracts`, `execution`, or `contracts/product-domains` ports here
  when the implementation needs concrete dependencies.
- Keep protocol/transport projection in `adapters`, and keep product capability
  selection in `assembly`.

## Dependency Boundaries

- Services may depend on `contracts` and narrowly on provider-neutral execution
  crates when implementing runtime ports.
- Services must not depend on `assembly/core`, interface crates, product UI code,
  or app command handlers.
- Service-to-service dependencies must stay narrow; reusable contracts should
  move to `contracts` or `execution` instead of creating broad coupling.
