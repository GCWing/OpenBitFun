# OpenBitFun CLI Agent Guide

Scope: `src/apps/cli`.

Read the repository `AGENTS.md` first. For architecture-sensitive work, also
read:

- [`cli-product-line-design.md`](../../../docs/architecture/cli-product-line-design.md)
- [`product-architecture.md`](../../../docs/architecture/product-architecture.md)
- [`agent-runtime-deployment-design.md`](../../../docs/architecture/agent-runtime-deployment-design.md)
- [`product-customization-blueprint.md`](../../../docs/architecture/product-customization-blueprint.md) when changing product assembly, branding, or packaging

## Ownership

Model-edit compatibility has a focused check:
`cargo test --locked -p openbitfun-cli --bin openbitfun model_selection::tests`.
Older mutation DTOs preserve account/channel policy. Merge write-only credentials
and unexpressed routing fields against the current model inside the existing
config write lock, so a concurrent settings edit cannot be overwritten.

CLI owns only surface concerns:

- Clap entrypoints and CLI-local configuration
- terminal acquisition/restoration and input normalization
- TUI state, rendering, popups, local draft history, and local effects such as
  clipboard or external-editor integration
- projection of Runtime events into text, JSON, JSONL, and user diagnostics
- Shared Runtime client/server adaptation and Peer Device host presentation

Session, turn, model round, tool execution, permissions, cancellation,
persistence, context, workspace binding, MCP, Subagent, and other product facts
belong to their shared owners. Do not add CLI-only managers or reproduce shared
behavior behind a TUI branch.

Existing Core compatibility forwarding may remain until a reviewed owner
migration has behavior-equivalence tests. A typed port is not evidence that the
runtime owner moved.

## Runtime paths

Normal interactive submissions follow:

```text
ChatView / StartupPage
  -> CliAgentRuntimeClient
     -> Embedded AgentRuntime typed API
     -> Shared private Runtime IPC v18
  -> existing owner/service APIs
     -> ConfigService / registries / MCPService / AccountRuntime / WorktreeService
     -> External Source and Hook domain APIs
```

Embedded and Shared TUI construct the same `CliAgentRuntimeClient`; only its
deployment backend differs. Controllers depend on that client for Runtime
behavior and call the existing owner/service APIs directly for the non-Runtime
operations they use. There is no catch-all TUI client, unified TUI management
module, domain service interface layer, or owner adapter. Controllers must not
reference Runtime IPC or Runtime implementation types, and they must not import
`openbitfun-app-server-protocol` wire DTOs. Non-Runtime projections come from the
stable contracts layer (`openbitfun-core-types` / `openbitfun-product-domains`) or the
existing owner API. Controller-local calls reject Remote workspace scope before
touching local state. The `server` command is an independent stdio Server Host assembled in
`server_host.rs`, which is the only module allowed to import the
`openbitfun-app-server` implementation; it injects an explicit method allowlist,
canonical cwd scope, transport limits, and the stdin EOF disconnect lifecycle.
App Server wiring is independent and does not constrain
the TUI path. Side-effecting operations need stable identities, controller/idle
rules, bounded frames, and outcome-unknown handling before a connection can retry.

Explicit Shell input follows:

```text
SHELL composer -> AgentUserShellCommandPort -> Core coordinator
               -> ToolPipeline(ExecCommand) -> TerminalPort / RemoteExecPort
               -> standard UserDialog + ModelRound persistence and events
```

CLI must never spawn the submitted command directly or expose a generic tool or
process API. Explicit user input may auto-approve an interactive `ask`, but
static `deny` rules, workspace routing, cancellation, audit, and tool
restrictions remain enforced.

## TUI rules

- Derive slash commands, palette actions, help, availability, and key bindings
  from the action registry. Do not add a second command table.
- Match established competitor entry flows when equivalent behavior exists.
  Prefer OpenCode names and interactions; do not invent `/shell` or aliases for
  the `!` Shell entry.
- Keep terminal input, state transitions, effects, and rendering independently
  testable. Views and reducers do not perform filesystem, network, config, or
  Agent operations.
- Shell mode is CLI presentation state only. It accepts an empty-composer `!`,
  keeps chat/shell histories separate, treats `/` as command text, and rejects
  images and structured `@` references before Runtime submission.
- Direct paste, `Ctrl+V`, and bracketed paste share `ComposerDraft`. Shared TUI
  rejects unsupported image payloads before IPC.
- Local effects such as `/editor`, copy, and export stay local. Product work
  such as shell execution, session mutation, and permissions goes through typed
  Runtime owners.
- Session-lineage membership, order, legacy relationship normalization,
  transcript reads, and targeted cancellation stay in shared Runtime owners.
  TUI may keep only the selector/read-only inspection state and must preserve
  the root composer while a descendant is visible.
- Always restore raw mode, alternate screen, mouse capture, paste mode, and the
  cursor on success, error, cancellation, initialization failure, or panic.
- Protocol stdout contains only the selected result format. Logs are English,
  contain no emoji, and use stderr or log files.

## Product and external-source boundaries

- Assemble CLI through `DeliveryProfile::Cli` and validated product Runtime
  parts. Hiding a command is not a backend capability restriction.
- The CLI selects the reviewed `openbitfun-core` owner-feature closure
  (`agent-runtime`, `external-sources`, `plugin-runtime`, `remote-connect`, and
  `ssh-remote`) plus the Code Agent atomic tool owners and the independent
  `tools-pages` owner. Pages binds to the executing host's AccountRuntime;
  controller-local account state must not enable remote tools. It must not register
  DeepReview, DeepResearch, MiniApp, or Canvas agents/tools. Do not replace the
  closure with `product-full` or a CLI-named umbrella; add a Core feature only
  when a production CLI path consumes that owner.
- CLI consumes typed external-source summaries and actions. It does not parse
  source files, import executable modules, implement or supervise plugin workers,
  duplicate approval state, or treat static discovery as runtime availability.
  A local product host may request Core-owned configured Plugin Host startup and
  instance activation; the lifecycle, worker, and protocol owners remain below
  the CLI surface.
- ACP agents, configuration import, executable plugins, Hooks, and Peer Device
  hosting have separate trust and lifecycle state. Do not infer one from
  another.
- Remote-unsupported local effects must fail visibly; never fall back to the
  controller machine.

Detailed compatibility rules belong in the dedicated architecture documents,
not in this file.

## Commands

```bash
pnpm run cli:dev
pnpm run cli:install
```

## Verification

Run the smallest checks matching the changed path:

```bash
cargo check -p openbitfun-cli
cargo test -p openbitfun-cli
cargo test -p openbitfun-cli --bin openbitfun peer_host::
cargo test -p openbitfun-cli --bin openbitfun system_info_home_contract
```

For streaming `exec` retry, context recovery, and final-event contracts:

```bash
cargo test --locked -p openbitfun-cli --test cli_command_contracts exec_cli_contracts::stream_json_
```

When a CLI change crosses a shared boundary, use the focused command maintained
by that owner: Agent Runtime for port/SDK behavior, the IPC adapter for shared
protocol behavior, Core for turn/tool/persistence behavior, Terminal for
PTY/ConPTY lifecycle, and Product Assembly for packaging. Do not copy those
owners' commands into this guide.

Use [`README.md`](README.md) for user-facing behavior and installation. Keep
developer internals here or in architecture docs instead of expanding the user
guide.

For unattended question lifecycle changes, run `cargo test --locked -p openbitfun-cli --bin openbitfun shared_runtime::` and `cargo test --locked -p openbitfun-agent-runtime-ipc protocol_contract_tests::`.

For Pages account adapters, use the focused Core command in its guide and `cargo check -p openbitfun-cli`.

For `/goal` prompt routing (including the pending-session guard):

```bash
cargo test --locked -p openbitfun-cli --bin openbitfun goal_prompts_
cargo test --locked -p openbitfun-cli --bin openbitfun -- modes::exec::tests:: dispatch::worker::tests::
```
