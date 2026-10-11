[中文](AGENTS-CN.md) | **English**

# Product Domains Agent Guide

Scope: this guide applies to `src/crates/contracts/product-domains`.

`openbitfun-product-domains` owns platform-agnostic product-domain contracts that can
compile without the full core runtime. Keep it focused on pure state, DTOs,
policies, and narrow ports; concrete runtime behavior belongs outside this crate.

## Guardrails

- Do not add a dependency from `openbitfun-product-domains` to `openbitfun-core`.
- Keep the default feature lightweight. Default builds must not pull runtime,
  service, desktop, network, process, AI, or tool-runtime dependencies.
- This crate may own pure DTOs, enums, serialization contracts, search plans,
  command-selection decisions, storage-shape parsers, domain policies, and
  product-domain port traits.
- Concrete adapters that perform IO, process execution, AI calls, Git service
  calls, platform integration, tool exposure, or desktop/Tauri work belong
  outside this crate.
- Preserve existing core import paths with re-export or wrapper facades until
  downstream call sites are intentionally migrated.
- Feature-gated additions must remain narrow. `plugin-source`, `miniapp`,
  `function-agents`, `external-sources`, and `product-full` should only enable their declared
  product-domain feature groups.

## Ownership Boundary

- `miniapp` may own MiniApp data shapes, pure lifecycle decisions, metadata and
  import policies, built-in bundle identity, embedded source assets, seed-plan
  facts, marker wire formats, host primitive call plans, and narrow ports.
- `function-agents` may own function-agent DTOs, prompt/domain policies,
  response parsing and repair rules, file-shape analysis, and Git/AI port traits.
- `plugin-source` may own OpenBitFun package manifest shapes, source identity,
  fixed package input data, workspace trust records, and pure trust epoch
  transitions.
- `remote_surface` (default feature) owns the Product Operation Registry: one
  row per product operation that can cross a host boundary, with its
  remote-workspace stance, Peer Device stance, CLI peer host support, the
  typed peer capability list, and the exported artifact under `src/generated/`.
  Hosts and the Web UI derive their tables from it; it never executes anything.
  Design: `docs/architecture/remote-surface-contract.md`. Focused check:
  `cargo test -p openbitfun-product-domains --no-default-features remote_surface`,
  then `pnpm run capabilities:generate` to refresh the generated projections.
- `external-sources` may own open ecosystem/source identifiers, typed
  capability-provider ports, catalog DTOs, and version-sensitive conflict
  fingerprints. It also owns the provider-neutral Agent, Tool-reference, and
  Skill-root contribution DTOs produced by executable plugin adapters. These
  DTOs do not define source formats, Host protocols, execution handles, or
  lifecycle. Provider refresh, filesystem watching, persistence, and lifecycle
  coordination belong to assembly, services, or adapters.
- Concrete filesystem writes, marker IO, host dispatch, worker side effects,
  compile orchestration, `PathManager` integration, concrete Git/AI services,
  provider acquisition, and transport error mapping must stay outside
  `product-domains`.

## Verification

Use the smallest matching check for the changed surface:

```bash
cargo test -p openbitfun-product-domains --no-default-features
cargo test -p openbitfun-product-domains --features product-full
node scripts/check-core-boundaries.mjs
cargo check -p openbitfun-core --features product-full
```

For documentation-only changes, run `git diff --check`.

For MiniApp bridge/session or embedded bundle changes, use the focused contracts:

```bash
cargo test --locked -p openbitfun-product-domains --no-default-features --features miniapp --lib miniapp::agent_bridge::tests
cargo test --locked -p openbitfun-product-domains --no-default-features --features miniapp --test miniapp_contracts
```
