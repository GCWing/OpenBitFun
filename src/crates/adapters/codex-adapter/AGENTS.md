# Codex Adapter Instructions

- This crate may read and normalize Codex user Instructions, Subagent, MCP, and Hook configuration but must never invoke Hook handlers, start Codex/app-server, connect MCP servers, or own trust, enablement, or product policy.
- Keep commands, prompts, arguments, environment values, and credentials inside the adapter. Public contracts expose only bounded summaries.
- Preserve native Codex event and handler names. Map only reviewed OpenBitFun Hook points; report every other event as native-only.
- Preserve Codex configuration-layer and field-overlay semantics inside each typed provider. Unknown behavior fields must block explicitly; do not invent Codex Command or standalone Tool sources.
- Do not depend on another ecosystem adapter. Shared product behavior belongs in contracts or assembly.

## Session discovery and import verification

```bash
cargo test -p openbitfun-codex-adapter --lib session::
# Optional read-only installed-source verification (prints counts only):
cargo test -p openbitfun-codex-adapter --lib inspect_installed_codex_session_titles -- --ignored --nocapture
# Set OPENBITFUN_TEST_CODEX_THREAD to inspect one logical thread's full history:
cargo test -p openbitfun-codex-adapter --lib inspect_installed_codex_thread_history -- --ignored --nocapture
# Verify all paginated source IDs and histories. Optionally set
# OPENBITFUN_TEST_CODEX_WORKSPACE to restrict verification to one workspace:
cargo test -p openbitfun-codex-adapter --lib inspect_installed_codex_paginated_workspace -- --ignored --nocapture
```

## Pet source verification

```bash
cargo test -p openbitfun-codex-adapter --lib pet_source
# Optional read-only verification on a host with the Codex desktop app installed:
cargo test -p openbitfun-codex-adapter --lib installed_builtin_pet_catalog -- --ignored --nocapture
```
