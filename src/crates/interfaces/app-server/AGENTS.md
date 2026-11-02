[中文](AGENTS-CN.md) | **English**

# App Server Interface Family Guide

Scope: this guide applies to the adjacent `app-server-protocol`,
`app-server-client`, and `app-server` crates, plus App Server production wiring.
Server-specific rules apply to `app-server` unless stated otherwise.

The App Server surface is split across four owners:

| Owner | Responsibility |
|---|---|
| `app-server-protocol` | Methods, wire DTOs, wire errors, event envelopes, and schema-free protocol roles |
| `app-server-client` | Typed requests, typed events, connection behavior, and a host-supplied transport abstraction |
| `app-server` | Server lifecycle, production handler registration, event forwarding, Runtime/domain-to-wire conversion, and error mapping |
| Product Host under `src/apps/*` | Concrete transport, authentication, connection scope, capability/limit construction, platform capabilities, process supervision, and shutdown |

Do not add new protocol or client ownership to `openbitfun-app-server`. Compatibility
modules and re-exports may remain while consumers migrate, but new methods,
DTOs, wire errors, and typed client behavior belong in the adjacent protocol
and client crates.

The `openbitfun-app-server/ts` feature is a compatibility forwarder only. The
protocol crate is the sole TypeScript schema exporter; do not add `ts-rs`,
runtime implementation types, or a second export command back to this crate.
Protocol wire DTOs and serde contracts remain available with no feature. The
protocol crate's default `rpc` feature attaches ACP JSON-RPC traits and exposes
its roles and transport helpers for compatibility; `ts` must remain orthogonal
and must not enable `rpc` or `agent-client-protocol`.

## Guardrails

- Keep compatibility role and transport helpers schema-free. Do not hard-code
  domain methods or business behavior into `AppServer` / `AppClient`, stream
  direction helpers, or in-memory transport constructors.
- `AppServer` / `AppClient` are custom protocol counterparts. Do not reuse the
  built-in ACP `Agent` / `Client` roles. Preserve the required per-role
  `HasPeer` implementation.
- Transport constructors must pin
  `ByteStreams::new(outgoing, incoming)` direction; never expose a swap-prone
  API. The Host chooses and owns the concrete transport.
- Register only production handlers backed by a real Runtime, Service, or
  Product Domain owner. A handler validates the wire contract and converts
  types; it must not hold a second copy of Session, Permission, Config,
  capability, or lifecycle state.
- This crate may select only the narrow `openbitfun-core` owner features required
  by registered handlers. `openbitfun-core/product-full` is forbidden. Add a new
  owner feature only with the corresponding boundary verification.
- Host-specific authentication, identity, workspace/execution scope,
  capability availability, transport limits, platform providers, process
  lifecycle, and connection fan-out stay in the Host. Do not infer them from a
  generic server default or global environment.
- Handlers must offload Runtime calls or return immediately. Do not call
  `SentRequest::block_task` inside a handler callback; reply through
  `responder.respond_with_result`.

## Event Delivery

Runtime events cross the App Server connection; they are not a client-side
Host subscription:

- The server receives an injected `AgentEventSource` associated with the same
  Runtime owner and forwards typed Agent, Permission, Config, and stream-state
  notifications through the connection.
- The typed client crate receives and fans out those notifications. A Host
  must not make its App Server client subscribe directly to the Core
  `EventQueue`, because that creates a protocol bypass.
- Connection-local sequence/cursor and sync behavior must remain explicit.
  Do not describe it as persisted cross-connection replay or resume unless
  such an owner and contract are implemented.

## Error Mapping

Map Runtime and domain failures to protocol-owned wire errors in this server
adapter. Keep stable kinds and structured data, and do not leak Runtime
internals. Host transport/auth/scope failures remain Host-owned; owner
failures use helpers such as `OpenBitFunAppRuntime::runtime_error` and
`session_runtime_error`.

## Verification

Legacy model edits must preserve account/channel selection and write-only
credentials. Merge against the current model under the existing config owner
write lock. Focused compatibility check:
`cargo test --locked -p openbitfun-app-server --offline --lib model_mutation_preserves_and_replaces_write_only_values`.

```bash
cargo check --locked -p openbitfun-app-server --offline
cargo test --locked -p openbitfun-app-server --offline --lib server::wire::tests
cargo test --locked -p openbitfun-app-server --offline --test agent_kernel
cargo test --locked -p openbitfun-app-server-protocol --offline --test legacy_wire_contracts
pnpm run check:core-boundaries
```
