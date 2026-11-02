# PI adapter

Own PI settings, package entry selection, and static extension event discovery.
Read TypeScript with the parser; never import an extension, install a package,
execute a command, or infer native trust from its location. Dynamic registrations
remain opaque; literal events remain native-only with unknown activation.
Keep registration in Product Assembly and use shared bounded filesystem helpers.

`session` reads Pi session JSONL v1-v3 without launching Pi or loading extensions.
It follows the last entry's parent chain, retains available pre-compaction history,
applies saved context edits, and correlates tool results by call ID. User messages
and extension/summary notes remain distinct; binary attachment payloads stay in Pi.
Discovery reads bounded file edges under the default agent sessions directory and
explicit absolute `PI_CODING_AGENT_SESSION_DIR` / global `sessionDir` roots.
Relative workspace-specific overrides are explicitly unsupported by global discovery.
Native persistence, following and continuation stay in Product Assembly/session owners.

Session verification: `cargo test -p openbitfun-pi-adapter --lib session::tests`.
For a real source, set `PI_CODING_AGENT_DIR` and optionally
`OPENBITFUN_TEST_PI_SESSION`, then run `cargo test -p openbitfun-pi-adapter --lib
inspect_installed_pi -- --ignored --nocapture`. The selected session checks the
two-turn local verification scenario; this command never writes source files.

Verification: `cargo test --locked -p openbitfun-pi-adapter --lib`
