# OpenBitFun Installer

A fully custom, branded installer for OpenBitFun — built with **Tauri 2 + React** for maximum UI flexibility.

## Why a Custom Installer?

Instead of relying on the generic NSIS wizard UI from Tauri's built-in bundler, this project provides:

- **100% custom UI** — React-based, with smooth animations, dark theme, and brand consistency
- **Modern experience** — Similar to Discord and VS Code installers
- **Full control** — Custom installation logic, right-click context menu, PATH integration
- **Cross-platform potential** — Same codebase can target Windows, macOS, and Linux

## Legacy data migration

Data Migrator is distributed separately and is not included in this installer.
To import legacy data, download and run the [standalone Data Migrator](../src/apps/data-tools/README.md) after closing both applications.

## Common tasks

Requires Node.js 22.12+ and pnpm 10.15.0, matching the workspace baseline.

### Install dependencies

```bash
pnpm install
```

Production installer builds call workspace desktop build scripts, so root dependencies are required.

### Run in dev mode

```bash
pnpm run tauri:dev
```

### Build the full installer

```bash
pnpm run installer:build
```

Use this as the release entrypoint. `pnpm run tauri:build` does not prepare validated payload assets for production.

### Build installer only

```bash
pnpm run installer:build:only
```

`installer:build:only` requires an existing `target/release/openbitfun-desktop.exe`
and its adjacent runtime directories. It never falls back to `release-fast` or
`debug`. For an explicit Cargo target, pass the exact executable:

```powershell
$env:OPENBITFUN_INSTALLER_APP_EXE = "target/x86_64-pc-windows-msvc/release/openbitfun-desktop.exe"
pnpm run installer:build:only
```

## Architecture

```
OpenBitFun-Installer/
├── src-tauri/                 # Tauri / Rust backend
│   ├── src/
│   │   ├── main.rs            # Entry point
│   │   ├── lib.rs             # Tauri app setup
│   │   └── installer/
│   │       ├── commands.rs    # Tauri IPC commands
│   │       ├── extract.rs     # Archive extraction
│   │       ├── registry.rs    # Windows registry (uninstall, context menu, PATH)
│   │       ├── shortcut.rs    # Desktop & Start Menu shortcuts
│   │       └── types.rs       # Shared types
│   ├── capabilities/
│   ├── icons/
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/                       # React frontend
│   ├── pages/
│   │   ├── LanguageSelect.tsx # First screen language picker
│   │   ├── Options.tsx        # Path picker + install options
│   │   ├── Progress.tsx       # Install progress + confirm
│   │   ├── ModelSetup.tsx     # Optional model provider setup
│   │   └── ThemeSetup.tsx     # Theme preview + finish
│   ├── components/
│   │   ├── BrandMark.tsx     # Canonical fine-line brand artwork
│   │   ├── StepIndicator.tsx # Read-only setup stages
│   │   ├── WindowControls.tsx # Custom titlebar
│   │   └── ProgressBar.tsx    # Accessible installation progress
│   ├── hooks/
│   │   └── useInstaller.ts    # Core installer state machine
│   ├── styles/
│   │   ├── global.css         # Base styles consuming canonical tokens
│   │   └── animations.css     # Keyframe animations
│   ├── theme/                 # Canonical theme projection + installer presets
│   ├── types/
│   │   └── installer.ts       # TypeScript types
│   ├── App.tsx
│   └── main.tsx
├── scripts/
│   └── build-installer.cjs    # End-to-end build script
├── index.html
├── package.json
├── vite.config.ts
└── tsconfig.json
```

## Installation flow

```
Language Select → Options → Progress → Model Setup → Theme Setup
       │             │          │            │              │
   choose UI      path +     run real    optional AI     save theme,
    language      options    install      model config    launch/close
```

## Development

### Prerequisites

- Node.js 22.12+
- Rust (latest stable)
- pnpm 10.15.0 via Corepack

### Setup

```bash
pnpm install
```

### Repository Hygiene

Keep generated artifacts out of commits. This project ignores:

- `node_modules/`
- `dist/`
- `src-tauri/target/`
- `src-tauri/payload/`

### Dev Mode

Run the installer in development mode with hot reload:

```bash
pnpm run tauri:dev
```

### Native UI preview

Run `pnpm run tauri:preview` to open the actual installer window with `--preview`.
The titlebar page selector opens each existing UI page without running an
installation. Theme and form changes stay in memory; Finish only closes the
preview. No simulated progress or installation result is generated.

The native invoke boundary permits only launch context, the default path,
existing-installation detection, disk-space reads, and closing the window. All
other installer commands are rejected, including path validation (which writes
a probe file), installation, uninstallation, app launches, configuration writes,
and model requests. Launch context also skips configuration-directory creation.
This restriction is enforced by the native process even if the UI is modified.

### Uninstall Mode (Dev + Runtime)

Key behavior:

- Install phase creates `uninstall.exe` in the install directory.
- Windows uninstall registry entry points to `"<installPath>\\uninstall.exe" --uninstall "<installPath>"`.
- Launching with `--uninstall` opens the dedicated uninstall UI flow.
- Launching `uninstall.exe` directly also enters uninstall mode automatically.

Local debug command:

```bash
npx tauri dev -- -- --uninstall "D:\\tmp\\example-install-dir"
```

Core implementation:

- Launch arg parsing + uninstall execution: [commands.rs](src-tauri/src/installer/commands.rs)
- Uninstall registry command: [registry.rs](src-tauri/src/installer/registry.rs)
- Uninstall UI page: [Uninstall.tsx](src/pages/Uninstall.tsx)
- Frontend mode switching and state: [useInstaller.ts](src/hooks/useInstaller.ts)

## Build

### Full release build

```bash
pnpm run installer:build
```

Release artifacts embed payload files into the installer binary, so runtime installation does not depend on an external `payload` folder.

### Full fast build

```bash
pnpm run installer:build:fast
```

### Installer-only build

```bash
pnpm run installer:build:only
```

If any required desktop runtime file is missing, or payload validation fails,
the build exits with an error. The installer verifies every manifest file's
size and SHA-256 after extraction before registering the installation.

### Installer-only fast build

```bash
pnpm run installer:build:only:fast
```

### Output

Default release output:

```text
src-tauri/target/release/openbitfun-installer.exe
```

Fast build output:

```text
src-tauri/target/release-fast/openbitfun-installer.exe
```

## Customization guide

### Changing the UI Theme

Shared light/dark values come from `@openbitfun/theme-openbitfun`. Installer-only named presets live in
[installerThemesData.ts](src/theme/installerThemesData.ts), and components consume only canonical
`--openbitfun-*` variables projected by [installerThemeRuntime.ts](src/theme/installerThemeRuntime.ts).

Buttons, inputs, fields, selectors, checkboxes, radio controls, page headers, and
native scrollbar styling come from the public `@openbitfun/ui` package. The
installer owns page layout and the install state binding. The `dev`, `build`, and
`type-check` entrypoints prepare the public design-system packages first, so a
clean checkout does not depend on pre-existing `dist` files.

The titlebar uses the application icon. Welcome and progress surfaces use the
canonical fine-line SVG from `assets/brand/source`. CSS masks follow the active
theme's foreground, including explicit theme choices that differ from the OS
setting. Theme choices use public radio controls with names and small color
palettes, without logos or framed thumbnails. The full installer window updates
on selection and serves as the live theme preview.

Page hierarchy uses spacing and typography. Existing-installation detection is
a short disclosure; version, location, and the uninstaller action stay inside
its details. Model endpoint and protocol fields are grouped in an advanced
disclosure, initially open for custom providers. Motion respects the system's
reduced-motion preference.

### Adding Install Steps

1. Add a new step key to `InstallStep` in [installer.ts](src/types/installer.ts)
2. Create a new page component in [src/pages](src/pages)
3. Add the step to the `STEPS` array in [useInstaller.ts](src/hooks/useInstaller.ts)
4. Add the page render case in [App.tsx](src/App.tsx)

### Modifying Install Logic

- **File extraction** → [extract.rs](src-tauri/src/installer/extract.rs)
- **Registry operations** → [registry.rs](src-tauri/src/installer/registry.rs)
- **Shortcuts** → [shortcut.rs](src-tauri/src/installer/shortcut.rs)
- **Tauri commands** → [commands.rs](src-tauri/src/installer/commands.rs)

### Adding Installer Payload

Place the built OpenBitFun application files in `src-tauri/payload/` before building the installer. The build script handles this automatically.
During `cargo build`, the payload directory is packed into an embedded zip inside `openbitfun-installer.exe`.

## Integration with CI/CD

Add to your GitHub Actions workflow:

```yaml
- uses: actions/checkout@v5
- name: Setup pnpm
  uses: pnpm/action-setup@v5
  with:
    version: 10.15.0
- name: Setup Node.js
  uses: actions/setup-node@v5
  with:
    node-version: '22'
    cache: pnpm

- name: Build Installer
  run: |
    cd OpenBitFun-Installer
    pnpm install
    pnpm run installer:build:only

- name: Upload Installer
  uses: actions/upload-artifact@v6
  with:
    name: OpenBitFun-Installer-Exe
    path: OpenBitFun-Installer/src-tauri/target/release/openbitfun-installer.exe
```
