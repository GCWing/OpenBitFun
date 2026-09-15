# agent-runtime Agent Guide

Scope: this guide applies to `src/crates/execution/agent-runtime`.

`openbitfun-agent-runtime` owns portable agent runtime decisions,
session/config/context facts, lifecycle helper state, and the narrow
port-backed `sdk` / `AgentRuntime` facade that can be built and tested without
`openbitfun-core`.

## Feature Boundaries

- `native-hook-settings` exposes Codex-compatible hook settings parsing and
  validation without process execution.
- `native-hook-runtime` extends settings with payload, output, and managed
  child-process execution.
- `agent-runtime` selects the complete portable runtime and includes
  `native-hook-runtime`.
- `default` stays empty. Consumers select the smallest owner feature they use;
  do not add a compatibility `full` feature or rely on another workspace
  consumer to create a Cargo feature union.

## Guardrails

- Do not depend on `openbitfun-core`, app crates, Tauri, ACP protocol, web UI,
  concrete service crates, or product-domain implementations.
- The `sdk` module may re-export only stable runtime request/response types,
  runtime-port contracts, and the service/tool/agent/hook registry types needed
  for dependency injection. It must not re-export raw PluginRuntimeClient types
  such as plugin runtime bindings, dispatch/read request types, status snapshots,
  plugin fault diagnostics, or host clients; Product Assembly uses the internal runtime
  builder when it needs to inject a plugin runtime.
- `AgentRuntime` may depend on stable ports plus injected `RuntimeServices`,
  tool registry, agent registry, and hook registry. Product assembly owns
  concrete registration; this crate must not create concrete managers, app
  state, filesystem, terminal, MCP, remote, or AI clients.
- The `runtime` module is internal / Product Assembly facing. Do not route
  client-facing SDK, Server/API, app, Web, mobile, or installer entrypoints
  through `openbitfun_agent_runtime::runtime`; those surfaces must use `sdk` or
  projected Server/API DTOs.
- Keep concrete scheduler/session lifecycle execution, session metadata IO,
  event emitter wiring, workspace/remote permission-scope projection, native
  permission Hook ordering, permission UI presentation, and product `Tool`
  adapter execution in `openbitfun-core` until a reviewed owner migration proves
  behavior equivalence. Provider-neutral permission policy/grant planning,
  confirmation gate/wait-channel, and user-question state may live here.
- Prefer pure facts and decisions first: queue policy, background delivery,
  dialog-turn queue state, active-turn facts, cancellation routing and
  suppression state, background running-turn injection construction, steering action
  planning, agent-session reply planning, thread-goal accounting/mutation/continuation decisions,
  scheduled-job lifecycle state transitions, runtime event facts,
  registry visibility/availability, custom subagent schema/default decisions,
  skill catalog/root/mode/selection facts,
  thread-goal metadata / event payload /
  token usage / scheduler delivery plans, thread-goal tool wire contracts,
  session config/defaults/summary and persisted session-state sidecar shape,
  user-question validation/result/channel contracts, SessionControl input/cancel-route/result contracts,
  custom subagent markdown front-matter IO, custom subagent discovery/loading,
  post-call hook routing/executor orchestration,
  tool confirmation gate/planning/failure/wait-result/channel mapping, light checkpoint
  summary policy, dialog-turn cancellation token state,
  round-boundary yield/injection state, turn-outcome
  queue decisions, registry source/profile facts, prompt-loop user-context
  policy, prompt listing reminder ordering, prompt-cache policy/identity/store,
  prompt runtime/workspace/user-context rendering, turn skill/agent snapshot
  state, code-review read receipts, session evidence ledger projection,
  finish-reason labels, session-state event labels, and turn-outcome event
  facts.
- Keep concrete prompt fact collection, workspace context IO, prompt-cache
  persistence wiring, dynamic environment collection, concrete hook side
  effects, named product workflow policy and execution, and concrete product tool execution
  outside this crate until a reviewed migration proves behavior equivalence.
- DeepReview compatibility modules and the built-in product Agent catalog still
  present here and in `assembly/core` are migration debt, not Runtime scope.
  Product Assembly already owns the selected Agent IDs. These compatibility
  paths may receive fixes needed to preserve existing behavior, but new named
  workflow policy belongs in `agent-workflows`; migrate one production path at
  a time with equivalence tests before deleting the old owner.
- Add focused tests before moving any runtime decision into this crate.

`compression_prefetch` owns provider-neutral threshold, completion publication,
claim and cancellation semantics. Core injects the future and validates its
context/request identity; this module never calls providers, emits product events,
or writes sessions. It is an internal assembly-facing module, not a new SDK or
wire capability.

## Test Target Layout

Integration contracts use six explicit Cargo targets so package-level checks
do not relink the same feature-free dependency closure for every source file,
while platform-specific process tests retain executable-level isolation:

| Target | Owns |
|---|---|
| `agent_definition_contracts` | Agent definitions, discovery, prompts, prompt cache, and skills |
| `agent_session_contracts` | Events, scheduling, sessions, SDK behavior, and workspace-reference ports |
| `agent_interaction_contracts` | Permissions, questions, hook payloads, and post-call hook behavior (`agent-runtime`) |
| `agent_long_horizon_contracts` | DeepReview and long-running thread-goal behavior (`agent-runtime`) |
| `native_hook_settings_contracts` | Hook settings parsing without process execution (`native-hook-settings`) |
| `native_hook_execution_contracts` | Unix-only native process execution, timeout, and cleanup behavior |

Add a contract to the nearest existing target. Do not add another top-level
integration target unless it requires a genuinely different feature,
platform, process, or dependency boundary. Use `--lib <filter>` for a focused
library test, or `--test <target> <module>::<filter>` for a focused public
contract test.

Grouped target roots stay flat: apart from module documentation, they contain
only direct `#[path = "..."]` / `mod ...;` pairs, and every leaf `.rs` file is
referenced exactly once. Isolated platform or process targets keep their test
implementation in the root file. The core-boundary check enforces this shape
so `autotests = false` cannot silently omit a new contract.

## Verification

Use the focused contract form by default. Run the package-wide form only when a
change crosses several runtime targets:

```bash
cargo test --locked -p openbitfun-agent-runtime --no-default-features --features agent-runtime --lib --tests
cargo test --locked -p openbitfun-agent-runtime --no-default-features --features native-hook-settings --test native_hook_settings_contracts
cargo test --locked -p openbitfun-agent-runtime --no-default-features --features agent-runtime --test <target> <module>::<test>
```

Run `pnpm run check:core-boundaries` only when Cargo dependencies, explicit test
targets, or grouped-root layout changed. Core product assembly and
`product-full` verification belong to Core or the consuming product guide, not
to this module's default checklist.
