[中文](AGENTS-CN.md) | **English**

# AGENTS.md

## Scope

This file applies to `OpenBitFun-Installer`. Use the top-level `AGENTS.md` for repository-wide rules.

## What matters here

`OpenBitFun-Installer` is a separate Tauri + React app, not part of the main Cargo workspace.

Important areas called out by the module README:

- `src-tauri/src/installer/commands.rs`: Tauri IPC and uninstall execution
- `src-tauri/src/installer/registry.rs`: Windows registry integration
- `src-tauri/src/installer/shortcut.rs`: shortcut creation
- `src-tauri/src/installer/extract.rs`: archive extraction
- `src/hooks/useInstaller.ts`: frontend installer state flow
- `src/i18n/`: installer-only strings; locale metadata is generated from
  `src/shared/i18n/contract/locales.json`

Install flow:

```text
Language Select → Options → Progress → Model Setup → Theme Setup
```

## Commands

These are command references, not the default precheck list. Use Verification
below for PR scope.

```bash
pnpm --dir OpenBitFun-Installer run installer:dev
pnpm --dir OpenBitFun-Installer run tauri:dev
pnpm --dir OpenBitFun-Installer run tauri:preview    # native UI only; no installation
pnpm --dir OpenBitFun-Installer run type-check
pnpm --dir OpenBitFun-Installer run build            # React build / CI reproduction
pnpm --dir OpenBitFun-Installer run installer:build  # packaging only
```

## Verification

Use the smallest matching check:

```bash
pnpm run i18n:audit                                                   # resource-only i18n
pnpm run i18n:generate && pnpm run i18n:contract:test && pnpm run i18n:audit
pnpm --dir OpenBitFun-Installer run type-check                            # frontend i18n/runtime
pnpm --dir OpenBitFun-Installer run test                                  # frontend control interactions
cargo check --manifest-path OpenBitFun-Installer/src-tauri/Cargo.toml      # Tauri/Rust changes
```

For the native `--preview` command boundary, use the focused policy tests:

```bash
cargo test --manifest-path OpenBitFun-Installer/src-tauri/Cargo.toml --lib preview::tests
```

For installer payload validation and the independent Data Migrator boundary, run:

```bash
node --test OpenBitFun-Installer/scripts/build-installer.test.cjs scripts/data-tools-tauri-build.test.mjs
cargo test --manifest-path OpenBitFun-Installer/src-tauri/Cargo.toml --lib installer::commands::tests
```

Run the full installer build only for packaging, payload, native bundling,
install/uninstall flow, registry, shortcut, or extraction changes:

```bash
pnpm --dir OpenBitFun-Installer run type-check && pnpm --dir OpenBitFun-Installer run installer:build
```

If you modify uninstall flow, also validate the uninstall mode entry points described in `OpenBitFun-Installer/README.md`.
