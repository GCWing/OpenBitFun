# runtime-ports Agent Guide

Scope: this guide applies to `src/crates/contracts/runtime-ports`.

`openbitfun-runtime-ports` owns stable runtime-facing ports, DTOs, and capability
facts. It is an interface crate, not a runtime implementation crate.

## Guardrails

- Do not depend on `openbitfun-core`, app crates, Tauri, concrete service crates,
  AI adapters, transport adapters, or tool implementations.
- Keep ports narrow and typed. Avoid untyped service locators, global registries,
  or catch-all context structs.
- This crate may define portable request/response DTOs, runtime handles,
  capability facts, cancellation surfaces, and service traits.
- `RemoteExecPort` owns only remote command/stdin/control DTOs, bounded
  one-shot command results, and lifecycle event shapes; SSH managers, channels,
  process storage, and workspace lookup do not belong here.
- `SessionStorePort` owns typed session storage-path resolution plus restore /
  load request and timing facts only. Concrete session persistence, file IO,
  session lifecycle, context restore, and prompt assembly do not belong here.
- Session model/mode mutation ports carry only the selected identity to the
  current owner. Catalog lookup, validity policy, persistence implementation,
  and product presentation stay outside this crate.
- `ScriptToolRuntime` owns only provider-neutral availability, versioned
  load/invoke/cancel/dispose requests, execution context paths, and string
  results. Ecosystem source parsing, approval/conflict policy, product routing,
  process supervision, dependency installation, and UI do not belong here.
- `PtcRuntime` owns only program execution, nested tool calls, definition
  requests, availability, and cancellation contracts behind `ptc-runtime`.
  Node process supervision belongs to Services Integrations; tool admission
  and permission decisions stay in the Core tool pipeline.
- `HookFunctionRuntime` owns only provider-neutral availability, single-worker
  start/transform-config/execute-tool/cancel/dispose requests, a complete
  plugin-generation registration **notification sink** (not a load response),
  a reverse-channel sink (`metadata`/`ask`/`ask_reply`), and typed config/tool
  results. One worker owns the ordered plugin set and returns one final config
  result for the complete config hook chain.
  Plugin activation/trust, process supervision, `server(PluginInput)` to
  `Hooks` construction, permission decisions, and UI do not belong here. It
  deliberately diverges from `ScriptToolRuntime` (push notifications plus
  reverse channel, versus synchronous load/invoke response); do not collapse
  the two.
- Do not put filesystem writes, process execution, network clients, Git/AI/MCP
  concrete behavior, product policy, permission decisions, audit outcomes, UI
  extension behavior, UI implementation, or UI command logic here.
- Preserve serialization compatibility for persisted or cross-process DTOs.
- Keep `default = []`. Select `agent-api`, `workspace-ports`,
  `terminal-port`, `remote-exec-port`, `remote-workspace-ports`, `git-port`,
  `runtime-event-port`, `plugin-runtime`, or `script-tool-runtime` only from
  the capability owner that consumes that surface.
- `tool-runtime-handles` is the only reviewed aggregate: it is the stable
  handle bundle shared by the tool-runtime owners. Do not add a general
  `service-ports`, `full`, or compatibility umbrella.

## Verification

```bash
cargo check --locked -p openbitfun-runtime-ports --no-default-features
cargo test --locked -p openbitfun-runtime-ports --no-default-features --features agent-api --lib
cargo test --locked -p openbitfun-runtime-ports --no-default-features --features workspace-ports --test session_store_contracts
cargo test --locked -p openbitfun-runtime-ports --no-default-features --features plugin-runtime --test plugin_runtime_contracts
cargo test --locked -p openbitfun-runtime-ports --no-default-features --features ptc-runtime --test ptc_tool_port_contracts
node scripts/check-core-boundaries.mjs
```

For documentation-only changes, run `git diff --check`.
