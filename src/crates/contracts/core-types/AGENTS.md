# core-types Agent Guide

Scope: this guide applies to `src/crates/contracts/core-types`.

`openbitfun-core-types` owns low-level shared DTOs and error/session/surface
contracts. Keep it dependency-light and stable for cross-crate reuse.

## Guardrails

- Do not depend on `openbitfun-core`, runtime owner crates, service crates,
  transport adapters, app crates, Tauri, AI providers, Git, MCP, terminal, or
  tool-runtime implementations.
- Keep additions limited to portable data shapes, serialization contracts, and
  small pure helpers.
- `product_identity` owns the immutable product ID, data namespace, and derived
  hidden-directory name compiled into first-party artifacts. It must not read
  runtime configuration or implement product selection.
- Preserve persisted and cross-process wire compatibility. Any field rename,
  enum variant change, or default change must be treated as a contract change.
- Product policy, runtime behavior, IO, process execution, and platform
  integration belong in owner crates above this layer.

## Verification

```bash
cargo test -p openbitfun-core-types
node scripts/check-core-boundaries.mjs
```

For documentation-only changes, run `git diff --check`.

For persisted image dialect values and endpoint compatibility, run
`cargo test --locked -p openbitfun-core-types --lib ai::image_dialect_compatibility`.
