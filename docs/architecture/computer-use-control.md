# Computer Use control-session SPEC

Status: Agent tasks select applications and execute through the existing tool
permission policy without a manual App-sharing or per-application grant step.
Optional manual-sharing APIs remain compatible for existing clients. The October
2026 migration implements permissions, coordinate mapping, virtual cursor
feedback and platform-scoped background input. Validation includes native macOS Tool/input/
capture checks, Linux GTK/AT-SPI execution and Windows native-module
cross-compilation. Windows native execution, GNOME Wayland portal execution and
remote end-to-end control remain acceptance gaps. Compilation is not native
acceptance, and background support is limited to each provider's declared routes.

## Product contract

Computer Use controls the GUI on the machine that owns the selected provider.
An active session identifies its target and mode, provides persistent feedback,
and can be stopped. Capturing an obscured window must return that window's pixels,
never the covering application's content or an unsolicited desktop capture.

Background mode must not raise a window, change the human's keyboard focus, switch
Spaces/desktops, or silently use global seat input. A backend's inability to meet
that contract must be visible. Foreground takeover requires explicit user
permission; approval of a message's content and recipient does not authorize it.
A generated agent plan cannot widen the original user's authorization.

The operating system owns privacy/sharing indicators. OpenBitFun neither imitates
macOS's Sharing menu on other systems nor suppresses native capture borders.
Product feedback adds target, mode, action, preview and Stop without claiming to
replace system consent or system Stop Sharing.

## Browser tool orchestration

`ControlHub.browser.navigate {url, observe?}` is the task entry point for rendered
pages. On Desktop it opens a built-in WebView when the conversation has no page;
otherwise it navigates that conversation's selected page. `observe: snapshot`
returns interactive refs and `observe: article` returns readable content in the
same call. Opening, connection, fixed sleeps and redundant reads are not required
preflight steps. The Desktop host correlates the exact requested WebView before
returning it; load/observation receipts separately describe readiness.

| Intent / action family | Contract |
|---|---|
| Discover / public HTTP | `WebSearch` discovers URLs; `WebFetch` reads public HTTP without browser cookies. These remain separate from rendered browser work. |
| Open / read rendered content | `navigate`, `snapshot`, `read_article`, `get` and its `get_text/get_html/get_url/get_title` aliases. `observe` avoids a second read after navigation. |
| Account / existing external tab | Prefer the Settings-selected, user-authorized CDP connection. `connect` selects an exact `session_id` or unique URL/title match without navigating it. An unbound navigation creates a new tab, preserving existing tabs. |
| Interact | `click`, `hover`, `fill`, `type`, `check/uncheck`, `select`, `press_key`, `scroll`, `auto_scroll`; use observed refs or selectors and refresh only when the next decision needs new state. |
| Readiness / capture | Condition-based `wait` and `screenshot`; built-in network-idle means native load completion, and full-page capture requires CDP. A duration-only wait requires no browser session. |
| Page lifecycle | `tab_new`, `back/forward/reload`, `close`, `list_pages/tab_query`, `switch_page`, `list_sessions`. Keep exact returned page identity across calls. |
| Page-context requests | `fetch` uses the selected page's credentials and CORS rules; `cookies/set_cookies` and `evaluate` remain explicit advanced operations. HTTP error responses preserve status/body; CORS/transport failure is a tool error. |
| CDP-only diagnostics | `network/network_requests`, `console`, `errors`, `trace`, `dialog`, `set_file_input_files` and allow-listed raw `cdp`. Built-in engines return explicit unsupported results. |
| Show empty product surface | `OpenBitFunControl.open(feature.browser)` shows the browser UI without inventing a URL. It is distinct from website navigation. |

The common actions use the existing `BrowserActions` engine port for WebView and
CDP. A conversation retains target/page identity; explicit or stale ids never
fall through to a different tab. Ending a conversation releases its selection,
not the user's browser pages. `open_builtin` and URL-bearing `read_article`
remain compatible aliases, including their legacy result keys.

Browser permissions are independent of `ai.computer_use_enabled`. External
browser identity/availability is exposed only after a Settings connection has
succeeded (or an opted-in startup connection receives browser-owned consent).
The Agent never starts another profile or opens permission settings through
`connect`. Disconnect blocks subsequent actions and clears page transports.
Explicit `mode: headless` remains an attach-only path for disposable project
browsers; product name and browser-reported user agent establish headless mode,
and a normal headed endpoint is rejected before page enumeration.

Navigation receipts distinguish a submitted navigation, load completion and an
optional failed observation. Observation failure never replays navigation or
input. Download and same-document transitions do not wait for nonexistent load
events. Full-page CDP screenshots use a document clip with
`captureBeyondViewport`, preserving viewport/emulation state; see the
[CDP capture contract](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-captureScreenshot).
Errors and recovery hints, complete bounded article text and fetch response
bodies survive assistant rendering. Partial action failures remain `ok: false`
with any receipts retained.

Remote-workspace sessions reject browser access before host IO; there is no
remote-workspace browser provider or silent controller-local fallback. A local
host driven through remote control or Peer Device Mode still owns its browser
provider/permission. Headless and detached hosts require an explicit available
CDP endpoint; they cannot create a Desktop WebView or prompt a disconnected
controller to approve a browser. Local unit/Chromium fixtures do not establish
mobile/IM, peer, detached, or native WebKit end-to-end behavior.

## Platform architecture

| Platform | Authorized observation | Input | System integration |
|---|---|---|---|
| macOS | Persistent ScreenCaptureKit `SCStream`, exact single-window filter | AX semantic actions; directed application events where supported; global input only with foreground authorization | System sharing integration and native stop; nonactivating AppKit feedback |
| Windows | Persistent Windows.Graphics.Capture window session | UI Automation patterns and supported targeted window messages; `SendInput` requires foreground authorization | WGC capture border and Closed event; product preview/Stop |
| Ubuntu Wayland | RemoteDesktop and ScreenCast portals sharing one session and its authorized PipeWire FD/stream | AT-SPI semantic actions; portal Notify seat input only in explicit foreground mode | Portal consent, compositor sharing UI and Session.Closed |
| Ubuntu X11 | Observe/foreground sessions use the same portal path; background semantic sessions need no picker | AT-SPI; missing portal capabilities fail explicitly | Product status/Stop; no claim of Wayland isolation for legacy X11 calls |

The control snapshot’s `capabilities` lists backend routes, such as semantic
input, directed keyboard/scroll or foreground seat input. It is not a promise
that every control supports a route; a background capability does not authorize
raw pointer gestures. Window capture, semantic input and arbitrary pointer input
are distinct capabilities. Portal selection does not identify a PID or authorize an unrelated
AT-SPI tree. Wayland seat input cannot provide isolated background coordinates.
Games, custom renderers, protected content, minimized/hidden windows and other
Spaces require explicit capability/error handling; no backend promises universal
background input.

## Ownership and execution

Portable DTOs and `AppInputAction` live in `tool-contracts`; the host port lives in
Core. Desktop owns native resources and platform adapters. Assembly must not own
OS APIs, native focus workarounds or concrete capture implementations.

The shared action catalog and structural target validation live in
`tool-contracts`. Desktop's `control_session/admission.rs` is a deterministic
owner/mode/lease state machine; its facade alone performs native cleanup and
carries tokens across workers. `desktop_host/observation.rs` coordinates native
reads, while `observation_cache.rs` stores bounded references without owning input
permission. `computer_use_geometry` adapts the independent `computer-use-rust`
project's image/content/surface mapping for all three platforms. The reference
project's macOS-only capture/input and standalone MCP/session shell are not a
replacement for the existing Windows, Linux or product runtime providers.

### Reference implementation migration

The five requested areas are adapted from `computer-use-rust` into the existing
product owners. The reference repository is development evidence, never a
runtime, build, test or filesystem dependency of OpenBitFun.

| Area | Reference source | OpenBitFun owner and adaptation |
|---|---|---|
| Permission query/request | `src/native/permissions.rs`, native permission probes | `computer_use_permissions` contracts, Desktop `permissions.rs`, `ComputerUsePermissions.tsx`; four separate read-only probes and explicit request receipts; Windows capability/UIPI facts and Linux AT-SPI/session consent replace macOS-specific assumptions |
| App sharing and control grants | `src/sharing.rs`, `src/grants.rs`, sharing controls in `src/gui.rs` | Admission state machine plus Desktop `sharing.rs`, `shared_preview.rs`, `process_identity.rs`, `grants.rs`, `share_grants.rs`; user-selected native window, observe first, separate revocable grant, executable-bound remembered preference, manual preview gestures |
| Coordinate conversion | `CoordinateMap` in `src/sharing.rs` | Portable `CaptureGeometry` and Web `previewGeometry.ts`; image/content/global/preview round trips, aspect fit, negative origins, independent X/Y scales, strict padding rejection and immutable screenshot identity |
| Virtual mouse | `src/cursor.rs`, GUI cursor rendering | Web `VirtualCursor.ts` ports the deterministic physical model, rendered by `PreviewCursor.tsx`; 63 Rust-generated reference samples cover movement, retargeting, immediate placement, resize and visibility. Existing passive native overlays remain platform adapters |
| Background control | Native directed/semantic input and desktop-state comparison | Existing AX/UIA/AT-SPI and directed-input providers plus `background_guard.rs`; diagnostic focus/pointer/window-order evidence, explicit unsupported routes, no restore or replay. Concurrent human input does not revoke Agent control. The reference's implicit Command modifier is not copied because it changes the requested click |

### Permissions and user sharing

Opening the OpenBitFun settings page, checking status or reading AX never requests OS permission.
The user selects each request explicitly. Receipts distinguish a request API
invocation from the current grant and from observing a visible OS dialog. Input
Monitoring is optional. Windows does not invent a macOS-style grant; protected
desktops, capture policy and target integrity still apply. Linux's portal grant
belongs to one selected session; AT-SPI availability does not grant seat input.

`start_control` enters the requested mode directly. An initial app action can
start background control implicitly. The Agent discovers applications through
`list_apps`, supplies the target selector and continues observation/input under
the existing Runtime tool policy. Application changes invalidate old references;
they do not require a user to select the next app. Background AT-SPI startup
does not open a portal picker. Linux portal capture and foreground seat input
still require compositor-owned consent.

The optional manual-sharing API uses `awaiting_share`, opaque process-bound
choices, observe-first capture and a separate revocable input grant. Its scope
does not apply to normal Agent tasks. Existing remembered preferences and manual
clients remain readable; no stored user grants are deleted by this correction.
Settings uses the established `ConfigPageRow` layout: desktop-control toggle and
the two required macOS permissions, with setup actions only for missing grants.
Input Monitoring, executable diagnostics and manual-sharing controls are not
part of this settings page. The missing-permission setup button explicitly
requests the corresponding OS permission on capable hosts before opening its
system pane; older hosts retain their existing system-pane action.

Remembering a grant is optional and never starts a share or selects a window.
The preference binds the canonical executable path, full executable SHA-256,
bundle identity when available and input mode; process start identity and file
metadata are checked around hashing. An updated executable requires a new
grant. The versioned bounded file preserves unknown fields and unreadable user
data; writes are atomic, privately permissioned and protected against concurrent
changes. Forgetting an active matching preference revokes input before disk IO.
Portal streams have no verified executable identity and remain session-only.

### Autonomous task execution

The built-in prompt carries the user's task through app discovery, observation,
input, verification and supported recovery. Routine app targeting, connection
alternatives and message composition do not create additional approval steps.
A request to compose and send specified information to a named recipient includes
composing the wording; the Agent verifies the recipient/content without asking
for the same authorization again. Genuine missing information, OS-owned consent,
explicit permission denials and user Stop remain authoritative.

Computer Use, Cowork, Claw and shared parent-agent guidance use the same autonomous
targeting and composition rules. Browser selection and connection are user-owned
Settings actions. Account-dependent work prefers the selected browser only after
connection/consent; a missing grant or user Disconnect cannot be bypassed through
ComputerUse, a different profile, or an agent-driven debugging setup. Native
browser chrome still uses independently authorized ComputerUse capabilities. `open_app` no longer has a platform-wide
foreground-only policy: macOS uses `open -g` and Windows requests
`SW_SHOWNOACTIVATE` for background launches. These are launch requests, not proof
that every third-party app honors activation policy; subsequent observations
establish actual state. Linux currently reports unavailable background launch
instead of silently using an activating launcher. Existing AT-SPI targets remain
usable. GUI-less hosts and remote workspaces do not fall back to the local GUI.

Manual preview input joins the same exclusive action lease as the Agent. Pointer
gestures retain their screenshot until release; resizing or revocation cancels
them. Click/right click/double click, drag, scroll, text and key input use the
native provider. The preview cannot pass Agent-owned AX indices. Input errors
revoke the grant and are never automatically replayed. Linux background sharing
shows the AT-SPI tree and exposes semantic Agent actions; it does not fabricate
pixels or coordinate input for an unrelated portal surface.

The app-input pipeline has one execution owner:

```text
single app_* call ─┐
                  ├─ validate → typed input program → dispatch_app_input per step
app_batch steps ──┘                                    ↓
                                            one final observation
                                                      ↓
                                            receipts + pixels/AX
```

`computer_use_program` owns ordered dispatch, receipts, cancellation checks and
final observation. Single-action aliases compile to the same typed program as
`app_batch`. The former four host methods combining click/text/scroll/key input
with a snapshot have been removed from the internal port. There is no separate
single-action recovery executor that can repeat a mutation or take redundant
intermediate observations.

A program selects one application and cannot switch target or mode between
steps. Click, text, key chord, scroll, drag and wait steps are all parsed and
validated before any input is dispatched. Structural checks include image IDs,
nonnegative image coordinates, grid dimensions/indices and nonempty OCR targets,
including text/scroll focus targets in later steps. Legacy shorthand coordinates
and node indices use checked integer conversion rather than wrapping onto a
different control. Native providers still validate live bounds and identity.
`dispatch_app_input` performs input
only. A known sequence can avoid intermediate model/AX/OCR/capture work; unknown
search results still require an observation before choosing a result. macOS and
Windows clicks have no implicit per-step settle sleep; explicit `wait_ms_after`
is preserved. A program takes its final observation through the capture provider
instead of multiplying a fixed delay by its step count.

For an observed search field whose Return-to-search behavior is already known,
a program can combine `app_type_text` with that field as `focus`, followed by
`app_key_chord` with `["return"]`. Inspect the resulting search results before
choosing one. Focus-and-type alone is already one input step. Model-facing schemas
retain this concrete combination for both image and node targets; a batch changes
neither native delivery capability nor authorization.

The executor checks active owner/generation/target scope before each step and
before final observation. Cancellation interrupts side-effect-free waits. Native
input returns its delivery result so partial delivery is not hidden by dropping
a future. Remaining steps are not run after failure or cancellation. Native macOS gestures also release any presses left unfinished by a failed or cancelled action, so a partial chord or drag cannot leave modifiers or mouse buttons held for the next action. An
observation completing after stop, rebinding or generation change is discarded.

For latency, the model starts with a known application's observation instead of
unconditionally listing applications, starting control and checking status. The
first app observation can enter background control; stopped sessions still require
an explicitly permitted restart. Prompt guidance groups already-decided inputs
until the next information boundary and reuses the returned observation. It does
not reduce the user's selected reasoning effort or impose step/retry-count caps.

`get_app_state`, `app_batch` and single app-input aliases accept optional
`include_image` (default `true`). With `false`, Desktop reads AX and refreshes
observation/node identities without retrieving or encoding a model screenshot.
This is suitable for sufficient semantic state or known keyboard flows. Canvas,
visual verification and selecting image coordinates still need an image-bearing
observation. Target preparation, control leases, cancellation and native consent
remain unchanged; AX-only is not a different input route. Legacy port providers
can retain their old capture path and omit the image from its result. Existing
callers/persisted tool calls omit the field and retain their previous behavior.
The option is local tool presentation, not a new remote GUI capability.

Program receipts include `observation_elapsed_ms` alongside per-step and total
elapsed time. These measure host execution, not model reasoning or end-to-end
latency. macOS focus-and-type/key operations take one desktop witness pair around
the complete operation, including an internal native focus click; nested witness
pairs are unnecessary. No native validation or post-input frame barrier is removed.

Receipts distinguish attempted steps, submitted steps, the failing step and
observation failure. A native error may follow partial submission. Neither that
error, a missing screenshot nor an unchanged AX digest authorizes replay.
Submission means accepted by the delivery path, not verified application success;
completion must be established by the resulting application state. The evidence
helper fingerprints every encoded byte, but hashes cannot measure changed image
area or establish completion. Its legacy loop API makes no loop claim from
repeated action names, mouse usage or identical frames. Automatic retry policy
is restricted to transient read failures; mutation errors never authorize replay.

Main agents can use ComputerUse directly when the host and tool configuration
allow it. The ComputerUse subagent is optional. Delegated execution keeps
`original_user_context` separate from `agent_plan`, with message provenance;
missing original context never becomes foreground permission. Browser automation
is preferred for attached web content, but a browser process name is not an input
authorization boundary for native chrome, dialogs or unattached windows.

## Session lifecycle and revocation

The Agent resource lifecycle is `idle → active(requested mode) → stopped|failed`,
with internal starting/cleanup transitions. One Runtime session owns the GUI
resource. Competing ownership returns `control_busy`; it does not create a
second permission owner or Agent loop.

An explicit tool start requests a mode under Runtime permission policy. Discovery
alone does not create capture. Linux portal capture binds the consented surface
separately from semantic application identity. Stop/status are idempotent. A
stopped generation requires an explicit restart, not a screenshot-driven
resurrection. The Agent may restart after recoverable target/capture loss, but
must respect a user stop or denial. Optional manual sharing retains its separate
`awaiting_share → active(observe) → active(granted mode)` lifecycle; revoking its
grant preserves observation and invalidates stale input workers immediately.

Stop revokes admission and advances generation before cancelling native work,
releasing owned pressed keys/buttons, stopping capture and hiding feedback.
Native Closed/Stop Sharing, cancellation, permission revocation and target loss
use the same owner path. Generation/sequence tokens cross blocking/native worker
boundaries; observation leases never carry input authority. Unknown actions fail
before admission. An unrelated executor cannot observe or rebind an in-flight
action without carrying its original token. Target revisions distinguish every bind, including A → B → A
in one generation, and native stop callbacks carry the stream's original revision.
Delayed work cannot borrow a later action's admission. Startup and
cleanup epochs prevent late callbacks from resurrecting or clearing newer state.
Native cleanup is serialized and rechecks its epoch after acquiring the cleanup
lock; a delayed cleanup job cannot tear down a restarted session.
Already submitted external effects cannot be rolled back.

## Observation, coordinates and model transport

A screenshot returns the authorized native capture's bytes, screenshot ID,
image/native dimensions and coordinate geometry. It does not perform a four-way
display search or require a confirmation crop. Screenshot admission requires a
supported control provider and a bound capture target. Legacy crop, quadrant,
reset-navigation and window hints remain accepted with an explicit ignored-field
notice; they do not select a new surface or grant authorization. Legacy DTOs
remain readable, without advertising their obsolete navigation workflow.

Image coordinates are meaningful only with the corresponding `screenshot_id`,
`image_content_rect` and `image_global_bounds`. Apply scaling once. Reject unknown
IDs, padding, out-of-range points, target changes and invalid geometry. No
clamping can redirect a bad coordinate onto an edge control. macOS and Windows
query live native bounds and can translate a retained image's
coordinates for pure window movement when the image projection and size remain
valid; resizing or changed projection requires fresh observation. Retina, mixed
DPI, negative origins and cross-monitor movement are acceptance cases.

Screenshot geometry is scoped by control generation and target revision and
retained in a bounded history of 16 images; pixels are not retained in that cache.
Stop, restart and rebind invalidate it. Preview frames carry the same revision,
and controllers reject stale responses even when the target string matches.

Observed node indices refer to retained native identities from that observation.
`observation_id` identifies the node address space independently of the content
`digest`. Every application snapshot creates a new identity, invalidates derived
interactive/visual views, and stamps all returned views with that identity.
New callers echo it on node/index input; hosts reject unknown/stale explicit IDs
before dispatch. Legacy callers can omit it, and older payloads default it to
absent. Native AX/UIA/AT-SPI caches independently validate generation and target
revision and release retained observations on Stop. macOS node lookups retain
their own guard before unlocking the cache, so concurrent cleanup cannot free an
in-flight reference. Do not rebuild a tree and
reinterpret an old index. Bound-window input validates
the element's actual owning window, including same-PID foreign-window rejection.
Application-level menu exceptions must be explicit, not a general unknown-window
escape hatch.

`describe_screen` observes the explicit or bound target. The human foreground app
and physical pointer are separate metadata. Window chrome alone is incomplete AX
content, not successful reading of a document or conversation. Native OCR uses
the authorized pixels. Explicit app AX reads can survive classified surface/frame
or screen-capture-permission failures, marked `capture_preparation_error`,
`capture_status: unavailable` and `control_target_available: false`. Such reads
create no binding and attach no prior target's pixels. Lock, stop, ownership,
generation, revocation and unknown errors cannot use that fallback.

A text-only screenshot request performs a real text observation. Tool results
preserve structured identities, AX/OCR facts, errors and geometry in the model's
actual result channel; a short summary is not a replacement. Image attachments
retain their bytes and metadata through supported OpenAI-compatible, Responses,
Anthropic and Gemini transports. Model vision capability and transport support
are separate gates. Persisted images remain available to capable later consumers.

Post-input observation is fresh with respect to the capture provider's guarantee.
macOS marks a host-clock input barrier and waits for a later complete or idle
ScreenCaptureKit sample. Idle can establish unchanged pixels; resize still needs
a valid complete frame. This proves capture timing, not completion of asynchronous
application work. Windows drains WGC frames to the newest available frame; it
does not claim an equivalent input-clock barrier.

Windows input preparation validates and reuses the live WGC session without
consuming or encoding a frame. Only an actual observation requests pixels. WGC BGRA converts directly to RGBA
and the host encodes JPEG; there is no intermediate PNG, GDI/PrintWindow path or
desktop capture fallback. Preview encoding supplies its known dimensions rather
than decoding its own JPEG. Unchanged legitimate dark frames are preserved.
Explicit action waits subscribe to session changes; Stop, revocation or target
replacement interrupts them immediately, including waits between batch steps.

## Native input rules

Background actions capture desktop witnesses before and after submission.
macOS checks foreground identity plus its activation epoch, the physical pointer
and relative order of existing windows; Windows checks foreground HWND, pointer
and window order. Linux can inspect active AT-SPI top-level windows but cannot
observe compositor cursor/stacking, which remain unknown in the receipt. These
witnesses are diagnostics, not admission or revocation gates: the user may keep
working while directed input runs. Missing samples leave evidence unavailable;
changed samples retain their actual values without replacing the native action's
result, stopping the session or replaying input. Native target, mode and lease
checks still govern input. Boundary samples cannot attribute changes to this
operation or prove all transient or later application behavior.

### macOS

Retain the selected content window across observations. A sharing-indicator
window appearing earlier in WindowServer order must not replace it. Conflicting
explicit window selection fails; validate a replacement before releasing a live
capture. AX focused-window observation resolves the actual bound window, not an
unrelated Sharing dialog. Missing exact identity is an error.

For one unmodified left ImageXy click, native application-root AX hit testing may
select an explicitly pressable button, checkbox, radio button or link. The hit
must belong to the exact bound window and contain the point. Do not rank nearby
rectangles, climb ancestors or replace double/right/modifier clicks with AXPress.
Only explicit ActionUnsupported permits a different delivery path; unknown AX
outcomes stop without a duplicate click.

Text/key `focus` uses retained AX identity or native hit testing and semantic
focus for text controls. Other eligible targets use the exact-window directed
focus route described below. Unknown focus outcomes must not type into an old
field or silently switch to global foreground input.
For explicit text-control focus, typing first uses one `AXSelectedText` mutation
at the retained target: replace the selected range or insert at the caret.
Preflight-confirmed unsupported semantic writing may use directed Unicode input;
an unknown write outcome stops without resubmission. An already focused control
is not focused again, preserving its selection. Semantic Unicode field input
passed the dedicated production Tool fixture; support for other applications
still depends on their native accessibility implementation.

Explicit foreground mode may use its authorized pointer-focus path. An unknown
AX outcome never implies successful focus. Scroll `focus` is only a coordinate
anchor: resolve it, update virtual pointer position, then scroll; never click the
control under the anchor.

Directed pointer events use one `CGEventPostToPid` route and exact window/local
coordinates. The existing dynamically resolved `CGEventSetWindowLocation`
routing dependency is checked; its absence is an explicit error. Authenticated
event delivery obtains the event record through `SLEventGetEventRecord` and
copies it into an owned, aligned 248-byte record. It no longer guesses offsets
inside an opaque CGEvent. The getter has a local no-input test; that test does
not establish delivery. The unused temporary foreground-menu activation helper
is removed. No implicit
Command modifier, global foreground activation or human-cursor warp is a substitute.
The directed mouse source is `CombinedSessionState`, with modifier flags set
explicitly to the requested modifiers. A private mouse source itself caused
AppKit to raise inactive windows in the strict fixture; changing only that source
is therefore part of the routing contract, not a reason to add Command. Keyboard
events retain a private source. Event field 58 is set to 1 for window routing; it
is not a click-group identifier and must not be repurposed as one. These event
fields are native adapter details, not application-specific rules.

#### Target-local focus lifecycle

`macos_input_focus` prepares the target application's internal active/focus state
without making that process the human desktop's frontmost application. It
validates the exact window ID, current geometry and capture action lease. A
window-addressed down/up focus pair is placed outside the content frame at local
`(-8,-8)`; it must not hit a content control. The requested gesture then uses its
observed target coordinates and original modifiers. There is no implicit Command,
global foreground switch, window raise/restore or human-cursor warp.

The preparation cache includes generation, PID, window ID, human foreground
identity and activation epoch, so preparation is not repeated for every key or
batch step while stale activation state cannot be reused. There is no app-name
rule or guessed content-control coordinate. Preparation does not depend on an AX
key-state acknowledgement, which normal AppKit windows can omit; fixtures inspect
their own `NSWindow.keyWindow` directly.

Cleanup validates process-serial identity before touching the target, and skips deactivation if the user has made that target the actual
foreground application. It cannot deactivate a reused PID or reset another
application's focus. The outside-frame focus pair and cleanup belong to the
control lifecycle, not to a model-generated sequence of clicks.

The production Tool/native fixture passed a five-action background program:
click an ordinary non-AX canvas, type text, invoke the real menu with Cmd+Shift+K,
scroll by 8, then type an emoji, followed by one final observation. The covered target received one content
click with unchanged modifiers, text reached the canvas while the separate text
field remained unchanged, and the menu/scroll actions took effect. Exactly one
outside-frame focus pair prepared the entire program. The observer retained
active/key/frontmost and stacking state, received no input, and the human cursor
matched its baseline. Stop deactivated the internally prepared target. Semantic
Unicode field input also passed in the fixture before the program.

The standalone raw native runner has prior passing evidence with strict cursor,
lifecycle and event-scope checks; it was not rerun during this refactor. Both
runners use ordinary inactive controls and preserve the observer baseline;
neither substitutes a permissive first-click implementation. Current validation
counts and platform gaps are recorded in the verification section below.

Complete acceptance must verify no off-frame content hit, exactly one requested
content click, correct text destination, unchanged human foreground/key/stacking
state, modifier fidelity, cursor validity and Stop cleanup through the production
Tool pipeline. Native success on these controls will not establish universal
support for every application, game, Space or protected surface.

Hidden, minimized and unavailable surfaces are distinct from occlusion. A known
locked session yields `SESSION_LOCKED`; unknown session metadata retains normal
capture errors. No unlock, wake or automatic activation is a recovery action.

### Windows

Observation and semantic actions share a retained MTA UIA worker/cache. Validate
PID, HWND, generation, target revision, enabled state and geometry before supported Invoke,
Toggle, SelectionItem or Scroll operations. Release retained COM references with
the cache; do not rebuild indices during input.

Standard Unicode Edit/RichEdit text insertion replaces the current selection
through `EM_REPLACESEL`, preserving text outside that selection. An observed
NodeIdx retains UIA identity. ImageXy resolves through the screenshot map and
recursive `ChildWindowFromPointEx` within the bound HWND, then retains that exact
child's UIA element; it does not hit-test a covering application's global point.
Without explicit focus, `GetGUIThreadInfo` reads the bound window thread's focused
native control. PID, UIA process, root HWND, enabled state and read-only state
must match before input. Unsupported OCR/grid or non-edit targets return
`BACKGROUND_TEXT_UNAVAILABLE`; timeout after submission is an unknown outcome,
not a retry. No clipboard, foreground switch or arbitrary whole-value replacement
substitutes for insertion. The point/focus routes and their native fixture have
cross-compile evidence; the Windows fixture has not been executed.

### Ubuntu

Portal authorization immediately binds the retained stream to the control
resource. A scope change cannot silently replace that binding in the same
generation; stale-generation work is rejected. Portal sessions retain one
authorized PipeWire remote and stream. Prefer stable
PipeWire serial targeting when available. Frame-size changes invalidate absolute
coordinates. Notify input is the single portal seat transport; do not mix in an
unconsented X11/global path. Portal authorization has a bounded deadline and
explicit local-authorization failure; late responses cannot revive old sessions.
Native-thread Stop schedules release/closure through the retained runtime.

AT-SPI caches retain bus/object identity, control generation and target revision. Default actions
execute once without coordinate fallback. Text insertion uses character caret
and selection offsets with UTF-8 byte length. One selected range is replaced;
unselected text remains intact. Invalid offsets or multiple selections fail
explicitly. The bridge uses canonical `NActions`/`GetName` and `GetNSelections`
wire names rather than relying on known incompatible generated/batch calls.

## Persistent visual feedback

The virtual pointer is independent of the human pointer. Its last position lasts
until Stop or target change; only the click ring expires. The arrow uses a rounded
neutral-gray silhouette, soft shadow and a fixed hotspot. Raw model/OCR captures
do not contain the feedback overlay. Input text is not copied into feedback logs.

Native feedback is nonactivating and click-through. macOS hides it while the
target region is covered, retaining its position for reappearance. Windows uses
preview feedback conservatively when native visibility cannot be established.
Ubuntu preview does not invent a Wayland global overlay. Reduced-motion retains
static position feedback without movement transitions.

The physical preview cursor is a deterministic 240 Hz simulation sampled by
`requestAnimationFrame`, with retargeting, directional rotation, speed stretch,
arrival deformation, opacity/blur and resize behavior from the reference. Motion
never acknowledges, schedules or delays native input. Reduced-motion uses
immediate feedback. Rust-generated golden traces test the mathematical port,
not native OS delivery. The click ring expires independently of the persistent
pointer.

The product surface shows authoritative target, mode, status and Stop while the
chat card is collapsed. Preview sampling is bounded and stops when unobserved;
React component lifetime does not own native capture lifetime. Generation/target
checks discard stale preview responses and device-switch results.

## Remote and upgrade compatibility

| Scenario | Required behavior |
|---|---|
| Remote workspace | Existing SSH/Docker workspace refusal; never operate the controller's local GUI as fallback |
| Remote control | An executing Desktop's Agent selects and controls its own applications without requiring an App picker on Mobile/IM; cancellation remains reachable. Native OS consent and missing GUI providers are explicit limitations; no hidden app-selection dialog |
| Peer Device | Share/permission/preview commands proxy to the peer only after `computer_use_sharing_v1` negotiation; controller permission is not peer permission; old peers and CLI without GUI reject explicitly |
| Detached Dispatch | Headless execution has no implied GUI capability or submitter UI dependency; require an explicitly negotiated target provider |

Missing new capabilities on old peers mean unknown/unsupported. Portable fields
use conservative defaults; old payloads remain readable. Do not delete/reset
persisted sessions, settings or profiles to repair incompatibility. Internal Rust
port cleanup does not authorize changing persisted or cross-version wire shapes.
Local fixtures and unsupported-host unit tests are not remote end-to-end evidence.

## Verification and acceptance

### Latency design evidence, 2026-10-13

The installed `openai-codex-electron` 26.1007.30912 artifact (`@oai/cua` 0.2.6,
`@oai/sky` 0.7.6) informed the interaction policy. Focused REA static analysis
covered the shipped CUA JavaScript API and macOS Sky client, plus their packaged
tool documentation. It established these distinctions:

- Persistent JavaScript can await several input operations and return one final
  observation in one model-facing call. Native input and state reads still use
  separate IPC requests. This is grouping at the model boundary, not evidence of
  one native batch RPC.
- App selection already emits initial state. Native input wrappers do not
  implicitly emit another tree/image after each input.
- AX text, image and combined observations have separate public methods.
  `getAXState` only emits text to the model, but calls the same underlying state
  RPC; these wrappers do not prove that the native service avoids capture.
- The macOS client caches its transport, correlates responses by request ID and
  serializes writes. The exposed AX diff option is visible; the native diff and
  settling algorithms are outside the inspected JavaScript boundary.

The corresponding REA parent Evidence IDs are
`ev_2f831c53ee4f06ac0236cdbc8eb701cbd5e584c2e33fa12029006b3fc80512e0`
and `ev_49bc75d47413c72fd45730106ded6c3377f0651baa70105ec8494e64f7898056`.
The inventories completed, while dynamic/external semantic relationships remain
unknown. This is shipped-code evidence, not observed Codex execution or a recovered
server-side system prompt. No comparative model latency or hidden reasoning
configuration was established. Third-party code is not a product dependency.

The [public computer-use API guide](https://developers.openai.com/api/docs/guides/tools-computer-use)
also describes executing ordered actions before returning an observation; this
is a public integration pattern, not proof of the desktop application's API wire.
The [programmatic-tool guide](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling)
calls for measuring correctness, evidence, model turns and latency together.
OpenBitFun applies the interaction policy through its existing typed program and
host port, retaining its authorization, partial receipts and cancellation rules.

Local macOS acceptance used the production Tool → host → native input/observation
path, with independent target and foreground-observer applications. The strict
fixture passed AX-only node input, fresh/stale observation checks, default-image
recovery, semantic and image targets, Unicode entry, scroll, five-step canvas
input, manual preview/revocation and Stop. Foreground identity/key state, window
order, physical cursor and exact native delivery assertions remained enabled.

The latency fixture executed the same five inputs (four Unicode text insertions
and one known shortcut) in fresh processes for each case. Three repetitions per
case, using a development build and a 12-node AX tree, produced:

| Observation policy | Input tool calls | Returned observations / images | Median host time | Range |
|---|---:|---:|---:|---:|
| Single inputs, default images | 5 | 5 / 5 | 1,749 ms | 1,661–1,755 ms |
| One batch, default image | 1 | 1 / 1 | 464 ms | 462–464 ms |
| Single inputs, AX only | 5 | 5 / 0 | 176 ms | 164–181 ms |
| One batch, AX only | 1 | 1 / 0 | 149 ms | 137–150 ms |

Each timed result had to contain the exact final text in its returned AX state;
an immediate fixture read confirmed shortcut delivery before recovery reads or
waits. That read adds 0.073–0.130 ms, reported separately. Setup, the initial
observation, later screenshot recovery and cleanup are outside the measurement.
These are strategy comparisons in the same updated build, not a before/after
model benchmark: batching already existed. No model inference, complex-app tree,
Codex runtime, Windows/Linux native execution or remote end-to-end latency is
included. Three samples establish a range/median, not a meaningful p95.
The measured executable SHA-256 is
`e1c2e5b3beb4eb608b94d3520905d53f16575aa85c009fe0de8475ad6cdb7d16`.

The 78 focused tool/prompt contracts passed, including legacy provider/image
defaults, malformed option rejection before input, cancellation/scope changes,
partial receipts, and SSH-workspace/headless refusal of controller-local GUI.
Remote workspace, remote control, Peer Device Mode and Detached Dispatch were
not exercised end to end. Locked or concurrently active test desktops are
inconclusive; clean runs retain all isolation assertions rather than accepting
those samples as performance evidence.

### Autonomous-control correction, 2026-10-13

The correction starts from `99acb6f04`. Focused checks passed: 51 Core
ComputerUse tool tests, two browser connection-hint tests, 163 Desktop Computer
Use tests, 33 control/permission contract tests, eight prompt-catalog tests,
64 isolated production-source context tests and 27 frontend settings/control
tests. Nine Desktop native tests and one isolated browser test are ignored in
those unit commands. `cargo build -p openbitfun-desktop`, `check:web`, the Web
production build, changed-page ESLint, generated capabilities, repository hygiene
and core boundaries passed. These suite counts overlap.

The real macOS Tool roundtrip starts implicitly through application observation,
with no manual sharing API or separate input grant. It passed exact click,
Unicode/Return delivery, OCR verification, stale-reference rejection and Stop.
The strict native fixture starts background control explicitly, resolves a
running bundle, opens its explicit app path without activation, then passes
the covered button/text/scroll and five-action canvas/shortcut/emoji program.
Observer foreground/key/stacking, activation history, input history and the
physical cursor stay unchanged. Optional manual-preview tests run only after
the Agent sequence has passed. Two earlier strict runs exposed bundle-ID and
unregistered-path resolution failures; both were fixed before the final pass,
with no relaxed assertions or input replay.

The settings page was inspected in a real macOS Tauri window using the newly
built frontend and an isolated test profile. The desktop-control section has
the standard toggle and two permission rows, with no app selector, grant panel,
Input Monitoring or executable diagnostics. The test profile does not exercise
a fresh OS permission denial/approval/restart cycle.

Windows production modules, including the shell launcher, pass cross-compilation.
Windows and Linux native execution and all four remote scenarios were not rerun
for this correction. Prior platform evidence below does not prove the updated
end-to-end behavior. Cold application startup and arbitrary third-party app
activation behavior are not covered by the macOS already-running fixture.

A wider Core `--lib computer_use` filter additionally selected the unchanged
`registry_exposes_controlhub_and_computer_use` test, whose product-registry
expectation failed under the minimal feature set: without `product-full`, the
default runtime selects the Agent Runtime baseline tool plan. The owning
`computer_use_tool::tests` suite passes. Full product assembly is covered by CI;
the registry test's narrow-feature mismatch remains unresolved. The older
`direct_desktop_policy_tests` filter matches no current
tests and is not counted as coverage.

### Historical migration evidence, 2026-10-12

The 2026-10-12 refactor started from `f5b6d3ab2`. Focused checks passed: 72 Core
Computer Use tests, 160 Desktop tests, 33 contract tests, five runtime-evidence
tests, eight prompt-catalog tests, 63 isolated production-source context tests,
19 operation-registry tests, nine Desktop remote-workspace policy tests and
82 frontend tests. The frontend command covers sharing/permissions, preview
gestures, stale responses, peer capability gates, Appearance registration and
cursor/geometry parity. The cursor oracle contains 63 samples generated by the
unmodified reference Rust implementation. Counts from separate suites overlap
and must not be added into a unique-test total. Nine Desktop native tests and one
browser context test remain opt-in/ignored in those unit commands; they are not
counted as native passes. The macOS Desktop debug build, `check:web`, i18n audit,
all-surface color audit, repository hygiene, generated capability check and
core-boundary checks also passed.

Dedicated macOS fixtures separately verified retained AX references after cache
cleanup, stale observation-ID rejection before input, the complete Tool/native
roundtrip, strict background input, capture and passive feedback. The final
strict background run used the production App selection, observe-only capture
and explicit grant flow, then exercised native manual-preview input and rejected
its stale request after grant revocation. Observer foreground/key/stacking, its
input-event history and the system cursor assertions all passed, including Stop.
Earlier attempts include a hardware-idle precondition timeout and two failures
of the final unchanged-cursor assertion; they remain failure/inconclusive evidence.
An unchanged rerun during a user-provided quiet interval passed. Neither input
replay, focus restoration nor relaxed assertions were used to obtain that pass.
The separate Unicode/OCR roundtrip initially stopped at its background-start
precondition because macOS selected the disposable target as the foreground app.
Its runner now starts an independent observer after the host initializes; the
rerun passed exact input counts, Unicode text, stale-reference rejection, OCR,
generation/binding continuity and foreground preservation.

The Windows production native modules pass cross-compilation with
`test-windows-computer-use-native.mjs --check --target x86_64-pc-windows-msvc`.
A full Desktop cross-build on macOS is blocked by the unavailable Windows C SDK
headers required by `ring`; module type-checking does not cover that build or
native execution. Linux production modules were compiled and executed in an
ARM64 Debian container with real D-Bus, AT-SPI, GTK and Xvfb: 65 focused tests
passed, with two opt-in native tests ignored; the separate GTK fixture then
passed button activation and UTF-8 EditableText insertion while preserving
existing text. This validates the production AT-SPI provider under Xvfb, not a
full Linux Desktop build or compositor integration. No GNOME Wayland compositor,
portal chooser or live PipeWire stream was available for the portal fixture.

The sharing card was rendered in Chromium with the real design-system styles at
1000×800 and 390×700; the narrow layout keeps Stop visible while permissions are
expanded. That visual harness mocks transport. It is not an end-to-end Tauri
permission-dialog test. Full OS denied-to-granted/restart flows and system Stop
Sharing UI interaction remain manual acceptance work.

Run focused checks from the [Desktop Computer Use guide](../../src/apps/desktop/src/computer_use/AGENTS.md)
and [Core guide](../../src/crates/assembly/core/AGENTS.md). A build-only result,
ignored native test or permissive first-click fixture is not a successful strict
background-input run.

| Area | Recorded evidence | Remaining scope |
|---|---|---|
| macOS strict production Tool pipeline | User-selected share and separate grant; five-action non-AX canvas/text/menu/scroll/emoji program with one final observation; exactly one content click and one outside-frame focus pair; native preview input and revocation; observer foreground/key/stacking and human cursor unchanged; no observer input; Stop deactivated target | Wider applications, cross-Space behavior and visual system Sharing UI acceptance |
| macOS capture/feedback | Dedicated native fixtures exercised obscured target pixels, binding retention, movement/resize, hidden/minimized errors, closure and pointer lifetime; earlier locked-session rejection evidence was not rerun | System Stop Sharing interaction and broader platform/application matrix |
| Linux text semantics and scope | 65 production-module tests plus a real GTK/AT-SPI activation and UTF-8 insertion fixture under D-Bus/Xvfb; portable admission, permission, grant and geometry checks | Full Linux Desktop build, GNOME Wayland portal consent, real PipeWire/seat input and sharing UI; arbitrary background coordinates remain explicitly unsupported |
| Windows native modules | Production-source cross-compilation of control admission, UIA/MSAA, WGC, pointer feedback, permissions, process identity, grants and background witnesses | Full Windows Desktop build, native delivery, WGC border/stop and foreground preservation |
| Permissions and remembered grants | Read-only probe/explicit request tests, process identity checks, private atomic persistence, legacy/future-field retention, grant revocation and no automatic sharing | Real OS permission denial/approval/restart matrix and broader executable upgrade scenarios |
| Preview and virtual cursor | Rust golden parity, padded/negative-origin/resize geometry, one-input dispatch, pointer ownership, cancellation and two responsive visual renders; native preview Escape delivered once | Full desktop UI-to-native pointer/drag matrix across all three OSes |
| Remote scenarios | Explicit remote-workspace/headless-provider refusal tests; frontend peer-scope, old-peer capability denial and stale-preview tests | No remote-workspace, Remote Connect, Peer Device or Detached Dispatch end-to-end GUI validation |

The macOS strict fixture builds before opening windows, initializes the host,
uses separate application bundle identities, and waits for a bounded hardware
input idle interval before foreground setup. Busy desktop timeout is
`INCONCLUSIVE`, not PASS. After the baseline, it never restores the observer's
focus or stacking order. Activation history detects transient focus changes;
assertions retain failure evidence. Fixtures manipulate only their disposable
windows and send no real messages. Timings are fixture observations, not promised
whole-task speedups or performance across platforms.

Release acceptance additionally requires:

1. Obscured capture returns the selected surface with no covering pixels or
   unsolicited full-desktop fallback.
2. System/product Stop, cancellation, permission loss and target closure reject
   queued/stale-generation work and release held inputs without resurrection.
3. Background native input preserves human foreground, focus, pointer and stacking
   state while another fixture is used; unsupported paths report limitations.
4. Receivers observe exactly one submitted action; failed final observation never
   repeats input. Partial programs expose completed and unattempted steps.
5. Coordinate tests cover stale IDs, rebinding, resize, Retina/mixed DPI, negative
   monitor origins, window movement and same-PID foreign windows.
6. Model messages carry the actual image and its matching identity/geometry;
   text-only paths supply real AX/OCR evidence rather than empty success.
7. Portal denial, missing devices/streams/plugins, closed sessions and revoked
   resources fail explicitly and clean up without local fallback.
8. Legacy deserialization and unsupported-host defaults pass; native OS and remote
   scenarios are reported separately rather than inferred from shared tests.
