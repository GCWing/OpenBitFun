# Peer Device Mode

Peer Device Mode switches the desktop (and mobile control target) data plane
onto another same-account online OpenBitFun device. The React shell stays local;
product invokes and agentic events come from the peer. The peer may be Desktop
or CLI: both speak the same HostInvoke / DeviceEvent protocol.

## Product goal

After login, clicking an online peer device **B** from controller **A** must make
A's workspace list, sessions, assistants, chat, and tools behave like using
OpenBitFun on B's machine. The authority is **B's live local OpenBitFun state** via
HostInvoke / DeviceEvent fan-out — not a merged cloud session history.

## Attachment vs rendered surface

Two concepts, deliberately independent:

| | Attachment | Rendered surface |
|---|---|---|
| What it is | A live control link to a peer | The one device this window draws |
| How many | Any number, concurrently | Exactly one |
| Ends when | Explicit disconnect or logout | Replaced by the next switch |
| Effect on the peer's agent | Keeps it running and fanning out | None |

This split is what makes several devices usable at once: dispatch a turn on B,
switch the UI back to A, dispatch another turn on A, and both keep running.
The frontend entry points are `switchToDevice` / `switchToLocal` /
`disconnectDevice` on `PeerDeviceContext`; the sidebar `DeviceSurfaceSwitcher`
lists this machine plus every online peer.

Two rules follow, and both are load-bearing:

- **A surface switch never mutates the device being left.** Everything in
  `resetProductSurface()` is frontend-only. Sending `terminal_shutdown_all`
  during a switch lands on the *previous* transport and
  kills work an agent there still depends on.
- **Product events are routed by their source device.** The controller re-emits
  peer DeviceEvents under their original event name, so with peers attached in
  the background one bus carries several agent streams. The desktop controller
  tags each re-emitted payload with `__openbitfunSourceDeviceId`
  (`remote_connect_api::PEER_EVENT_SOURCE_KEY`; non-object payloads are wrapped
  under `__openbitfunSourcePayload`), and `deviceSurfaceRouting.ts` — applied inside
  `TauriTransportAdapter.listen` — delivers a surface-scoped event only when its
  producing device is the rendered one. Untagged events are local by definition.
  Control-plane events (`account://…`, window chrome, updater) are never scoped
  and always pass.

### Surface identity and activation

The rendered device is a first-class `DeviceSurfaceId` (`local` or a peer
device id), not an implicit property of one mutable global transport. Cache,
request, capability, workspace, session-state-machine, processing-status,
pending-message, and composer-draft identity includes that surface. FlowChat
and workspace state are stored in per-surface containers: switching selects a
container immediately, then reconciles it with its host; it does not erase the
container belonging to the device being left.

Every surface activation creates a monotonic epoch and `AbortSignal`.
Product invokes capture that epoch, including through `ApiClient`; a response
or retry that outlives it raises `SurfaceChangedError` and is abandoned as
control flow. Controller-plane commands are exempt because their authority
remains the controller regardless of the rendered surface. Transport/event
routing and container selection commit synchronously in `activateSurface` so
no observer can see B's state while requests still target A.

`PeerDeviceSurfaceController` serializes activation outside React. Rapid
requests coalesce to the last target, a committed-but-superseded hydrate is
invalidated before the next target proceeds, and a real activation failure
rolls back to the previously rendered reachable surface. Separately,
`PeerConnectionManager` owns each attachment's
`connecting`/`ready`/`degraded` lifecycle, keepalive and capped backoff;
React only subscribes to snapshots. Attachment disposal is the only operation
that discards a peer's cached surface state.

Presence gaps and product RPC transport failures move an established attachment
into `degraded`; they never select the local surface. Only a dedicated
`peer_mode_ping` plus recovery `peer_control_attach` handshake changes it back
to `ready`. Product timeouts do not count as independent failed health checks.
Recovery uses one in-flight handshake per device, retries with exponential
backoff capped at 15 seconds, and continues until explicit disconnect/logout.
A device returning to account presence accelerates a pending retry without
claiming the control link is already restored. Cached capabilities, the surface
epoch, requests' target device and session projections stay with that peer;
recovery neither reboots the surface nor resubmits a Turn. The window displays
a persistent reconnecting notice with a manual return-to-local action while its
selected peer is degraded. Background peers recover without switching the view.

Because the local surface can now miss its own events while another device is
rendered, Session attachment is no longer Peer-only. After this window's first
surface switch, `isSurfaceReconcileEnabled()` attaches whichever surface is
rendered, local included.

### Running-Turn attachment

Desktop and CLI own a durable session journal independently of attached
controllers. `HostStreamHub` (`services-integrations::remote_connect::host_stream`)
publishes `session-record` events carrying the existing persisted Turn,
ModelRound and item contracts, stable record IDs, revisions and tombstones into
an in-memory, per-stream, byte-bounded log on the host. Controllers merge the
highest revision for each identity; an older child record cannot regress a
completed parent. Text, thinking and tool-body content have this one authority.
Permission and other control events remain separate from transcript content.

The relay stores none of this. A controller opens a stream with the
`read_stream` device RPC (`{stream_id, after|before, epoch, subscribe}`), which
answers a `stream_page` with `epoch`, `cursor`, `events`, `has_more` and
`oldest_seq`; `unsubscribe_stream` releases the hint lease. While subscribed,
the host fans out an encrypted `host-stream-changed` device event naming only
the stream id, epoch and newest sequence; controllers treat it as a nudge and
read the missing range themselves. The catalog is the `@host/catalog` stream,
terminals are `terminal-<id>`. Every page and hint is pairwise-encrypted
between the two devices and forwarded by the relay without persistence, so an
offline host has no history to show and nothing about a session leaves the
account's devices.

`HostStreamSubscriber` (Rust) and `HostStream`/`HostSessionStream` (Web,
Kotlin, ArkTS) load the latest bounded page first, replay older pages backward
without moving the forward cursor, and catch up forward on hints, reconnects
and a keepalive renewal. A page whose `epoch` differs from the one being
followed means the host restarted the stream: the client announces a gap so
consumers drop derived state, then resyncs from the latest page. Nothing is
cached on the controller beyond the rendered replica. The Surface epoch rejects
records and responses from a device that is no longer rendered. Desktop
`RelaySessionHistory` owns the subscription across initial loading, realtime
delivery and older-page prefetch.

Version skew is negotiated, not assumed. Hosts advertise `host_stream_v1` in
their handshake `capabilities`; a controller that does not see it reports the
host as too old instead of sending `read_stream`, and a host that receives the
retired `get_session_key` command answers an explicit error pointing at the
upgrade. A relay from before this change still emits session `update` frames,
which new clients ignore; the current relay answers the retired
`/v1/sessions` and `/v3/sessions/{id}/messages` routes with `410 Gone`.

Remote session loading does not combine a full `restore_session_view` response
with token deltas, and the former 3s reconciliation poll is not a Relay history
source. Local/non-Relay runtime surfaces still use their existing materialized
projection, event backfill and restore APIs; those local owners have not been
removed by the Relay migration.

Controller presence admits a control request; it does not own an accepted Turn.
A disconnected controller leaves the Runtime, pending questions, permission
mailbox and journal alive. Source lag or a journal publication failure is
reported as a continuity gap; observer failure does not cancel accepted work.

### Blocking-interaction reattachment

A push event is a notification, not the owner of an interaction that can block
an Agent turn. The owning Runtime keeps every native `AskUserQuestion` and
interactive permission request in a live mailbox until it is answered or
cancelled; an `AskUserQuestion` registration is also removed if its owning Tool
future is dropped. `get_session_interaction_mailbox` takes `{request:{sessionId}}`
and returns the existing `SessionInteractionSnapshot` contract: session-filtered
`userQuestions` and `permissions`, each with its monotonic revision. Desktop and
CLI expose the same small operation. Controllers read it on initial attachment
and reconnect independently of the durable transcript log; steady control events
update the presentation without repeatedly loading either mailbox or history.
Native question registration, answer, cancellation, timeout, and owning-future
drop also advance the Runtime mailbox watch. Hosts publish the coalesced
`session-interaction-changed` invalidation through the durable session stream;
controllers then refresh only the small mailbox. The watch retains the latest
revision rather than queueing question payloads on the Tool execution path.

The frontend projects that mailbox into the active Surface container. Permission
requests are retained for inactive Surfaces by source device, while missed
`AskUserQuestion` cards are reconstructed in their exact Dialog Turn and model
round. Snapshot responses are fenced by the Surface epoch and by event/revision
ordering, so an old response cannot erase a newer request or revive one that was
already answered. Reattachment only repairs presentation state: it never
restarts, cancels, or moves the Session, Dialog Turn, or Tool future.

Rendering a mailbox entry and answering it are separate compatibility
contracts. A Peer Host that accepts `submit_user_answers` advertises
`peer_mode_ping.capabilities.user_question_response`. Older Desktop hosts are
compatible because they already exposed the command; older CLI hosts are not,
so controllers must leave the card visible but disabled with an explicit
upgrade/unsupported state instead of sending a mutation that cannot complete.
Current controllers include the owning Session id, and the host rejects an
answer when that Session no longer owns the pending Tool id. New hosts retain
the legacy process-wide Tool-id form for older controllers that omit Session id.

This is the contract for any new blocking interaction: its execution owner must
retain replayable request state and expose it through an attach/snapshot path.
A one-shot frontend event plus an unresolved channel is not a complete
multi-device implementation.

## Cloud account sync vs Peer Remote

| Concern | Account cloud sync | Peer Device Mode |
|---|---|---|
| Purpose | Settings preference sync; optional session **backup upload** | Live full-client remote on another device |
| Session list on A | Local disk only (cloud sessions are **not** imported) | Peer's live session store via HostInvoke |
| Settings | May pull/apply cloud settings to this device | Reloaded from peer after enter (via peer transport) |
| Offline peer | N/A | Must exit Peer Mode; UI must not keep a stale Remote label |

Do **not** treat cloud session blobs as the Remote data plane. Do **not** merge
cloud session metadata into local disk on login or periodic pull — that pollutes
A and conflicts with Peer Mode.

Settings sync is continuous on every logged-in host (Desktop, interactive CLI,
and the CLI daemon): local changes upload after a ~5s debounce (content-hash
deduped); cloud changes are pulled at process start and then every ~30s. After
applying or uploading settings, a host fans out `account://settings-applied`
to attached controllers; the controller re-emits it locally so the frontend
config cache and model selectors refresh without reconnecting.

The opened/recent workspace catalog is host-owned in the same way. Whenever a
host's `WorkspaceService` persists a catalog change — including one made by a
mobile controller, an IM bot, or a Peer Mode controller through
`set_workspace` / `create_session` — `start_workspace_catalog_publication`
emits a `workspace-catalog-changed` hint (payload: `{ revision }`, no catalog
data). The host's own webview re-reads `get_opened_workspaces` /
`get_recent_workspaces` / `get_current_workspace` on that hint so a workspace
another surface opened appears in its list without a manual open; the hint is
also fanned out to attached controllers (Desktop through
`should_fanout_peer_ui_event`, CLI through `PeerControllerEventEmitter`) and is
surface-scoped on the controller, so only the rendered device's catalog is
re-read. A surface never lets a host-side selection change steal its active
workspace unless it had no usable selection.

The account settings payload is the complete `ConfigExport.config` document,
not a whitelist assembled by the login UI. Its scope is:

| Persisted configuration | Account sync coverage |
|---|---|
| `app` | Language, startup/window preferences, logging, notifications, layout, FlowChat, AI experience/quick actions, voice input/call settings, keybindings, tool/Skill groups, hook enablement gates, worktree defaults |
| `ai` | Persisted models and credentials, default/task/subagent model selectors, Agent profile overrides, Skill availability, Review Teams, concurrency/timeouts, proxy, browser/tool preferences, non-secret WebSearch settings |
| `editor`, `terminal`, `workspace` | Preferences in the global document; workspace files and machine connection records are separate |
| `tool_permissions`, `memories` | User permission policy and memory preferences; project permission files and generated memory content are separate |
| `mcp_servers`, `acp_clients`, `plugin`, `project` | Declarations present in the global document; external executables, installed packages and separately stored project overlays are not copied |
| `appearance`, `font` | Appearance selection and UI font preferences; imported skin assets are stored separately |

The frontend refreshes the config cache and the appearance, font and language
runtimes after a settings-applied event. Keybindings register a path watcher
even when their initial value came from the bootstrap hint, and an empty or
removed override restores the registered default. Applying these preferences
does not save them again. An unavailable imported skin keeps the persisted
selection and exposes the existing degraded/unavailable state.

This is settings synchronization, not a user-home backup: custom Agent and Skill
source files, `hooks.json` declarations/scripts, plugin packages, skin/pet
assets, local credential-vault entries, SSH profiles and browser storage are
outside this payload. A synchronized declaration or asset path does not imply
that its dependency is installed or usable on another host. Runtime-only model
credentials are also excluded. Session backup upload has a separate lifecycle.

The sync engine subscribes to successful local mutations at `ConfigService`,
in addition to legacy host notifications. This covers model, Skill, Agent
profile, and individual preference mutations through Desktop and CLI. Failed
writes, runtime-only credentials, reloads, and cloud imports do not emit this
local-change signal. Pending local edits take priority over the periodic pull;
a fetched blob is applied only if the local document still matches its
pre-fetch snapshot. The comparison and import share the config write lock.

Imports validate the OpenBitFun product identity, export format and config
schema, then replace the document. Within the supported schema, omitted fields
with serde defaults acquire those defaults; they do not retain the receiving
host's prior value. Arrays and dynamic maps remain authoritative, so deleted
models, profiles and list entries are not resurrected. Pre-OpenBitFun formats
and retired fields require the explicit migration tool. Configuration write
timestamps and informational build versions are excluded from the sync content
hash so a reload or unchanged save does not cause a redundant upload.

Realtime voice credentials live in `app.voice_call` in the same persisted
configuration and export/backup format as model settings. Account settings
apply is authoritative here too: a supplied empty voice key clears the local
key, and absent voice fields receive defaults. Explicit file imports can
restore or clear a supplied key; local voice saves and resets can also clear
it. A valid whole-config import creates a raw
`app_pre-import_*.json` backup before replacement, under the existing backup
retention policy. Config reload and model-reference reconciliation serialize
their reads and writes with local saves so stale snapshots cannot undo a
completed credential save. These rules do not change speech command routing:
capture, configuration and realtime connections remain on the controller.

Config mutations publish in-memory values and change notifications only after
atomic persistence succeeds. Model CRUD and Agent/Skill map edits use a shared
read/modify/write operation; startup profile canonicalization updates only its
map. User backups have unique names even within the same second. Web UI reads
resolve legacy model metadata without writing it back, model edits read fresh
host data inside the client mutation queue, and AI-experience controls save
only edited fields. An explicit empty quick-action list stays empty across
reloads; defaults are supplied only when absent or when explicitly reset.

SSH `WorkspaceKind.Remote` remains a separate path (local session mirror + remote
FS) and must not be mixed with Peer Device Mode.

## Boundaries

- Not SSH `WorkspaceKind.Remote` (local session mirror + remote FS).
- Switch via the sidebar device switcher, or Account Login → Online Devices →
  click a device. Both list this machine, so returning to it is a switch like
  any other.
- Selecting this machine only changes what is rendered; peers stay attached and
  keep working. `Disconnect` in the switcher is the separate, explicit action
  that ends a peer's control link and discards that peer's cached Surface state
  on the controller. It does not cancel a Turn the peer has already accepted;
  reconnecting later reattaches to the Host-owned durable session journal. Pending
  controller-only interactions still follow their owner's mailbox or fail-closed
  policy.
- Local-only commands (window chrome, updater, account login/logout, peer
  control plane) never execute on the peer on behalf of a controller. Which
  commands those are is declared once, per command, in the Product Operation
  Registry (`openbitfun_product_domains::remote_surface`); the desktop host, the
  CLI host, and the Web UI transport adapter derive their tables from it. See
  [remote-surface-contract.md](remote-surface-contract.md).
- Unsupported or denied commands fail loudly; they must not fall back to the
  local host (that would leak local content). The CLI host distinguishes
  "controller-owned", "unsupported on a CLI host (reason)", "retired", and
  "unknown to this host version" so a controller can tell a policy refusal
  from a version mismatch.

## Transport

- One account-scoped Socket.IO connection owns RPC acknowledgements, method
  registration, presence and session updates. Rust `relay_client` supplies account
  epochs and lifecycle cancellation around `realtime_client`; TypeScript uses
  `AccountRealtime`. Replacing an account retires its socket and pending replies.
  Transient disconnection does not destroy the Runtime's tasks or journals.
- Relay `rpc-call` routes to the authenticated target's registered method and
  carries the caller's deadline (120s when omitted). The server checks account
  membership before routing. Missing acknowledgement after dispatch is an unknown
  mutation outcome; a replacement socket is not grounds to execute it again.
  Socket.IO server ping interval is 15s, ping timeout 45s, and connect timeout
  15s. These transport facts do not establish Runtime readiness.
- Relay admission reserves estimated in-flight RPC memory, with 16MiB per account
  and 64MiB globally. Exhaustion rejects the call explicitly before submission.
  Large encrypted RPC payloads use the separate HTTP bulk lane; TypeScript
  `RpcPayload` inlines up to 128KiB and bounds one transfer block at 64MiB.
  File upload uses bounded chunks rather than increasing the whole-file envelope.
  Each upload action carries the captured `workspacePath` and saved SSH
  `remoteConnectionId` (absent/empty denotes local), or a session identity.
  The runtime binds transfer state to account, provider, and workspace root;
  changing the selected workspace cannot redirect an in-flight upload.
  The Relay stores ciphertext, not decrypted workspace content or credentials.
- Desktop `PeerDeviceTransportAdapter` orders each pending dispatch burst as
  interactive, normal, then background work. It does not maintain an independent
  in-flight count limit or reserved slot. Actual admission belongs to the Relay
  memory budget. Its read and mutation deadlines use the same 120s
  `DEFAULT_RPC_TIMEOUT_MS` contract as `AccountRealtime`; explicit caller
  deadlines continue to flow to the native transport and server. Retryable reads
  retain bounded exponential-backoff recovery. Explicitly idempotent dialog
  submissions reuse their stable session/turn identity; ordinary mutations remain
  single-shot because a missing acknowledgement is an unknown outcome.
- Mobile delegated-auth recovery retries only a Relay HTTP 401. A decrypted host
  application error mentioning an upstream 401 must not repeat a mutation.
  Captured account and target identities fence credential refresh and delivery.
- Controller product operations use `RemoteCommand::HostInvoke` and the Product
  Operation Registry. Desktop dispatches through its Tauri bridge; CLI uses
  boxed, invocation-scoped portable handlers. Unsupported operations return an
  explicit reason. CLI has real workspace, file and terminal providers rather
  than treating the absence of a desktop IDE as absence of these capabilities.
- Canonical session content travels through the durable encrypted journal, not
  per-controller `DeviceEvent` fan-out. Remaining device events carry ancillary
  product/control notifications. Their loss cannot become the authority for
  transcript content or cancel a running Turn. Both direct record updates and
  journal catch-up feed the same stable-ID replica.
- `get_session_interaction_mailbox` restores revisioned questions and permissions
  on attach/reconnect. Runtime question changes produce a coalesced
  `session-interaction-changed` journal event; controllers then read only that
  small mailbox. Surface/event fences prevent stale responses from reviving
  completed interactions. Answers still go to the existing Runtime owner.
- PTY execution and bounded replay history belong to the target, including saved
  SSH workspaces. Local CLI publishes coalesced cursor notifications from a
  watch channel, so a slow observer cannot exhaust a raw-output tap and silently
  lose its subscription. SSH notification consumers tolerate broadcast lag and
  read the retained cursor. Controllers fetch bounded replay pages and render
  them in their terminal surface. Account retirement stops that publisher's
  notification observers without terminating the PTY.
- During Peer Mode, controller-local SSH maintenance and selected background
  editor/Git/search refreshes retain their existing noise-reduction policy.
  These UI refresh policies are separate from durable session synchronization.
  Explicit detach restores the controller shell; uncertainty about attachment
  teardown does not cancel Host-accepted work.

## Workspace directory picking

Native `@tauri-apps/plugin-dialog` always opens on the **controller** machine.
In Peer Device Mode that would pick a path on A and then send it to B via
`open_workspace` / `create_directory` — wrong semantics.

Peer Mode therefore uses an in-app directory browser on A that lists B's
filesystem through HostInvoke (`get_directory_children`, etc.). Entry points
call `pickWorkspaceDirectory()`:

- Local mode → native plugin-dialog
- Peer Mode → `PeerDirectoryBrowser` via `peerDirectoryPickerStore`

Still use normal `openWorkspace` / create-workspace flows (not SSH
`openRemoteWorkspace` / `WorkspaceKind.Remote`).

## File download ownership

The native save/folder dialog always selects a destination on controller A,
while the workspace source belongs to peer B. A download is therefore a
split-endpoint operation: B returns file bytes through the existing
`GetFileInfo` / `ReadFileChunk` protocol and A writes those chunks through its
local filesystem adapter. Directory downloads enumerate B recursively and
create the corresponding tree on A. Never forward A's selected destination to
B through `export_local_file_to_path`; paths and permissions are host-specific
and may represent a different operating system.

Session attachments bind file reads to the session workspace. Downloads without
an associated session capture `workspace_path` and the runtime's saved
`remote_connection_id` once and carry them on every metadata/chunk request.
The runtime resolves that explicit provider and rejects missing identities or
unknown saved profiles; changing its selected workspace cannot redirect an
in-flight download to a same-named local file. The legacy filesystem/terminal
HostInvoke adapters distinguish an explicit empty connection id (runtime-local)
from an omitted identity (native runtime path inference). Workspace menu actions
send the selected workspace identity; local and SSH roots with identical paths
must not select each other's provider. Controllers await each bounded
chunk write and verify offset, size, and file revision before accepting more.
A failed or cancelled native save is not reported as a completed destination. Desktop peer downloads use the controller-local
`local_file_download` sink: the native adapter checks the save dialog's destination
scope, creates private sibling staging, validates write offsets, and atomically
replaces the target only after the complete stream passes validation. Cancel and
failure discard staging; they never truncate or remove an existing destination.
The webview resource owns the sink, and no parent-directory permission is added.


Host directory observers subscribe once to the encrypted `@host/catalog`
stream. `host-catalog-changed` invalidates session/workspace lists; initial
attachment, reconnect, and foreground recovery coalesce directory refreshes.
Revision values are invalidations, not cross-process clocks. Device presence
comes from the account WebSocket, without a second periodic directory RPC.

## Ownership

- Command policy and peer capabilities (all surfaces):
  `src/crates/contracts/product-domains/src/remote_surface/`
- Desktop host invoke / fan-out: `src/apps/desktop/src/api/peer_host_invoke.rs`,
  `remote_connect_api.rs`
- CLI host invoke / fan-out: `src/apps/cli/src/peer_host/` (Core registry; no
  webview bridge). Device routing in `src/apps/cli/src/account.rs` special-cases
  `HostInvoke` / `DeviceEvent`. Same machine Desktop+CLI share one `device_id`;
  the authenticated connection epoch retires the previous connection.
- Frontend mode + transport: `src/web-ui/src/infrastructure/peer-device/`,
  `adapters/peer-device-adapter.ts`
- Surface routing / switcher: `deviceSurfaceRouting.ts`,
  `deviceSurfaceReconcile.ts`, `deviceActivity.ts`,
  `DeviceSurfaceSwitcher.tsx`, `useAccountDeviceRoster.ts`
- Peer directory picker: `pickWorkspaceDirectory.ts`, `PeerDirectoryBrowser.tsx`,
  `PeerDirectoryPickerHost.tsx`

## Regression guards (read before changing session/account paths)

Frontend invariants and known failure modes:
[`src/web-ui/src/infrastructure/peer-device/README.md`](../../src/web-ui/src/infrastructure/peer-device/README.md).

Especially: Peer Mode must not call fail-closed `account_fetch_session_turns`
during hydrate; clear stale `currentWorkspacePath` on peer switch; pass live
workspace into `create_session`; keep config HostInvokes high-priority.
