[中文](AGENTS-CN.md) | **English**

# Adapter Layer

This layer owns protocol, transport, external-provider, and host-facing adapter
crates. Adapters translate between product/runtime contracts and concrete
protocols; they should not become owners of product policy or reusable OS
services.

## Modules

| Crate | Responsibility | Local doc |
|---|---|---|
| `agent-runtime-ipc` | Non-published private local IPC adapter for the opt-in first-party Shared TUI Runtime; closed interactive operations only | [AGENTS.md](agent-runtime-ipc/AGENTS.md) |
| `miniapp-ipc` | Private local launch records, bounded framing and discovery shared by Desktop and the lightweight MiniApp Shell; no execution owners | [AGENTS.md](miniapp-ipc/AGENTS.md) |
| `ai-adapters` | AI provider request/response adapters and stream protocol glue | [AGENTS.md](ai-adapters/AGENTS.md) |
| `opencode-adapter` | OpenCode source semantics for user Instructions plus the live Command, standalone Tool, Subagent, MCP, and static Hook providers; managed-package static preview | [AGENTS.md](opencode-adapter/AGENTS.md) |
| `dsh-adapter` | DeepSeek Harness (`dsh`) bundle/profile projection, static Hook bridge discovery and explicit MCP declarations | [AGENTS.md](dsh-adapter/AGENTS.md) |
| `pi-adapter` | PI settings/package extension selection and static native event discovery; no execution | [AGENTS.md](pi-adapter/AGENTS.md) |
| `claude-code-adapter` | Runtime-free Claude Code user Instructions, Command, Subagent, MCP, and Hook source semantics with redacted projection | [AGENTS.md](claude-code-adapter/AGENTS.md) |
| `codex-adapter` | Runtime-free Codex user Instructions, Subagent, MCP, and Hook source semantics with redacted projection | [AGENTS.md](codex-adapter/AGENTS.md) |
| `zcode-adapter` | Read-only Zcode SQLite task discovery and session-history translation | [AGENTS.md](zcode-adapter/AGENTS.md) |
| `static-hook-support` | Shared bounded/redacting static-source utilities plus the JSON/TOML Hook parser used by sibling ecosystem adapters; no ecosystem policy or runtime | inherited |
| `transport` | Event transport adapters plus protocol-neutral bounded JSON encoding and TypeScript message/JSON-RPC mechanics shared by current hosts | [AGENTS.md](transport/AGENTS.md) |
| `webdriver` | Embedded WebDriver protocol and browser automation adapter | [AGENTS.md](webdriver/AGENTS.md) |

## Placement Rules

- Put protocol serialization, transport projection, external provider request
  shaping, and host communication adapters here.
- Keep OS, filesystem, terminal, MCP, remote, git, and watch implementations in
  `services` unless the code is purely protocol translation.
- Keep delivery-profile selection and adapter registration in `assembly`.
- Do not create a shared API crate for a single host or a future protocol. A
  non-published pre-integration seam may remain crate-internal only when the
  adjacent design names its first consumer, stable test contract, integration
  check, and removal condition. Promote only the API used by that consumer.

## Dependency Boundaries

- Adapters may depend on `contracts`, `execution`, and narrowly on `services`
  when an adapter must expose a service capability through a protocol.
- Adapters must not depend on `assembly/core`, product UI code, app command
  handlers, or Tauri APIs unless the crate is explicitly feature-gated for that
  host boundary.
- Prefer stable contracts over adapter-to-adapter coupling. Cross-adapter
  dependencies require a clear boundary reason.
