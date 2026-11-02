# Project resources

Open **Project resources** from the `Settings2` action beside a project's More menu.
**Open directory** is available inside the More menu. The page uses the Home
content frame and design-system cards, buttons, typography and colors. It contains
directory management, workspace-targeted schedules,
inline project permissions, and project agents and skills, in that order. It does not claim that a
discovered capability was loaded by a specific conversation. The page does not list
project instruction documents or read the project root for them.

Click the large project icon in the header to open the shared icon editor. The
header displays the saved color or image and updates together with the project
list. Editing targets the browsed project, including Peer hosts; switching device
or leaving the tab closes the draft. Older hosts show the editor's unsupported state.

Below the project name, a Home-style statistics strip shows distinct changed Git
paths, the project's saved, unarchived top-level conversation count, workspace-owned
tasks, project Agents and project Skills. Personal and built-in capabilities are
excluded using the same scope as the section lists. Loading and failed counts show
an unavailable value; incomplete skill discovery remains marked. Environment,
connection and filesystem paths are not shown in the statistics, and the page no
longer reads connection profiles solely for that summary. Task, Agent and Skill
counts are keyboard-accessible shortcuts that scroll to and focus their sections;
scrolling respects reduced-motion preferences.

The page does not scan the project for a file count. Git counts include staged,
unstaged, untracked and conflicting paths without double
counting partially staged files; the metric does not display a branch name.
Conversation counts use the host catalog total from a one-row page request,
including discovered external sources, rather than the currently loaded sidebar rows.
Pending discovery or source diagnostics mark the count as incomplete. Statistics
refresh on activation, after resource edits and on retry; this page has no header
refresh button and adds no background polling.
Missing, failed and non-repository states remain distinct from zero.

Each tab is addressed by `(device surface, workspace ID)`. Browsing never changes
the active workspace or creates a session. Closed projects and other devices show
an unavailable state without an active-workspace fallback. This page has no
new-conversation action. Files carry the owning workspace
and connection into the workbench. Directory management uses the Home device strip's
horizontal cards, icon/name/path hierarchy and status pills. The primary directory
leads, followed by related directories; overflowing cards have scroll controls.
The primary card opens files, while related cards and the header action open the editor. Editing reuses
the existing directory dialog, with an External Import-style list of directory paths,
descriptions and row actions. Related rows expand inline for editing; external references
remain read-only, and changes are only persisted on Save. Project guides are not listed in this section.
The dialog uses the design system's 800px width and 640px panel height, clamped to
the viewport; its body scrolls while its header and footer stay in place.
When only the primary directory exists, Add directory appears beside the card in the
Home device sign-in button style. Once related directories exist, Add directory moves
to the section header, using the Home icon/text action style.
Both entries open a separate medium-size dialog with a path picker and optional
description. A direct addition saves immediately; the manager's Add action opens the
same dialog and stages a new row for its existing Save action. Cancel leaves the list
unchanged. Native/Peer and SSH pickers retain the project host, and late selections
or save results cannot affect another device or a closed dialog.
Related cards expose a circular glass remove action
on hover or keyboard focus (always available on touch). Removal requires confirmation
and only unlinks the directory from the project; disk files and the primary directory
are retained. Device/project changes invalidate pending confirmations, and a failed save
keeps the directory visible for retry.
Every directory card also exposes a circular glass action to open that directory
in the system file manager. This action is available for this computer's desktop
projects, passes the owning workspace ID, and does not change the active project.
SSH workspaces, Peer surfaces and browser clients show a disabled action with an
explanation. In-flight results are fenced to the original device and project.
Tool and command permissions appear after scheduled tasks. Their Home-style
split card counts saved permission entries on the left and combines remembered grants
and static rules in a single-line list on the right, with effects visible and sources available on hover and in the full list.
The count describes stored entries, not effective access after rule precedence.
Click the count or a list entry to open the full list. The section's Add permission
action opens a separate medium-size form. Adding from the page saves the completed
rule directly; adding from the list stages it for the existing Save action. Cancel
never inserts a blank row, and failures preserve the form for retry. Grants can be revoked, and static rules can be
edited, reordered, discarded and explicitly saved through the existing APIs. Closing
the list or reactivating the tab preserves drafts; changing project or device isolates
them. Unavailable hosts show retryable errors.

Scheduled tasks follow directories and use the same split layout, with total and
enabled/paused counts. Their summary and full list both target workspace-owned jobs.
Add task opens a separate fixed-size creation dialog, including when launched from
the task manager. The page entry does not open or load the manager behind it.
Manage tasks, beside Add task with the Home action divider, opens the full list. Both task and
permission dialogs use fixed desktop dimensions, clamp to the viewport, and scroll
their External Import-style lists inside the dialog. Empty preview panes show only
a centered Add action, without a title, explanatory copy or View all button.
While that empty-state action is visible, the section header omits its duplicate
Add action. Loading and failed states keep their existing header action. Manage tasks
remains available in the task header, including the empty state.
Directory, permission and task lists share the External Import grid-row geometry:
one rounded outer frame, single separators between rows, shared column gaps and
row padding. Expanded editors span every column inside that frame; table, row and
cell roles retain their accessible structure.

Tasks, permissions, Agents and Skills share single-line resource rows. Row hit areas
and hover backgrounds extend into the surrounding padding without changing content
alignment or row gaps. Available height and the measured row size determine the
visible count; overflow reserves an ellipsis row that opens the complete list.
Agent and Skill lists also reserve a final Add item, including while overflowing.
Their complete lists retain project-scoped detail and creation entry points.

Agents and Skills occupy two separate rounded cards. Empty cards show only their
centered Create/Add action; unsupported actions remain disabled with a focusable
explanation tooltip. Agent and Skill creation receive an explicit project owner and
default to project scope. Project Agent creation starts with a subagent, since
ordinary Agent modes are user-scoped in the existing product contract.

Section headings lead directly into content, without introductory subtitles. Header
actions use the same small icon/text buttons, muted idle color and hover border as Home.

Agent and Skill cards show project-owned resources only; this page has no
source-switching control. The sidebar shows related-directory counts as a standard
neutral pill with a link icon and formatted number, spaced from the project name
using the shared spacing scale.

Remote workspace file reads use the project connection. SSH Agent creation and
non-local Skill installation are explicitly unavailable. Peer reads and supported
actions use existing transport APIs; host errors remain visible and retryable,
including older hosts that lack a capability. No Remote Control wire or Detached
Dispatch behavior is added; running jobs retain their existing owners and continue
independently of the page. Dialogs use the existing shared orchestration.

## Verification

```bash
pnpm --dir src/web-ui run test:run src/app/scenes/project-resources src/app/components/NavPanel/sections/workspaces/WorkspaceProjectPermissionsPanel.test.tsx src/app/components/scheduled-jobs/ScheduledJobsView.table.test.tsx src/app/components/scheduled-jobs/scheduledJobDraft.test.ts
pnpm run check:web
pnpm run i18n:audit
```

The fixtures exercise explicit project ownership, simulated SSH and Peer scoping,
old/unsupported host errors, and stale response isolation. They do not establish
live remote-workspace, Remote Control, Peer Device or Detached Dispatch behavior,
or native visual fidelity. Browser control is not required for verification.
