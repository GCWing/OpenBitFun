[中文](AGENTS-CN.md) | **English**

# Agent Runtime IPC

Scope: `src/crates/adapters/agent-runtime-ipc`.

This non-published crate is the private local protocol used by the first-party Shared TUI adapter.
It provides discovery, one-instance locking, bounded framing, authenticated initialization, a closed interactive operation set,
session controller leases, event delivery, connection bounds, and cleanup. It is not a public SDK, remote protocol, service layer, or Runtime owner.

## Pre-integration contract

- Only consumer: the first-party interactive TUI adapter in `src/apps/cli`.
  GUI, Remote, Peer, ACP, Headless CLI, and SDK Host are not implied consumers.
- Stable test contract: platform-local endpoint, strict initialize-first handshake, separate handshake/request deadlines,
  128 KiB request and 8 MiB response/event limits, bounded connections, one controller per Session, one active Turn per connection,
  disconnect cancellation, sticky event-stream invalidation, 30-second idle exit, and owner-checked discovery cleanup.
- Integration check: the consumer must reuse existing Agent Runtime owners and
  prove Embedded/Shared behavior equivalence without depending on SDK Host.

## Boundaries

- Export only the exact workspace-private API needed by the CLI adapter. Do not
  publish this crate or expose its wire as an SDK contract.
- The closed operation budget is Health, a read-only workspace-scoped main-Agent mode summary, Session list/create/restore/delete/fork (including transcript on restore/fork), current-Session rename, Agent mode/model update, manual context compaction, Session undo/redo, current-controller read-only workspace-reference search/persisted-reference lookup, root-scoped Session-lineage query/descendant transcript read/targeted descendant cancellation, and a read-only diff of the Runtime-bound workspace that does not acquire a Session lease,
  declarative context reload, Turn submit/steer/user-authored Shell execution/cancel, pending/respond Permission, and UserInput answers, first interaction, and cancellation. First interaction disables the unattended deadline in the Runtime owner; cancellation dismisses only the question. Both require the current Session controller. Delete is limited to an idle Session not controlled by any client.
  Fork is a current-controller, idle-only operation. It either copies through the latest persisted Turn or stops immediately before an explicitly selected Turn. The encoded success result carries the authoritative new Session and transcript; only then may the server atomically switch the connection lease from the source Session to the fork.
  Manual compaction is a current-controller, idle-only Turn operation. The client supplies its exact Turn ID before admission so timeout or disconnect cleanup can cancel the same owned task; once Core begins the atomic context commit, a late cancellation does not expose a false idle state.
  User-authored Shell execution is a current-controller, idle-only Turn operation with a caller-supplied Turn ID. It delegates to the narrow Runtime port and normal ToolPipeline, permission, workspace-routing, persistence, and cancellation owners; it is not a generic Tool or process-execution wire.
  Steering is a current-controller, active-Turn-only operation with caller-supplied Session and Turn IDs. It delegates to the shared Runtime owner, rejects stale projections, and does not create a second Turn or queue owner.
  Lineage operations require the current root controller. Query and transcript inspection remain read-only during an active Turn; targeted cancellation validates descendant membership in the Runtime owner and follows the existing Session-abort semantics for the selected descendant's active execution subtree. They do not add observer, detach, paging, or controller-transfer semantics.
  Context reload may run during an active Turn, does not rewrite that Turn, and guards the cache so the next message reads invalidated instructions.
  Undo/redo is a current-controller operation that may enter during an active Turn because Core owns cancel-and-drain before mutation. Its success response carries the authoritative transcript and clears the connection's active-Turn projection. It is local-workspace only and does not expose a generic checkpoint protocol.
  Disconnect cleanup is internal lifecycle, not a detach operation.
  Model catalogs, defaults, and full Agent/Subagent management remain product configuration outside this wire. The main-Agent summary is only the minimal host-owned selector projection: startup reads the Runtime-bound workspace without a Session lease, while a Session-scoped query requires that Session's current controller and lets the Runtime owner resolve its execution workspace. Its external-source classification is ecosystem-neutral, and it carries no installation, mutation, activation, or runtime lifecycle API. Do not add archive, replay, observer,
  general controller transfer, Tool/MCP/Hook management, or other product configuration incidentally.
- Stable Event, Product Domain, and Runtime Port DTOs may be reused. Only the
  protocol-neutral bounded JSON encoder from `openbitfun-transport` is reused; the
  single-consumer length-prefix framing remains private to this wire. Do not
  depend on `openbitfun-core`, Agent Runtime implementations, SDK Host, services,
  Tauri, terminal, tool runtime, or remote transports.
- Use only Windows Named Pipes or Unix Domain Sockets. Do not add TCP, HTTP,
  WebSocket, browser access, or remote fallback.
- Treat this as same-user local isolation, not a sandbox. Product composition
  must supply a user-private runtime directory.
- Embedded callers must continue to invoke the typed Agent Runtime directly and
  must not initialize this transport. Shared outgoing request, response, and
  event frames are encoded once before write; strict decoding, unknown-field
  rejection, frame limits, bounded queues, and backpressure must not be weakened
  for throughput.

## Upgrade compatibility

The v20 handshake advertises `local_context_truncation` before force compaction.
Current clients can decode handed-off v18/v19 discovery and retain ordinary
compaction when the capability is missing; force fails before any request.
Production Shared TUI discovery roots and Runtime identities include the IPC
version, so upgrading never replaces a running older host. Older clients keep
using their matching host; restart those clients and host to use v20. Strict
unknown-field decoding remains enabled.

## Verification

```bash
cargo test -p openbitfun-agent-runtime-ipc
node scripts/check-core-boundaries.mjs
```
