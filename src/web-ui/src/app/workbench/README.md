# Workbench content tabs

New files, terminal views and contextual content prefer the canvas opposite an
already open session tab in the same device/workspace/filesystem scope. That tab
remains eligible while another main scene is active. Only sceneStore's open tabs
are destinations: cached history or a selected session whose tab was closed cannot
open a session implicitly. Without a matching open tab, open a main SceneBar resource.
Existing main views are reused in place, including views explicitly popped out.
File View and Panel View are no longer content scenes. The resource navigation
panel remains available beside conversations and editors.

## Ownership

| Owner | Contract |
| --- | --- |
| sceneStore / scenePaneModel | Tab identity and pane membership, per-pane selection, command focus, pinned order, history and close completion |
| contentResourceStore | Resource identity, captured origin, presentation metadata, dirty/missing status and rename reconciliation |
| EditorDocument | Unsaved text, saved baseline, retained Monaco model and editor view state |
| ResourceFileContext | Origin-bound I/O for nested document renderers and embedded Markdown assets |
| ContentResourceView | Direct resource rendering and the save/discard/cancel close guard |
| FileTabManager / workbenchContentService | Normalize open requests and commit state before a view mounts |
| sceneTabTransfer | Uniform live-identity moves between panes for every scene and resource kind |
| canvasTabTransfer | Promote contextual canvas tabs into stable workbench resources with document handoff |
| WorkbenchLayout / workbenchPaneLayoutStore | Device-local pane geometry, visibility, shared header and panel controls |
| CanvasToolbarProvider | Host-directed toolbar placement; groups retain their tab callbacks and store mode |
| ContentCanvas and its hosts | Contextual content and editor groups; the workbench, Git and bottom-terminal hosts choose toolbar placement |

Default routing captures the device/filesystem origin before session activation,
waits for the owning session's navigation gate, selects its workspace snapshot and
reveals both the conversation and its canvas in one navigation transaction.
Later host mounts cannot replace that write.
Content navigation uses existing-tab activation, which revalidates the session
reference and origin after activation or settings exit. Closing, retiring or
replacing the destination cancels the request instead of recreating its tab.
Git opens and bottom-terminal opens keep their explicitly selected inline host.

WorkbenchLayout owns one SplitView for the header and both content regions.
SceneViewport renders a flat, keyed deck of SplitViewSurface hosts: moving a tab
changes grid placement, never the React parent, iframe, document or mounted scene.
SceneStore records optional pane membership (legacy tabs default to primary),
explicit scene/canvas/empty selections for both panes, and an independent focused
pane. `activeTabId` is a read-only projection of the focused pane's scene; canvas
focus has no scene ID. Focusing an already selected pane does not write history
or change either selection. Scene navigation history remains scene-tab history.

Open, history, move, canvas reveal and close fallback all use the scene owner's
navigation transaction: plan both panes, guard settings only if its presentation
is replaced, activate any newly presented session, revalidate device epoch and
source lifetime, then commit selection and reveal the required panes. A failed,
canceled or superseded activation leaves the prior presentation intact. Closing
an unfocused pane can activate its session fallback without changing command focus.
Settings drafts remain mounted on moves; moving Settings itself does not leave it.
Resource metadata, pinning and history bookkeeping never infer pane selection.

Session workspace tabs retain their existing singleton presentation contract:
only the authoritative session host is presented. Selecting a session bookmark
in the other pane moves that presentation and selects a non-session fallback in
the previous pane. It does not duplicate global composers, selection or runtime
ownership. A newly opened workspace session inherits the presented conversation's
pane. Authoritative session changes update that presentation even while the other
pane has command focus. Other scene kinds can remain visible alongside it.

The contextual canvas remains one independent editor-group host. It starts in the
secondary pane and follows the side opposite the presented conversation, including
close fallback. Its keyed SplitViewSurface changes grid placement without
reparenting the editor; the toolbar follows its pane. Selecting a page there hides
that host. Explicit canvas reveal selects its content again; closing its last tab
cannot collapse a pane containing page tabs or the conversation. Existing per-session canvas snapshots remain
readable. Layout mode belongs to the device workbench, so changing sessions cannot
hide a moved page. The legacy sessionPaneLayoutStore path re-exports the shell owner,
retains old preference keys/legacy layout projection, and reads old in-memory modes.
The `session.auxiliary` Appearance address stays on the shell wrapper for skins.

SceneTopBar owns both tab regions and the short separator. SplitView supplies the
header's live column geometry, including clamping, resizing and overlay placement;
header actions and native controls do not shift that boundary. The outer shell is
edge-to-edge, so the header border meets both edges without gutter compensation.
Collapsed headers show the short separator only when the leading actions contain
controls. SceneChromeHost selects actions per pane. CanvasToolbarProvider places
the contextual groups' controls in the header; Git and bottom-terminal toolbars
retain their local hosts. Main/secondary scene tabs share the same drag protocol.
Drops onto tabs, empty header space, canvas tabs or the collapsed panel control use
live identity and validate device epoch and source lifetime again on commit.
The full header slots accept drops, including their padding. `tabDragLifecycle`
defers capture-phase drop cleanup to the next task so native event checkpoints
cannot unmount the advertised destination before React handles the drop.
While a tab is dragged, the existing header slots use design-system neutral
backgrounds, with the neutral hover tint on the destination and only their outer
top corners rounded. Their exact bounds, panel visibility and shared body geometry
stay unchanged. The middle short separator is temporarily hidden without removing
its space; no hint text, floating material or extra inset is introduced. Capture
observes the destination even when a nested tab handles the drop. Embedded canvas
toolbars are transparent; the shell owns the single background and groups maximize
and collapse controls together using the standard compact action gap.
Scene and contextual canvas groups consume their content width in one pane row;
only the remaining trailing space grows. Promoting a canvas tab and returning it
to the pane must not create separate stretched regions between adjacent tabs.
When a move reveals a session in its source pane, the scene owner activates that
session before committing the layout, while command focus stays on the moved tab.
Maximizing the secondary pane also maximizes its header: primary tabs and the
pane separator are hidden, the secondary tabs occupy the full row, and restoring
split mode returns both headers to their saved sides without closing any tabs.

Desktop must deliver HTML drag events to these platform-independent targets.
On macOS, the Wry adapter routes non-file gestures to WKWebView and retains the
native receiver for Finder paths; see `third_party/wry/OPENBITFUN-PATCH.md`.
Frontend drag-event tests do not prove native dispatch, and changes to that
adapter require a Desktop rebuild rather than HMR.

Inline pop-out promotes a canvas tab into a workbench resource and keeps its
EditorDocument reference, captured origin, pinned state and dirty status. Further
left/right moves keep that same resource owner; they do not repeatedly convert it
back into canvas state. Canceled, forged, closed-source or stale-device drags do
nothing. Conflicting dirty resources are retained. Terminal moves never terminate
the underlying process. Older canvas tabs keep their `canvas:<tab-id>` document
identity; document cleanup checks retained canvas snapshots.

## Identity and lifetime

- File identity includes device surface, remote connection and normalized path.
  Native percent sequences are preserved; only explicit file URIs are decoded.
  Windows drive/UNC identity is case-insensitive, remote paths retain POSIX case.
  Workspace-relative paths resolve against the captured workspace.
- Opening an existing file activates its tab and replaces navigation intent.
  Navigation does not overwrite its buffer or create another file tab.
- Editor models have document-owned identities. Renames update the displayed and
  saved path without replacing the document. File and directory rename events carry
  the origin captured before the filesystem request.
- Open file views retain their state during tab and device switches. Every document
  operation checks device identity and activation epoch. It cannot silently read
  or write through the newly selected device. Returning to a failed initial load
  allows the editor to retry on activation.
- Closing a dirty main document offers Save, Discard and Cancel. Failed/canceled saves
  preserve the tab; repeated close gestures share one pending operation. Resource
  removal releases its retained document model.
- Closing a workspace does not delete its opened documents. Their original file
  scope remains explicit. Device tab restoration is window-local, not a persisted
  session/workspace schema or a guarantee of recovering drafts after process exit.
- Main and side close shortcuts share user keybindings but register in distinct focus
  scopes; editor focus inherits its actual main/side owner. Main tabs support drag ordering, pinning, middle-click/Delete/Ctrl+W close and
  content-tab batch close. Batch close skips pinned content and stops on a canceled
  close. Paths, unsaved changes and missing files are exposed by the tab chrome.

## Boundaries and verification

This is a Web UI composition change over the existing filesystem and terminal
adapters. It changes no Rust runtime, remote wire format, session persistence or
headless job ownership. Resource/document tests exercise origin isolation, stale
work rejection, rename identity, navigation, close behavior and device restoration.
Those tests are not live Desktop, SSH, Peer Device, Remote Control or Detached
Dispatch integration evidence. Markdown rich undo across an actual inline-to-main
remount and project-wide language-service behavior are separate integration checks.

Use the focused commands in [AGENTS.md](AGENTS.md) and the editor's existing guide.
