# OpenBitFun Web UI

[中文](./README.zh-CN.md) | English

## Overview

This directory contains OpenBitFun’s **Web UI** (React + TypeScript). The same frontend codebase is reused by:

- **Desktop**: loaded via **Tauri**
- **Server/Web**: built into static assets and served by the backend

## Floating conversations

The bottom-right window opens the persistent OpenBitFun control conversation in
text mode. Drag a session tab into the window to continue that session there;
use its return action or drag it back to the main tab bar to move it out.
Agentic MiniApps add their associated conversations as tabs automatically.
Drafts, attachments, execution and reading position stay with the conversation.

The MiniApp header's Conversation action restores its current conversation,
including a hidden dock tab, without creating a session. Open app in the dock
returns to its application tab. An expanded MiniApp conversation follows the
active application unless the user is typing, on a call, or viewing a regular
conversation. Hidden tabs and collapsed windows stay hidden during background
updates. Closing the application tab stops its Agent runs and worker, ends its
call, and removes its dock entry; saved history remains. A failed shutdown keeps
the application open and reports the failure. Switching devices only detaches
the view and never stops applications on the device being left.

The control conversation uses a continuous, lightweight transcript. Scrolling up
automatically loads earlier records while preserving the reading position.
In text mode, records scroll beneath the fixed controls, whose translucent blur
appears away from the top. A quiet three-dot activity indicator appears below the
current user message while its turn is processing, and stops when attention is
needed or processing ends. Collapsing hides the whole panel after its exit
animation while retaining the draft and records.
The new-conversation button selects a fresh control conversation on the host and
keeps earlier records. Finish a running task or call before starting a new one;
peer hosts must advertise `control_conversation_reset_v1` for this action.
Its compact logo-and-label button
above the messages opens realtime voice, expanding into the particle call image
on the same axis. The original top-left back arrow returns to text and gathers
it back into the compact identity;
the transcript, reading position and unsent draft stay mounted. Only available
task progress is shown. Permission requests bring the text composer back into
view while keeping the call active. Other conversation tabs retain their
standard chat presentation and header voice entry. Collapsing the window also
keeps the call active; hang up explicitly to end it. Voice and text share
saved conversation history; a live call remains bound to its original session
and device. ACP and Detached Dispatch conversations retain text interaction;
shared voice history requires a host advertising `control_conversation_v1`.
The standalone web server does not yet expose this control-conversation contract;
use Desktop or a capable peer host.

## Tech stack

- React 18.3
- TypeScript 5.8
- Vite 7
- SCSS
- Zustand (state management)
- Monaco Editor

## Directory structure

```
src/web-ui/
├── README.md                     # This file
├── README.zh-CN.md               # Chinese version
├── LOGGING.md                    # Logging & debugging notes
├── index.html                    # Entry HTML
├── package.json                  # Dependencies & scripts
├── package-lock.json             # Locked dependency versions
├── public/                       # Static assets
├── src/                          # Frontend source
│   ├── app/                      # Main app UI
│   ├── features/                 # Feature modules
│   ├── flow_chat/                # Flow / chat UI
│   ├── generated/                # Generated content (placeholder/artifacts)
│   ├── hooks/                    # Shared hooks
│   ├── infrastructure/           # Infra (API/i18n/theme/etc.)
│   ├── locales/                  # Translations
│   ├── shared/                   # Shared utils & types
│   ├── tools/                    # Tool UIs (editor/terminal/git/etc.)
│   ├── main.tsx                  # App entry
│   └── vite-env.d.ts             # Vite type declarations
├── tsconfig.json                 # TS config
├── tsconfig.node.json            # Node/Vite TS config
├── vite.config.ts                # Vite config
└── vite.config.version-plugin.ts # Version plugin
```

## Frontend communication layer

### Core idea

One UI, two runtimes:

- **Desktop**: Tauri API (`invoke`, `listen`)
- **Server/Web**: WebSocket / Fetch API

### Adapter pattern (conceptual example)

```ts
const adapter = IS_TAURI ? TauriAdapter : WebSocketAdapter;

await adapter.request("execute_agent_task", params);
adapter.listen("agentic://text-chunk", callback);
```

## Development

### Start the dev server

```bash
# Desktop
pnpm --dir src/web-ui run dev

# Server/Web
VITE_BUILD_TARGET=web pnpm --dir src/web-ui run dev
```

### Build

```bash
# Desktop
pnpm --dir src/web-ui run build

# Server/Web
VITE_BUILD_TARGET=web pnpm --dir src/web-ui run build
# output: dist/
```

## Subscription models

In **Settings → Models → Subscription accounts**, sign in, choose **Use**, and
open the model picker. **Refresh models** fetches the account's current list
without signing out or reopening the editor. Saved models remain selectable;
you can also enter a provider-supported model ID manually.

Antigravity queries its authenticated `fetchAvailableModels` endpoint; Codex
uses its subscription catalog, including models unavailable through the public
OpenAI API. For OpenCode, choose Go/Zen and a model; OpenBitFun selects the
matching Chat Completions, Responses, or Messages protocol from the account catalog.
xAI and Hermes query their model endpoints. Hermes uses Chat Completions with
Nous OAuth bearer authentication for all models, including `anthropic/*`, matching
the current upstream default while its native Messages cache issue is unresolved.
Saved model IDs and subscription credentials remain valid.

Subscription login supplies the required authentication and account headers even
if a saved model used custom-header replace mode. There is no need to paste tokens
or provider identity headers into the model editor. These policies apply only to
subscription models; API-key models continue to use their saved request settings.

The account's returned IDs determine availability. A familiar or older ID does
not prove the underlying model is outdated, and a model advertised by a vendor
is not necessarily available through every subscription or OAuth client. A
failed subscription lookup shows an error instead of presenting preset models
as an account result. Antigravity browser login requires the local desktop;
device-code login can authorize the other providers from another browser.

## Gitee pull requests

The Pull Requests panel recognizes HTTPS and SSH remotes on `gitee.com`. Public
repositories can be read anonymously. Add a Gitee personal access token from the
panel, or set `GITEE_TOKEN` on the OpenBitFun host, to access private repositories
and perform authorized write actions. A saved token takes precedence over the
environment. Grant the Gitee `pull_requests` and `projects` scopes for PR work;
Issue evidence additionally needs the corresponding `issues` scope. Repository
membership and reviewer permissions still apply.

Gitee supports PR details, files/diffs, commits, comments, check runs, Deep Review,
PR creation (including drafts and fork branches), ordinary review comments,
approval, and resetting the current user's approval. Approval never uses the
administrator force option or resets other reviewers. If approval succeeds but
its accompanying comment fails, the action reports the applied approval and asks
to retry only the comment.

Gitee fetches file and line counts for the current page before returning list rows,
using the same bounded concurrency as GitLab and GitCode. Filtering and pagination
run first; a failed statistics request preserves the PR and its known/unknown counts.

The adapter conservatively treats responses of 200 files or 250 commits as
potentially incomplete. Public file responses have stopped at 200 and ignored
pagination parameters despite the schema's advertised 300-file limit. Deep Review
retains limited coverage instead of claiming a complete review. Diffs are bound to the PR's full
base/head revisions and become stale if the target changes while loading. Check
output/error excerpts are available; full CI execution logs remain at the check's
external details page. Native change requests, replies to a specific thread,
thread resolution, draft reviews, and merging are not exposed as Gitee actions.

For an SSH workspace, repository discovery runs through the remote workspace
transport and Gitee API requests use the OpenBitFun host's network and credentials.
Peer mode uses the target host; both sides must support the provider. A CLI peer
does not expose the desktop PR panel. Headless Agent tools require credentials on
the executing host and report missing access without requiring a local GUI login.
Gitee credentials are stored separately from the legacy review-platform token
file so downgrading does not make existing GitLab/GitCode credentials unreadable.
Self-hosted Gitee installations are not inferred from arbitrary hostnames.

## Related docs (within this package)

- [Logging guide](LOGGING.md)
- [Motion audit and optimization checklist](MOTION_AUDIT.md)
- [Independent design system](../../design-system/README.md)
- [i18n README](src/infrastructure/i18n/README.md)

## Notes

Creative mode in the packaged Desktop can control existing settings, manage
installed MiniApps, and apply persistent UI customizations without a source
checkout or build tools. Ask for the client change in Creative mode and review
the native Keep/Revert preview. The host confirms only after the shell and
customization activate; failure or timeout restores the previous revision.

Custom modules can also register Agent-callable commands and compose persistent
state with events. The shipped [Creation API](public/openbitfun-creation-api.md)
documents runtime discovery, activation and cleanup. These extensions require
the visible local Desktop; they are unavailable on remote/Peer/headless surfaces.
MiniApp source operations use the installed product's lifecycle owner and
preserve omitted source fields and existing app storage when updating.

1. **Don’t call Tauri APIs directly** in UI components; use the adapter layer.
2. **Keep Web compatibility** in mind (some capabilities may not exist in browsers).
3. **Prefer CSS variables** over hard-coded colors/sizes.

## Ecosystem compatibility status checks

Open a disposable local workspace in Desktop and select an agent under Ecosystem Compatibility.
Use test content or reversible imported copies. Category discovery coverage is independent of copy import and execution support.

| Check | Action | Expected result |
|---|---|---|
| Command discovery | Put `Reply with STATUS_OK.` in `.claude/commands/status-check.md`, then refresh the catalog | The category shows the discovered count and the category dialog lists the discovered commands. Viewing it neither enables execution nor offers unsupported copy import; runtime activation stays with its existing owner |
| MCP copy versus connection | Review and import an existing supported MCP declaration, leaving the native copy disabled | The row says Imported and connection not confirmed. Check and enable the copy in MCP settings, which owns the actual connection result |
| Read-only hooks | Select Pi or DSH with a configured extension and open the Hook category dialog | Static declarations are viewable without execution. Single and category import actions are absent |
| Categories without discovery | Inspect plugins or full settings | The label says "Not yet supported" and the description explains that this page cannot show the content yet, without claiming that all other feature entry points are unsupported |
| Discovery and environment | Toggle Automatic discovery above the sidebar search, inspect its hover/focus explanation, and refresh manually while paused; then switch workspace or Peer | Only automatic catalog reads pause; prior results, runtime enablement and approvals stay intact. Built-in presets remain under More apps; actual sources/content or user configurations appear under Identified. Content shows counts or scan results. Late and failed reads preserve scoped content. Old hosts keep a read-only switch; remote imports never fall back to the controller |

From the repository root, run the focused status and interaction checks:

```bash
pnpm --dir src/web-ui run test:run src/app/scenes/ecosystem-compatibility
pnpm run check:web
pnpm run i18n:audit
pnpm run capabilities:check
pnpm run capabilities:test
```

Fixtures cover scan failures, legacy hosts with missing facts, and conflicts without damaging real configuration.
Remote/Peer frontend fixtures verify presentation and import gates; actual SSH, cross-device, IM remote control and Detached Dispatch require separate environment testing.
