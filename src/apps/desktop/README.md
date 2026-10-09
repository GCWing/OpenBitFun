# OpenBitFun Desktop

For development commands, see [AGENTS.md](AGENTS.md) and the repository
[contribution guide](../../../CONTRIBUTING.md).

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
