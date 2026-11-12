# OpenBitFun updater adapter

Source: the published `tauri-plugin-updater` 2.10.1 crate from
<https://crates.io/crates/tauri-plugin-updater/2.10.1>, licensed MIT / Apache-2.0.
The repository patch in the workspace Cargo manifest selects this copy. It
remains a third-party platform adapter, outside the product crate layers.

Changes:

- Bound stalled network reads without imposing a total download deadline.
- Windows: start an unelevated supervisor, authorize maintenance only after its
  readiness event, wait for the old process handle, retain an installation
  receipt, report post-exit failure, and restart with the original user's token
  and arguments. The standalone installer's native maintenance protocol owns
  file rollback and integration recovery. Legacy NSIS packages receive the
  actual current installation directory.
- macOS: stage beside the app when writable; authorize a same-volume copy when
  required; restore the previous bundle after a failed publication, retaining
  the backup if restoration fails. Main-thread dispatch errors return normally.
- Linux AppImage: validate the staged executable before atomic rename; never
  move away the running executable before extraction succeeds. Package-manager
  cancellation does not reopen another authorization prompt or fall back to
  an invisible terminal, and sudo output is drained while waiting.

The patch uses file locks stabilized in Rust 1.89. This is recorded in the
vendored manifest; package version and the upstream public API remain 2.10.1.

Focused checks from the repository root:

```sh
cargo test --locked -p tauri-plugin-updater --lib
node --test scripts/tauri-release-manifest.test.mjs scripts/updater-maintenance.test.mjs
cargo test --manifest-path OpenBitFun-Installer/src-tauri/Cargo.toml --lib
cargo test --locked -p openbitfun-desktop --no-default-features --lib api::update_api::tests
```

Run Linux AppImage/package-manager checks on Linux and macOS bundle checks on
macOS. Windows tests cannot validate those OS branches. UAC approval, alternate
administrator credentials and packaged GUI restart also need a Windows native
smoke test. Never use a developer's existing installation for destructive tests.

Remove this patch when an upstream version provides equivalent transactional
installation, readiness handoff, error receipts and bounded read behavior, and
the matching platform tests pass against that version. Keep the signed custom
installer selection until its maintenance protocol is replaced explicitly.
