# events Agent Guide

Scope: this guide applies to `src/crates/contracts/events`.

`openbitfun-events` owns platform-neutral event contracts and the emitter interface.
It describes events; it does not own event delivery or product decisions.

## Guardrails

- Keep event payloads serializable, stable, and platform-neutral.
- Do not depend on app crates, Tauri, transport adapters, concrete services, or
  UI command logic.
- Preserve event names, payload fields, priority semantics, and ordering
  assumptions when refactoring.
- Use shared DTOs from `openbitfun-core-types` when event payloads need stable
  identifiers or portable facts.
- Delivery, persistence, throttling, subscription routing, and remote sync
  behavior belong in transport, services, or app adapters.

## Verification

```bash
cargo check -p openbitfun-events
cargo test --locked -p openbitfun-events --lib frontend_projection::tests::result_read_projects_the_same_turn_identity_for_peer_and_local_consumers
node scripts/check-core-boundaries.mjs
```

For documentation-only changes, run `git diff --check`.
