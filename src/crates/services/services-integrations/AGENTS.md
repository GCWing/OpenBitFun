# services-integrations Agent Guide

Scope: this guide applies to `src/crates/services/services-integrations`.

`openbitfun-services-integrations` owns reviewed integration contracts and runtime
slices that are outside pure product logic but still platform-neutral.

## Guardrails

- Do not depend on `openbitfun-core`, app crates, desktop adapters, CLI UI, or web
  presentation code.
- Keep integration families behind explicit features. The default feature set
  should not compile heavy Git, MCP, SSH, network, or file-watch runtimes.
  Boundary checks enforce `default = []` and the current `product-full`
  integration feature-group list.
- MCP config/process/transport lifecycle, server runtime state
  (registry/connection pool/catalog/reconnect/runtime-only config), lifecycle
  policy, OAuth credential storage/authorization bootstrap, the concrete RMCP
  dependency, and protocol result-content rendering live here. Core may keep
  compatibility exports plus product callback/session/reconnect orchestration,
  but must not reintroduce a direct RMCP dependency. MCP wire types may be
  projected into execution-owned tool bridge descriptors. Product tool registry
  assembly, manifest filtering, `GetToolSpec` execution, and bridge
  presentation/validation behavior remain outside this crate unless a reviewed
  owner move proves behavior equivalence.
- Remote-connect platform-neutral primitives belong here: device identity,
  account device encryption, authenticated device invitation generation, relay client protocol, dialog/cancel
  orchestration ports, LAN endpoint helpers, IM bot provider clients,
  provider-private cursor caches, mobile-web relay upload, image-context adapter
  contracts, remote workspace helpers, and command/response assembly.
- `remote_connect::host_stream` is the host-side owner of on-demand session,
  terminal and catalog streams: an in-memory, byte-bounded per-stream log with
  an epoch, `read_stream`/`unsubscribe_stream` handling, and `HostStreamNotifier`
  hint leases. `remote_connect::host_stream_subscriber` is the Rust controller
  reader. Neither the relay nor any client persists stream content; do not add
  relay-stored history, `get_session_key`, or a durable stream cache here.
- The `remote-persistence` feature is the lightweight persisted-shape owner shared
  by Remote Connect, remote SSH, and offline migration. Keep it free of network,
  SSH transport, and runtime orchestration dependencies so owner readers and
  writers can validate staged data without enabling those heavier families.
- `remote_connect::file_projection` performs bounded output reads through the
  session-selected `WorkspaceFileSystem`; `remote-connect` therefore selects
  `runtime-ports/workspace-ports` without enabling an SSH implementation. Core
  supplies the session root and provider. IM adapters consume authorized bytes
  and must not re-resolve paths on the bot host.
- Remote workspace facts, session metadata, file projection DTOs, and
  workspace/projection host traits belong in `openbitfun-runtime-ports`.
- Workspace-root source selection, persistence/workspace service reads,
  concrete scheduler/session restore, terminal pre-warm adapters, and product
  execution remain core-owned unless a reviewed port/provider moves them with
  equivalence tests.
- Remote-SSH registries, disabled surfaces, SSH channels, SFTP, remote FS,
  remote workspace FS/shell providers, remote terminal, remote ExecCommand
  runtime-port adapter, and manager assembly live here behind explicit remote
  SSH features. Stable workspace path/session identity is owned by
  `services-core::workspace_identity`; `remote_ssh::paths` is only its legacy
  compatibility re-export and must not regain transport-independent logic.
- Retained developer Relay deployment tooling (`remote_ssh/relay_deploy.rs`) stages embedded
  scripts under `~/.openbitfun/relay-deploy/` and clones source to
  `~/.openbitfun/relay-src/` (never `$HOME/openbitfun`). Embeds
  `src/apps/relay-server/mirror.sh` and runs `openbitfun_mirror_init` before apt /
  Docker install / GitHub sync so mainland China hosts use configured mirrors.
  Operator guide: `src/apps/relay-server/README.md`. The product wizard is retired. Desktop Tauri
  wrapper: `src/apps/desktop/src/api/relay_deploy_api.rs`.
- Workspace search owns the local flashgrep daemon/session lifecycle and
  indexed-search result conversion behind `workspace-search`; product config
  and workspace bootstrap stay in the core facade as injected hooks. The daemon
  returns match positions only, so content output uses
  `search/grouped_line_matches` and hydrates line text from disk in
  `workspace_search/line_hydration.rs`; the preview primitives it shares with
  the ripgrep path live in `openbitfun-services-core::filesystem::content_preview`.
- Remote SSH workspace-search owns the disabled surface, path/scope/probe,
  bundle/retry strategy, and flashgrep session/context lifecycle behind a
  provider boundary.
- Browser-control owns provider-neutral browser detection, CDP endpoint HTTP
  probing/page creation, and CDP launch process handling behind
  `browser-control`; product profile paths and tool request/result types stay in higher
  layers.
- Web tool network providers own concrete HTTP/Exa requests behind `web-tools`;
  product validation, readable extraction, and tool result types stay in
  higher layers.
- Review-platform provider detection, repository discovery, token persistence,
  provider DTO mapping, pagination policy, HTTP transport, and Git provider
  integration live behind `review-platform`; core may only inject product data
  paths, remote-workspace classification, and compatibility API wrappers.
- MiniApp runtime here may own host primitive dispatch, built-in seed file
  writes, marker IO, storage/import bundle filesystem IO, and JS worker process/pool
  lifecycle. Manager workflow orchestration remains outside this crate until
  reviewed owner migration.
- Managed plugin source integration may own bounded package discovery,
  integrity checks, fixed package input reads, no-follow path handling,
  trust-file locking, and atomic persistence. Product path selection stays in
  assembly; ecosystem parsing and
  PluginRuntimeClient behavior stays in its adapter and execution modules.
- Script-tool runtime integration owns provider-neutral process supervision,
  bounded framing/output, script load/invoke/cancel/dispose, timeout, and worker
  health behind `script-tool-runtime`. It must not parse OpenCode source paths,
  decide approval/conflicts, register product tools, or claim OS sandboxing.
  Approved modules run in dedicated child processes separated from the Rust application process for
  failure containment, not as a security or protocol-authentication boundary.
  The shared `services-core::process_tree` boundary owns managed-descendant cleanup for
  script workers, local stdio MCP, and other managed service children: Unix uses a dedicated process group; Windows attaches a
  suspended child to a kill-on-close Job Object before resuming it and fails
  closed when attachment fails. This is lifecycle containment, not an OS
  sandbox or a CPU/memory/filesystem/network resource limit; surfaces must keep
  those residual risks explicit. Unix descendants that deliberately create a
  new session/process group are outside the managed boundary.
- Announcement remote fetch/cache lives here; product assembly supplies config
  values such as endpoint, locale, version, platform, and cache path.
- DeepResearch report IO here owns report/citation sidecar filesystem work;
  provider-neutral citation numbering stays in `openbitfun-agent-runtime`. The IO
  path must use the injected `WorkspaceFileSystem` for both local and remote
  workspaces; never probe or fall back to the host filesystem for a remote
  workspace path.

## Verification

Select one integration family and its minimum feature set. Remote SSH uses a
grouped target for tests within the same boundary; use
`--test <target> <module>::<filter>` for a single source module instead of
creating another Cargo target. Real transport/system boundaries such as MCP
streamable HTTP stay independent. Representative stable entry points are:

```bash
cargo check -p openbitfun-services-integrations --no-default-features
cargo test -p openbitfun-services-integrations --no-default-features --features remote-persistence --lib remote_persistence::tests::
cargo test -p openbitfun-services-integrations --no-default-features --features mcp --test mcp_contracts
cargo test -p openbitfun-services-integrations --no-default-features --features mcp --test mcp_streamable_http_contracts
cargo test -p openbitfun-services-integrations --no-default-features --features remote-ssh --test remote_ssh_contracts remote_ssh_disabled_contracts::
cargo test -p openbitfun-services-integrations --no-default-features --features remote-ssh-concrete --lib remote_ssh::manager::tests::workspace_
cargo test -p openbitfun-services-integrations --no-default-features --features remote-ssh-concrete --lib remote_ssh::wsl::tests::
cargo test --locked -p openbitfun-services-integrations --no-default-features --features remote-ssh-concrete --lib remote_ssh::relay_deploy::tests::
cargo test --locked -p openbitfun-services-integrations --no-default-features --features remote-connect --lib remote_connect::relay_client::tests::
cargo test --locked -p openbitfun-services-integrations --no-default-features --features remote-connect --lib remote_connect::host_stream::tests::
cargo test --locked -p openbitfun-services-integrations --no-default-features --features remote-connect --lib remote_connect::host_stream_subscriber::tests::
cargo test -p openbitfun-services-integrations --no-default-features --features file-watch --test file_watch_contracts
cargo test --locked -p openbitfun-services-integrations --no-default-features --features workspace-search --test workspace_search_contracts
cargo test --locked -p openbitfun-services-integrations --no-default-features --features deep-research --lib deep_research::tests::
cargo test --locked -p openbitfun-services-integrations --no-default-features --features review-platform --lib review_platform
pnpm run check:core-boundaries
```

Other family-specific targets remain in `Cargo.toml`; add a guide command only
for a recurring workflow, not to mirror every test target.

For persistent public marketplace image caching (restart/offline reuse, URL
boundaries, and bounded disk storage), run:

```bash
cargo test --locked -p openbitfun-services-integrations --no-default-features --features miniapp-market --lib market_image::tests
```

On Windows with an initialized WSL distribution, set `OPENBITFUN_TEST_WSL_DISTRO`
and run `cargo test -p openbitfun-services-integrations --no-default-features
--features remote-ssh-concrete --lib wsl_windows_workspace_transport -- --ignored`
for binary filesystem/stdio, exit status, cancellation, and saved reconnect.

For SFTP handle ownership and cancellation regressions, run
`cargo test --locked -p openbitfun-services-integrations --no-default-features
--features remote-ssh-concrete --lib
remote_ssh::manager::tests::workspace_sftp::`. These loopback SSH/SFTP tests
advertise a small handle limit and are included in the existing CI
`workspace_` filter. To exercise real OpenSSH file IO over loopback SSH, set
`OPENBITFUN_TEST_SFTP_SERVER` to an installed `sftp-server` executable and run
the same command with the filter ending in
`workspace_sftp::openssh_real_files_over_loopback_ssh -- --ignored`.

For the remote Flashgrep distribution gate and retained protocol helpers, use:

```bash
cargo test --locked -p openbitfun-services-integrations --no-default-features --features remote-ssh,workspace-search --lib remote_ssh::workspace_search::service::tests::
```
