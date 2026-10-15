# Workbench

Follow the Web UI guide. Keep main tab/history ownership in sceneStore, resource
identity/origin in contentResourceStore, and document buffers in EditorDocument.
Do not reintroduce File View / Panel View containers, nested main content tab bars,
mount-dependent open queues, or a dependency on the active workspace during saves.
Use explicit pane selections and the shared navigation transaction; do not derive
selection from command focus/history changes or place the canvas in a fixed pane.

Focused verification from the repository root:

```bash
pnpm --dir src/web-ui run test:run src/app/workbench/workbenchNavigation.test.ts src/app/workbench/contentResourceStore.test.ts src/app/workbench/workbenchContent.test.ts src/app/workbench/canvasTabTransfer.test.ts src/app/workbench/sceneTabTransfer.test.ts src/shared/ui/SplitView.test.tsx src/app/scenes/SceneViewport.test.tsx src/app/scenes/session/sessionPaneLayoutStore.test.ts src/app/workbench/WorkbenchLayout.test.tsx src/app/components/panels/content-canvas/CanvasToolbar.test.tsx src/infrastructure/services/ShortcutManager.test.ts src/tools/editor/services/EditorDocument.test.ts src/app/components/panels/content-canvas/hooks/canvasPanelOwnership.test.tsx src/app/components/SceneBar/SceneBar.test.tsx src/app/components/panels/content-canvas/tab-bar/TabBar.test.tsx
pnpm run check:web
```

For header drag/drop regressions, exercise the real header and tab bars, including
native capture-phase checkpoints and drops on tabs, controls and header padding:

```bash
pnpm --dir src/web-ui run test:run src/app/workbench/WorkbenchTabDrag.test.tsx src/app/workbench/sceneTabTransfer.test.ts src/app/workbench/canvasTabTransfer.test.ts src/app/components/SceneBar/SceneBar.test.tsx src/app/components/SceneTopBar/SceneTopBar.test.tsx src/app/components/panels/content-canvas/tab-bar/TabBar.test.tsx
```

Use the parent guide's Session state checks when changing activation or lifetime,
and the editor guide's focused suite when changing document behavior. Do not use
mock-based visual verification or browser control for this module.
