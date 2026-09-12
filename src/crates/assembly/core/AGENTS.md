[中文](AGENTS-CN.md) | **English**

# Core Agent Guide

## Scope

This file applies to `src/crates/assembly/core`. Use the top-level `AGENTS.md` for
repository-wide rules and the nearest narrower guide when one exists.

## Role

`openbitfun-core` is the shared product runtime facade. It still owns compatibility
paths and the `product-full` assembly boundary, but new decomposition work should
prefer the owner crates described in `docs/architecture/product-architecture.md`
and `docs/architecture/agent-runtime-services-design.md`.

Main areas:

- `src/agentic/`: agents, prompts, tools, sessions, execution, persistence
- `src/service/`: config, filesystem, terminal, git, MCP, remote connect, AI memory
- `src/infrastructure/`: AI clients, app paths, event system, storage, debug log server
- `src/product_runtime/`: Core Agent Runtime compatibility adapters and runtime service provider wiring

Agent runtime mental model:

```text
SessionManager -> Session -> DialogTurn -> ModelRound
```

## Boundary Rules

- Keep shared core platform-agnostic. Avoid host-specific APIs such as
  `tauri::AppHandle`; use shared abstractions such as
  `openbitfun_events::EventEmitter`.
- Desktop-only host adapters belong in `src/apps/desktop`, then flow through
  typed capability interfaces; use the production transport adapter when event
  delivery is needed.
- Do not add new cross-layer references from `service` to `agentic` without a
  narrow port/interface boundary.
- Do not move platform-specific logic, build-script behavior, product capability
  selection, or provider-specific AI serialization into shared core.
- When moving ownership out of core, preserve old import paths with facade or
  re-export code until downstream call sites are intentionally migrated.

## Decomposition Rules

- Treat `openbitfun-core` as a compatibility facade plus full product assembly point,
  not as the preferred home for new stable contracts.
- Put stable DTOs, facts, ports, and pure decisions in the matching owner crate
  where a clear owner exists. Keep concrete managers, IO, platform adapters, and
  product execution in core until a reviewed port/adapter/service design and
  behavior equivalence tests exist.
- Tool changes must preserve expanded/collapsed exposure, prompt-visible
  manifests, `GetToolSpec`, permission behavior, `ToolUseContext` semantics, and
  desktop/MCP/ACP catalog behavior.
- Workspace file tools select IO through `ToolUseContext::file_system_for_path`.
  Read/Write/Edit/Delete/LS must not add per-tool SSH branches. Shared algorithms
  belong in `tool-execution`; concrete filesystem/stream handling belongs in
  Services providers. Session artifacts stay host-local. A missing remote
  provider must fail without falling back to the controller filesystem.
- Snapshot preparation/completion may fail independently of the file tool.
  Never replay a mutation to repair tracking. A recorded operation is not proof
  of complete Session coverage; remote Session Undo retains its coverage gate.
- Runtime-owner migrations must keep concrete lifecycle, IO, event delivery,
  permission orchestration, and remote/platform implementations in core until
  the target owner has a reviewed port/adapter/service design plus
  behavior-equivalence tests.
- Product-domain changes may move pure product-domain plans with equivalence
  coverage, but filesystem writes, worker/host side effects, Git/AI concrete
  calls, marker IO, and path-manager integration stay in core unless a reviewed
  owner design says otherwise.
- `plugin_source` may inject product-owned paths and keep compatibility exports;
  concrete managed-package discovery and trust persistence stay in
  `services-integrations`, while ecosystem parsing and PluginRuntimeClient
  behavior remain in their adapter and execution owners.
- `plugin_runtime`, `external_sources`, and `instruction_sources` are the
  reviewed owner-feature composition files allowed to select ecosystem adapters
  for their respective capability contracts. Product surfaces consume
  product-level views and must not import adapter or raw plugin runtime client
  types.
- The managed OpenCode Plugin Host is an adapter/service resource. Core may
  assemble its launch, retain opaque logical instance and PTY scope bindings,
  and bridge matched requests to existing product owners. OpenCode route
  matching, wire DTOs, serialization/error mapping, and physical process-tree
  supervision stay in `opencode-plugin-host` and `services-core`; Core route
  projections must not invent provider connectivity, VCS, permission, or other
  owner state.
- External-source Desktop, TUI, Peer, and Server surfaces share the versioned
  product-domain control DTO and closed generic actions. Capability-specific
  approvals and conflict choices remain typed owner operations; do not add a
  second surface-specific lifecycle model or arbitrary control payload.
- Remote/service changes must keep external protocol lifecycle, workspace
  projection, scheduler/session restore, terminal pre-warm, and product
  execution boundaries explicit.
- Feature work must keep `product-full` as the compatibility product assembly
  boundary unless a separate product matrix review changes default capability
  selection.
- `agent-runtime` owns the Core Agent lifecycle baseline, native Hook runtime,
  basic filesystem/process tools, and Agent-control tools, including scheduled
  job execution. Concrete network and product capabilities stay explicitly
  selectable: `model-catalog`,
  `mcp-runtime`, `remote-connect`, `workspace-search`, `browser-control`,
  `web-tools`, `deep-research`, and `script-tool-runtime`.
  `model-catalog` composes runtime services for catalog update events;
  `mcp-runtime` layers the Core MCP tool bridge on the Agent lifecycle; and
  `remote-connect` layers its phone relay on the Agent lifecycle and model
  catalog. None of these relationships may be hidden in the `agent-runtime`
  baseline. `scheduled-jobs`, `document-read`, and `subscription-auth` are
  additive dependency/source modifiers, not standalone runtime profiles. The
  latter two use Cargo weak dependency forwarding so they refine an already
  selected tool or adapter owner without activating that owner by themselves.
  Product-owned managed worktree lifecycle is available only when the Agent
  lifecycle and Git service owners are both selected; it is not a tool-pack owner.
  Function Agent adapters use the independent `function-agents` owner;
  MiniApp domain/runtime/market dependencies belong only to `tools-miniapp`.
  Tool implementation groups use the matching `tools-*` owner feature.
  Product Assembly supplies the exact `ProductToolPlan`; Core materialization
  validates that requested owners were compiled and must not infer product
  capability from Cargo's feature union. The Agent Runtime baseline plan is
  exactly `Basic` plus `AgentControl`, not a hidden delivery profile.
  `external-sources` adds third-party discovery/import adapters,
  `plugin-runtime` adds executable plugin-client wiring,
  `opencode-plugin-host` composes the managed Host and its reviewed route
  owners. None may enable `product-full`.
- CLI/ACP closure checks keep Cargo resolver-v2 normal and host
  (build/proc-macro) feature contexts separate, while treating all
  target-specific declarations within each context as one reviewed architecture
  boundary. Split a package/module owner when platforms genuinely differ; do
  not hide an unreviewed Core capability behind mutually exclusive Cargo `cfg`
  branches.
- Keep the light compatibility features independently compilable. Local service
  profiles are `dispatch-store`, `terminal`, `workspace-runtime`, and
  `workspace-watch`; `remote-workspace` adds only the remote workspace facade,
  while `ssh-remote` adds concrete SSH transport. Integration facades
  `announcement`, `file-watch`, `git`, and `review-platform` remain independent,
  with `service-integrations` only their compatibility aggregate. None of these
  narrow features may enable `product-full` directly or transitively.
- `product-full` must explicitly compose every capability it consumes, including
  product-only `services-core` features such as `permission`, `session-git`, and
  `runtime-ownership`, every concrete service owner, and every `tools-*` group.
  Do not put those features on the dependency declaration, because Cargo
  feature union would force them into every core consumer.
- Core's default feature set is empty. `product-full` is an explicit
  compatibility assembly selected by real product entrypoints, never the
  library's implicit default. Capability-local utility dependencies remain
  optional and are activated by their owner features; in particular,
  `base64`, `futures`, `regex`, `tokio-util`, and `openbitfun-agent-tools` belong to
  the Agent Runtime, local-storage, or dispatch-store closures that
  use them. Core's direct feature-free Tokio edge keeps only filesystem and
  synchronization support required by config and app-path state; the selected
  Services Core `json-io` owner separately carries the runtime/time capabilities
  required for bounded atomic JSON writes.
- Backend Fluent bundles and mutable translation state are owned by
  `i18n-runtime`; locale ids, aliases, fallback facts, metadata, and
  model-facing language copy remain feature-free contracts. Hosts that call
  `I18nService` must select `i18n-runtime` explicitly.
- Reusable diagnostic redaction and local Diff implementations remain
  compatibility facades under the exact `diagnostics` and `diff` features.
  Agent Runtime selects `openbitfun-services-core/workspace-text-runtime` for
  bounded asynchronous workspace reads; synchronous path normalization stays
  available to contract-only consumers without Tokio.
- Platform transport emitters are host adapters. Desktop imports
  `openbitfun_transport::TransportEmitter` directly; Core exposes only the stable
  `openbitfun_events::EventEmitter` contract and must not re-export a host adapter.
- Keep `cargo check -p openbitfun-core --no-default-features` viable. Gate
  product-only modules at their owner feature; if a light facade operation
  cannot safely complete without a product owner, fail closed and preserve any
  durable recovery state instead of enabling `product-full` implicitly.

## Owner References

Use these files for ownership details instead of expanding this guide:

- `docs/architecture/product-architecture.md`
- `docs/architecture/agent-runtime-services-design.md`
- `src/crates/execution/agent-runtime/AGENTS.md`
- `src/crates/execution/tool-contracts/AGENTS.md`
- `src/crates/execution/agent-workflows/AGENTS.md`
- `src/crates/contracts/product-domains/AGENTS.md`
- `src/crates/contracts/runtime-ports/` and `src/crates/execution/runtime-services/` source docs
- `src/crates/services/services-core/AGENTS.md`
- `src/crates/services/services-integrations/AGENTS.md`
- `src/crates/execution/tool-provider-groups/AGENTS.md`

Narrower local guides already exist for some subtrees:

- `src/crates/adapters/ai-adapters/AGENTS.md`
- `src/crates/assembly/core/src/agentic/execution/AGENTS.md`
- `src/crates/assembly/core/src/agentic/deep_review/AGENTS.md`

## Verification

AI client construction and subscription credential compatibility:

```bash
cargo test -p openbitfun-core --no-default-features --features ai-adapter-runtime,subscription-auth --lib infrastructure::ai::client_factory::tests
```

This guide owns Core verification. Select one command pattern that matches the
change; do not run every feature variant:

```bash
cargo check -p openbitfun-core --no-default-features
cargo check -p openbitfun-core --no-default-features --features <touched-owner-feature>
cargo test -p openbitfun-core --no-default-features --features <minimal-features> --lib <module>::<test>
```

Use the first command when the feature-free facade changed, the second when one
feature boundary changed, and the third for behavior. Run
`pnpm run check:core-boundaries` only for Cargo features, dependency direction,
or test-target layout. Workspace checks and product-wide tests are CI-backed and
are not the default Core precheck. For documentation-only changes, run
`git diff --check`.

Configuration persistence, account settings import, backup restore, legacy
field/deletion compatibility, local-change notifications, and save/reload/model
concurrency regressions have feature-free fixtures:

```bash
cargo test -p openbitfun-core --no-default-features --lib service::config::
```

The account sync adapter requires `remote-connect`, which also covers
Agent-profile canonicalization in the focused configuration suite:

```bash
cargo test -p openbitfun-core --no-default-features --features remote-connect --lib service::config::
cargo test -p openbitfun-core --no-default-features --features remote-connect --lib service::remote_connect::settings_sync::tests
```

Focused workspace-IO and snapshot regression entry points (use the matching
filter rather than a product-wide build):

```bash
cargo test -p openbitfun-core --no-default-features --features agent-runtime,git,document-read --lib file_read_tool::tests
cargo test -p openbitfun-core --no-default-features --features agent-runtime,git --lib file_write_tool::tests
cargo test -p openbitfun-core --no-default-features --features agent-runtime,git --lib delete_file_tool::tests
cargo test -p openbitfun-core --no-default-features --features agent-runtime,remote-workspace,git --lib service::snapshot::
```

MCP chat discovery and deferred-tool manifest contracts (Git is needed by the
existing Agent tool test assembly):

```bash
cargo test --locked -p openbitfun-core --no-default-features --features mcp-runtime,git --lib agentic::tools::product_runtime::
```

Skill discovery, installation provenance, and local/remote registry regressions:

```bash
cargo test --locked -p openbitfun-core --no-default-features --features agent-runtime,git --lib agentic::tools::implementations::skills::
```

For configured OpenCode discovery and explicit skill loading, include their owner feature and tool tests:

```bash
cargo test --locked -p openbitfun-core --no-default-features --features agent-runtime,git,external-sources --lib agentic::tools::implementations::skill
```

Detached Dispatch controller, target query compatibility, and managed-baseline checks:

```bash
cargo test --locked -p openbitfun-core --no-default-features --features agent-runtime,dispatch-store,ssh-remote,git --lib service::dispatch::
```

IM bot reply routing, account-device observation, and interaction delivery:

```bash
cargo test --locked -p openbitfun-core --no-default-features --features remote-connect --lib service::remote_connect::bot::
```
