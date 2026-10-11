[中文](AGENTS-CN.md) | **English**

# AGENTS.md

OpenBitFun is a Rust workspace plus React frontends.

Repository rule: **keep product logic platform-agnostic, then expose it through platform adapters**.

## Quick start

1. Read `README.md` and `CONTRIBUTING.md` before architecture-sensitive changes.
2. Use the primary product loop below for normal development. Surface-specific
   alternatives belong in the nearest app guide.
3. After Rust file changes, prefer `pnpm run fmt:rs` to format only changed or staged `.rs` files. Use `cargo fmt` only when you intentionally want broader formatting coverage.
4. After changes, use the nearest local `AGENTS.md` for the focused verification
   command. The repository-level verification section below only covers
   cross-cutting checks.
5. Workspace Rust dependencies own compatible versions, not broad capability
   unions. Each crate must select the dependency features it actually uses;
   keep test-only features in dev-dependencies and attach feature-gated service
   capabilities to the owning crate feature. Disable third-party defaults in
   `[workspace.dependencies]` when they are not part of every consumer's
   contract; members inherit that policy and add only their needed slices. For
   internal crates whose guarded `default` is empty, do not repeat
   `default-features = false` on every edge. Narrow consumers of an intentional
   compatibility default, such as ACP, must still disable it explicitly.
   Manifests copied into a standalone Docker build context must keep explicit
   versions and default policy because they cannot inherit the workspace root.
   `tokio/full` is forbidden in the root workspace and workspace members.

## Layered Module Index

Dependencies flow top to bottom. This table is the physical crate layout, not
the full conceptual architecture. For Product Surface / Product Assembly /
Product Feature / Agent Kernel / Execution / Extension / Cross-platform Adapter /
Stable Contracts and Security Control Plane boundaries, read
[`docs/architecture/product-architecture.md`](docs/architecture/product-architecture.md).
Keep crate dependencies inside each layer to the smallest set needed.

| # | Layer | Path | Owns | Modules / entries | Layer doc |
|---|---|---|---|---|---|
| 1 | Interfaces and entrypoints | `src/apps/*`, `src/web-ui`, `src/mobile-web`, `OpenBitFun-Installer`, `tests/e2e`, `src/crates/interfaces` | Product hosts, commands, UI entrypoints, protocol interfaces, and cross-surface tests | desktop, CLI, server, relay, Web UI, mobile web, installer, E2E, `acp`, `app-server`, `sdk-host` | nearest local `AGENTS.md`; [interfaces](src/crates/interfaces/AGENTS.md) |
| 2 | Product assembly | `src/crates/assembly` | Compatibility exports, product capability selection, product-full wiring, immutable built-in Agent content, adapter/service registration, and ecosystem-neutral source coordination | `agent-content`, `core`, `external-sources`, `product-capabilities` | [AGENTS.md](src/crates/assembly/AGENTS.md) |
| 3 | Adapters | `src/crates/adapters` | AI/transport/WebDriver protocol adapters, external AI work source adapters (OpenCode/Claude Code/Codex), and external-provider translation | `agent-runtime-ipc`, `ai-adapters`, `opencode-adapter`, `claude-code-adapter`, `codex-adapter`, `static-hook-support`, `transport`, `webdriver` | [AGENTS.md](src/crates/adapters/AGENTS.md) |
| 4 | Services | `src/crates/services` | Reusable OS, filesystem, terminal, MCP, remote, git, watch, process, session persistence primitives, MiniApp runtime IO, and network implementations | `services-core`, `services-integrations`, `miniapp-market-service`, `relay-service`, `page-function-runtime`, `terminal` | [AGENTS.md](src/crates/services/AGENTS.md) |
| 5 | Execution primitives | `src/crates/execution` | Portable Agent Runtime, named-workflow policy, stream, plugin runtime client, typed-service, tool-contract, tool-group, and tool-execution building blocks | `agent-runtime`, `agent-workflows`, `agent-stream`, `tool-contracts`, `plugin-runtime-client`, `runtime-services`, `tool-provider-groups`, `tool-execution` | [AGENTS.md](src/crates/execution/AGENTS.md) |
| 6 | Stable contracts and product domains | `src/crates/contracts` | Shared DTOs, event shapes, runtime ports, and product domain contracts/policies | `core-types`, `events`, `runtime-ports`, `product-domains` | [AGENTS.md](src/crates/contracts/AGENTS.md) |

Boundary rules:

- Interfaces and app entrypoints expose selected product behavior; reusable behavior moves down.
- Assembly wires lower layers and selects product capability facts; it must not implement concrete adapter, OS, or service details.
- Product features assemble user-facing commands, UI contributions, settings, and default policy on top of kernel capabilities; long-running task, scheduler, permission, session/workspace, memory, DFX, hook, and event facts stay in Agent Kernel owners.
- Adapters translate protocols and external-provider shapes; they should not own product capability selection or reusable OS service behavior.
- Services implement reusable concrete OS, process, terminal, MCP, remote, git, filesystem, and MiniApp runtime IO capabilities.
- External systems are boundary resources, not repository layers. Only registered adapters/services/app-local providers should call them; other layers consume ports and stable contracts.
- Execution crates are portable runtime building blocks, not host-specific or delivery-profile owners.
- Contracts stay behavior-light and must not depend upward.


## Common commands

Keep this list to stable repository entry points. Surface- and crate-specific
test commands belong in the nearest local `AGENTS.md` and must not be copied here.

```bash
# Setup and primary product loop
pnpm install
pnpm run desktop:dev               # full hot-reload: Vite HMR + Rust auto-rebuild & restart

# Repository checks
pnpm run fmt:rs                    # format only changed / staged Rust files
pnpm run check:repo-hygiene        # repository content and filename rules
pnpm run check:github-config       # GitHub workflow/configuration rules
pnpm run check:core-boundaries     # Cargo/module ownership boundaries
```

For Web UI, mobile, CLI, Desktop, Installer, packaging, and focused test
commands, use the nearest local guide. The full script registry remains in
[`package.json`](package.json).

## Global rules

### Process artifacts

- Do not add or update files under `docs/superpowers/**`. Keep temporary
  planning, design, and implementation-process artifacts local. Move durable
  architecture or feature facts into the existing document for that area, and
  put user-facing guidance in the owning app README.

### Internationalization

- Locale ids, aliases, fallback rules, and surface defaults are owned by
  `src/shared/i18n/contract/locales.json`. Run `pnpm run i18n:generate`
  after editing it.
- Shared stable labels live in
  `src/shared/i18n/resources/shared/<locale>/terms.json`; workflow copy stays
  in the owning product surface.
- Do not import Web UI locale resources into smaller product surfaces such as
  `src/mobile-web` or `OpenBitFun-Installer`. See `docs/architecture/i18n.md`.
- Static self-contained pages may use generated page-scoped shared-term files;
  they must not import Web UI locale catalogs.
- Web UI loads only bootstrap namespaces eagerly; use `useI18n(namespace)` for
  route or feature copy and keep direct `i18nService.t(...)` calls in bootstrap
  namespaces.
- Use shared i18n formatting helpers for user-visible dates, times, and
  numbers instead of direct `Intl.*` or `toLocale*` calls.
- `pnpm run i18n:audit` enforces key/placeholder parity, direct static key
  existence, dynamic key source proofs, literal fallback and locale-format
  no-growth baselines, shared-term/l10n governance baselines, non-blocking
  same-text locale inventory, and the no-hardcoded-CJK source budget.

### Theme and color tokens

- Theme and color-token baselines are ratchet contracts, not editable test
  expectations. Do not make a failing theme audit pass by raising values in
  `scripts/theme-color-governance-baseline*.json`, loosening fixture/assertion
  counts, adding broad allowlist entries, or removing CI audit coverage.
- Lower theme baselines when measured debt is removed. If a change truly needs a
  new color or key, add the smallest owner contract and document why existing
  semantic, component, or specialized-domain tokens cannot cover it.
- For theme, CSS variable, widget payload, mobile, installer, or CLI/TUI color
  changes, run `pnpm run theme:color-audit:all`.

### Logging

Logs must be English-only, with no emojis.

- Frontend: [`src/web-ui/LOGGING.md`](src/web-ui/LOGGING.md)
- Backend: [`src/crates/LOGGING.md`](src/crates/LOGGING.md)

### Tauri commands

- Command names: `snake_case`
- TypeScript may wrap with `camelCase`, but invoke Rust with a structured `request`

```rust
#[tauri::command]
pub async fn your_command(
    state: State<'_, AppState>,
    request: YourRequest,
) -> Result<YourResponse, String>
```

```ts
await api.invoke('your_command', { request: { ... } });
```

### Platform boundaries

- Do not call Tauri APIs directly from UI components; go through the adapter/infrastructure layer.
- Desktop-only host adapters belong in `src/apps/desktop`, then flow through typed capability interfaces and, when event delivery is needed, the production transport adapter.
- In shared core, avoid host-specific APIs such as `tauri::AppHandle`; use shared abstractions such as `openbitfun_events::EventEmitter`.

#### Non-interactive child processes

- Any non-interactive child process that may run under a GUI, headless,
  background, or redirected host must not use bare `std::process::Command` or
  `tokio::process::Command`, including CLI modes that another host can invoke.
  Prefer
  `openbitfun_services_core::process_manager::{create_command, create_tokio_command}`
  or the existing facade for that layer. If a direct command is unavoidable,
  Windows code must explicitly apply `CREATE_NO_WINDOW`; Node child processes
  must set `windowsHide: true`. Apply the same policy to test fixtures so tests
  do not flash console windows either.

### Remote scenarios

OpenBitFun is not a local-only desktop app. The workspace, the runtime that executes
a turn, and the person driving it can each sit on a different machine. Treat the
four scenarios below as first-class targets of every change, not as a later port.

| Scenario | What it means | Design entry point |
|---|---|---|
| Remote workspace | The active workspace lives on an SSH host, a jump-host chain, or a Docker container; files, terminal, search, and Agent subprocesses must execute there | [remote-workspace-transport.md](docs/architecture/remote-workspace-transport.md), [remote-workspaces.md](docs/features/remote-workspaces.md) |
| Remote control | Mobile web, or a Feishu / Telegram / WeChat bot, drives a session on a Desktop or CLI host through the Remote Connect relay | [`src/mobile-web`](src/mobile-web/AGENTS.md), `remote_connect` in [services-integrations](src/crates/services/services-integrations/AGENTS.md), [relay-service](src/crates/services/relay-service/AGENTS.md) |
| Peer Device Mode | One same-account device becomes the data plane of another: the controller shell stays local, invokes and events come from the peer | [peer-device-mode.md](docs/architecture/peer-device-mode.md), [peer-device README](src/web-ui/src/infrastructure/peer-device/README.md) |
| Detached Dispatch | A controller submits a durable job to another OpenBitFun host and may then disconnect; the target owns the job, session, worktree, event log, and permission mailbox | [detached-task-dispatch.md](docs/architecture/detached-task-dispatch.md) |

Rules that apply to all four:

- Design the remote path together with the feature. A capability that assumes UI,
  process, and filesystem share one machine is incomplete, not "phase one".
- Degrade loudly. When a scenario cannot be supported, gate the entry point or
  return a clear unsupported state. Silent local fallback, fake success, empty
  payloads, and generic errors are all regressions; local fallback additionally
  leaks local content to a remote controller.
- Keep blocking interaction answerable from a distance. New permission prompts,
  dialogs, and pickers must reach the driving surface through the existing dialog
  and permission-mailbox orchestration. A turn that only the desktop window can
  unblock deadlocks remote control and dispatch jobs.
- Survive disconnect. Remote surfaces reconnect, replay by cursor, and re-hydrate,
  so prefer resumable cursors and idempotent mutations over state that exists only
  while a client happens to be attached.
- Remote workspace paths are POSIX on every client OS. Do not split or join them
  with host `std::path` semantics, and do not reuse a controller-side path on a
  peer host.

Per-scenario obligations:

- **Remote workspace**: every desktop Tauri command has one row in the Product
  Operation Registry
  ([`remote_surface/table.rs`](src/crates/contracts/product-domains/src/remote_surface/table.rs))
  declaring its remote-workspace stance. The desktop closure test and the
  capability generator reject new commands without a row, and the registry's
  ratchet forbids growing the `Unaudited` backlog. See
  [remote-surface-contract.md](docs/architecture/remote-surface-contract.md).
- **Remote control**: mobile web and IM bots reach sessions through the
  `RemoteCommand` wire protocol and the bot command router / menu, not through the
  Web UI. When a session-level capability is added or moved — workspace or
  assistant selection, session lifecycle, mode, model, approval, attachment —
  extend those surfaces or make them answer with an explicit unsupported reply.
- **Peer Device Mode**: product commands are proxied to the peer by default. A
  command that must stay on the controller (window chrome, updater, account
  identity, local OS automation) is declared `ControllerLocal` in the same
  registry row; the desktop peer host, the CLI peer host, and the Web UI
  transport adapter all derive their deny sets from it, and
  `pnpm run check:core-boundaries` rejects a hand-written table. A command the
  CLI host runs needs a handler plus `cli_peer: HANDLED` in its row (the
  closure test in `src/apps/cli/src/peer_host/commands/mod.rs` keeps both in
  step). Peer capabilities are typed (`PeerHostCapability`) and advertised
  from the registry. Read the peer-device README invariants before changing
  session, account, or hydrate paths.
- **Detached Dispatch**: jobs run headless on the target under the CLI delivery
  profile, with no interactive host and no guaranteed controller connection. The
  controller is an observer, never a runtime or filesystem proxy. Do not add
  behavior that requires a live submitter, and treat the dispatch protocol version
  and required target capabilities as a compatibility contract — a new target-side
  requirement needs a negotiated capability, not an assumption.

State which remote scenarios a change was exercised in. Local-only tests are not
evidence of remote behavior.

### Upgrade compatibility

Users upgrade in place, and the remote scenarios above routinely put two
different OpenBitFun versions on the same connection. Every change must keep
existing installs working without manual repair.

- **Persisted shapes are read by older and newer code.** Config, settings,
  sessions, connection profiles, worktree and dispatch records: add fields with
  defaults, keep deserialization tolerant, and never repurpose or narrow the
  meaning of a field that is already on disk. A field old data cannot supply
  must not become required.
- **Never delete or reset user data to recover from something you cannot
  parse.** Keep the record, degrade the feature, and surface a clear state.
  Missing credentials, an unreadable profile, a timeout, or an offline host are
  not reasons to drop a session, workspace, or connection. Destructive removal
  stays an explicit user action.
- **Cross-version boundaries negotiate; they do not assume.** Peer HostInvoke,
  the dispatch protocol, relay and mobile web, and IM bots all talk to a build
  you do not control. Advertise a capability and check it before using it —
  package version equality is not evidence of behavior — and keep the older
  side on a working path instead of failing it.
- **A rename is a migration.** Keep reading the old name, id, or record shape
  until no supported peer can still send it, and migrate referenced data
  (vault entries, workspace pointers) together with the thing being renamed.
- **Prove it with tests.** Cover legacy deserialization and an old-payload
  round trip, not just the new shape. A test that only exercises data written
  by the current code is not upgrade coverage.

### Agent loop behavior

- Do not add hard-coded limits or pattern checks to the agent loop as a first response to looping behavior, such as blocking repeated tool calls by string or count alone.
- Excessive hard-coding turns the agent loop into a brittle workflow engine. Investigate the root cause first: tool behavior, model interaction, session context packaging, prompt/tool schema design, or state synchronization issues.

### Agent hooks

- OpenBitFun native user hooks implement the Codex hook contract, so <https://learn.chatgpt.com/docs/hooks> is the reference for their events, payload fields, and decision schema. Do not fork that contract. [`docs/features/agent-hooks.md`](docs/features/agent-hooks.md) ([中文](docs/features/agent-hooks.zh-CN.md)) covers only the OpenBitFun-specific parts — file locations, the `app.hooks` gates, and the deviations table — and must be updated whenever a deviation is added or closed.
- The portable engine (settings parsing, payload construction, process execution, decision merging) lives in `openbitfun-agent-runtime::native_hooks`. `openbitfun-core::native_hooks` owns config discovery, gating, and per-event dispatch helpers; dispatch sites call those helpers instead of executing hooks inline.
- Executable hooks may come from native user configuration, ecosystem plugins, or OpenBitFun built-ins (including the current compiled-in `post_call_hooks`). These sources keep distinct trust, configuration, contract, and execution-policy semantics, but may register through the shared `HookRegistry` and be dispatched by `AgentHookEngine`. The external hook catalog of other AI applications (`external_hooks`) remains read-only discovery data and must not enter the executable registry.

## Architecture

### Product architecture guardrails

For any `openbitfun-core` decomposition, feature-boundary, dependency-boundary, or
Rust build-speed refactor, read both
[`docs/architecture/product-architecture.md`](docs/architecture/product-architecture.md)
and
[`docs/architecture/rust-build-dependency-boundaries.md`](docs/architecture/rust-build-dependency-boundaries.md)
before editing. Keep these files as entry points; put module-specific ownership
details in the nearest module `AGENTS.md`.

Repository-level decomposition rules:

- Do not confuse DTO/contract extraction with runtime owner migration.
- Product surfaces may diverge; share stable facts or ports, not UI, protocol,
  lifecycle, or platform implementation.
- Moving runtime ownership requires a reviewed port/provider design, old-path
  compatibility, behavior equivalence tests, and explicit confirmation when a
  behavior boundary could change.

For Agent Runtime deployment, multi-GUI/TUI/Remote instances, shared Session
control, or process-topology changes, also read
[`docs/architecture/agent-runtime-deployment-design.md`](docs/architecture/agent-runtime-deployment-design.md).
Do not key Rust Runtime or Node/Bun Plugin Host processes by client, workspace,
session, or plugin by default; use the responsible state module, execution and
security conditions, and measured capacity.

### CLI product-line guardrails

For CLI/TUI parity work, non-interactive output contracts, external config
imports, plugin management UX, CLI Agent behavior, or branded CLI distributions,
read [`docs/architecture/cli-product-line-design.md`](docs/architecture/cli-product-line-design.md)
and [`src/apps/cli/AGENTS.md`](src/apps/cli/AGENTS.md). Keep CLI/TUI presentation
in the app; move reusable product behavior through Product Assembly, Agent
Runtime, Tool/Harness, Runtime Services, or the existing extension boundaries.

### HarmonyOS PC CLI/TUI guardrails

For changes that affect HarmonyOS PC CLI/TUI support, also read
[`docs/architecture/platform-portability-design.md`](docs/architecture/platform-portability-design.md).
This is a future platform target, not implemented support. The product target is
the real PC system terminal; HAP, `hdc shell`, the phone Remote App, and remote
execution are not substitutes. Design each concrete adaptation as a separate
topic and keep the current mobile capability unchanged.

### Product customization guardrails

For product definitions, branded distributions, GUI/TUI layout selection,
bundled product extensions, or customization build tasks, read
[`docs/architecture/product-customization-blueprint.md`](docs/architecture/product-customization-blueprint.md).
Keep product customization separate from user runtime configuration and plugins.
GUI and TUI may share stable product facts, but not layout, component, theme-key,
keybinding, or renderer schemas. Product assembly results and layout selections
may carry a small immutable list of product identity, data-isolation, recovery,
upgrade-integrity, or legal protection IDs. They must not carry user/source-level
plugin policy, installation, activation, update, permission, or dynamic health state.
Product Profile, Brand Pack, GUI/TUI Surface Blueprint, and Resolved Product Manifest are retired
design terms, not current production objects. Do not create compatibility formats
for them; implement only the smallest product-definition and assembly-result fields
used by a real build and runtime consumer.

For OpenCode live configuration or plugin execution, also read
[`docs/architecture/extensions/opencode-extension-compatibility.md`](docs/architecture/extensions/opencode-extension-compatibility.md).
The current P0 adapter remains a managed-package/static-preview path until the matching
OC-R phase is implemented and verified. Do not extend the legacy managed-package
path as the target OpenCode runtime model, and do not treat a design target as an
already available capability.

### SDLC quality guardrails

For lifecycle evidence, gates, Artifact Graph, Project Profile, Deep Review
policy, OpenCode compatibility, or target-project governance changes, read
[`docs/sdlc-harness/README.md`](docs/sdlc-harness/README.md)
first, then [`docs/sdlc-harness/design.md`](docs/sdlc-harness/design.md). If
module boundaries or behavior change, follow the matching design under
`docs/sdlc-harness/architecture/` or `docs/sdlc-harness/features/`.

Do not hard-code OpenBitFun repository assumptions as target-project rules; keep
quality protection behavior target-aware, evidence-backed, risk-tiered,
cost-aware, and auditable.

## Verification

Choose verification at the owner, not from a repository-wide test matrix:

1. Read the nearest local `AGENTS.md` and run its narrowest command that covers
   the changed behavior.
2. Prefer one package, one test target or module filter, and the minimum feature
   set. Do not use `product-full`, `all-features`, or a workspace-wide suite as a
   shortcut.
3. Run a repository check only when its contract changed: repository hygiene for
   layout/content rules, GitHub config for workflow changes, and core boundaries
   for Cargo features, dependency direction, or test-target layout.
4. Leave broad builds, workspace suites, packaging, and platform matrices to
   existing CI unless the change affects those paths or reproduces a CI failure.

If a module lacks a useful focused command, add it to that module's guide rather
than expanding this file. Do not pre-emptively align every module's test list;
document a command only when a real workflow needs it.

## Agent-doc priority

Prefer the nearest matching `AGENTS.md` / `AGENTS-CN.md` for the directory you are changing. If local guidance conflicts with this file, follow the more specific, nearer document.
