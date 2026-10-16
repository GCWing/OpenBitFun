# Lightweight MiniApp Shell

The standalone native window hosts shell.html and isolated MiniApp content. It
connects to the existing Desktop host through miniapp-ipc; Agent execution,
storage, permissions, tasks and instance authority remain in that host. Do not
depend on Desktop, Core, Agent Runtime or services-integrations, including
transitive dependencies. System APIs are limited to the existing authorized
window/dialog/notification/opener adapters.

Build this package in a separate Cargo invocation with the miniapp-shell profile.
Desktop feature unification or debug builds must never inflate exported apps.
The preparation script stages the executable for both raw builds and Tauri's
externalBin and enforces a 16 MiB per-architecture artifact regression budget.
macOS exported bundles copy this executable, not the Desktop host;
Windows/Linux shortcuts point to the installed sidecar. No fallback copies the
host when a sidecar is missing. The original v1 manifest remains compatible.

Window chrome is declared by each MiniApp's optional `chrome.titlebar` metadata.
Use the renderer and generated Lucide catalog in `src/shared/miniapp-chrome` for
both native windows and draft previews. Window controls remain host-owned and
usable on content/IPC failure. Keep the return action disabled until the content view is ready,
and acquire its transfer guard before awaiting IPC. Native close must not wait
indefinitely for a disconnected host. The v1 IPC bootstrap advertises
`miniapp_custom_chrome_v1`; older hosts use the default custom titlebar.
macOS keeps native decorations with an overlay titlebar and actual AppKit traffic
lights, using the main app's token-based inset and minimum row height. Windows
reuses `src/shared/miniapp-chrome/window-controls.css` with the main application.
Legacy `controlsPosition` is round-trip data, never authority to move system
buttons. Do not draw imitation macOS controls or overlay manual resize regions
on the native macOS window. Native titlebar double-click follows system preferences.

The HTML is the same shell used before extraction. Do not copy the Web UI,
catalog, backend, or product resources into this package. Keep native heartbeats,
permissions, transfer acknowledgements and host-bound identity unchanged.

`miniapp-chat.js` is a Shell-local presentation module; the main window's Hi
Dock is independent. Only an authorized `chat.claimComposer` reveals the launcher.
Keep submissions on `chat:userMessage`/`chat.completeUserMessage`, including apps
that create their session after the first message. Bind only app-owned sessions,
fence stale topic snapshots and duplicate Runtime events by their cursor, and
restore through the host's optional `miniapp_chat_snapshot_v1` capability. Older
hosts retain live SDK input with an explicit history limitation. Collapse and
release never cancel accepted work; Stop targets a specific Agent turn. Chat copy
is page-scoped in `chat-labels.json`, and colors use the generated token projection.

Chat visuals are built from the actual Hi and FlowChat style owners through
`styles/chat.js`: FloatingMiniChat, LauncherButton, ChatComposer, IconButton and
FlowChat message styles. `styles/chat-layout.scss` only adapts native DOM/layout;
do not reintroduce a separate chat palette or bubble/composer skin. The generator
emits CSS and static CSS-module class maps, without React or Web UI runtime code.
`prepare:miniapp-shell` regenerates both styles and their token projection before
Cargo builds. Keep the generated files committed for direct Cargo builds, and
verify drift whenever a shared style owner changes.

Always enable Tauri's `custom-protocol`, including optimized shells launched by
a development host. The shell never uses a dev server. Without this feature,
Tauri replaces the macOS bundle's MiniApp Dock icon with the compile-time host
icon on Ready; a window icon cannot correct that. macOS launches must use the
per-app bundle and its ICNS. The headless diagnostic must report
`tauriDevMode: false`.

Focused verification (no computer-use/browser verification):

```bash
node scripts/generate-miniapp-chrome-theme.mjs --check
node scripts/generate-miniapp-chat-styles.mjs --check
node --test scripts/generate-miniapp-chat-styles.test.mjs
pnpm --dir src/web-ui run icons:check
pnpm --dir src/web-ui run test:run src/app/scenes/miniapps/components/MiniAppShell.test.ts src/app/scenes/miniapps/components/MiniAppTitlebar.test.tsx
pnpm --dir src/web-ui run test:run src/app/scenes/miniapps/components/MiniAppShellChat.test.ts
cargo test --locked -p openbitfun-miniapp-shell --profile miniapp-shell --bin openbitfun-miniapp-shell window_chrome
pnpm run prepare:miniapp-shell
target/debug/openbitfun-miniapp-shell --miniapp-shell-info
node --test scripts/prepare-miniapp-shell.test.mjs
cargo test --locked -p openbitfun-miniapp-ipc
cargo test --locked -p openbitfun-desktop --lib miniapp_desktop
cargo build --locked -p openbitfun-desktop
```

Native artifact size and signature checks must use built files and temporary
bundles, without starting a GUI. Report the actual measured platform; macOS
evidence does not establish Windows/Linux native behavior.

After preparing a macOS shell, exercise the real temporary export and headless
diagnostic with:

```bash
OPENBITFUN_MINIAPP_SHELL_TEST_BINARY="$PWD/target/miniapp-shell/openbitfun-miniapp-shell" cargo test --locked -p openbitfun-desktop --lib miniapp_desktop::launcher::tests::macos_real_shell_export_is_compact_and_runs_headless_diagnostics -- --ignored
```
