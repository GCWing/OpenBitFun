# Workspace resources

The workspace's folder entry opens one persistent navigation panel containing files
and terminals. Opening this panel leaves the active conversation or editor intact.
The existing `file-viewer` navigation id and `file-viewer-nav` appearance identity
remain compatible with navigation links and installed skins. Files and selected
terminal sessions follow the [workbench opening policy](../../workbench/README.md):
prefer the matching workspace's already open session tab and its right panel, or
open a main resource tab when no matching session tab is open. A cached or selected
session alone never opens a session tab. Existing main views are reused; a right-panel tab can be
popped out from its menu or dragged onto the top tab bar. There is no File View
content scene or intermediate container in the main tab bar.

Resource navigation owns an explicit `(device surface, workspace id)` browse target
in `navSceneStore`. The folder action updates only that target; it never activates
the global workspace, initializes/selects a chat, or creates an empty session.
Back/forward navigation retains the target. A closed target
or another device cannot fall back to the active workspace. Legacy untargeted entry
points still use the current workspace.

The top navigation title shows the browse target's project name. Files and terminals
sit directly below it, without a duplicate project row or location badge. Use the
main navigation's folder actions to browse another project.

`WorkspaceResourcePanel` passes the resolved workspace to `FilesPanel` and the shared
Shell hooks. File reads, downloads, mutations, menus and terminal opens carry that
origin, including its SSH connection. Main conversations and their canvas snapshots
continue to follow explicit session activation.

## Ownership

| Owner | Responsibility |
| --- | --- |
| `WorkspaceResourcePanel` | Workspace identity, composition, accessible section controls and action feedback |
| `workspaceResourceState` | Device/workspace-scoped layout preferences; no files, terminal processes or credentials |
| `FilesPanel` / file-explorer | File operations, tree state, search and navigation |
| Existing Shell hooks | Workspace terminal projections, saved configurations and explicit terminal actions |
| `TerminalService` / platform adapter | Terminal transport, event subscriptions and device-epoch boundaries |
| `terminal-core` | PTY lifetime and immutable initial working directory |

The panel reuses existing owners; it does not create an independent terminal manager
or filesystem cache. Search preferences are kept in the file-explorer owner under an
explicit resource key, while results are refreshed from the target.

`WorkspaceBody` owns the shared navigation background material. Resource navigation
uses the same `NavPanel` transition as other navigation pages, with transparent
content above that material. Retained inactive navigation layers are inert and hidden
from assistive technology; resource navigation does not add an opaque cover.

## Interaction contracts

- File and terminal sections scroll independently and support collapse. The splitter
  supports pointer capture, arrow keys, Shift for larger increments, and Home/End.
  Empty terminals consume only a compact section.
- Each section's actions appear while the pointer is over that section or one of its
  actions has keyboard focus. Touch surfaces keep them visible, and hiding preserves layout.
- File and terminal content opens keep workspace navigation visible. Explicit
  navigation back to the main sidebar is respected; settings keep their own navigation.
- File-tree context menus can create a terminal in the selected directory. A terminal
  can reveal its current directory when it is inside the active workspace.
  Reveal preserves unrelated expanded folders, applies the target's path semantics,
  and addresses virtual rows by data index, including compressed directory chains.
- Opening a saved configuration does not run its startup command. Start, stop and
  remove are explicit actions. Removing a saved configuration does not stop its PTY.
- Regular terminal tabs carry `terminalCloseBehavior: detach`. Closing those tabs
  does not stop the process. Specialized and legacy
  terminal tabs retain their existing lifetime policy.
- Exiting a shell leaves its output visible; only closing the view clears its selection.
- A running status means an active terminal session, not that its foreground program
  or development server is healthy.

## Workspace and device scope

Layout and terminal projections include the device surface and remote connection.
Asynchronous terminal work checks the originating device epoch and workspace before
committing UI state or opening a view. A panel unmount only detaches UI listeners.

Terminal ownership is projected from the immutable creation directory. Among nested
opened projects, the closest matching root owns the terminal. Current-directory events
change the displayed location without moving the terminal between projects. Saved
configurations remain attached to the workspace in which they were saved.

Remote paths use POSIX semantics even on a Windows controller. New SSH terminals pass
the owning connection explicitly and do not apply the controller's shell executable.
Host errors retain the last terminal projection and show an unavailable state; an
unsupported CLI peer terminal command remains visibly unsupported.

## Compatibility

`initialCwd` is optional response enrichment backed by the existing terminal-core
`initial_cwd` fact. Old payloads deserialize and round-trip unchanged. Older hosts
without this field remain usable: the frontend anchors their first observed directory
for the terminal-service lifetime. A fresh client cannot reconstruct an earlier
directory an old host never supplied.

Existing local saved-terminal keys and their version-1 records remain readable.
Unknown record fields survive edits. Unreadable configurations and newer record
versions remain intact, with read/write errors surfaced instead of reporting a save.
Other devices and SSH connections use isolated namespaces. Ambiguous historical
path-only profiles are left intact and are not automatically imported onto another
host.

The feature is a shared Web UI surface over existing adapters. Remote-workspace and
peer scoping have contract coverage; these tests do not establish live SSH/peer,
mobile Remote Control, or Detached Dispatch end-to-end behavior.

## Focused verification

```bash
pnpm --dir src/web-ui run test:run src/tools/terminal/services/terminalWorkspaceScope.test.ts src/tools/terminal/services/manualTerminalProfileService.test.ts src/tools/file-system/utils/fileTreeReveal.test.ts src/app/scenes/workspace-resources/workspaceResources.test.ts src/app/scenes/workspace-resources/terminalViewLifecycle.test.tsx
pnpm --dir src/web-ui run test:run src/app/scenes/terminal/TerminalActionBridge.test.tsx src/tools/file-explorer/controller/ExplorerController.test.ts src/infrastructure/api/service-api/WorkspaceAPI.test.ts src/shared/context-menu-system/core/ContextResolver.resourceScope.test.ts src/shared/context-menu-system/commands/builtin/file/RevealInExplorerCommand.test.ts
cargo test -p terminal-core --lib workspace_origin_contract_tests
pnpm run check:web
pnpm run i18n:audit
```

No mock-based visual validation or browser control is required for this change.
