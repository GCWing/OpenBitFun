# Computer Use (desktop host)

## Scope

Platform-specific automation for the unified `computer_use` tool lives under
`src/apps/desktop/src/computer_use/`. Shared contracts and tool orchestration
are in `src/crates/assembly/core` and `src/crates/execution/tool-contracts`.

## Platform maturity

| Platform | Tier | Capabilities |
|---|---|---|
| **macOS** | AX-first | Accessibility tree, directed background input, persistent ScreenCaptureKit window capture, menu shortcuts, interactive/visual views |
| **Windows** | AX-first | UI Automation patterns/tree, persistent WGC window capture, MSAA observation for legacy VCL, targeted message input |
| **Linux** | Portal + AT-SPI | Consented PipeWire capture, foreground portal input, background semantic activation and EditableText, AT-SPI application trees |

### Ubuntu / Linux control

Wayland capture and seat input use one xdg-desktop-portal session. Never use an
XWayland `DISPLAY` as evidence that X11 desktop input is supported. Portal denial,
revocation, missing plugins, and stream geometry changes fail explicitly; they
must not trigger X11 input or whole-desktop capture fallback. GStreamer consumes
the portal's authorized PipeWire FD, not a default unrestricted connection.

AT-SPI provides `list_apps`, `get_app_state`, `app_click` with a cached `NodeIdx`,
and `app_type_text` with an explicit EditableText node. These semantic operations
do not change compositor focus. Arbitrary background coordinates, app-scoped key
chords, interactive/visual cached views, and menu shortcuts are unavailable.
Portal-selected pixels are not automatically attached to a PID-selected tree.

Run the real native portal fixture in the desktop user's Ubuntu session (requires
`python3-gi`, GTK 3, GStreamer PipeWire/base/good plugins and portal services):

```bash
cargo check --locked -p openbitfun-desktop --tests
node scripts/test-linux-computer-use-native.mjs -- --test-threads=1
bash scripts/test-linux-computer-use-atspi.sh
bash scripts/test-linux-computer-use-portal.sh
```

Select only the dedicated **OpenBitFun Portal Fixture** window. The fixture checks
real PipeWire frames, observation-only input rejection and stop revocation. It
does not prove foreground input delivery or remote behavior.
For headless AT-SPI verification, use
`dbus-run-session -- xvfb-run -a bash -lc 'export NO_AT_BRIDGE=0; bash scripts/test-linux-computer-use-atspi.sh'`.
The AT-SPI fixture checks one GTK button activation and UTF-8 EditableText insertion
while preserving existing text;
it does not establish compatibility with every application. Run the SPEC's
remaining native acceptance scenarios separately.

## Module map

- `desktop_host/` — `ComputerUseHost` trait impl; entry for all actions
- `control_session/admission.rs` — pure mode/owner/lease/start/stop state machine
- `control_session/sharing.rs`, `desktop_host/sharing.rs` — user-selected window, observe-first sharing and revocable input grant
- `permissions.rs`, `process_identity.rs`, `grants.rs`, `share_grants.rs` — explicit OS requests and executable-bound remembered preferences
- `desktop_host/shared_preview.rs` — scoped manual preview input through the same native host/lease as the Agent
- `desktop_host/background_guard.rs` — before/after desktop witnesses; no focus restoration or replay
- `desktop_host/foreground.rs` — explicit exact-window activation and global input destination checks
- `desktop_host/linux_launch.rs` — literal executable/desktop-entry launch with bounded helper waits
- `desktop_host/observation.rs`, `observation_cache.rs` — observation identity and bounded screenshot geometry; never input authority
- `desktop_host/state.rs` — derived host feedback and view caches
- `macos_*` / `windows_*` — platform AX, capture, list-apps, shortcuts
- `windows_capture.rs` — WGC frame conversion and authoritative window bounds
- `windows_wgc_capture.rs` — Windows.Graphics.Capture (Direct3D11)
- `windows_window_target.rs` — Win32 window facts and portable default-target policy
- `linux_ax_ui.rs` — AT-SPI locate
- `linux_control.rs` — portal lifetime, PipeWire frame consumption, foreground seat input
- `linux_control_ax.rs` — AT-SPI background semantic operations
- `linux_control_policy.rs` — pure session classification and keysym encoding
- `screen_ocr.rs`, `ui_locate_common.rs` — shared OCR/locate helpers

## Native capture boundaries

The implementation contract is [Computer Use control-session SPEC](../../../../../docs/architecture/computer-use-control.md).
macOS and Windows retain a real native single-window capture session. Never fall
back to desktop pixels when window capture fails or the target is obscured.
Background input must not activate a window or use the global input seat.
For an ordinary user-requested GUI task, the Agent may explicitly change to
foreground mode when background delivery is unsupported or verified ineffective,
unless the user required background-only/no-disruption. This is a new tool
decision, never a native retry or implicit escalation. macOS/Windows
`activate-app-v1` activates the exact bound window and returns a fresh observation;
global input must validate the foreground destination. Linux retains its separate
portal consent/surface identity. Preserve user Stop, cancellation and OS denial.

## Target-local macOS focus acceptance

The directed-input route can change a target application's internal
focus without changing the human foreground application. Its window-addressed
focus pair at local `(-8,-8)` must remain outside content; the requested gesture
must reach content exactly once with unchanged modifiers. Do not validate it
using a fixture that overrides `acceptsFirstMouse`. Record dequeued mouse events
so standard controls' tracking loops cannot hide a delivered mouse-up. Record observer active/key,
frontmost PID, stacking order, real text destination and content event counts.
Do not use missing AX key-state attributes as a substitute for native focus
validation: fixtures inspect their own `NSWindow.keyWindow`. Preparation caches
must include generation, PID, window ID, human foreground identity and activation
epoch plus a passive target-local loss epoch, and must not add app-name rules or
content-coordinate guesses. Target-local event monitoring must be listen-only;
unavailable monitoring disables cache reuse, not background input. An off-frame routing
position is distinct from the actual user-requested content target.
No after-action raise/restore is allowed. Stop may deactivate a target only when
it is not the user's actual foreground application. Prototype success is not
production acceptance; the complete native Tool pipeline must pass separately.
Mouse events use CombinedSessionState and explicit requested flags; keyboard
events retain a private source. Preserve field 58 as window-routing metadata,
not a click-group counter. Cleanup validates process-serial identity before
target deactivation; it does not require the original window to remain open.

## Verification

For observation payloads, OCR projection, AX filtering/digests, and browser
snapshot context, use the isolated compiler harness first. It compiles the
production Rust files by path, with the actual DTO source and no replacement
algorithms or native-host mocks. Cargo dependencies must already be cached
(`cargo fetch --locked` on a fresh machine).

```bash
node scripts/test-computer-use-context.mjs
cargo test -p openbitfun-desktop --lib context_integrity_tests
```

Native black-box fixtures use only a dedicated test window / rendered image:

```bash
# Node 22/24 and installed workspace dependencies; installed Chrome required.
# CHROME_PATH can select another Chromium executable.
node scripts/test-browser-snapshot.mjs --native-ocr
# macOS + Accessibility permission; creates and closes its own AppKit window.
node scripts/test-native-ax-context.mjs
# macOS + Screen Recording permission; captures only its own obscured test window.
node scripts/test-macos-control-capture.mjs
# Locked-host rejection only; never wakes or unlocks the desktop.
node scripts/test-macos-control-capture.mjs --locked
# macOS passive cursor lifecycle; no capture or accessibility permission required.
node scripts/test-macos-control-pointer.mjs
# Shared macOS/Windows presentation math; also runnable on Linux without a GUI.
node scripts/test-computer-use-pointer-motion.mjs
# macOS + Accessibility and Screen Recording permissions; clicks only its dedicated fixture process.
node scripts/test-macos-directed-input.mjs
# Covered standard controls: exact native AX hit + semantic action + fresh capture.
node scripts/test-macos-input-controls.mjs --semantic
# Full Tool image-coordinate button activation/text focus and wrong-field guard.
# Target/observer have distinct app bundles; AppKit initializes before the
# foreground baseline. Activation history catches transient focus changes.
# Also induces target-local loss while foreground stays fixed, then verifies
# the next ordinary input prepares focus again without another content click.
node scripts/test-macos-input-controls.mjs --orchestration
# Real AX messaging timeout in a stopped disposable process, then one directed
# click after resumption; retains exact delivery and foreground/cursor checks.
node scripts/test-macos-input-controls.mjs --busy-ax
# Explicit foreground transition on disposable windows; wrong-focus rejection,
# exact activation and native Unicode/shortcut delivery.
node scripts/test-macos-input-controls.mjs --foreground
# Identical five-input sequence: five tool calls vs one batch, with default
# images and AX-only observations. Fresh isolated app/host per case.
node scripts/test-macos-input-controls.mjs --latency
# Diagnostic raw-pointer contract, including ordinary non-AX first click and
# unchanged modifiers/z-order. Both this raw runner and the full Tool five-action
# fixture passed; do not substitute a permissive first-click implementation.
node scripts/test-macos-input-controls.mjs
# Full Tool -> provider -> native loop on a dedicated window, with main-thread runloop.
node scripts/test-macos-control-roundtrip.mjs
```

For explicitly selected disposable real applications, the devtools JSONL probe
uses the same production Tool path and main-thread run loop. It accepts only one
startup PID (optionally one window), background observations and app actions;
it rejects activation, global input, clipboard and scripts. Do not use personal
application windows or infer delivery from `ok: true`. Observe after errors
before choosing another action; the probe never retries input automatically.

```bash
cargo test -p openbitfun-desktop --features devtools --test computer_use_native_roundtrip --no-run --message-format=json
# Use the executable path emitted above; EOF or the total deadline stops control.
OPENBITFUN_CUA_PROBE_PID=<pid> OPENBITFUN_CUA_PROBE_OUTPUT_DIR=/tmp/cua-probe <executable>
# stdin JSONL: {"id":"observe","input":{"action":"get_app_state","include_image":true}}
cargo test -p openbitfun-desktop --features devtools --lib native_control_roundtrip::probe
# Independent read-only witness; no app launch, permission prompts or input.
clang -fobjc-arc -fblocks -Wall -Wextra -Werror -framework AppKit -framework ApplicationServices scripts/fixtures/computer-use-background-witness.m -o /tmp/cua-witness
/tmp/cua-witness --target-pid <pid> --target-window <window-id> --output /tmp/cua-witness.json
```

Wait for the witness's baseline before input. `SIGUSR1` requests a new baseline;
wait for its sequence to advance. `SIGTERM` flushes the final record. Check
sampling gaps and unknown AX reads, and separate concurrent human activity from
backend-caused changes. The witness records IDs/coordinates, not titles, text or
pixels; it cannot independently prove key-window state or causal attribution.

The browser fixture runs production snapshot/resolver JavaScript in Chromium,
then passes the actual DOM payload to compiled Rust presentation tests. The
optional OCR step compiles the Desktop test target and invokes macOS Vision on
the rendered JPEG. The AX fixture compiles the Desktop test target and checks
native AX nodes, text, states, parent indices, cache entries, filtering, and DTO
round trips. These are local macOS checks, not Windows/Linux or remote evidence.

The latency fixture reports actual returned observations/images, AX node counts
and native tool wall time including one separately timed fixture JSON check.
It checks exact Unicode text, immediate shortcut delivery,
fresh AX-only node identities, recovery of default screenshot observations,
and the same foreground/cursor invariants as the orchestration fixture. It does
not invoke a model. Startup and cleanup are outside the reported measurement;
timings are diagnostic evidence, not machine-dependent pass/fail thresholds.
The native fixture requires an unlocked desktop; its read-only startup gate
reports a locked screen as inconclusive without waking or unlocking it.

Observation invariants:

- Rectangle containment does not prove two controls have the same action.
- Projection uses content padding and authoritative global bounds; invalid
  geometry and OCR matches outside the content are not actionable coordinates.
- AX snapshot digests cover state and geometry as well as labels. A state-only
  change must not be mistaken for a failed action and trigger duplicate input.
- Stale interactive/visual indices must be returned to the caller for a fresh
  choice, never silently reused after rebuilding a different view.
- Element-budget omissions are reported in `omitted_element_count`, including
  when text rendering is disabled; focused controls survive budget selection.

```bash
cargo test -p openbitfun-desktop --lib computer_use
cargo build -p openbitfun-desktop
```

Windows-only paths (`windows_wgc_capture`, UIA) compile on CI (`windows-latest`).
The Windows job also runs the isolated native-module unit suite independently
of the Tauri test loader; interactive native delivery fixtures remain ignored.
UIA observation, semantic input, locate, hit-test and shortcut discovery share
one MTA worker. `provider_worker.rs` bounds admission and caller waits: a request
has a ten-second deadline and polls control cancellation every 50 ms. UIA also
uses two-second connection and five-second transaction limits with automatic
focus disabled. Never release the occupied slot, spawn replacement workers, or
queue another input just because a caller timed out. Foreign code may still be
running. Input that has crossed its submission fence has an unknown outcome on
failure; do not retry it or switch to a coordinate click. Stop fences input still
in preflight, while already submitted input can complete later. After the native
call returns, discard abandoned observations and require a fresh read. A provider
that never returns leaves UIA explicitly busy until it recovers or the host is
restarted; status and Stop must remain independent of that worker.

The focused desktop `computer_use` tests include portable blocking-provider
regressions for deadlines, cancellation, late input, busy admission and recovery.
They simulate foreign-call stalls and do not establish real Windows delivery.
The isolated native-module harness compiles the production control owner, UIA,
MSAA, WGC and pointer modules. Its portable error-envelope adapter replaces no
native APIs or algorithms. Cross-compilation is type-checking, not Windows
execution; full Desktop compilation and native fixtures still belong on Windows.

```bash
# Native Windows: unit tests; native delivery fixtures remain opt-in/ignored.
node scripts/test-windows-computer-use-native.mjs
# Other hosts with the target installed: compile production native modules only.
node scripts/test-windows-computer-use-native.mjs --check --target x86_64-pc-windows-msvc
# Interactive Windows: own-process main + topmost companion selection and real WGC pixels.
node scripts/test-windows-computer-use-native.mjs default_window_captures_main_beside_topmost_companion -- --ignored --test-threads=1
```

For default Windows target selection, run
`node scripts/test-computer-use-context.mjs windows_window_target`.
The portable regression includes issue #3291's reported HWNDs, styles and bounds;
it is not evidence of WGC execution. Native default selection must prefer content
over floating utility windows without app-name rules. Explicit HWNDs and existing
bindings bypass ranking. WGC rejection reports the selected HWND and window facts;
never probe another target or substitute desktop pixels after a failure. The
interactive fixture captures only its own Win32 window; it does not establish
Tauri/WebView2 compatibility on every Windows build.

Observation IDs and target revisions are additive wire fields. Keep accepting
legacy payloads, advertise `observation-id-v1`, and reject explicit stale IDs
before input. New observations invalidate prior AX/view indices even when the
content digest is unchanged. Do not replace namespace identity with a digest.

Agent native fixtures must discover and address their target through production
tools without manual share selection or a separate input grant. Cover explicit
`start_control` and implicit first-action startup. Optional manual-share fixtures
exercise target inventory, observe-first capture and grants separately; they must
not hide an Agent regression by performing those UI steps in fixture setup.
Permission probes never prompt. Desktop-state witnesses record concurrent human
activity without revoking Agent control or replaying input.

The Web preview's deterministic cursor is verified against Rust-generated
`computer-use-rust` samples retained in the repository. The reference source is
not required to build or run tests. After preview, sharing or permission UI edits:

```bash
pnpm --dir src/web-ui run test:run src/app/components/ComputerUseControlCard.test.tsx src/app/components/computer-use src/infrastructure/api/adapters/peer-device-adapter.test.ts
```

These UI tests cover permission requests, stale device/grant responses, geometry,
gesture cancellation and cursor math. They do not establish native delivery or
remote end-to-end behavior. The strict macOS fixture also exercises native shared
preview capture/input and stale preview rejection after revocation.

Native pointer presentation uses `pointer_motion.h` for both AppKit and Win32.
Keep elapsed-time spring math free of OS/input dependencies. AppKit's visibility
refresh must never snap an in-flight movement; Win32 reuses one worker/window,
coalesces only visual targets and wakes on Stop. The native click pulse follows
visual arrival without delaying input. Linux/Wayland uses the shared Web preview;
do not introduce an X11/global pointer fallback. After native-motion changes run
the portable math fixture plus the platform fixture above. The Windows
`--check` command validates types only; its native test mode links the shared C
model. Browser tests and portable math on macOS are not native Windows/Linux
or remote-session evidence.
