# services-core Agent Guide

Scope: this guide applies to `src/crates/services/services-core`.

`openbitfun-services-core` owns cross-platform service DTOs and helpers that compile
without the full product runtime. This includes generic filesystem/search/JSON
IO helpers, bounded local Instruction file reads, Session metadata storage
helpers, the durable Memory SQLite format, and local OS action primitives such as command lookup,
clipboard, file/url opening, script execution, workspace runtime FS/shell
providers, process-wide TLS provider selection, managed process-tree lifecycle,
process-level Agent Runtime ownership locks, and system facts. Product crates may layer routing, policy,
capability selection, event emission, or legacy error mapping outside this
crate.

## Guardrails

- Do not depend on `openbitfun-core`, app crates, Tauri, tool runtime, or product
  runtime crates.
- Prefer `openbitfun-core-types` for shared DTOs and `openbitfun-runtime-ports` for
  cross-layer traits.
- Keep dependency features explicit and keep `default = []`. The coarse service
  capability owners are `credential-vault` (prompt-free encrypted local
  credential files), `diagnostics` (diagnostic-log redaction), `diff`
  (local text diff calculation), `filesystem` (local file operations/search),
  `json-io` (generic locked and atomic JSON file IO), `local-storage`
  (JSON/session/usage persistence), `process-runtime` (command
  lookup and supervised child lifecycle), and `workspace-instructions`
  (declarative instruction discovery). Consumers enable those or the narrower
  `workspace-runtime`, `workspace-identity`, `runtime-ownership`, `tls-provider`,
  `permission`, `dispatch-workspace`, `markdown`, `session-git`, and
  `workspace-text-runtime` extensions only for behavior they use. `routing-state`
  composes only `json-io` and hashing for opaque scoped routing facts; it does
  not select accounts, retry delays, cooldown applicability or capacity policy.
  `resource-capacity` composes JSON IO, hashing and lease IDs for cooperative
  resource admission; it has no account, model or credential policy. Products
  needing IANA time-zone ranges and dashboard aggregation additionally select
  `token-usage-statistics` and `memory-store`. In particular, session metadata consumers must
  not compile libgit2 unless they use the memory-workspace baseline/diff API.
  Keep Tokio and platform API capabilities owner-scoped too: the empty profile
  carries no Tokio dependency, `workspace-runtime` explicitly composes
  `process-runtime`, and Windows storage/process bindings
  must not be enabled from one shared dependency feature union.
- `tls-provider` is the single owner of the process-wide Rustls provider. It
  selects only `ring`, `std`, and `tls12`; provider-neutral Reqwest consumers
  call `tls_provider::ensure_ring_crypto_provider` before client construction.
  Do not install a Rustls provider from another crate.
- Runtime call sites that touch agent execution, scheduler state, workspace
  managers, filesystem orchestration, or product behavior stay outside this
  crate. `workspace-runtime` may implement local `openbitfun-runtime-ports`
  providers, but not workspace selection or product orchestration.
- `runtime_ownership` owns only canonical identity plus Embedded shared-lock and
  Shared exclusive-lock primitives. It must not select workspaces, start or
  cache Runtime instances, or define Session/Turn ownership.
- The `product-identity` capability re-exports immutable build facts from
  `openbitfun-core-types`. Storage, dispatch, integration, and ownership code
  must reuse them; runtime product selection and product policy stay outside
  this crate. Capabilities that need those facts compose `product-identity`
  explicitly rather than adding them to the empty profile.
- `workspace_identity` owns canonical local roots plus stable local/remote
  workspace and session-storage identifiers. It has no SSH registry, transport,
  authentication, SFTP, PTY, or remote lifecycle responsibility; integrations
  may preserve old paths through re-exports.
- Do not add remote SSH, MiniApp storage, tool-result persistence, `PathManager`
  globals, or product runtime bindings to `filesystem`; keep those in core or a
  reviewed adapter/provider.
- Preserve legacy core imports with facade/re-export code when ownership moves.
- `process_tree` is the single reusable owner for supervised child-process
  lifecycle. Unix implementations use a dedicated process group; Windows must
  attach a suspended child to a kill-on-close Job Object before resuming and
  fail closed if attachment fails. Consumers own protocol shutdown; this owner
  owns cleanup for managed descendants and does not claim sandbox or
  resource-limit safety. Unix descendants that deliberately create a new
  session/process group are outside this boundary and must be treated as a
  disclosed residual risk until a platform supervisor is introduced.
- Windows final cleanup closes only registered `process_tree` child Jobs and
  rejects new managed spawns after shutdown begins. It must not initialize or
  close the Job used by `contain_current_process_tree`: that explicit CLI/SDK
  host-lifetime guard includes the host itself and stays alive until process
  exit. Keep updater/restart handoff processes outside managed child trees.

## Verification

Start from the capability that owns the change. Integration targets group test
source files with the same owner and feature closure; keep a focused run small
with `--test <target> <module>::<filter>` instead of adding another Cargo
target. Representative stable entry points are:

```bash
cargo check -p openbitfun-services-core --no-default-features
cargo test --locked -p openbitfun-services-core --no-default-features --features system-proxy --lib system_proxy::tests
cargo test -p openbitfun-services-core --no-default-features --features pet-packages --lib pet_packages
cargo test -p openbitfun-services-core --no-default-features --features asar --lib asar
cargo test -p openbitfun-services-core --no-default-features --features process-runtime --lib system::info::tests
cargo test -p openbitfun-services-core --no-default-features --features credential-vault --lib credential_vault::tests::
cargo check -p openbitfun-services-core --no-default-features --features filesystem
cargo test -p openbitfun-services-core --no-default-features --features filesystem --lib filesystem::tree::tests::large_files_remain_visible_in_metadata_listings
cargo test -p openbitfun-services-core --no-default-features --features diagnostics --lib diagnostics::contract_tests::
cargo test -p openbitfun-services-core --no-default-features --features diff --lib diff::contract_tests::
cargo test -p openbitfun-services-core --no-default-features --features workspace-text-runtime --lib workspace_text::tests::
cargo test -p openbitfun-services-core --no-default-features --features workspace-runtime --lib workspace::tests::
cargo test -p openbitfun-services-core --no-default-features --features local-storage --test session_contracts session_metadata_contracts::
cargo test -p openbitfun-services-core --no-default-features --features local-storage --lib session::metadata
cargo test -p openbitfun-services-core --no-default-features --features local-storage --lib session::page::tests
cargo test -p openbitfun-services-core --no-default-features --features local-storage --lib session::offline_import
cargo test -p openbitfun-services-core --no-default-features --features local-storage --test session_write_lock_contracts
cargo test -p openbitfun-services-core --no-default-features --features local-storage --test exclusive_file_lease_contracts
cargo test -p openbitfun-services-core --no-default-features --features memory-store --lib memory_store::tests::
cargo test -p openbitfun-services-core --no-default-features --features token-usage-statistics --lib token_usage::
cargo test --locked -p openbitfun-services-core --no-default-features --lib dispatch_contract::tests
cargo test -p openbitfun-services-core --no-default-features --features routing-state --lib routing_state::
cargo test --locked -p openbitfun-services-core --no-default-features --features resource-capacity --lib resource_capacity::
cargo test -p openbitfun-services-core --no-default-features --features process-runtime --test process_runtime_contracts
cargo test -p openbitfun-services-core --no-default-features --features process-runtime --lib process_tree::tests::
cargo test --locked -p openbitfun-services-core --no-default-features --features tls-provider --lib tls_provider::tests
pnpm run check:core-boundaries
```

Other capability-specific target names remain in `Cargo.toml`; document a new
command here only when it becomes a recurring owner workflow.

For Computer Use clipboard text transport, helper deadlines and native round trips:

```bash
cargo test --locked -p openbitfun-services-core --no-default-features --features process-runtime --lib system::local_actions
# Linux: disposable Xvfb and headless Sway seats; requires xvfb/xauth, xclip,
# xsel, wl-clipboard and sway. Never uses the user's current clipboard.
bash scripts/test-linux-clipboard.sh
# Windows: opt-in, disposable desktop/CI host only; replaces its clipboard.
cargo test --locked -p openbitfun-services-core --no-default-features --features process-runtime --lib system::local_actions::clipboard::tests::native_clipboard_roundtrip -- --ignored --exact
```

The ordinary macOS suite uses a named AppKit pasteboard, not the general user
pasteboard. The OS CI matrix runs all three native routes, including Linux X11
and Wayland. Windows clipboard helpers must use STA and byte-preserving UTF-8
stdin/stdout; never put clipboard contents into scripts or command arguments.
Linux clipboard owners may keep serving after the parent exits: do not wait for
inherited stdout/stderr pipes after a write. Only an executable that never
started permits write fallback. A timeout or error after launch has an unknown
write outcome and must not trigger another helper.

For workspace instruction family selection, non-empty fallback, and local/port
resolution parity:

```bash
cargo test --locked -p openbitfun-services-core --no-default-features --features workspace-instructions --test declarative_workspace_instruction_contracts
cargo test --locked -p openbitfun-services-core --no-default-features --features workspace-instructions,workspace-runtime --test workspace_instruction_contracts
```

## Offline-compatible storage formats

`session-recovery` owns offline migration-damaged session scanning, verified
full-session backup, resumable repair and rollback. It reuses workspace identity
and session metadata/index owners and never starts runtime or SSH connections.
App hosts must stop data writers before calling its mutation entry points.

```bash
cargo test -p openbitfun-services-core --no-default-features --features session-recovery --lib session_recovery
```

`routing_state` stores versioned resource bindings and cooldown observations
under caller-injected opaque scope keys. Reads do not initialize files. Updates
reload under the JSON OS lock and strictly replace atomically, preserving
unknown root and nested fields. Same-resource binding epochs never regress;
cooldown writes keep the longest same-epoch deadline and reject older epochs.
Unknown versions and malformed state stay intact and return an error. Resource
eligibility, scope/lineage selection, expiry interpretation and execution leases
remain outside this fact store.

`resource_capacity` serializes policy compare-and-exchange and owner registration
under the same JSON transaction lock. Each live owner holds a separate OS lease;
file existence, PID and timestamps never prove ownership. Unlimited admission
still registers holders so lowering a limit cannot ignore in-flight work. A
policy update never terminates existing holders. Dropping an admission waiter
does not interrupt an accepted file transaction: it finishes under its lock and
the unclaimed result releases its OS guard. Crashes release guards through the
OS; subsequent admission removes stale registrations. Reads do not initialize
missing state; unknown fields are retained and malformed or unsupported state
returns an error without reset. Snapshot counts are observations, not slot
reservations. Consumers choose stable resource scope, qualification checks,
queue policy and remote capability semantics.

`token_usage` keeps model-attempt attribution in the existing opaque
`token_details.openbitfunModelRequest` object so legacy serializers retain
the fact. Account identity is captured by the request producer, not reconstructed
from current credentials. Native attempts commit first to the versioned
`records/model-attempts/YYYY-MM-DD.json` authority, then project to the legacy
daily batch. Old cached daily writers cannot erase this authority. Updates
reload under the JSON OS lock, deduplicate immutable attempt IDs, preserve
unknown fields, and replace strictly atomically. Queries merge both sources,
prefer authority before scope filters and pagination, and never create or repair
files. Same-day pre-authority native rows are promoted on a native write; there
is no read-triggered history migration. Explicit clear-all covers both sources.
Projection failure is logged without undoing an accepted attempt; unreadable
data and unsupported authority versions remain explicit query errors, never
empty replacements or fallback to stale projections.
The owned writer completes accepted records after a caller stops awaiting it.
Optional `routingWarnings` in the attempt context retain open-string preference
observations supplied by the request producer. Legacy records default to an
empty list; preserve unknown codes through ledger and statistics round trips.
Do not infer warnings from current files or turn them into usage counters.
Unknown usage is counted separately from known zero; account dashboard totals
derive from ledger records. Existing per-instance model/session caches do not
constitute a new cross-process aggregation guarantee.

workspace-persistence owns workspace records and registry validation;
coordination-store owns the durable coordination SQLite schema;
session-event-format owns the logged-event envelope and durable-prefix validator.
StorageError carries only storage error categories; Core preserves its original
error mappings. Workspace managers, watchers, identity loading and live scanning
remain in Core through runtime extension traits on the shared records.

```bash
cargo test -p openbitfun-services-core --no-default-features --features workspace-persistence,coordination-store,session-event-format --lib
```

For bounded workspace upload ownership, offset recovery, conflict detection, and account retirement:

```bash
cargo test -p openbitfun-services-core --no-default-features --features workspace-transfer,workspace-runtime --lib workspace_transfer::tests
```

For complete local Skill package deployment, cache integrity, source changes,
executable modes and unsupported targets:

```bash
cargo test --locked -p openbitfun-services-core --no-default-features --features skill-package-sync,workspace-runtime --lib skill_package_sync::tests
```

These tests use local POSIX workspace providers. The real loopback SSH/SFTP
exercise is documented in the services-integrations guide. Full deployment
requires Python 3 on the POSIX target and rejects nested symlinks or reparse
points; a symlinked package root is canonicalized before scanning.
The selected remote workspace may have symlink ancestors; only that trusted
root is resolved. Managed cache components below it must remain plain directories.

Workspace catalog identity and upgrade deserialization (without live filesystem/SSH activation):

```bash
cargo test -p openbitfun-services-core --no-default-features --features workspace-persistence --lib workspace_persistence::tests
```
