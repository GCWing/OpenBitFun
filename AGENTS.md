[中文](AGENTS-CN.md) | **English**

# AGENTS.md

OpenBitFun is a Rust workspace plus React frontends, delivered through several hosts (Desktop/Tauri, CLI/TUI, server, mobile, mobile-web, installer).

Repository rule: **keep product logic platform-agnostic, then expose it through platform adapters**.

## Where rules live

- This file holds repository-wide rules. The nearest `AGENTS.md` to the files you change owns local boundaries, commands, and focused verification; if it conflicts with this file, the nearer guide wins.
- Commit and PR conventions: [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Layers

Dependencies point downward: a crate may depend on lower layers, not on higher ones, and same-layer dependencies stay minimal. Layer guides list their crates and the exact allowed edges. This table is the physical crate layout; the conceptual architecture (4+1 views) is in [`docs/architecture/product-architecture.md`](docs/architecture/product-architecture.md).

| # | Layer | Path | Owns | Must not | Guide |
|---|---|---|---|---|---|
| 1 | Interfaces and entrypoints | `src/apps/*`, `src/web-ui`, `src/mobile-web`, `src/*-market-web`, `OpenBitFun-Installer`, `tests/e2e`, `src/crates/interfaces` | Product hosts, commands, UI entrypoints, protocol interfaces, and cross-surface tests | Keep reusable behavior; move it down | nearest local `AGENTS.md`; [interfaces](src/crates/interfaces/AGENTS.md) |
| 2 | Product assembly | `src/crates/assembly` | Compatibility exports, product capability selection, product-full wiring, immutable built-in Agent content, adapter/service registration, and ecosystem-neutral source coordination | Implement concrete adapter, OS, or service details | [AGENTS.md](src/crates/assembly/AGENTS.md) |
| 3 | Adapters | `src/crates/adapters` | Protocol, transport, local IPC, WebDriver, AI-provider, and external AI work-source adapters; external-provider translation | Own product capability selection or reusable OS service behavior | [AGENTS.md](src/crates/adapters/AGENTS.md) |
| 4 | Services | `src/crates/services` | Reusable OS, filesystem, terminal, MCP, remote, git, watch, process, network, session persistence, and MiniApp runtime IO implementations | Own protocol/transport projection or product capability selection | [AGENTS.md](src/crates/services/AGENTS.md) |
| 5 | Execution primitives | `src/crates/execution` | Portable Agent Runtime, named-workflow policy, stream, plugin runtime client, typed-service, tool-contract, tool-group, and tool-execution building blocks | Own host-specific or delivery-profile behavior | [AGENTS.md](src/crates/execution/AGENTS.md) |
| 6 | Stable contracts and product domains | `src/crates/contracts` | Shared DTOs, event shapes, runtime ports, and product-domain contracts/policies | Carry runtime behavior or depend upward | [AGENTS.md](src/crates/contracts/AGENTS.md) |

- Product features only assemble user-facing commands, UI contributions, settings, and default policy. Long-running task, scheduler, permission, session/workspace, memory, DFX, hook, and event facts stay with their existing owners.
- External systems are boundary resources, not layers. Only registered adapters, services, or app-local providers call them; other code consumes ports and stable contracts.

## Commands

```bash
pnpm install
pnpm run desktop:dev               # primary dev loop: Vite HMR + Rust auto-rebuild and restart
pnpm run fmt:rs                    # run after Rust edits; formats only changed / staged .rs files
pnpm run check:repo-hygiene        # repository content and filename rules
pnpm run check:github-config       # GitHub workflow / configuration rules
pnpm run check:core-boundaries     # Cargo features, dependency direction, module ownership
```

Use `cargo fmt` only when broader formatting is intended. Surface, packaging, and focused test commands live in the nearest guide; the full script registry is [`package.json`](package.json).

## Verification

Verify at the owner, not with a repository-wide matrix:

1. Run the narrowest command from the nearest `AGENTS.md` that covers the changed behavior.
2. Prefer one package, one test target or module filter, and the minimum feature set. Do not use `product-full`, `all-features`, or a workspace-wide suite as a shortcut.
3. Run a repository check only when its contract changed: `check:repo-hygiene` for layout/content rules, `check:github-config` for workflows, `check:core-boundaries` for Cargo features, dependency direction, or test-target layout.
4. Leave broad builds, workspace suites, packaging, and platform matrices to CI unless the change affects those paths or reproduces a CI failure.

## Rules for every change

### Bug fixes

Before changing code for a bug, check only the relevant local code and local Git history for an existing fix, using the reported version and reproduction conditions when available. State the result before starting. If a fix already exists, cite the code or commit instead of duplicating it.

### Platform boundaries

- UI components do not call Tauri APIs directly; go through the adapter/infrastructure layer.
- Desktop-only host adapters live in `src/apps/desktop` and flow through typed capability interfaces, plus the production transport adapter when events must be delivered.
- Shared core avoids host-specific APIs such as `tauri::AppHandle`; use shared abstractions such as `openbitfun_events::EventEmitter`.

### Tauri commands

Command names are `snake_case` and take one structured `request`. TypeScript wrappers may be `camelCase`.

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

### Non-interactive child processes

- A non-interactive child process that may run under a GUI, headless, background, or redirected host (including CLI modes another host can invoke) must not use bare `std::process::Command` or `tokio::process::Command`. Use `openbitfun_services_core::process_manager::{create_command, create_tokio_command}` or the existing facade for that layer.
- If a direct command is unavoidable, Windows code applies `CREATE_NO_WINDOW` explicitly and Node child processes set `windowsHide: true`.
- Test fixtures follow the same policy, so tests do not flash console windows.

### Rust dependencies

- `[workspace.dependencies]` owns compatible versions, not broad capability unions. Each crate selects the features it actually uses, keeps test-only features in `[dev-dependencies]`, and attaches feature-gated service capabilities to the owning crate feature.
- Disable third-party defaults in `[workspace.dependencies]` when they are not part of every consumer's contract; members inherit that policy and add only the slices they need.
- For internal crates whose guarded `default` is empty, do not repeat `default-features = false` on every edge. Narrow consumers of an intentional compatibility default, such as ACP, still disable it explicitly.
- Manifests copied into a standalone Docker build context keep explicit versions and default policy, because they cannot inherit the workspace root.
- `tokio/full` is forbidden in the root workspace and in workspace members.
- Details: [`docs/architecture/rust-build-dependency-boundaries.md`](docs/architecture/rust-build-dependency-boundaries.md). Verify manifest changes with `pnpm run check:core-boundaries`.

### Logging

Logs are English-only, with no emojis. Frontend: [`src/web-ui/LOGGING.md`](src/web-ui/LOGGING.md). Backend: [`src/crates/LOGGING.md`](src/crates/LOGGING.md).

### Internationalization

- `src/shared/i18n/contract/locales.json` owns locale ids, aliases, fallback rules, and surface defaults. Run `pnpm run i18n:generate` after editing it.
- Shared stable labels live in `src/shared/i18n/resources/shared/<locale>/terms.json`; workflow copy stays in the owning product surface.
- No surface imports another surface's locale catalog. Web UI locale resources must not be imported by `src/mobile-web`, `OpenBitFun-Installer`, or static pages; static self-contained pages use generated page-scoped shared-term files.
- Format user-visible dates, times, and numbers with the shared i18n helpers, not direct `Intl.*` or `toLocale*` calls.
- Run `pnpm run i18n:audit` after changing locale resources or user-visible copy. It enforces key/placeholder parity, static and dynamic key proofs, and no-growth baselines for literal fallbacks, direct locale formatting, and hard-coded CJK source text.
- Details: [`docs/architecture/i18n.md`](docs/architecture/i18n.md).

### Theme and color tokens

- Theme and color-token baselines (`scripts/theme-color-governance-baseline*.json`) are ratchet contracts, not editable test expectations. Never make a failing audit pass by raising baseline values, loosening fixture/assertion counts, adding broad allowlist entries, or removing CI audit coverage.
- Lower a baseline when measured debt is removed. If a change truly needs a new color or key, add the smallest owner contract and document why existing semantic, component, or specialized-domain tokens cannot cover it.
- Run `pnpm run theme:color-audit:all` after theme, CSS variable, widget payload, mobile, installer, or CLI/TUI color changes.
- Details: [`docs/architecture/theme-token-optimization.md`](docs/architecture/theme-token-optimization.md).

### Agent loop

Do not add hard-coded limits or pattern checks to the agent loop as a first response to looping behavior, such as blocking repeated tool calls by string or count alone; that turns the loop into a brittle workflow engine. Investigate the root cause first: tool behavior, model interaction, session context packaging, prompt/tool schema design, or state synchronization.

### Docs and process artifacts

- Do not add or update files under `docs/superpowers/**`; `pnpm run check:repo-hygiene` rejects them.
- Keep temporary planning, design, and implementation-process artifacts local. Move durable architecture or feature facts into the existing document for that area, and put user-facing guidance in the owning app README.

## Remote scenarios

The workspace, the runtime that executes a turn, and the person driving it can each sit on a different machine. Treat these four scenarios as first-class targets of every change, not as a later port.

| Scenario | What it means | Design entry point |
|---|---|---|
| Remote workspace | The active workspace lives on an SSH host, a jump-host chain, or a Docker container; files, terminal, search, and Agent subprocesses must execute there | [remote-workspace-transport.md](docs/architecture/remote-workspace-transport.md), [remote-workspaces.md](docs/features/remote-workspaces.md) |
| Remote control | Mobile web, or a Feishu / Telegram / WeChat bot, drives a session on a Desktop or CLI host through the Remote Connect relay | [`src/mobile-web`](src/mobile-web/AGENTS.md), `remote_connect` in [services-integrations](src/crates/services/services-integrations/AGENTS.md), [relay-service](src/crates/services/relay-service/AGENTS.md) |
| Peer Device Mode | One same-account device becomes the data plane of another: the controller shell stays local, invokes and events come from the peer | [peer-device-mode.md](docs/architecture/peer-device-mode.md), [peer-device README](src/web-ui/src/infrastructure/peer-device/README.md) |
| Detached Dispatch | A controller submits a durable job to another OpenBitFun host and may then disconnect; the target owns the job, session, worktree, event log, and permission mailbox | [detached-task-dispatch.md](docs/architecture/detached-task-dispatch.md) |

Rules for all four:

- **Design the remote path together with the feature.** A capability that assumes UI, process, and filesystem share one machine is incomplete, not "phase one".
- **Degrade loudly.** When a scenario cannot be supported, gate the entry point or return a clear unsupported state. Silent local fallback, fake success, empty payloads, and generic errors are regressions; local fallback also leaks local content to a remote controller.
- **Keep blocking interaction answerable from a distance.** New permission prompts, dialogs, and pickers reach the driving surface through the existing dialog and permission-mailbox orchestration. A turn that only the desktop window can unblock deadlocks remote control and dispatch jobs.
- **Survive disconnect.** Remote surfaces reconnect, replay by cursor, and re-hydrate; prefer resumable cursors and idempotent mutations over state that exists only while a client is attached.
- **Remote workspace paths are POSIX on every client OS.** Do not split or join them with host `std::path` semantics, and do not reuse a controller-side path on a peer host.

Per-scenario obligations:

- **Remote workspace**: every desktop Tauri command has exactly one row in the Product Operation Registry ([`remote_surface/table.rs`](src/crates/contracts/product-domains/src/remote_surface/table.rs)) declaring its remote-workspace stance. The desktop closure test and the capability generator reject a command without a row, and new rows may not use `Unaudited` (that backlog only shrinks). Run `pnpm run capabilities:generate` after editing the table. See [remote-surface-contract.md](docs/architecture/remote-surface-contract.md).
- **Remote control**: mobile web and IM bots reach sessions through the `RemoteCommand` wire protocol and the bot command router / menu, not through the Web UI. When a session-level capability is added or moved (workspace or assistant selection, session lifecycle, mode, model, approval, attachment), extend those surfaces or make them answer with an explicit unsupported reply.
- **Peer Device Mode**: product commands are proxied to the peer by default. A command that must stay on the controller (window chrome, updater, account identity, local OS automation) is declared `ControllerLocal` in the same registry row; the desktop peer host, the CLI peer host, and the Web UI transport adapter derive their deny sets from it, and `pnpm run check:core-boundaries` rejects a hand-written table. A command the CLI host runs needs a handler plus `cli_peer: HANDLED` in its row; the closure test in `src/apps/cli/src/peer_host/commands/mod.rs` keeps both in step. Peer capabilities are typed (`PeerHostCapability`) and advertised from the registry. Read the peer-device README invariants before changing session, account, or hydrate paths.
- **Detached Dispatch**: jobs run headless on the target under the CLI delivery profile, with no interactive host and no guaranteed controller connection. The controller is an observer, never a runtime or filesystem proxy. Do not add behavior that requires a live submitter. The dispatch protocol version and required target capabilities are a compatibility contract: a new target-side requirement needs a negotiated capability, not an assumption.

State which remote scenarios a change was exercised in. Local-only tests are not evidence of remote behavior.

## Upgrade compatibility

Users upgrade in place, and the remote scenarios above routinely put two different OpenBitFun versions on the same connection. Every change must keep existing installs working without manual repair.

- **Persisted shapes are read by older and newer code.** For config, settings, sessions, connection profiles, worktree and dispatch records: add fields with defaults, keep deserialization tolerant, never repurpose or narrow the meaning of a field already on disk, and never make required a field that old data cannot supply.
- **Never delete or reset user data to recover from something you cannot parse.** Keep the record, degrade the feature, and surface a clear state. Missing credentials, an unreadable profile, a timeout, or an offline host are not reasons to drop a session, workspace, or connection. Destructive removal stays an explicit user action.
- **Cross-version boundaries negotiate; they do not assume.** Peer HostInvoke, the dispatch protocol, relay and mobile web, and IM bots all talk to a build you do not control. Advertise a capability and check it before using it (package version equality is not evidence of behavior), and keep the older side on a working path instead of failing it.
- **A rename is a migration.** Keep reading the old name, id, or record shape until no supported peer can still send it, and migrate referenced data (vault entries, workspace pointers) together with the thing being renamed.
- **Prove it with tests.** Cover legacy deserialization and an old-payload round trip, not just the new shape. A test that only exercises data written by the current code is not upgrade coverage.

## Read before changing

Read the listed documents before editing in these areas. The sub-bullets are hard constraints.

- **`openbitfun-core` decomposition, feature or dependency boundaries, Rust build speed**: [`docs/architecture/product-architecture.md`](docs/architecture/product-architecture.md) and [`docs/architecture/rust-build-dependency-boundaries.md`](docs/architecture/rust-build-dependency-boundaries.md).
  - Do not confuse DTO/contract extraction with runtime owner migration.
  - Product surfaces may diverge; share stable facts or ports, not UI, protocol, lifecycle, or platform implementation.
  - Moving runtime ownership requires a reviewed port/provider design, old-path compatibility, behavior equivalence tests, and explicit confirmation when a behavior boundary could change.
- **Agent Runtime deployment, multi-GUI/TUI/Remote instances, shared Session control, process topology**: [`docs/architecture/agent-runtime-deployment-design.md`](docs/architecture/agent-runtime-deployment-design.md).
  - Do not key Rust Runtime or Node/Bun Plugin Host processes by client, workspace, session, or plugin by default; use the responsible state module, execution and security conditions, and measured capacity.
- **CLI/TUI parity, non-interactive output contracts, external config imports, plugin management UX, CLI Agent behavior, branded CLI distributions**: [`docs/architecture/cli-product-line-design.md`](docs/architecture/cli-product-line-design.md) and [`src/apps/cli/AGENTS.md`](src/apps/cli/AGENTS.md).
  - Keep CLI/TUI presentation in the app; move reusable product behavior through Product Assembly, Agent Runtime, Tool/Harness, Runtime Services, or the existing extension boundaries.
- **HarmonyOS PC CLI/TUI**: [`docs/architecture/platform-portability-design.md`](docs/architecture/platform-portability-design.md).
  - This is a future platform target, not implemented support. The product target is the real PC system terminal; HAP, `hdc shell`, the phone Remote App, and remote execution are not substitutes. Design each concrete adaptation as a separate topic and keep the current mobile capability unchanged.
- **Product definitions, branded distributions, GUI/TUI layout selection, bundled product extensions, customization build tasks**: [`docs/architecture/product-customization-blueprint.md`](docs/architecture/product-customization-blueprint.md).
  - Keep product customization separate from user runtime configuration and plugins. GUI and TUI may share stable product facts, but not layout, component, theme-key, keybinding, or renderer schemas.
  - Product assembly results and layout selections may carry a small immutable list of product identity, data-isolation, recovery, upgrade-integrity, or legal protection IDs. They must not carry user/source-level plugin policy, installation, activation, update, permission, or dynamic health state.
  - Product Profile, Brand Pack, GUI/TUI Surface Blueprint, and Resolved Product Manifest are retired design terms, not production objects. Do not create compatibility formats for them; implement only the smallest product-definition and assembly-result fields used by a real build and runtime consumer.
- **OpenCode live configuration or plugin execution**: [`docs/architecture/extensions/opencode-extension-compatibility.md`](docs/architecture/extensions/opencode-extension-compatibility.md) and [`src/crates/adapters/opencode-adapter/AGENTS.md`](src/crates/adapters/opencode-adapter/AGENTS.md).
  - The compatibility matrix describes targets and gaps; do not treat a design target as an already available capability.
  - Do not extend the legacy managed-package path (the P0 static-preview entry) as the target OpenCode runtime model.
- **Agent hooks**: [`docs/features/agent-hooks.md`](docs/features/agent-hooks.md) ([中文](docs/features/agent-hooks.zh-CN.md)).
  - Native user hooks implement the Codex hook contract, so <https://learn.chatgpt.com/docs/hooks> is the reference for events, payload fields, and decision schema. Do not fork that contract. The feature doc covers only the OpenBitFun-specific parts (file locations, the `app.hooks` gates, and the deviations table) and must be updated whenever a deviation is added or closed.
  - Engine, registry, hook-source, and dispatch ownership: the [`agent-runtime`](src/crates/execution/agent-runtime/AGENTS.md) and [`core`](src/crates/assembly/core/AGENTS.md) guides.
- **Lifecycle evidence, gates, Artifact Graph, Project Profile, Deep Review policy, OpenCode compatibility, target-project governance**: [`docs/sdlc-harness/README.md`](docs/sdlc-harness/README.md) first, then [`docs/sdlc-harness/design.md`](docs/sdlc-harness/design.md). If module boundaries or behavior change, follow the matching design under `docs/sdlc-harness/architecture/` or `docs/sdlc-harness/features/`.
  - Do not hard-code OpenBitFun repository assumptions as target-project rules; keep quality protection behavior target-aware, evidence-backed, risk-tiered, cost-aware, and auditable.

## Maintaining these guides

- Keep this file to cross-cutting rules and stable repository entry points. Module ownership details, surface- or crate-specific commands, and focused test lists belong in the nearest guide; add a command there only when a real workflow needs it.
- Layer guides own the crate tables; do not enumerate crates here.
- Update `AGENTS.md` and `AGENTS-CN.md` in the same change.
