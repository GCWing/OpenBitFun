# DeepSeek Harness (dsh) Adapter

This crate owns the static, runtime-free projection of DeepSeek Harness (`dsh`)
plugin package sources. It reads a OpenBitFun-managed package whose
`openbitfun.plugin.json` declares `adapter: "dsh_compatible"`, parses the package's
`package.json` `dsh` declaration, and projects the discovered bundle entries
(`dsh.bundle.patch` -> `cordis.patch.yml` rows) and/or profile bundle references
(`dsh.profile.bundles`) as projection-only plugin sources.

`hook_source` separately discovers home/profile Cordis patches and workspace
composition files. It follows explicit Claude Code/Codex bridge `configPath`
references using the selected launch workspace for relative paths. It never
composes a profile or executes plugins. Bridge events remain native-only;
unresolved paths, opaque bundle composition, and malformed sources are visible
diagnostics. Keep these semantics out of the OpenCode adapter and native registry.

`mcp_source` discovers explicit `@deepseek-ai/dsh-mcp-client` declarations in
home/profile/workspace `cordis.yml` and `cordis.patch.yml`. Each file is an
independent reuse source, not an effective native profile. Literal stdio and
HTTPS Streamable HTTP declarations use the shared MCP provider and import ports.
Preserve launch-relative cwd, the 60-second default tool timeout, and disabled
OAuth discovery. Dynamic YAML, partial patches and scoped lifecycle behavior remain unsupported.
Direct compatibility activation rejects explicit reconnect/startup policies;
explicit snapshot import accepts valid literal reconnect and failOnStartupError
settings with a disclosure that OpenBitFun owns lifecycle after import. Source
disabled state does not block import. Keep the discovery revision when preparing
the import so status relaxation cannot break or bypass stale-plan checks. Never
evaluate Cordis or install packages during discovery. Environment and headers stay private to the
approved runtime preparation and require manual setup for snapshot import.

It does not execute Cordis plugins, install npm packages, or depend on a
user-local `dsh` CLI. Execution of dsh bundles belongs to future Plugin Host /
external-ACP work, not this adapter boundary.

If executable dsh support is added, the dsh adapter may project capabilities
whose OpenBitFun owner semantics have been verified through the provider-neutral
plugin capability contract. Cordis source parsing, execution handles, Host
protocol, and lifecycle remain dsh-owned and must not reuse the OpenCode Config
Hook or OpenCode Plugin Host composition path. The current configured Skill-root
merge and precedence behavior remains OpenCode-owned; dsh Skill publication
requires its own consumer evidence before that path is shared.

## Boundary Rules

`session` reads default `$DSH_HOME/sessions` v0 raw JSONL and concatenated Zstandard
logs with bounded decompression. It projects append-origin human history,
assembled assistant messages, reasoning and correlated tool results into the
existing session-import contract. Model-only replacements and stream chunks must
not duplicate transcript entries. Keep discovery, parsing and format diagnostics
here; native persistence, follow/fork and presentation remain with existing owners.
Never execute Cordis patches to discover custom persistence roots.

- Depend on stable contracts (`openbitfun-runtime-ports`, `openbitfun-product-domains`)
  and the `PluginRuntimeAdapter` boundary trait. Do not depend on `openbitfun-core`,
  app crates, Tauri APIs, product UI, or concrete service managers.
- Keep the dsh `package.json` `dsh` field shape and `cordis.patch.yml` entry
  extraction inside this crate. Cross-crate outputs use typed
  `PluginSourceRef` / `PluginStatusSnapshot` / `PluginDiagnostic` DTOs; do not
  expose raw dsh YAML or JSON as product contracts.
- Cordis rows may mount services that register model-facing tools when dsh runs
  them, but static row metadata is not an executable OpenBitFun provider candidate.
  `load_dsh_package_adapter` therefore returns no provider dispatch targets.
  Unsupported or unparsable content must produce typed invalid projections and
  diagnostics, never silent success.
- New ecosystems are sibling adapters registered by Product Assembly
  (`openbitfun-core/plugin_runtime`), not modes of this adapter.

## Verification

- `cargo test --locked -p openbitfun-dsh-adapter --lib session::tests`
- Real installed-history check: set `DSH_HOME` and `OPENBITFUN_TEST_DSH_SESSION`, then
  `cargo test --locked -p openbitfun-dsh-adapter --lib inspect_installed_dsh_session_read_only -- --ignored --nocapture`.

- `cargo test --locked -p openbitfun-dsh-adapter --lib mcp_source::tests`
- `cargo test --locked -p openbitfun-dsh-adapter --lib hook_source::tests`
- `cargo test --locked -p openbitfun-dsh-adapter --test dsh_source_adapter`
- `cargo test --locked -p openbitfun-core --no-default-features --features plugin-runtime --lib plugin_runtime::tests`
