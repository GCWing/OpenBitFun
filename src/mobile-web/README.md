# Mobile web remote control

Open a desktop invitation and sign in with the desktop's GitHub account. The
browser remembers this login: refreshing, opening another tab with the same
invitation, or reopening the browser does not require another GitHub login while
the Relay token remains valid.

## Account and connection scope

- Login and the encrypted-RPC device identity belong to the browser profile,
  website origin, and Relay endpoint. Tabs share them through IndexedDB. This
  includes same-network HTTP invitations, where secure-context Web Locks are
  unavailable. Authentication uses a Bearer token, not an authentication cookie.
- Each tab independently selects its desktop and conversation. **Disconnect**
  returns that tab to device selection, including after reload. **Sign out** in
  Devices signs out the browser's tabs for that endpoint. Other browser profiles
  and the desktop account remain signed in.
- The desktop's Connected devices list receives the stable controller device ID
  as `ping.client.id`. Refreshes and new tabs therefore share one presence entry
  on a given desktop. Display names such as Chrome / macOS are labels, not keys;
  two real browser profiles with identical labels remain separate.
- A LAN address and the official site are different origins and have separate
  logins. Private browsing and clearing site data also create a separate or new
  identity. The Relay currently issues 30-day tokens; an actual HTTP 401 returns
  the affected tabs to sign-in. Network failures and offline desktops retain the
  saved account.

## Upgrade behavior

The first upgraded tab can migrate its v2 sessionStorage login together with the
original private key and controller ID. Other upgraded tabs adopt the shared
identity and migrate matching navigation. Sign-out leaves a revision marker so
a suspended legacy tab cannot restore an already signed-out token. Unknown or
unreadable records are preserved and shown as a storage error.

Tabs still running an older bundle may continue reporting their old presence
IDs until refreshed or closed. Those entries expire under the host's existing
75-second idle lease after their last ping; this client does not delete devices
or merge different profiles by their display name.

## Verification

`pnpm --dir src/mobile-web run test:account-browser` runs the actual React client
in independent Chrome tabs and persistent/disposable profiles. Requests are
intercepted for synthetic LAN HTTP and official HTTPS origins; the fixture
implements Relay authentication and encrypted host RPC. It checks shared login,
stable presence IDs, concurrent logins, delayed responses, cross-tab sign-out,
restart, legacy migration, expiry, and storage failures. Install Chrome/Chromium
or set `PUPPETEER_EXECUTABLE_PATH`. No live GitHub authorization occurs.

For live-host acceptance, use a desktop build serving this mobile bundle (and a
deployed bundle for the official site). Sign in once, open the same invitation
in a fresh tab without an opener, reload both tabs, and reopen the browser.
Confirm that the desktop retains one Connected devices entry. Select different
desktops in the two tabs, disconnect one tab, then sign out from Devices and
confirm both tabs return to sign-in. A separate browser profile should remain
independent. Repeat on LAN HTTP and official HTTPS; fixture tests alone are not
evidence of a live Relay/desktop deployment.

## Controlled runtime capabilities

Mobile web is a controller: workspace paths, files, terminals, and SSH operations execute on the selected Desktop or CLI runtime. The workspace picker offers that runtime and its saved SSH connections; it does not create connections or collect SSH credentials. Product operations use the same `host_invoke` registry as peer control. A missing remote connection identity must never fall back to the runtime’s local filesystem.

Conversation history and live updates share revisioned `session-record` entries. The controller opens the latest encrypted message page, prefetches older pages in a single background flight shared with explicit older-page requests, and applies WebSocket messages directly when their sequence follows the committed cursor. Sequence gaps, reconnects, and returning to a visible tab trigger forward recovery. Stable record identities and revisioned deletion markers make backward pages safe to merge with newer edits. Cache fragments, the forward cursor, and the older-page boundary commit atomically in IndexedDB. A separate host transcript snapshot is not mixed into this stream.

The workspace tools provide directory browsing, text-file reading/editing, file/folder creation, file renaming/deletion, binary upload/download, and an xterm PTY renderer. Saving a read file supplies its original SHA-256 to the runtime, which rejects conflicting writes. Terminal output follows durable notifications and resumes the runtime's output cursor. These controls do not create a phone/browser runtime.

Pending questions and permissions use the runtime interaction mailbox independently of transcript history. Initial attachment, reconnect, foreground recovery, and permission control events refresh that mailbox. Requests are answered by `requestId`, including requests with no tool-call attachment; edited approval input is sent to the same runtime permission owner.

File uploads stream 3 MiB chunks through the runtime transfer owner, use a whole-file digest, and resolve a lost append acknowledgment through the transfer cursor. Downloads stream chunks to the browser writable-file picker with backpressure; browsers without that API retain Blob parts until their download API accepts the file. Preview buffers remain separate from downloads. Terminal input is coalesced and serialized, resize keeps the latest dimensions, and ANSI output is rendered by xterm rather than interpreted by a custom parser.

Account sign-in offers independent GitHub and email-code accounts through the
shared OpenBitFun authorization page. No password registration is needed. Use the
same login method and account on the desktop/CLI and phone to see its devices.

## Host-owned message queue

On hosts advertising `dialog_queue_v1`, the composer remains available while a
turn runs. Accepted follow-ups appear in the host message queue, shared with the
desktop and supported Peer Device controllers. Closing this page, disconnecting
the phone, or leaving the session does not stop host-side dispatch.

- **Send now** starts the selected message when idle. While a turn runs, the
  host finishes the current atomic action and starts the selected message as
  the next regular user turn. It has its own history and navigation entry on
  desktop and mobile; existing tool results stay with the preceding turn.
  Acceptance is distinct from the new turn actually starting. Older hosts may
  still render steering inline within the active turn. The turn-scoped SDK
  steering API used by CLI/Dispatch retains its inline contract; this handoff
  belongs to host queue promotion.
- **Remove from queue** only removes an unstarted message. It never stops the
  active turn. An operation that lost a race with dispatch is rejected.
- A failed turn or unconsumed steering retains the message as blocked on the
  host. Resolve the cause, then explicitly send now or remove it.
- A lost response leaves an unconfirmed local record in IndexedDB. **Check /
  retry** queries the original message ID before retransmission; it does not
  allocate a second submission. Local storage must succeed before sending.
- The guarantee starts when the execution host accepts the message. A request
  that never reached the host is not guaranteed to run. Pending messages are
  held in host memory: quitting or restarting the execution host can lose them.
  A changed queue epoch prevents automatic replay; the submitting browser keeps
  its cached text for an explicit recovery decision.

Older hosts retain the legacy send path and do not expose this queue management
UI. ACP and Detached Dispatch retain their own driver behavior. Permissions and
questions still use the existing remote interaction mailbox.

Verification: `pnpm --dir src/mobile-web run test:host-queue` covers ambiguous
retries and a real Chromium page close/reopen with IndexedDB. The browser tests
use simulated host/relay data and disposable profiles; they are not evidence of
a physical phone or an SSH workspace test.

### Project icons

Recent-project and compact sidebar rows display the owning host's project icon when it
advertises `workspace_icon_read_v1`. Built-in project categories use the same Lucide artwork
as Desktop, including life/hobby categories. Theme changes select the light/dark image locally;
a legacy single image serves both themes, and a missing variant falls back to the available
image without rewriting host metadata. Missing or unknown glyph IDs fall back to the folder/server shape without
altering host settings. Older hosts retain their existing default icons. Images
are fetched through authenticated RemoteCommand requests by workspace ID, never by a
controller-local file path. Reconnect/catalog refresh reloads the host projection; target
epochs prevent a late response from another device replacing the current icon. Icon editing
is available in the Desktop controller; mobile/IM editing requests receive an explicit
unsupported response. A failed image read preserves host settings and displays a fallback
with an unavailable hint.
