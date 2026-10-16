# MiniApp desktop presentation

The desktop host owns one instance registry per product data directory. Acquire
its OS lease before initializing the Agent runtime. The separate
`src/apps/miniapp-shell` executable never links AppState or an Agent runtime.
A macOS launcher copies only that compact executable into its locally signed
bundle; Windows and Linux launch the installed sidecar with a persisted record.
The old Desktop launch flag delegates to the sidecar for existing shortcuts.
Missing sidecars fail explicitly; never copy the full host as a fallback.

Keep identity, lease, and transfer rules in the MiniApp contracts/services owners.
This directory owns native launchers, icon conversion, the closed local IPC
adapter and Desktop command wiring. Shared v1 wire/record mechanics belong to
`adapters/miniapp-ipc`; shell presentation belongs to `apps/miniapp-shell`. IPC uses a private Unix
socket or named pipe with bounded frames and per-host credentials. Never expose
arbitrary Tauri invocation or arbitrary JS evaluation to MiniApps. Shell SDK
dispatch binds app/workspace identity from the authenticated view lease.

The main window observes revisioned snapshots and uses the existing sceneStore.
MiniApp chrome is portable metadata, not a launch-record field or executable
host markup. Bootstrap exposes the optional chrome capability and resolves
shared window labels for older/newer Shells. Application actions emit view-bound
content events; do not enable the reserved semantic content-control adapter.
Main-app actions register by `miniapp:<appId>` in SceneChrome, including split
panes; do not restore a duplicate embedded header.
Installed catalog cards offer tab and independent-window launch before startup;
running state stays on the matching card, without a separate instance bar.
System installation status and removal inspect the OS entries against persisted
launch identities. Uninstall never removes app data, runtime bundles or leases,
never follows symlink entries, and must tolerate already-removed exports.
Native launch requests carry the same optional catalog SVG as installation;
older requests remain valid. macOS ICNS owns its rounded, transparent-inset
layout, independently of shared PNG/ICO assets. Migrate old ICNS from the saved
full-canvas PNG so the existing glyph/watermark survive, and include the icon
hash in bundle rebuild decisions. Never solve a Dock issue by clearing global
system icon caches or changing the user's Dock pins.
Transfers prepare a target, acknowledge its ready state, then release the source.
The first version explicitly reopens the document: arbitrary unsaved DOM/JS
state is not migrated. Closing the last primary or pending view stops the app's
Worker, Agent runs and streams. A transfer source's late close cannot stop its
destination. The host serializes last-view shutdown against new presentations
and drains accepted shell starts; tabs drain their accepted starts before detach.
Keep the tab ticket until scene removal commits, and fence late snapshots with
the detach response revision so a closing scene cannot recreate its own tab.
Content action contracts are reserved and their advertised capability list is
empty. Remote workspace, Peer, mobile, and detached hosts do not acquire local
presentation as a silent fallback.

Focused checks (no browser/computer-use validation):

For custom chrome, also run `pnpm --dir src/web-ui run test:run src/app/scenes/miniapps/MiniAppScene.chrome.test.tsx src/app/scenes/miniapps/components/MiniAppTitlebar.test.tsx src/app/scenes/miniapps/components/MiniAppShell.test.ts`
and `cargo test --locked -p openbitfun-desktop --lib openbitfun_control_host::miniapps::tests`.


```bash
cargo test --locked -p openbitfun-desktop --lib miniapp_desktop
cargo test --locked -p openbitfun-desktop --lib remote_workspace_policy
cargo build -p openbitfun-desktop
pnpm --dir src/web-ui run test:run src/app/scenes/miniapps/miniAppPresentationStore.test.ts src/app/scenes/miniapps/miniAppLifecycle.test.ts src/app/scenes/miniapps/components/MiniAppRunner.test.tsx src/app/scenes/miniapps/hooks/useMiniAppBridge.test.tsx
pnpm --dir src/web-ui run test:run src/infrastructure/api/service-api/MiniAppPresentationAPI.test.ts
pnpm --dir src/web-ui run test:run src/app/scenes/miniapps/hooks/useMiniAppLaunch.test.tsx src/app/scenes/miniapps/components/MiniAppLibraryRow.test.tsx src/app/scenes/miniapps/components/MiniAppCard.presentation.test.ts
pnpm --dir src/web-ui run test:run src/app/scenes/miniapps/components/MiniAppSystemAppActions.test.tsx
pnpm --dir src/web-ui run test:run src/app/scenes/miniapps/MiniAppPresence.test.tsx
```

Native bundle fixture tests must write only to their temporary directory and
must not launch UI. macOS fixture evidence does not prove Windows taskbar or
Linux compositor behavior; report which platform was actually exercised.

Native shell heartbeats and the main native container renew committed views even
when WebView timers are suspended. Pending targets still expire without a ready
acknowledgement. Agent permissions use the existing runtime permission mailbox;
shell content cannot call its response adapter. Managed views reject the legacy
`agent.cancelStaleRuns` reload cleanup: explicit Stop or per-turn cancellation is
required so opening a new presentation cannot silently cancel accepted work.
