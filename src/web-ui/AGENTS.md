[中文](AGENTS-CN.md) | **English**

# AGENTS.md

## Scope

This file applies to `src/web-ui`. Use the top-level `AGENTS.md` for repository-wide rules.

## What matters here

`src/web-ui` is the shared frontend for:

- Tauri desktop
- server/web via WebSocket / Fetch adapters

Most changes start in:

- `src/infrastructure/`: adapters, i18n, theme, providers, config
- `src/infrastructure/peer-device/`: Peer Device Mode transport switch + host-invoke bridge
- `src/app/`: shell layout and top-level composition
- `src/flow_chat/`: chat flow UI and state
- `src/tools/`: editor, terminal, git, workspace, file explorer
- `src/shared/`: shared services, stores, helpers, types
- `src/locales/`: localized strings

Peer Device Mode (same-account remote full client) is documented in
`docs/architecture/peer-device-mode.md`. Frontend invariants:
`src/infrastructure/peer-device/README.md`. Do not reintroduce nested
sessions/chat shells; enter peer mode from the device list (Remote Connect →
My OpenBitFun) instead.

Remote Connect uses the global GitHub account and the official versioned Relay.
Account controls use the shared account-identity service; do not expose a separate
Relay account, custom server field, or self-hosted deployment entry. SSH and Docker
workspace connections remain independent of Relay sign-in.

## Local rules

- Do not call Tauri APIs directly from UI components; go through the adapter / infrastructure layer
- Reuse `@openbitfun/ui`, design tokens, theme, i18n, and Zustand stores before adding new frontend primitives
- Floating UI uses `Portal` / `createOverlayPortal` from `@openbitfun/ui`, never raw React portals or category z-index overrides. Declare `ownerRef` for sibling/coordinate child surfaces, pass `open` during retained exits, and use `useDismissibleLayer` or `subscribeOverlayInteraction` for shared event ownership. Notification stacks use neutral `OverlayRegion` layout with independently ranked cards.
- Menu and Listbox own row spacing through `overlay.menu.rowGap`. Use `MenuList` for menu rows inside custom scroll/animation wrappers, rather than local item margins or private list-gap overrides. Check menu composition changes with `pnpm --dir src/web-ui run test:run src/shared/ui/MenuComposition.contract.test.ts`.
- Prefer the design system's `OverflowText` for single-line labels over local ellipsis rules or sliced strings. Plain text defaults to fade plus hover/focus marquee; set `behavior="marquee"` for text-only highlights and keep icons/actions outside. Put `data-overflow-trigger` on the owning control; standard component label slots already provide overflow handling. Keep multiline, touch-first, and editable content in their appropriate layout.
- Theme and color-token changes must follow
  `docs/architecture/theme-token-optimization.md`: failing audits should be
  fixed by reusing tokens, merging redundant values, or adding a scoped owner
  contract. Do not raise baseline or test expectation counts just to make a
  theme audit pass. Use `pnpm run theme:color-audit:all` for changes that touch
  theme tokens, CSS variables, color literals, widget payloads, mobile,
  installer, or CLI/TUI color projection.
- Keep locale metadata in the generated i18n contract files. Edit
  `src/shared/i18n/contract/locales.json`, run `pnpm run i18n:generate`, and
  keep Web UI strings under `src/web-ui/src/locales`.
- Use `useI18n(namespace)` for route or feature copy so non-bootstrap
  namespaces stay lazy. Direct `i18nService.t(...)` calls require bootstrap
  namespace coverage.
- Follow `src/web-ui/LOGGING.md`: English only, no emojis, structured logs

## CSS invalidation in dynamic views

- For component-owned sibling styles in frequently changing DOM, prefer dedicated classes over tag-only or universal sibling selectors. CSS Modules and an ancestor scope do not isolate browser invalidation work.
- Use flex/grid `gap` when the existing layout and spacing semantics permit it. Do not mechanically replace same-tag adjacency with `:not(:first-child)` or change layout mode.
- Generated content may retain semantic tag selectors. For measured hotspots, add renderer-owned classes; `:where(.owned-class)` can narrow a compound selector without increasing specificity. Preserve raw HTML, nested lists, mixed table cells, and math rendering behavior.
- Check matching and cascade equivalence when rewriting selectors. Use short Selector Stats captures to identify invalidation causes and ordinary traces to measure speedups; invalidation counts alone do not establish user-visible gains. Do not impose a blanket ban on sibling selectors.

## Commands

Keep development/build entry points here. Verification commands are maintained
only in the section below.

```bash
pnpm --dir src/web-ui dev
pnpm run build:web                     # build-impacting changes / CI reproduction
```

`pnpm run build:web` runs type-check and Vite concurrently; either error may
appear first and their output uses `[type-check]` / `[vite-build]` prefixes.
Set `VITE_USE_POLLING=1` only when native file events miss changes, typically on
a network drive or WSL mount.

## Verification

For icon changes, also run `pnpm --dir src/web-ui run icons:check` and the focused
`src/infrastructure/design-system/IconUsageIntegration.test.tsx` and
`src/app/startup/startupPreload.test.ts` tests. Static startup chrome and native
form decorations are generated from Lucide by `pnpm --dir src/web-ui run icons:generate`.
General-purpose icons use Lucide; the four harness modes, Git branch, brand logos,
mascots, and device overview artwork retain their authored assets.

Choose the smallest matching check:

```bash
pnpm run i18n:audit
pnpm run i18n:generate && pnpm run i18n:contract:test && pnpm run i18n:audit
pnpm run type-check:web && pnpm --dir src/web-ui run test:run src/infrastructure/i18n/core/I18nService.test.ts
pnpm run motion:audit
pnpm run check:web
```

Use the first line for resource-only locale changes, the second for
contract/shared-term changes, the third for i18n runtime/namespace-loading
changes, the fourth for presentation or interaction-motion changes, and the
fifth for ordinary Web UI code. `check:web` runs type-check plus the same
Appearance contract, theme color, and theme visual governance gates used by CI,
so rendered DOM or styling regressions are caught locally. The motion audit is
an intent-review inventory, not a pass/fail gate; do not mechanically replace
deliberate layout transitions or animate virtualized content. Rely on CI for
full lint, build, and broad test coverage unless the local change specifically
needs it.

For navigation-divider dragging, elastic feedback, cancellation, and keyboard resizing:

```bash
pnpm --dir src/web-ui run test:run src/app/layout/useNavResize.test.tsx src/app/layout/WorkspaceBody.presentation.test.ts
```

These local DOM fixtures cover gesture state and spring settling, not native
WebView rendering or live remote scenarios.

For project creation entry points, work-location/environment selection, and local / SSH / WSL / Docker routing:

```bash
pnpm --dir src/web-ui run test:run src/app/components/NewProjectDialog/NewProjectDialog.test.tsx src/app/components/NavPanel/MainNav.projectCreation.test.tsx src/app/services/createProject.test.ts src/features/ssh-remote/SSHConnectionDialog.test.tsx
```

These fixtures cover location/environment combinations, source routing, connection configuration, cancellation and
device-switch fences; they do not establish live WSL, Docker or remote-host behavior.

For connection and authentication form size consistency, labels, source capsules,
host-scoped container discovery, capsule deselection, inherited-host configuration, independent editing/saving, saved-connection actions,
and remote browser keyboard/modal behavior:

```bash
pnpm --dir src/web-ui run test:run src/features/ssh-remote/SSHConnectionDialog.fields.test.tsx src/features/ssh-remote/SSHConnectionDialog.test.tsx src/features/ssh-remote/useWorkspaceSourceOptions.test.tsx src/features/ssh-remote/workspaceSourceError.test.ts src/features/ssh-remote/SSHRemoteProvider.test.tsx src/features/ssh-remote/SSHAuthPromptDialog.test.tsx src/features/ssh-remote/RemoteFileBrowser.test.tsx
```

The form composition fixtures use public UI components to catch default-size
drift and cover conditional settings, saved/new views, separate endpoint drafts,
credential-only retries, custom container values, search clearing, independent actions,
numeric bounds, and focus ownership; DOM assertions do not establish native
rendering or live connections.

For conversation selection and the floating annotation editor (placement,
dragging, resizing, draft retention, and nonmodal interaction):

```bash
pnpm --dir src/web-ui run test:run src/flow_chat/selection/FlowChatSelectionBar.test.tsx
```

These DOM fixtures do not establish native WebView rendering or live remote behavior.

For Hi-to-MiniApp image preparation, SDK inheritance, admission and peer compatibility:

```bash
pnpm --dir src/web-ui run test:run src/app/scenes/miniapps/miniAppComposerMessages.test.ts src/app/scenes/miniapps/miniAppBridgeImages.test.ts src/app/scenes/miniapps/hooks/useMiniAppBridge.test.tsx src/infrastructure/api/service-api/MiniAppAPI.test.ts src/flow_chat/utils/imagePayload.test.ts src/infrastructure/api/adapters/peer-device-adapter.test.ts
```

These tests exercise production JS with host/transport fixtures; they do not establish
live model, SSH workspace, Remote Control, Peer Device or Detached Dispatch behavior.

For Appearance descriptor changes, also exercise production registration; its ID
and property validation goes beyond the static DOM audit:

```bash
pnpm --dir src/web-ui run test:run src/infrastructure/appearance/registry/AppearanceRegistry.test.ts
```

For Session selection, presentation synchronization, and scene lifetime changes,
also run the focused state contracts:

```bash
pnpm --dir src/web-ui run test:run src/app/services/sessionSceneLifecycle.test.ts src/flow_chat/services/sessionActivation.test.ts src/flow_chat/services/storeSync.test.ts src/app/stores/sceneStore.test.ts
```

For composer mode restoration, passive synchronization, or explicit mode selection:

```bash
pnpm --dir src/web-ui run test:run src/flow_chat/hooks/useChatInputModeSync.test.tsx src/flow_chat/hooks/useSessionModeSelection.test.tsx src/flow_chat/utils/chatInputMode.test.ts
```

These state/hook fixtures cover delayed session loading and selected peer-surface
replacement; they do not establish native rendering or live remote behavior.

For cross-device undo/redo/rollback history invalidation and settled-Turn fences,
run `pnpm --dir src/web-ui run test:run src/flow_chat/services/flow-chat-manager/EventHandlerModule.test.ts`.
Missing fence identities (including legacy payloads) must reload authoritative
history; an explicit settled-Turn identity must preserve newer live Turns.

For text-entry guards, composer sanitization, or keyboard focus routing, run
`pnpm --dir src/web-ui run test:run src/shared/utils/textInputGuard.test.tsx src/flow_chat/components/RichTextInput.test.tsx src/flow_chat/hooks/useComposerDefaultFocus.test.tsx src/flow_chat/utils/chatInputKeyOwnership.test.ts`.
These cover DOM event ownership, controlled fields, IME and selection preservation;
they do not establish native OS keyboard or remote transport behavior.

For ecosystem discovery, import, or compatibility status presentation changes:

```bash
pnpm --dir src/web-ui run test:run src/app/scenes/ecosystem-compatibility
```

For followed external session views, refresh-on-open and first-send forks:

```bash
pnpm --dir src/web-ui run test:run src/flow_chat/components/ExternalHistoryNotice.test.tsx src/flow_chat/utils/externalHistory.test.ts src/flow_chat/services/flow-chat-manager/MessageModule.test.ts src/flow_chat/services/flow-chat-manager/SessionModule.test.ts src/flow_chat/store/FlowChatStore.test.ts src/flow_chat/components/modern/UserMessageItem.test.tsx src/flow_chat/hooks/useMessageSender.test.tsx
```

These local store/DOM fixtures cover source-version pinning, device switches and
explicit Peer gating; they do not validate native WebView or remote-host behavior.

For workspace catalog pagination, source filters, count/expansion behavior and
old-host fallback, run `pnpm --dir src/web-ui run test:run src/app/components/NavPanel/sections/sessions src/app/components/NavPanel/workspaceSessionView.test.ts src/flow_chat/store/FlowChatStore.test.ts src/infrastructure/api/service-api/SessionAPI.test.ts`.
These fixtures verify bounded page requests and transport payloads, not live remote connections.

For session header filter menus, per-filter Select All, reset, and persisted preferences:

```bash
pnpm --dir src/web-ui run test:run src/app/components/NavPanel/components/WorkspaceSessionFilterMenu.test.tsx src/app/components/NavPanel/workspaceSessionView.test.ts src/app/components/NavPanel/workspaceSessionView.persistence.test.ts src/shared/ui/MenuComposition.contract.test.ts
```

These DOM and store fixtures do not establish native rendering or live remote behavior.

For application update discovery, skip persistence, notification timing, and
download/install transitions, run the focused behavior tests (these do not
establish visual fidelity):

```bash
pnpm --dir src/web-ui run test:run src/infrastructure/update src/infrastructure/api/service-api/SystemAPI.test.ts src/shared/notification-system/components/NotificationContainer.test.tsx
```

For Markdown parse prewarming or dependency resolution, run
`pnpm --dir src/web-ui run test:run src/infrastructure/markdown/markdownParse.worker.test.ts src/infrastructure/markdown/markdownParseCache.test.ts`.
This builds the real Worker entry with the product aliases, checks parsing without
a DOM, and covers failure fallback. Build configuration changes also need `pnpm run build:web`.

For shared overlay ordering, dismissal, focus or presence changes, run the
focused DOM and ownership contracts in addition to `check:web` (these do not
establish visual or remote transport behavior):

```bash
pnpm --dir src/web-ui run test:run src/shared/ui/OverlayStack.test.tsx src/shared/ui/OverlayOwnership.contract.test.ts src/shared/ui/Dialog.test.tsx src/shared/ui/MenuPopover.test.tsx src/infrastructure/appearance/runtime/AppearanceOverlayHost.test.ts src/shared/notification-system/components/NotificationContainer.test.tsx src/shared/context-menu-system/components/ui/ContextMenu.test.tsx
```

For Markdown Mermaid rendering states and supported syntax:

```bash
pnpm --dir src/web-ui run test:run src/infrastructure/markdown/MermaidBlock.test.tsx src/tools/mermaid-editor/services/MermaidService.test.ts
```

The service tests use the real Mermaid parser; native SVG rendering still needs UI verification.
