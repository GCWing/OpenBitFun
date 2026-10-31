# Desktop Computer Use wiring

Native OS implementation and focused provider tests live in
[the shared service](../../../../crates/services/computer-use/AGENTS.md).
This directory only re-exports that provider for existing Desktop APIs and owns
the devtools-only full Core Tool integration fixtures. Keep Tauri projection in
the app; do not reintroduce a separate native implementation here.

```bash
cargo check --locked -p openbitfun-desktop --tests
node scripts/test-macos-control-roundtrip.mjs
node scripts/test-macos-computer-use-self.mjs
```

The strict fixtures use disposable windows and retain the shared service guide's
permission, foreground-preservation and no-replay requirements.
