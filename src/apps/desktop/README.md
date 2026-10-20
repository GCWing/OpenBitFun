# OpenBitFun Desktop

For development commands, see [AGENTS.md](AGENTS.md) and the repository
[contribution guide](../../../CONTRIBUTING.md).

## Remote Connect

Sign in once with the shared GitHub account. The official Relay and **Same
network** (the embedded LAN Relay) can run at the same time. Each tab shows its
own connection and connected browsers; **Disconnect** affects that tab only.
Closing a connection code keeps an established connection running.

**My devices**, Peer Device Mode, account synchronization and detached dispatch
use the official Relay. Starting or stopping the LAN Relay does not switch their
account or endpoint. LAN invitations advertise the selected network interface;
select it again and create a new invitation after changing networks.

The official device session is restored on restart. The embedded LAN connection
is temporary and starts when requested. Builds that previously saved a temporary
LAN session in the account slot attempt to restore the official Relay from the
shared identity; failed sign-in leaves the previous credential on disk. Signing
out closes both connections.

## Global agent instructions

Put personal instructions for local OpenBitFun sessions in
`~/.openbitfun/AGENTS.md` (`%USERPROFILE%\.openbitfun\AGENTS.md` on Windows).
If `OPENBITFUN_HOME` is set, the file is read from that directory instead.
A non-empty file replaces Codex's global instructions, including
`AGENTS.override.md`. If the OpenBitFun file is missing, empty, or whitespace-only,
OpenBitFun keeps loading Codex's global instructions as before. OpenCode,
Claude Code, and project instruction files continue to load independently.

After editing the file, run `/reload instructions` in the session. The next
message rebuilds its instruction context. Remote SSH/Docker workspaces use
their workspace instruction files and do not load the controller's global files.

## Project agent instructions

OpenBitFun selects one instruction family at the workspace root, in this order:

1. AGENTS: the first non-empty file among `AGENTS.override.md` and `AGENTS.md`.
2. Claude: the first non-empty file among `CLAUDE.md` and `.claude/CLAUDE.md`,
   followed by `CLAUDE.local.md` and `.claude/rules/**/*.md`.
3. OpenCode: local instruction files referenced by the project OpenCode configs.

Missing, empty, and whitespace-only files do not block a fallback. Once a
family supplies instructions, lower-priority families are skipped. A Claude
family containing only local notes or path-scoped rules still counts as selected.
Path-scoped rules load only after a matching file is read, and only when the
Claude family is selected. Use `/reload instructions` after changing the files
to rebuild startup context on the next message.

## Independent MiniApps

MiniApps use a customizable titlebar in independent windows, with native macOS
traffic lights and the main application's right-hand Windows caption controls.
The return icon brings the app back to OpenBitFun. Inside OpenBitFun, MiniApp actions live on
the main top bar, alongside an icon to open an independent window. System app
installation actions are available from **More app actions**. Customization uses
the Creative mode icon; the default action group has no reload icon.

Each app can customize `chrome.titlebar` in its `meta.json`: title and icon
visibility, alignment, density, app button shape, semantic colors,
and app action buttons. Draft previews include the same titlebar renderer used by
the native shell. The titlebar logo is hidden by default; set `showIcon: true` to
display it. The settings travel with imports, marketplace packages, saved
versions and rollbacks. App actions emit `chrome:action` in the current view;
minimize, maximize, drag, resize, close and return remain host operations.
System button placement and appearance follow the host platform. Legacy
`controlsPosition` values are preserved but do not move system controls. macOS
keeps the main window's toolbar height and native control inset for both densities;
draft previews reserve that space without drawing imitation traffic lights.
Missing configuration uses the default custom titlebar. Existing exported apps
need **Update system app** and a restart to use the new Shell. Older hosts and
Shells remain compatible; custom chrome support is advertised as
`miniapp_custom_chrome_v1` without changing the v1 launch-record format.

Installed MiniApp cards offer **Open in app** and **Open in a window** before
launch, including when an update is available. Running state appears on the
same card. Selecting the current destination focuses it; selecting the other
destination transfers it after confirmation. App details provide **Stop** and
**Add system app** without requiring a launch first. A tab also provides **Open in
a window** and **Add system app**. Every generated icon carries the OpenBitFun
mark in its bottom-right corner. System launchers are placed in the user's
Applications folder on macOS, Start Menu on Windows, and application menu on Linux.
System app names show the app title without internal IDs. Once added, app details
and the tab header offer **Update system app** and **Uninstall system app**.
Updating refreshes older numbered or oversized launchers. Uninstalling removes
only owned system entries, retaining the MiniApp, saved data and running tasks;
it can be added again later. Removing an entry through the OS is also detected
when app details are reopened.

The system launcher can start OpenBitFun in the background. Closing the last tab
or independent window stops that MiniApp's Worker, Agent runs and streams.
During a window/tab transfer, a prepared destination keeps the instance alive;
late close notifications from the source do not stop it. **Stop** ends an instance
even while a presentation is open. A crashed shell is cleaned up after its lease
expires. Refreshing, hiding a window or switching device surfaces is not a close.
An explicit quit of OpenBitFun ends its host runtime. Window/tab switching reopens
the document and retains saved data; save unsaved page state before confirming.
The source closes only after the destination is ready. One installed app is bound
to one workspace per host until its instance is stopped.

Each native window uses a separately built **MiniApp Shell**, which contains only
the window, local system adapters and private IPC. Agent execution, storage,
tasks and instance management stay in the shared OpenBitFun host. macOS exports
copy this small executable plus the icon and app identity; Windows/Linux entries
point to the installed shell. The full Desktop program is never copied into an
export. Updating an older system app upgrades its executable while retaining
its launch identity and saved data.

On macOS, Dock icons come from each MiniApp bundle's own ICNS. Independent
windows and system installations use the same catalog glyph and fixed brand
watermark, with a rounded body and transparent canvas inset. The shell always
uses bundled resources, including beside a development host, so Tauri cannot
replace the Dock icon with the OpenBitFun development icon. After upgrading an
older exported app, choose **Update system app**, then quit and reopen that
MiniApp to load the new executable and icon.

The normal development and packaging commands prepare the optimized shell
automatically. After changing shell Rust/HTML during an existing development
session, run `pnpm run prepare:miniapp-shell` before reopening the MiniApp.
Direct Cargo Desktop builds need the same preparation once. Packaging uses
Tauri's `externalBin` for platform placement and signing; raw builds require the
adjacent `openbitfun-miniapp-shell` executable (`.exe` on Windows).

An independent window displays its own Agent permission requests through the
shared runtime mailbox. Legacy MiniApps that call `agent.cancelStaleRuns` on every
reload must use explicit per-turn cancellation instead in managed instances;
automatic reload cleanup is rejected to preserve running work during transfers.
The independent shell uses the configured light/dark mode at launch; its native
chrome does not yet mirror live theme customizations from the main window.

Independent windows have an app-specific **Hi** chat panel, enabled when the app
claims the composer through `app.chat.claimComposer()`. The app can supply its
title, welcome text and suggestions; messages continue through its existing
`chat:userMessage` handler and Agent session. The panel follows only the app's
bound topic and supports streaming replies, per-turn Stop and approval hints.
Its launcher, floating panel, message typography/bubbles and composer compile
the same style sources used by the main window's Hi and FlowChat. This shares
appearance without adding React or the main window's runtime to the Shell.
Collapsing or releasing chat does not stop accepted work. After a MiniApp closes
or transfers to an independent window, the main window's Hi collapses when only
its pinned control conversation remains (or no tabs remain). Other conversation
tabs keep it expanded; topic switches and reloads do not trigger this cleanup.
Compatible hosts advertise
`miniapp_chat_snapshot_v1` to restore the latest 16 turns plus current execution
after a reload or event gap; older hosts keep live chat and display the history
limitation. Existing system apps need **Update system app** and a restart to
load the new Shell chat assets.

Independent presentation is unavailable for remote workspaces, Peer Device Mode,
mobile/bot control, and detached CLI jobs. These entry points do not silently
launch a local copy. App content control is reserved but not yet advertised.

## OpenCode model services

In **Settings → Models**, add **OpenCode Zen** for free models or pay-as-you-go
access, or **OpenCode Go** with your Go API key. Zen uses the public key when
the API key field is empty; paid models require your own key. Fetch the model
list to select each model's Chat Completions, Responses, or Messages route.

Free-model requests include OpenCode gateway headers and map the session's Bash
and Read tools to the gateway's lowercase names. If the model requests a tool
that the session does not provide, the request ends with an explicit error.
The public free-model route uses matching session headers and excludes the old
request header. This compatibility applies to the public Zen API-key connection;
it does not reroute Console OAuth credentials. To use a free model on this path,
choose OpenCode Zen with API-key authentication and leave the key empty (or use
the literal `public`).
Console OAuth remains a separate Zen authentication option; existing account
credentials and saved model configurations are retained.

## WorkBuddy and ZCode subscriptions

In **Settings → Models → Subscription accounts**, sign in to **WorkBuddy**
(China), **WorkBuddy AI** (international), or **ZCode**. ZCode asks you to choose
**Z.ai** or **BigModel** when you start sign-in. Connected regional accounts
stay visible separately under ZCode so each can be imported or signed out.
Finish sign-in in the browser, return to OpenBitFun, choose **Use as model**,
then select models from the live catalog. Authorization runs on the model host;
the verification page can be opened on another device. Credentials are kept in
OpenBitFun's vault.

WorkBuddy uses renewable account tokens and its Chat Completions gateway.
ZCode browser sign-in reuses or creates the selected project's `zcode-api-key`
(a team's `zcode-team-api-key`) and uses the Coding Plan Messages endpoint.
Personal subscriptions and assigned team seats are supported. ZCode Start/gift
plans are separate routes and are not imported by this channel. A missing plan
or unavailable catalog returns an error instead of selecting another plan.

The real authorization-init endpoints were exercised on 2026-10-19. Completing
sign-in and model inference require the user's account; initialization alone
does not verify subscription eligibility or model availability.

## Subscription allowance

Subscription accounts are grouped by service. Each account has its own identity,
status, allowance and actions; identical email addresses retain distinct account
markers. **Add account** starts a new slot on hosts that advertise support.
Refreshing, importing and signing out target that exact slot; sign-out confirmation
lists only models and pools which reference it. ZCode keeps one service heading
with Z.ai/BigModel labels on its account rows.

Connected accounts show allowance in **Settings → Models → Subscription accounts**
and beside selected accounts in the model editor. Codex shows its reported rate
windows and additional model limits. WorkBuddy and WorkBuddy AI show remaining
credits, including enterprise usage; ZCode (Z.ai and BigModel) shows its reported
Coding Plan windows, with MCP calls shown separately. Totals, reset times and plan
expiry appear only when the provider reports them. Other channels explicitly show
that allowance lookup is unsupported.

OpenBitFun reads allowance from the account's host, supports manual refresh, and
refreshes visible active panels once per minute. A failed refresh retains the last
observation with a stale indicator. Unknown amounts stay unknown; zero and
unlimited are distinct. These WorkBuddy/ZCode observations are informational and
do not change model routing. Older peers without the quota capability show an
unsupported-host state.

Grok OAuth accounts show the reported billing period and optional on-demand
usage in the existing subscription account panel. Reads use the selected account,
including its CLI headers. Peers require `grok_quota_v1`; older account-quota
support does not imply Grok billing support. These observations are display-only.

OpenCode Go API-key models show 5-hour, weekly and monthly usage in their connection
editor after the connection is saved. Keys stay on the configuration's host, and
older peers require the separate `subscription_model_quota_v1` capability before
receiving model-scoped requests. Invalid keys and keys without Go entitlement show
distinct messages. Idle windows do not show placeholder reset dates. This endpoint
does not report monetary balances. Zen/Console balance lookup is unavailable while
[the upstream balance API request](https://github.com/anomalyco/opencode/issues/10448)
remains open; use **Open console**. Public free-model access explicitly states that
remaining free usage and reset times are not exposed. Console OAuth is never sent
to Go's API-key billing endpoint. Local HTTP/DOM fixtures cover these paths; live account
billing and physical remote hosts have not been verified.

## Subscription routing status

The Models settings frontend was restored to upstream/main on 2026-10-16.
That rollback withdrew the earlier account cards, quota panels, account/channel
editors, enhanced usage displays, chat diagnostics and account-aware frontend
API/Peer wiring. The current subscription sign-in and allowance panels are
described above.
Existing account credentials and configurations are retained; this UI rollback
does not enable, disable or clear account pools.

The native backend still supports provider-scoped account slots, credential
isolation and explicit account/channel failover. See the
[architecture and current limitations](../../../docs/architecture/subscription-account-routing-design.md).
Earlier full Desktop mock results refer to the withdrawn UI version and do not
prove integration of these controls in the current Models page. Real providers
and physical remote hosts remain unverified.

The backend retains account/channel usage attribution; the frontend has its
original statistics display.

## Session storage directories

The workspace and session action menus include **Open session storage directory**.
The workspace action opens its managed sessions root; the session action opens
that session's subdirectory. Empty workspaces create the sessions root on demand.
Remote SSH/Docker workspaces open their locally stored session mirror, not the
remote project directory. These actions are unavailable in Peer Device Mode,
browser clients, and for detached sessions owned by another host.

For manual recovery, exit every OpenBitFun instance using the session and back
up its complete directory before editing or moving files. Moving a directory
does not update the workspace bindings in its metadata or saved configuration.

## Computer Use control

Computer Use opens a visible control session. Its status card shows the current
target and mode, with a preview and **Stop control** button. The preview displays
the agent's virtual pointer separately from the captured application pixels.
Stopping from the card, the operating system, or task cancellation revokes the
session; a new explicit start is required. Sharing also ends when the turn ends.

The tool's `start_control` action selects `observe`, `background` (the default),
or `foreground`. Observation cannot send input. Background actions preserve your
foreground application and physical pointer where the application supports
semantic or directed input. A request that needs the desktop keyboard/mouse seat
returns a foreground requirement rather than silently switching control mode.
On macOS, native accessibility actions and an exact-window directed-input route
support background operation without taking over the human foreground window.
The directed route prepares only the target's internal focus, preserving the
requested mouse modifiers. Foreground mode remains separate and can use your
physical pointer and focused keyboard input.

The directed route passed a full five-action Tool/native program on a dedicated
canvas: click, text, menu shortcut, scroll and emoji input, with one final
observation. The observer kept its foreground focus and window order; its input
and the human cursor were untouched. The measured 466 ms includes observation,
not model reasoning. This proves the tested controls, not universal support for
every application.

Claw, Cowork, Standard and Creative agents can use ComputerUse directly; the
ComputerUse subagent is optional. Known input sequences can use `app_batch` with
one final observation. Every step is checked before the first input, including
image identities, coordinate ranges and grid indices. A partial failure retains completed input receipts so
already submitted text or commands are not replayed. Visual models can target
unlabeled controls and canvases using pixels from the bound window screenshot;
missing accessibility labels do not by themselves prevent visual observation.
The capabilities reported by `control_status` describe available backend routes,
not support for every control or gesture. For a known search field that submits
on Return, combine text with `focus` and a Return key step, then inspect the
results before selecting one. Focus-and-type by itself is already one call;
batching cannot repair an unavailable input route.

ComputerUse also reads and writes plain text on the **runtime host's clipboard**:

```json
{"action":"clipboard_set","text":"Text to copy\nincluding another line"}
{"action":"clipboard_get","max_output_bytes":65536}
```

These actions work on Windows, macOS and Linux without activating an application.
They do not paste or submit text. `clipboard_set` replaces the clipboard; an empty
string clears its text. Unicode and line endings are preserved. Text containing
NUL or exceeding 16 MiB is rejected. `clipboard_get` returns `text`, the original
`byte_length`, and `truncated`; its output limit defaults to 64 KiB and caps at
1 MiB, ending on a UTF-8 boundary. The older `max_bytes` name remains accepted.

Windows uses the built-in Windows PowerShell and Windows Forms clipboard APIs;
macOS uses AppKit through the built-in JavaScript bridge. On Linux, install
`wl-clipboard` for Wayland, or `xclip`/`xsel` for X11, and run OpenBitFun in that
desktop session. Wayland does not silently fall back to an XWayland clipboard.
Helpers have a ten-second deadline. A failed write may already have changed the
clipboard; inspect it before retrying. Image/file clipboard formats are not
exposed by these text actions.

Clipboard access obeys the ComputerUse session and Stop. Window-only sharing
does not grant access to the global clipboard. SSH workspaces and headless hosts
reject these actions; a remote controller uses the executing desktop host's
clipboard, never its own local clipboard as a fallback.

On macOS, persistent ScreenCaptureKit window sharing uses the system's sharing
controls. macOS 12.3 or newer is required for capture; system indicator appearance
depends on the OS version. Hidden or minimized targets must be restored before
observation. On Windows, Windows.Graphics.Capture retains the native capture
border. Background controls use UI Automation and supported window messages;
standard Edit/RichEdit fields preserve unselected text when inserting or
replacing the current selection. A field may be selected by its observed node,
image coordinates, or the bound window’s existing focused native edit control.
Unsupported providers return a capability error. These Windows paths have
cross-compilation coverage; interactive Windows acceptance is still pending. Windows does not
have the macOS Sharing menu.

Windows accessibility requests return after ten seconds if the application's
provider stops responding. Stop remains available and prevents input that has
not yet been submitted. An `INPUT_OUTCOME_UNKNOWN` error means the application
may still complete the input: wait for it to recover, then observe before taking
another action. OpenBitFun does not automatically repeat the click or text. While
that native call is still running, new accessibility requests return
`AX_PROVIDER_BUSY`; a provider that never returns requires the target to recover
or OpenBitFun to restart. A missing preview only means no valid image is available
(including observations requested without images); it does not mean that the
control status is unavailable.

See the [cross-platform control contract](../../../docs/architecture/computer-use-control.md)
for platform limits, lifecycle guarantees, and native verification scenarios.

### Ubuntu

On Ubuntu GNOME, Computer Use uses the system desktop portal for screen sharing
and foreground input. Start a control session, then approve the surface and
input devices in the system dialog on the machine running Desktop. GNOME owns
its sharing indicator and stop control. Stopping sharing revokes further input;
OpenBitFun never falls back from Wayland to X11 input after denial or disconnect.
Foreground portal input controls the desktop seat and can move your real pointer.

Background application operations use AT-SPI semantic actions and EditableText
when the application exposes them. Read the application state first, then use
its node index. Background coordinate clicks, arbitrary key chords, and games
without accessibility support require foreground mode. A portal-selected image
is bound when portal authorization completes and is not automatically assumed
to belong to an AT-SPI application selected by PID. A running session cannot
silently rebind its stream within the same generation.
Applications must expose accessibility information for semantic control.

The `.deb` package declares GStreamer and portal runtime dependencies. For an
AppImage or a directly launched development binary on Ubuntu, install:

```bash
sudo apt install gstreamer1.0-pipewire gstreamer1.0-plugins-base gstreamer1.0-plugins-good xdg-desktop-portal xdg-desktop-portal-gnome
```

Source builds additionally need `libgstreamer1.0-dev` and
`libgstreamer-plugins-base1.0-dev`. A running user D-Bus, PipeWire, and a compatible
desktop portal backend are required. Other desktops must install their own
matching portal backend; installing GNOME's backend does not give a headless
server a desktop. Missing plugins or portal capabilities produce explicit errors.

Remote controllers see the execution host's authorization state. System portal
consent may require a person at that host. SSH workspaces and headless CLI jobs
do not acquire a GUI or control the controller's local desktop implicitly.

For focused Linux verification, run
`node scripts/test-linux-computer-use-native.mjs -- --test-threads=1`.
`bash scripts/test-linux-computer-use-atspi.sh` creates its own GTK controls and
checks semantic activation and Unicode selection replacement while preserving
unselected text.
For a headless fixture run, use
`dbus-run-session -- xvfb-run -a bash -lc 'export NO_AT_BRIDGE=0; bash scripts/test-linux-computer-use-atspi.sh'`. `bash scripts/test-linux-computer-use-portal.sh` requires a
real desktop and asks you to select its dedicated fixture window in the system
picker. These fixtures require Node.js 22/24, Rust, `python3-gi` and GTK 3; the
portal fixture also needs the runtime packages listed above.

## macOS application icon builds

Development uses the committed macOS ICNS fallback and does not require Icon
Composer. Packaged macOS 26/27 builds also include the native Icon Composer
catalog; earlier macOS releases use the static fallback. Building a distributable
macOS bundle requires full Xcode 26 or newer selected through `DEVELOPER_DIR` or
`xcode-select`. The packaging command rejects a missing catalog instead of
silently shipping only the legacy icon. See the
[brand resource guide](../../../assets/brand/README.md#macos-icons) for regeneration
and focused validation commands.

## macOS menu bar

The menu bar uses the solid ring brand mark as a transparent template logo that follows the system's light
and dark appearance. The number beside it counts sessions with unread completed,
failed, or interrupted results in the current device's loaded session list.
Transient and internal subagent sessions are excluded. Viewing the result in a
focused conversation acknowledges it; the number disappears when none remain.
Clicking the menu bar icon always shows and focuses the main window, including
when it is already visible; repeated clicks never hide it. Opening the main
window alone does not mark other conversations as read.

When viewing a peer device or SSH workspace, the count follows the displayed
sessions and updates the controller Mac's menu bar. It does not change the
remote host's tray or execution state.

## Application updates

New versions appear in a fixed 368 × 224 px bottom-left card that stays until an explicit
action. Only narrow viewports constrain its width; content and update status do not
resize the card. Clicking outside does not dismiss it. The card shows up to three lines
from the first paragraph of the release notes, omitting Markdown formatting and
decorative content. Releases without a summary use a quiet brand imprint and fine
rules in the reserved body area, without placeholder copy. The actions remain at
the bottom, and long error messages use a two-line preview with the full text on hover.
Errors reduce the introduction to one line to keep feedback and retry controls visible.
Select the version title to open the full release notes in a 600 × 480 px details
dialog, constrained by the viewport. Both cards share a frosted surface with an even,
softly blurred blue and cyan tint at low intensity. Semantic color and blur
tokens keep this material consistent across themes. Dark mode gently lifts the base,
adds a broad soft reflection and a thin inner highlight, and retains a muted cyan
companion to the icy blue tint. High-contrast and
reduced-transparency modes use a solid surface. The dialog header shows the product and release version
once. Release notes are always expanded, with a clear introduction, compact
section headings, and evenly spaced list entries. Typography uses semantic
dialog-title, body-md, section-heading, and supporting-text roles; introduction
and details share the same standard body size. A space-8 gap separates the title
from the reading area. The header, reading column, and footer share one inset.
The body scrolls while
the standard dialog footer keeps update actions and download progress visible.
The footer uses the primary action for download or install and a neutral action
for skip or restore; downloading shows only a progress bar. No-summary releases
center a larger official brand mark on the same frosted surface, filling the
reserved body without placeholder copy or a repeated version number.
Closing the card or reading the notes keeps a blue dot on the bottom-left
settings gear and **Check for updates** in its More menu. Hover to see the
available version, or select the menu item to reopen the download/skip card.
**Skip this version** suppresses reminders for that version only. An explicit
manual check can revisit a skipped release without restoring automatic reminders.

Choose **More → Check for updates** for a manual check. The single menu row shows
only the action and its temporary checking state. Up-to-date, already-downloaded,
and failure results use the notification system; an available release reuses the
download/skip card. Results still arrive if the menu closes during the check,
and reopening the menu does not replay them. Checking never opens About or starts a download.
The menu item is always present in desktop builds, including development.
Manual checks use the configured update feed. Development builds skip automatic
checks and do not restore discovery from previous runs; starting the app or opening
More cannot create a new-version reminder without a manual check in that run.
Packaged builds restore only valid discovery for the installed host version.
Available releases must have a higher semantic version: an equal version, an older
release, or build metadata alone never creates a reminder. The displayed `-dev`
suffix is a UI label and does not participate in update comparisons.
Browser-only surfaces omit desktop update actions.
About only contains
product identity and build information.

Choose **Download update** to download and verify an update while continuing to
use OpenBitFun. Downloading does not install or restart the application.
When the navigation footer is visible, a dot travels from the download button to
the circle beside **More**. Only after it arrives does the navigation circle appear and the
card close. The circle fills from bottom to top using downloaded bytes, with a
gently flowing wave along the rising surface.
Hover for the percentage, or select it to reopen the progress card.
Hover subtly enlarges and brightens the circle itself, and pressing gently
compresses it. The surrounding hit area stays transparent, while keyboard focus
retains the design-system focus ring. Reduced motion keeps this feedback stationary.
The progress card retains the version and introduction, with only a progress
bar along the bottom and no status sentence or percentage text.
Until the total size is known, a shallow wave flows continuously along the bottom
of the same circle, with a steady fill level and a tooltip showing the downloading
status. As soon as the total arrives, the same wave continues flowing while its
level follows real byte progress. No dot-grid spinner or fabricated percentage
is shown; reduced motion disables the wave animation and fill transitions.
Keyboard activation and reduced motion use an immediate handoff; hidden
navigation keeps progress in the card.

When the download finishes, the navigation circle changes to a solid success
color with no border and a contrasting checkmark. No completion card or dialog
opens automatically. Select the checkmark to open the installation confirmation
directly. More no longer shows a reminder for the downloaded version.
Failed downloads return to the reminder in More; an older downloaded package
keeps its own installation checkmark if a newer download fails.
Installation restarts OpenBitFun on this device and interrupts its active sessions.
Choosing **Later**, or closing the confirmation, keeps the downloaded update.
The checkmark remains available whenever you are ready.

Downloaded updates remain available after closing and reopening OpenBitFun.
After reopening, the current updater requires access to the update server to
restore installer metadata, but does not download the package again. If this
step or installation fails, the pending update remains available to retry.
Use **Download again** in the error dialog if the cached package is damaged.

Application updates always belong to the local desktop, including while viewing
a peer device or a remote workspace. They do not install software on the peer or
cancel independently running detached jobs on another host. Connections through
the restarting desktop are interrupted.

## Windows WSL workspaces

In the remote connection dialog, choose **Workspace target → Windows WSL**.
Select an installed Linux distribution, optionally enter a Linux user, then
connect and choose a folder inside that distribution. **Refresh distributions**
reloads the list after you install another distribution. No SSH server or SSH
credentials are needed. WSL must already be installed and the distribution must
have completed its first-run setup on the Windows host.

Files, search, Git, Agent commands, and terminal sessions use the selected Linux
filesystem and processes. Paths use POSIX separators. Saved connections retain
the distribution and optional user for reconnect; omitting the user uses the
distribution's configured default user.

In Peer Device Mode, the selected Windows Desktop host owns WSL discovery and
execution. Older peers and CLI peers explicitly refuse native WSL setup;
non-Windows hosts show an unsupported state. Existing mobile and bot session
controls can continue driving a host session, but do not expose WSL connection
setup. Detached Dispatch does not provision WSL connections. SSH port forwarding
is unavailable for native WSL targets; use Windows WSL networking to reach a
Linux service.

## Remote SSH file handle errors

If writing files and browsing directories both start failing with
`Limit exceeded: handle limit reached`, update OpenBitFun to a build containing
the SFTP handle-lifecycle fix. Earlier builds can exhaust a client-side counter
even when the server has already closed the files. Save ongoing work before
manually disconnecting and reconnecting the remote workspace as a temporary
recovery; reconnecting can interrupt its terminals and commands.

This message alone does not establish a server configuration problem. Raising
server limits only delays a leaked-counter failure. Running `ulimit` in a new
SSH shell does not change the limits of the already-running SFTP subsystem.
OpenBitFun does not modify the remote user's shell startup files, SSH daemon
configuration, or OS limits automatically. If the problem persists after the
fix, capture the OpenBitFun version and logs plus the server's SFTP implementation
and advertised limits so genuine concurrent-handle or server resource exhaustion
can be distinguished from a client lifecycle problem.

## Development startup

Run `pnpm run desktop:dev` from the repository root. The launcher prepares
Flashgrep and the locked Sherpa speech libraries before compiling Desktop.
Sherpa libraries or archives are reused from the current target cache or the
main Git checkout's target cache. If absent, curl downloads the version-specific
archive, supporting HTTP and SOCKS proxies; Cargo handles extraction and linking.
Explicit `SHERPA_ONNX_LIB_DIR` and `SHERPA_ONNX_ARCHIVE_DIR` overrides are preserved.

When another worktree uses the default ports, start a separate dev server:

```sh
OPENBITFUN_DEV_PORT=1432 pnpm run desktop:dev
```

HMR uses port 1431 in this example; `OPENBITFUN_DEV_HMR_PORT` can override it.
The launcher supplies the same HTTP URL to Tauri that Vite listens on, and both
the main window and companion window read that configured URL.


## Windows release signing (maintainers)

`Desktop Package` uses Certum SimplySign on the hosted Windows runner. Configure
these repository Actions secrets before publishing a release:

| Secret | Value |
| --- | --- |
| `CERTUM_USERNAME` | SimplySign login account |
| `CERTUM_OTP_URI` | Full `otpauth://totp/...` provisioning URI, including its original algorithm, digits and period |
| `CERTUM_KEY_ID` | SHA-1 fingerprint of the activated Code Signing certificate |

The OTP URI is provisioning data from the activation QR code, not a current
mobile token, an email activation code or the certificate PIN. Do not paste it
into an issue, PR, log or online QR decoder. Certum's
[activation instructions](https://support.certum.eu/en/how-to-activate-access-to-simply-sign-application/)
describe the activation-link email and separate activation-code email used to
show the QR code. If the original provisioning data is unavailable, contact
Certum/the reseller about regaining access; do not assume the Desktop login can
export it. Replacing the provisioning seed also requires updating the CI secret
and potentially reactivating the mobile app.

The workflow compiles with `--no-bundle`, then opens the SimplySign session.
`--bundle-only` in the Desktop build wrapper runs `tauri bundle` using the same
product and updater configuration, without recompiling. Tauri signs the NSIS
payload and installer before generating updater `.sig` files. Since Tauri
restores the unsigned raw Desktop EXE after bundling, the workflow separately
signs that EXE before the custom installer hashes and embeds it. Finally, it
signs the custom installer. Subsequent release staging copies/renames those
bytes and generates the existing updater/manual-download signatures.

Verification requires Windows Authenticode trust, the configured signer and a
timestamp. Any failure blocks artifact upload. A publication run requires all
three secrets; an artifact-only run with none configured explicitly builds
unsigned packages. Partial configuration always fails. No PFX/private-key export
is required, and the existing Tauri updater key remains unchanged.

Login uses a pinned community action, not an official Certum CI API. Its GUI
login compatibility and any additional certificate PIN prompt must be validated
with the actual account before the first signed release. Diagnostic screenshots
are disabled. A timed-out signing step must be investigated rather than bypassed.
Only trusted release code should receive the secrets. Code signing identifies
the publisher; it does not guarantee that SmartScreen reputation warnings vanish.

Focused checks:

```sh
pnpm run check:github-config
node --test scripts/desktop-tauri-build.test.mjs OpenBitFun-Installer/scripts/build-installer.test.cjs
pwsh -NoProfile -File scripts/ci/sign-windows.test.ps1
```

The PowerShell test uses mocked signing results; a Windows build with the real
certificate is still required to prove cloud signing and timestamp/trust validation.

## Marketplace sources

Open the **Skills** scene, choose **Skill Marketplace**, then **Marketplace sources**.
The default source is the enabled official `https://skills.sh` marketplace. You can
edit, disable or remove it, add sources, and save an empty list to stop searching.
Each source has its own name, API format (**skills.sh** or **SkillHub**), deployment
root URL, optional Bearer API token and enabled state. Include any deployment
subpath, but do not append `/api/search` or `/api/v1` to the root URL.

All enabled sources are searched concurrently. Results are interleaved, labelled
with their market name, and retain their installation identity. Errors from one
source are shown without hiding successful sources. The original `SKILLS_API_URL`
environment override applies to the default official skills.sh URL; an explicitly
configured custom URL takes precedence. Disabling or deleting the official source
also disables its environment override.

SkillHub uses its ClawHub-compatible search API and native ZIP download API, and
installs supporting files into OpenBitFun's user or project Skills directory. An
existing destination is preserved and reported as a conflict. skills.sh-compatible
sources use the existing repository-based `npx skills` installer: a custom search
API does not supply a custom ZIP download protocol.

Tokens are stored in the serving host's application configuration; browser login
sessions are not shared with OpenBitFun. The market is currently available in the
local Desktop scene. Peer mode and older hosts show unsupported states. SSH/Docker
project installation remains unsupported; choose user scope to install on the
serving host. Mobile/bot controls, CLI peers and Detached Dispatch do not gain a
marketplace configuration or installation entry point.

## WeChat session result notifications

While the WeChat bot is running, completed turns in its currently selected local
session can send their text to WeChat without a new incoming message. This includes
scheduled jobs and turns started in the desktop window. Turns started by that same
WeChat bot retain their normal reply path and are not pushed a second time. Failed
turns and empty output are not pushed. Use a dedicated session if desktop activity
should not appear in WeChat.

Delivery still needs a valid WeChat reply context and available channel quota;
this feature does not bypass either restriction or impose an additional daily
three-message limit. Several queued results are combined into one reply of at most
4,000 UTF-8 bytes, favoring the newest results. Longer output is truncated; the full
answer remains in the session. These pushes share the channel quota with normal
replies, including any split replies.

Unavailable reply context and send failures keep output in a bounded, in-memory
queue for retry. Sending another WeChat message refreshes the reply context and
wakes the sender. The queue holds at most 20 results per recipient for 24 hours;
older entries are discarded. Restarting or replacing the bot clears pending output.
This is best-effort notification, not a durable message inbox. Switching sessions
or devices discards output from the previous selection before sending.

Proactive notifications currently require the session runtime and WeChat bot to
run on the same OpenBitFun host. A session on that host may use an SSH workspace;
this does not make it an account-device session. When switching the bot to another
account device, the existing reply includes an explicit notice that proactive
scheduled-job and desktop-result notifications are unavailable there. Ordinary
WeChat-initiated requests keep their existing cross-device reply path. This feature
does not add cross-host Peer Device or Detached Dispatch result delivery.

## Model pools

In **Settings → AI models → Model pools**, create named pools from existing model
configurations. Add/remove members, move them up/down, and choose **Ordered** or
**Balanced**. In a native chat's model menu, switch to **Battery mode** and
choose a pool. Its summary shows the pool name, the last accepted concrete member
and the routing strategy. Click the pool name to choose another pool; manual mode
continues to list only individual models. Pool requests use
each member's configured defaults; session reasoning overrides are hidden while
a pool is selected. A successful explicit model or pool choice is remembered for
new native chats. Existing chats keep their selection; automatic pool failover
does not change the preference. Subagent defaults, built-in overrides and fork
defaults accept a model, a pool, or parent inheritance; a child owns its binding.

Ordered uses the first eligible member when establishing or replacing a binding.
Balanced rotates new assignments across eligible members. Both preserve a healthy
chat binding, even when a higher-priority member recovers or the pool is reordered.
This balances assignments within one Runtime, not tokens, cost, or work across
independent hosts. Native child agents that inherit the parent choice inherit the
pool and receive their own assignment; externally approved fixed bindings stay fixed.

Health comes from actual requests, without background quota or balance queries.
Network failures, throttling, quota exhaustion and unavailable providers cool down;
authentication, billing and permission failures require attention. After cooldown,
one live request probes the member. The **Retry** action permits another attempt
after repairing configuration. Disabled, deleted and incompatible members are
skipped. Health is shared when multiple pools refer to the same model configuration.

Image requests are checked before submission and again when selecting a member.
A text-only member remains eligible when it can call `analyze_image`, the Agent
allows that tool, and a separate enabled image understanding model is configured.
Otherwise the pool skips it and selects a compatible multimodal member. Images
in inherited context and later user steering follow the same rule; tool-result
pixels require native image support. Request incompatibility does not mark a
member unhealthy or change the pool's shared context budget.

Each member retains ordinary response recovery, up to ten attempts including the
initial request, with the existing early-stop rules. Before effective output,
network failures, timeouts, throttling and unavailable providers switch promptly
when another eligible member is ready. Without an alternative, the same member
retains ordinary retries. Authentication, permission, billing and quota failures
can also switch members; invalid requests, content-policy rejections and
cancellation cannot. Empty or malformed responses and unclassified provider
failures use member-local recovery first, then may switch without marking that
member globally unhealthy.

Pool traversal has no shared ten-attempt cap: each failed member is excluded for
the current recovery traversal, so an eleventh member remains reachable. Retry
backoff and cooldown use the current member's attempt count. Failover is forbidden
once any attempt in the logical round has produced effective output, even if a
later attempt fails before output. Existing same-model stream recovery remains
available; cross-member recovery never replays output or completed tools.
Switching updates model-specific prompt/tool configuration and provider replay
projection. If no compatible member is available, the request
fails with member states and the earliest known retry time; it never silently
uses the primary model or another pool. Deleting a pool preserves chat references
and any default pointer so users can explicitly select a replacement. Pool edits
run under the main configuration write lock; concurrent edits to the same pool
use the last saved value without stale-draft conflict detection.

Pool chats and subagents use the smallest resolved context window among valid,
enabled text members. The compression trigger is the smallest member input budget
(its context window minus its output allowance and safety reserve), which can
come from a different member. Offline and cooling-down members still contribute;
request-specific tool/image filtering does not expand the common budget. Member
configuration and output limits remain unchanged. Automatic and manual compression
share this budget, and each model round refreshes it after configuration edits.
The selector tooltip shows the pool window and compression trigger above the
current member's details. Limits come from the execution host, including Peer
Device Mode; the controller never substitutes its own model configuration.

Pool definitions are stored in the main configuration at `ai.model_pools`.
New pools receive an ID such as `model-pool-a7k2m9`: six random lowercase letters
or digits after the prefix. The execution host checks for collisions while saving;
renaming or editing a pool preserves its ID and chat references.
Typed defaults live in `ai.agent_model_selections` (`mode`, plus
`subagents.default`, `subagents.builtin` and `subagents.fork`). An absent selections
section is converted from `ai.agent_model_defaults` during configuration loading
and persisted atomically. Migration only adds the new field to the existing file;
startup recovery does not rewrite unrelated source records. Once present, the
whole typed section is authoritative, including empty builtin overrides. Invalid
or null selections are retained and fail visibly instead of falling back.
Imports, whole-config/AI replacements and installer-config repairs perform the
same migration at their ingestion boundary. Fresh configs and resets initialize
typed defaults directly. Runtime reads require the new section; ordinary field
updates and saves do not perform legacy migration.
Legacy defaults remain readable by older versions but are no longer updated.
Legacy client write requests are translated into typed updates on the new host.
Old versions may discard new fields when rewriting the main config; preserving
new settings across downgrade/write/upgrade is not guaranteed. The unreleased standalone pool file is no longer read.

Runtime health, cursors and bindings remain in `model-pool-runtime.v1.json`;
session metadata retains selection intent and the last accepted binding. Runtime
state and pool records do not contain copied API credentials. Pool definitions
and their containing section have no edit revision fields. Typed operations require the execution
host's advertised `model_pool_selection_v1` capability.

Desktop supports local and SSH/Docker workspace sessions through the shared Runtime.
BTW side questions inherit the parent's pool and current binding under both
routing strategies, preserving cache reuse while that member remains usable.
The BTW selector can explicitly choose another pool or a fixed model, including
before the first selected-text question. Peer hosts must advertise
`btw_model_pool_selection_v1` for these typed initial choices; older hosts retain
the inherited path without silently replacing a pool with its current member.

Peer Device Mode routes pool operations to capable Desktop/CLI hosts. Standalone
browser clients, detached dispatch, and ACP/external-agent model selection
do not expose pool selection in this version. Mobile/IM clients can continue a
host-owned pool chat, but their legacy model-change operation explicitly refuses
to replace a pool; use a capable desktop controller to change that selection.
Defaults are snapshotted when native sessions are created; unrelated auxiliary
model slots and externally approved immutable model bindings keep their rules.

Validation uses local unit tests, mock HTTP streams, transport capability tests,
and host compilation. These do not establish live SSH/Docker, relay/mobile/IM,
Peer Device or detached-dispatch behavior. No interactive UI validation was run.
