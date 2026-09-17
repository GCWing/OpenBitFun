# terminal Agent Guide

Scope: this guide applies to `src/crates/services/terminal`.

`terminal-core` owns standalone terminal sessions, PTY process handling, shell
integration and resolution, and terminal event/config contracts. It is reusable
infrastructure, not a product command or UI layer.

## Guardrails

- Do not depend on `openbitfun-core`, app crates, Tauri, product domains, AI
  providers, Git, MCP, transport adapters, or tool-runtime implementations.
- Keep platform-specific behavior behind terminal abstractions and preserve
  Windows, macOS, and Linux shell compatibility.
- Do not change command execution, PTY lifecycle, persistence, output
  buffering, cancellation, or shell integration semantics as a side effect of
  refactoring.
- Product-specific terminal policies, remote workspace routing, and UI command
  wiring belong in higher layers.

## Verification

```bash
cargo check -p terminal-core
cargo test -p terminal-core --lib exec:: # process output, encoding, polling and lifecycle
cargo test -p terminal-core --lib workspace_origin_contract_tests # terminal response compatibility
node scripts/check-core-boundaries.mjs
```

For documentation-only changes, run `git diff --check`.
