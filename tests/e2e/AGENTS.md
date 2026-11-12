[中文](AGENTS-CN.md) | **English**

# AGENTS.md

## Scope

This file applies to `tests/e2e`. Use the top-level `AGENTS.md` for repository-wide rules.

## What matters here

Desktop E2E tests built with WebDriverIO plus OpenBitFun's embedded WebDriver.

Levels from `E2E-TESTING-GUIDE.md`:

- L0: smoke tests
- L1: functional tests
- L2: planned, not implemented yet

Core rules:

1. Test real user workflows
2. Use `data-testid` for stable selectors
3. Follow the Page Object Model
4. Keep tests independent and idempotent

## Commands

```bash
cargo build -p openbitfun-desktop
pnpm --dir tests/e2e install
pnpm --dir tests/e2e run test:l0
pnpm --dir tests/e2e run test:l0:all
pnpm --dir tests/e2e run test:l1
pnpm --dir tests/e2e exec wdio run ./config/wdio.conf.ts --spec "./specs/<file>.spec.ts"
```

## Verification

Prefer the narrowest relevant spec first, then broaden only if needed.

For the static/streaming long-session performance matrix, see the workload and
measurement definitions in [README.md](README.md#long-session-performance).
After building Desktop and production frontend assets, run
`pnpm --dir tests/e2e run test:perf:long-session`. Its isolated runner measures
first entry, repeated switching, bidirectional continuous wheel input and distant
turn-rail jumps. Validate metric aggregation and the private SSE model with
`pnpm --dir tests/e2e run test:perf:long-session:contract`.
`--scenario multi-tool` selects 26 model rounds and exactly 100 recorded tool
calls per historical turn (25 each of Read, Edit, Write and ExecCommand). The
same contract test validates generated files and preserves the old template.
Keep failed evidence; compare matching workloads/native profiles and avoid
concurrent builds. RAF is not compositor FPS. This is local desktop coverage;
none of the four remote scenarios is exercised.

For historical FlowChat scroll continuity, build Desktop and current frontend
assets, then run:

```bash
pnpm --dir tests/e2e exec wdio run ./config/wdio.flowchat-scroll-native.ts
```

This creates an isolated 80-Turn session, copies the completed packaged frontend,
and checks slow/fast bidirectional scrolling, reading-position restoration,
draft preservation and search navigation. The printed temporary directory keeps
`result.json`, per-phase frame data and screenshots. Set
`OPENBITFUN_E2E_FRONTEND_DIR` to a completed build with `frontend-revision.json`,
or `OPENBITFUN_E2E_WEBDRIVER_PORT` for a free driver port. Optional
`OPENBITFUN_SCROLL_DIAGNOSTICS=1` records row geometry and write stacks with
additional overhead. Wheel actions exercise the real WebView layout, not OS
trackpad inertia; local results do not establish remote or other-platform behavior.

The same runner accepts `OPENBITFUN_SCROLL_SCENARIO=tool-heavy` with
`OPENBITFUN_SCROLL_DENSE_GROUPS=400` for alternating shell/edit cards,
`OPENBITFUN_SCROLL_SCENARIO=rich-text` with `OPENBITFUN_SCROLL_TEXT_CHARS=80000`
for many paragraphs/fences/tables, and `OPENBITFUN_SCROLL_SCENARIO=code-block`
for one indivisible long fence. `OPENBITFUN_SCROLL_TURNS` controls history size;
`OPENBITFUN_SCROLL_FAST_DELTA=1800` forces giant-text boundary crossings that
ordinary wheel distances can miss. Four repeated session switches check DOM
residency; `OPENBITFUN_SCROLL_CYCLES` can extend that soak. The frame gates are
P95 < 34 ms and maximum < 100 ms; `OPENBITFUN_SCROLL_FRAME_BUDGET_MS` explicitly
records a different maximum for slower measurement hosts. Run benchmarks without
concurrent builds/tests. Geometry coverage excludes intentional trailing space
and does not prove compositor-only white/ghost pixels. macOS RSS reports the fixed
set of newly created host/WebKit candidates, not a JS heap measurement. Sampling
releases only disconnected WebDriver element handles (the embedded driver otherwise
retains old React trees); it never clears product caches or forces garbage collection.

Every frame report includes sample count, nearest-rank P50/P90/P95/P99, mean,
maximum, counts/percent above 33.33/50/100 ms, and consecutive-stall episodes.
`activeWheel` excludes the 24-frame idle settle from the scrolling denominator;
`phase` retains the whole sample. Report ordinary latency and slow-frame frequency
together instead of just maxima. Retain failed or externally CPU-contended runs
with their reason; do not average them silently into an isolated benchmark.
Verify the quantiles, threshold rates and idle-frame exclusion without launching
Desktop using `node --test tests/e2e/scripts/flowchat-frame-metrics.test.mjs`.

`OPENBITFUN_SCROLL_OPEN=1` measures 24 alternating real session clicks by default
(`OPENBITFUN_SCROLL_OPEN_SAMPLES` overrides it). `opening-result.json` separates
DOM attachment, text DOM, viewport placement, loading-shield release and two RAF
presentation opportunities. It reports first UI entry and repeat-entry distributions;
the first click is not necessarily cold storage because startup can prehydrate the
selected session. The fixture also rejects the historical text-readiness timeout.

Set `OPENBITFUN_SCROLL_STREAMING=1` to exercise the actual Agent runtime against
an isolated loopback SSE model. It runs four local shell commands and edits four
temporary files, streams a long Markdown response, checks reader takeover while
output grows, returns to latest, and validates completion and real tool results.
It uses no provider credentials. This is local runtime/WebView coverage, not a
live SSH/relay/peer/dispatch test.

`OPENBITFUN_STREAM_INITIAL_PARAGRAPHS` scales the initial text batch (80 by
default; 250 and 800 are approximately 120K and 400K characters).
`OPENBITFUN_STREAM_HOLD_PARAGRAPHS` extends the reader-hold interval while output
continues. Tool startup and first-text arrival have separate samples; first text
has the same P95/max frame gates as scrolling. Completion also verifies the
first/last paragraphs in persisted turns and releases arrival highlight ranges.
`frameDistributions` separates first arrival, sustained follow during 24 additional
paragraphs, and active reader scrolling. These phases must not be conflated with
the separate actual-tool startup sample.

`OPENBITFUN_SCROLL_PAINT=1` runs a separate native pixel test on the rich-text
fixture. It takes 128 immediate/settled screenshot pairs after alternating
1,800px wheel steps. Stable DOM line coordinates must contain foreground glyphs
and retain matching pixels after settling. Screenshots and `paint-result.json`
are retained. Encoding is excluded from timing benchmarks. WKWebView snapshots
are paint evidence at capture time, not a recording of every compositor frame
or OS trackpad inertia.

Memory diagnostics also report logical resource-budget bytes, active highlight
ranges and weak references to detached transcript roots; they never force GC.
`OPENBITFUN_SCROLL_MEMORY_CONTROL=1` uses the same short session and zero-distance
wheel actions as a driver control. `OPENBITFUN_SCROLL_MEMORY_IN_PAGE=1` runs
session clicks and synthetic scrolling in one native eval, removing repeated
driver-script compilation from the lifecycle experiment. This second mode does
not establish trusted-wheel behavior. Use `--mochaOpts.grep 'releases transcript DOM'`
to isolate either experiment. `OPENBITFUN_SCROLL_IDLE_MS` adds a final idle sample;
`OPENBITFUN_SCROLL_VMMAP=1` additionally captures macOS allocation summaries at
cycles 8 and last (these reads can affect RSS residency). Use
`OPENBITFUN_PERF_TRACE=1` to expose read-only resource-budget accounting.
`OPENBITFUN_SCROLL_ANIMATION_DIAGNOSTICS=1` additionally tracks weak references
to WAAPI animations in the single-eval experiment, grouped by owner, playback
state and effect-target attachment. It does not keep animation/effect/DOM objects
alive or force GC, and restores the patched `animate` method on exit. A cancelled
animation wrapper and a released effect are different observations; report both.
DOM growth assertions use cycles 8 onward because cold async syntax decoration
can add nodes after the first sample. All cold samples remain in the report.

For embedded WebDriver reveal/focus and shell scroll geometry, build Desktop
and current frontend assets, then run:

```bash
node tests/e2e/scripts/run-interaction-scroll.mjs
```

This runner uses real production controls, an independent packaged frontend
snapshot, temporary application storage and a private WebView store. It checks
click, pointer/wheel actions, element screenshot, input clear/send, offscreen reveal
and oversized click targets, and retains `result.json` in its printed temporary
directory. It does not use a mock page or establish remote/platform coverage.
Set `OPENBITFUN_E2E_FRONTEND_DIR` to a completed build directory with
`frontend-revision.json` to reuse an existing snapshot during concurrent builds.
The runner also snapshots the executable; `OPENBITFUN_E2E_DESKTOP_BINARY` can
select a freshly linked artifact when a development instance locks the default exe.

For workbench page latency, pane resizing and process residency, use a completed
production frontend and Desktop binary with the isolated runner:

```bash
node tests/e2e/scripts/run-workbench-performance.mjs
OPENBITFUN_WORKBENCH_BASELINE_FRONTEND=/absolute/path/to/completed/baseline/frontend node tests/e2e/scripts/run-workbench-performance-pair.mjs
node --test tests/e2e/scripts/workbench-performance-metrics.test.mjs
```

It records seven navigation destinations (first entry plus eight repeats), all
settings pages, project resources, files, a code editor, an 80-turn conversation,
terminal opening, real divider geometry, draft/reading preservation and three
30-second resource windows: active home, static Todos with home retained, and
home again. Each window follows a 5-second settle; snapshots and extra reading /
editor guards run outside measured windows. State guards default on. Schema 2
records protocol / harness hashes and exact cumulative-process-CPU boundaries.
The pair runner alternates three isolated baseline / optimized pairs, enforces
the same sequence, binary, environment and harness, and rejects incomplete or
experimental runs. It also compares all four avatar tracks and rendered SVG shape geometry at
40 points per 1600-ms cycle, outside timing; visible animation must keep advancing
and hidden home animation must stop. Eight native screenshot cases cover two
responsive sizes, three animation phases and scrolling; artwork must actually
paint inside its centered layout box. Paired comparison checks cropped pixels
with a small edge-antialiasing tolerance. Pair order is AB / BA / AB. Inspect `comparison.json` as well as each run.
`OPENBITFUN_WORKBENCH_PAIRS` controls paired repetitions;
`OPENBITFUN_WORKBENCH_PAIR_EVIDENCE` selects a persistent evidence directory. The printed evidence directory retains `result.json`, logs and any
failure screenshot. `passed` reports runner success; inspect `functionalPassed`
and `performanceBudgetsPassed` separately. GPU counters are system-wide and newly
created WebKit processes are attribution candidates, not a JS heap measurement.
The candidate PID set is frozen after initialization so unrelated later launches
do not inflate application totals; this still does not prove process ownership.
GPU-process CPU / RSS and system GPU busy / memory must be reported separately.
The resource sampler currently uses macOS `ps` / `ioreg`; this is not a
Windows/WebView2 or Linux/WebKitGTK resource benchmark.
The embedded driver emits MouseEvent for W3C pointer actions; this runner sends
PointerEvent through native eval for pointer-based dividers, without replacing
pointer capture, and requires actual movement. This does not establish trusted
OS mouse/trackpad behavior or compositor pixels for every frame.

`OPENBITFUN_WORKBENCH_PANELS_ONLY=1`, `OPENBITFUN_WORKBENCH_LAYOUT=overlay`,
`OPENBITFUN_WORKBENCH_SIDE=left` and `OPENBITFUN_WORKBENCH_TERMINAL_POSITION=bottom`
select isolated layout variants. `OPENBITFUN_WORKBENCH_REPEATS` and
`OPENBITFUN_WORKBENCH_IDLE_MS` control sample counts / window duration;
`OPENBITFUN_WORKBENCH_SETTLE_MS` controls settling. Different values cannot be
compared as the same protocol. The shared completed
frontend/binary overrides apply. `OPENBITFUN_WORKBENCH_MOTION_CONTRACT=1` adds
the all-artworks / sizes native source geometry contract after all timed windows;
`OPENBITFUN_MOTION_REFERENCE_COMMIT` selects its original player (default `HEAD`). Keep builds and tests out of timed runs.
The bottom variant seeds the terminal preference through the native config API,
then attaches the UI-created PTY through the existing bottom-host event contract;
it checks bottom-host resizing, not a user-facing bottom-opening workflow. Overlay
variants assert the real layout/side and exposed composer width.
`OPENBITFUN_WORKBENCH_CONTAINMENT_DIAGNOSTIC=1` is a separate, explicitly marked
temporary CSS experiment; never treat it as unmodified-product acceptance.


For a scene-only navigation comparison without opening the file editor, run
`node tests/e2e/scripts/run-scene-visibility.mjs`. It uses the shared attributed
native sampler, 30 home/history cycles, and three 30-second home/Todos/home
windows. `OPENBITFUN_SCENE_CYCLES`, `OPENBITFUN_SCENE_IDLE_MS`,
`OPENBITFUN_SCENE_LABEL` and `OPENBITFUN_SCENE_EVIDENCE` select the workload and
output; the completed frontend/binary overrides above apply. Reduced workloads
are marked pilot. Compare only identical protocol, harness, environment and
native hashes; the two arms may differ only in completed frontend assets.
Fixed avatar screenshots, motion geometry, hidden-scene focus/hit testing and
crossfade observations run after performance windows. This is local native
coverage, not OS input/compositor timing, first launch, remote, JS heap or GPU busy.
Protocol v2 starts timing at pointerdown and sends PointerEvent plus MouseEvent
through the real WebView handlers. The current embedded element-click endpoint
only emits MouseEvent, omitting the modality tracker and pointerdown session
activation; v1 failed its baseline animation guard for this reason. Never merge
these measurements with click-start MouseEvent-only results.
Run builds and checks before measuring; never concurrently.
The shared native runner requests independent copy-on-write frontend/native
snapshots when the filesystem supports them, falling back to ordinary copies.
They are not hard links or symlinks; changing a source cannot change past
evidence. Snapshot preparation is outside the measurement windows. Keep the
resulting harness hash distinct from earlier ordinary-copy runs, and do not
compact archived evidence while any performance workload is running.
For the matching AB/BA/AB comparison use
`OPENBITFUN_SCENE_BASELINE_FRONTEND=/absolute/baseline OPENBITFUN_E2E_FRONTEND_DIR=/absolute/candidate node tests/e2e/scripts/run-scene-visibility-pair.mjs`.
`OPENBITFUN_SCENE_PAIRS` defaults to three; `OPENBITFUN_SCENE_PAIR_EVIDENCE`
selects the output directory. Both arms retain the same non-editor workload.
Scene resource/action windows assert the expected active scene and document
visibility in both endpoint snapshots, record `document.hasFocus()`, and require
stable focus between endpoints. The pair runner additionally requires matching
focus conditions across arms. Unexpected navigation or focus differences invalidate
the comparison instead of being reported as savings. Endpoint guards cannot detect
a departure and return between snapshots. Retain failed evidence and rerun both
arms with one harness.
The shared native workload runner disables automatic app update checks only in its
isolated profile through Product Control, before shell readiness/prewarm, and reads
the preference back. `environment.automaticUpdateChecks=false` is part of comparison
identity. Updater work is explicitly outside these workloads; product data refresh,
animations and the real user's installation settings remain unchanged. Older runs
did not fix this preference or record document focus; do not mix their resource
data with the new harness. Use identical frontend assets for an A/A control when
validating measurement changes; that is not a product optimization comparison.

For isolated scene-switch attribution, run `node tests/e2e/scripts/run-navigation-profile.mjs`
with a new `OPENBITFUN_NAV_PROFILE_EVIDENCE` directory and the same completed
frontend/native overrides. Protocol v6 uses the pointer sequence above for 16
home/history cycles and a 20-second native WebContent stack sample; it opens
neither the file editor nor a PTY. `OPENBITFUN_NAV_PROFILE_LAYOUT=1` adds reversible
geometry getter wrappers and slow-call stacks. V4 also records the owning and
active scene's transition phase/visibility at each slow read without reading
computed styles. V3 results remain their own diagnostic protocol. Wrappers preserve native values,
but sampling and stack collection add overhead: these are diagnostic samples,
not speed/resource acceptance. A removed layout-read stack can move pending
layout to another reader, so validate actual savings with the uninstrumented pair.
V5 optionally adds `OPENBITFUN_NAV_PROFILE_MUTATIONS=1` with the layout flag to
collect DOM writes between slow reads and current focus-visible state. Each batch
keeps at most 128 primitive records and reports dropped records. These are not
synchronous write stacks, exact write timestamps or WebKit invalidation records;
CSS animation/engine work can invalidate style without a DOM mutation. The
observer disconnects with the getter wrappers. Keep V4 and V5 evidence separate.
V6 also wraps native `Element.checkVisibility` when available; the wrapper preserves
arguments/results and is restored with the geometry probes. Inclusive method time
can contain pending product layout, so do not subtract it as pure probe overhead.

For observer calibration, run `node tests/e2e/scripts/run-scene-probe-diagnostic.mjs`
with a fresh `OPENBITFUN_SCENE_PROBE_EVIDENCE` and the completed asset overrides.
It alternates full observation / frame-only / full-restored in one process, each
with eight home/history cycles and layout probes. The frame-only arm uses the same
pointer interaction and 700 ms RAF interval, but checks readiness once at the end
without per-frame visibility or geometry queries. It cannot report feedback/content
latency or pass those budgets. Sequential cache/JIT/GC effects remain confounders;
look for reversible overall resource changes, not just removed getter time.

For reversible scrollbar-rule attribution, run
`node tests/e2e/scripts/run-scene-style-diagnostic.mjs` with a fresh
`OPENBITFUN_STYLE_DIAGNOSTIC_EVIDENCE` and the same completed asset overrides.
It performs original / temporarily suspended / restored CSS phases in one native
process, each with eight home/history cycles and layout-read probes. Set
`OPENBITFUN_STYLE_DIAGNOSTIC_FOCUS_ONLY=1` to isolate the shared focus/hover paint
rules; that mode also requires identical scroller/tab viewport geometry. Exact
CSSOM restoration, draft, reading position and zero opened editors are checked.
This deliberately changes scrollbar presentation in isolated test storage to
diagnose cost. It is not a shipping optimization or performance acceptance, and
sequential phases share process age/caches. Never run it beside a benchmark.
Protocol v2 validates the primitive boolean through the native execute boundary
and records the effective rule scope. V1 wrapped the boolean in an array, so its
purported all-rule run actually removed only focus rules; retain that evidence
as a scope setup error, not an all-rule attribution result.

Protocol v3 additionally accepts `OPENBITFUN_STYLE_DIAGNOSTIC_MODE=session-display`
(leave `FOCUS_ONLY` unset). This temporarily gives only the hidden session scene
`display:none`, then removes that diagnostic rule. Each phase first checks the
hidden box outside its CPU window and returns to the session, requiring unchanged
active scroller/tab geometry. The zero-size hidden state is an intentional
diagnostic intervention, not equivalent product behavior: draft/reading checks
may reveal dependencies on hidden geometry. A successful run does not establish
all embedded-view, live-generation, accessibility or remote behavior. Do not
mix v3 values with the older protocols; their preparation and harness differ.

Protocol v4 additionally accepts `OPENBITFUN_STYLE_DIAGNOSTIC_MODE=session-inert`.
Only the retained session root's inert attribute writes are temporarily suppressed;
the original attribute methods and current isolation state are restored afterward.
Each phase checks the effective inert/aria-hidden state and unchanged active geometry.
This deliberately weakens interaction isolation for diagnosis and must never be
shipped as an optimization. Its layout probe also includes checkVisibility, so keep
v4 metrics separate from v3. Draft/reading checks are not focus or accessibility
equivalence proof for this intervention.

For transcript selection residency, run `node tests/e2e/scripts/run-timeline-selection.mjs`
with a new `OPENBITFUN_SELECTION_EVIDENCE` directory and those completed asset
overrides. It uses native WebKit selectionchange delivery after DOM Range selection,
scrolls a long history through row recycling, checks selected text/endpoints,
moves the selection outside to release leases, checks a range with both endpoints
outside the scroller, and clears it. Drafts survive and no editor is opened.
This is functional coverage, not OS drag selection, clipboard, selection paint,
remote behavior or performance acceptance. Do not run it beside a benchmark.

For native scene-tab overflow and reveal behavior, run
`node tests/e2e/scripts/run-scene-tabs.mjs` with a fresh
`OPENBITFUN_SCENE_TABS_EVIDENCE` directory and the completed frontend/native
overrides. It opens real non-editor scenes, narrows the native window, and checks
pointer reveal with intermediate scroll positions, Home/End selection and focus,
vertical-wheel translation, paging controls, width restoration and draft retention.
Keyboard events are synthesized through the real TabGroup handlers. This is a
functional regression, not OS-trusted input or compositor/performance acceptance;
its frame probes must stay separate from the scene visibility benchmark.
Protocol v3 seeds the isolated profile's pinned navigation before reloading and
explicitly opens all seven scenes, including Home. The app's tabless startup is
not an implicitly opened Home tab. Earlier v1/v2 setup failures remain evidence,
not product failures. The original implementation also fails the right-edge
reveal check because nested item offsets were interpreted in the wrong coordinate
system; retain that baseline failure rather than weakening visibility assertions.
V4 additionally closes Insights through the real Delete handler, waits for its
scene host to unmount, and reopens it from navigation. This checks native lifecycle
and retained conversation state; deliberately suspended reopening is covered by
the SceneViewport DOM fixture, not by this native workload.

For pet/bubble main-window activation after opening an embedded browser, build
Desktop and run `node tests/e2e/scripts/run-browser-window-activation.mjs`.
It uses completed frontend assets and isolated storage to exercise native window
activation, focus, tray hiding, geometry persistence, main-view command routing
and remote child-view ACL rejection with multiple browser children. The same
binary/frontend snapshot overrides above are supported. This is native command
coverage, not a pet-pointer or remote-session integration test.

For companion CPU, RSS, sprite cadence and system GPU observations on macOS:

```bash
OPENBITFUN_E2E_FRONTEND_DIR=/absolute/path/to/completed/frontend node tests/e2e/scripts/run-pet-performance.mjs
OPENBITFUN_PET_BASELINE_FRONTEND=/absolute/path/to/baseline OPENBITFUN_E2E_FRONTEND_DIR=/absolute/path/to/optimized node tests/e2e/scripts/run-pet-performance-pair.mjs
```

The pair runner alternates three baseline/optimized pairs (AB / BA / AB), using
the same Desktop binary and fresh storage for each run. Each production frontend
needs `frontend-revision.json`; generate it after an independent Vite build with
`node scripts/generate-frontend-revision.mjs /absolute/path/to/frontend`.
`OPENBITFUN_E2E_DESKTOP_BINARY` selects the native binary. Do not build or run
other tests during sampling. The native host is debug unless replaced explicitly.

The runner waits 15 seconds after shell readiness, then samples closed-before,
idle BitBlob, working with a fixture bubble, hidden, and destroyed-after states.
It hides the main window before each 5-second settle and asserts it stays hidden
at both boundaries of every 20-second window. This excludes delayed startup or
macOS application activation from the pet comparison. Activity uses the actual
companion event contract with fixture task data; it does not run a model or prove
remote task delivery. Cadence probes run outside resource windows and require
at least five distinct atlas positions. These are RAF/style observations, not
compositor pixel captures. `OPENBITFUN_PET_WINDOW_MS` and `OPENBITFUN_PET_PAIRS`
override duration and paired repetitions and must be reported with the results.

Raw `result.json`, logs and paired `comparison.json` remain in the printed
temporary directories. CPU is cumulative process time / wall time (100% is one
core). RSS and CPU for new WebKit candidates are separated from the host; the
pet candidate is identified by creation after reopening its window. The PID set
then stays fixed. These are candidate attributions, not a guaranteed ownership
API. GPU-process CPU/RSS are not GPU utilization or VRAM. `ioreg` GPU counters
are system-wide; unavailable JS heap is recorded as null. Local macOS results
do not establish Windows/Linux or any live remote scenario.

For attributed companion residency and allocation diagnosis:

```bash
OPENBITFUN_E2E_FRONTEND_DIR=/absolute/path/to/completed/frontend node tests/e2e/scripts/run-pet-residency.mjs
```

This uses the shared Darwin responsibility sampler and independent WebContent
identity pulses. Protocol v5 keeps the main window visible on the static Todos
scene while the companion is visible, hidden without destruction, then restored;
each phase has five 60-second windows. Earlier protocols tried keeping main
hidden; app activation can reveal it, invalidating that controlled condition.
Do not mix their resource data with v5 or attribute the shared GPU solely to pet.
Sprite size/source, authored walking or v2 look frames, and hidden pause remain
guarded. Real pointer input is recorded: walking cadence interrupted by look
frames is not counted as full walking verification. Native
`vmmap`/`heap` allocation summaries run only between phases. Callback counters wrap
the Tauri callback Map's set/delete/get without retaining callback values, so the run
is explicitly instrumented and is not an optimization A/B or
speed acceptance. It does not force GC, clear product caches, change polling, or
exercise custom pet caches and streamed bubbles. Use
`OPENBITFUN_PET_RESIDENCY_WINDOW_MS`, `OPENBITFUN_PET_RESIDENCY_WINDOWS`, and
`OPENBITFUN_PET_RESIDENCY_EVIDENCE` to select diagnostic duration/output; report
shortened windows. Allocation categories do not establish JS retention paths.

For conversation-owned browser pages, build Desktop and Web UI and run
`node tests/e2e/scripts/run-browser-session-isolation.mjs`. The fixture uses
isolated storage and loopback model/page servers. It drives the actual session
controls and Agent tool dispatcher to check background opening, concurrent reads,
native visibility and document preservation across repeated session switches.
Inspect its `result.json`; local native coverage does not prove remote behavior.
Full visibility coverage needs an unlocked desktop. For a locked/headless display,
`OPENBITFUN_E2E_BACKGROUND_ONLY=1` runs background execution and panel binding;
the report explicitly excludes foreground native visibility in that mode.

Markdown editor browser interaction tests (no desktop binary required):

```bash
pnpm --dir tests/e2e exec wdio run ./config/wdio.markdown-browser.ts
```

This focused runner mounts the production file editor with temporary file IO
through a test adapter; it does not replace desktop or remote transport coverage.
See `src/web-ui/src/tools/editor/AGENTS.md` for scope and output locations.

For the real desktop Markdown workflow, build the desktop and current frontend,
then run `pnpm --dir tests/e2e exec wdio run ./config/wdio.markdown-native.ts`
from the repository root. This focused runner uses packaged frontend assets and
a fresh temporary application profile; it does not use another checkout's dev server.

For Windows live application-update discovery, reminder deferral and signed download completion,
build the current frontend, then run `node tests/e2e/scripts/run-app-update.mjs --build`.
The build uses the public verification key from `docs/verify-downloads.md`; the test
requires a genuinely newer public release. `OPENBITFUN_E2E_FRONTEND_DIR` can select
an independent build containing `frontend-revision.json`. The runner uses isolated
application, updater-cache and WebView storage, downloads the real signed package,
and never confirms installation. It retains `result.json` under its printed temporary
directory. Only persisted reminder timestamps are aged to cover the 24-hour boundary;
no network response, update store, package or system clock is mocked.

For Gitee list filters and pagination against the public `dromara/sa-token`
repository, build the desktop and current frontend, then run
`pnpm --dir tests/e2e exec wdio run ./config/wdio.gitee-native.ts`.
This read-only live test uses a temporary application profile and Git remote,
checks the actual UI against independent Gitee API responses, and retains
screenshots plus `result.json` under the printed temporary evidence directory.
Set `GITEE_TOKEN` in the runner environment to authenticate both the desktop
and independent API reads when anonymous quota is exhausted. Do not put tokens
in the test source, command arguments, or retained evidence.

### Huawei knowledge MCP (live, opt-in)

After building Desktop, verify the public Huawei endpoint through settings,
health checks, document search, and document retrieval with isolated storage:

```bash
OPENBITFUN_E2E_HUAWEI_MCP=1 OPENBITFUN_E2E_STORAGE_ROOT="$(mktemp -d /tmp/openbitfun-huawei-e2e.XXXXXX)" pnpm --dir tests/e2e exec wdio run ./config/wdio.conf.ts --spec "./specs/l1-mcp-huawei-health.spec.ts"
```

The spec is skipped by default, uses no account credentials, and restores the
isolated MCP configuration after the run. Internet access and availability of
the public endpoint are required.

### Native subscription and channel pool (isolated mock)

The model settings UI was restored to upstream/main on 2026-10-16. This runner's
account/channel editor workflow is retained for reference and currently paused;
it requires a matching pre-rollback frontend snapshot. Do not run it against the
current baseline page or present its historical results as current UI acceptance.
Use the owner tests for retained backend behavior until the minimal UI returns.

After building the debug Desktop binary and a current packaged frontend:

```bash
node tests/e2e/scripts/run-subscription-pool.mjs
```

The runner requires OpenSSL, uses loopback OAuth/quota/model services and a
fixture CA, and drives the actual native commands, channel settings editor,
chat, tools, statistics and product restart. The debug E2E storage guard must
redirect subscription metadata and the encrypted fixture vault before account
discovery. It never copies or uses real subscription credentials. The two
`OPENBITFUN_E2E_FRONTEND_DIR` / `OPENBITFUN_E2E_DESKTOP_BINARY` snapshot overrides
are supported. Read the retained `result.json`; the existence of the runner is
not evidence of a passing application scenario or any physical remote host.
The additional service fixture models Antigravity browser authorization and
OpenCode Zen/Grok/Hermes device authorization, with independent account subjects,
refresh tokens and account catalogs. Each provider pool must recover a rejected
primary credential once, observe quota rejection, then use its declared backup;
assert actual HTTP identities, ledger attribution and independent sign-out.
Keep vendor HTTP behavior in the service fixture and native orchestration in
`verify-provider-account-pools.mjs`; neither may replace internal selection,
config commands or usage projections. Screenshots come from the real webview
after overlay rendering settles, not from a recreated mock page.
The runner records the copied binary SHA-256 and frontend revision, then removes
only its copied binary/frontend after stopping the app. Logs, result and the
isolated profile remain; set `OPENBITFUN_E2E_KEEP_SNAPSHOT=1` to retain the copies.

For workspace HTML preview resource loading, build Desktop and Web UI, then run:

```bash
node tests/e2e/scripts/run-html-preview.mjs
```

The native browser fixture uses isolated product storage and completed binary /
frontend snapshots. It verifies nested build output with root-relative CSS,
relative JavaScript modules and dynamic imports, parent-relative styles, images,
encoded filenames, and reloading one preview after opening another. Inspect its
`result.json`. It also opens a nested site index at `/`, follows a real page link,
reloads a history route, loads a deep link with a query, and verifies images/modules
plus a true 404 for a missing image. Views are shown and an image entrance
animation must finish, so decoding in a hidden view cannot satisfy the check.
This is native local browser coverage. The services-integrations
OpenSSH fixture separately covers the SSH/SFTP resource provider.

For long workbench residency and attributed macOS process resources:

```bash
node --test tests/e2e/scripts/native-process-probe.test.mjs tests/e2e/scripts/residency-metrics.test.mjs
OPENBITFUN_E2E_FRONTEND_DIR=/absolute/path/to/completed/frontend node tests/e2e/scripts/run-workbench-residency.mjs
```

The runner compiles a test-only native sampler with the local macOS SDK. A
calibration compares Mach-time CPU accounting to `CLOCK_PROCESS_CPUTIME_ID`.
Its launch helper disclaims the test IDE's responsibility, then every sample
requires the actual Desktop PID to own its Darwin responsibility identity.
Children are enumerated dynamically by that identity; unrelated WebKit processes
are excluded. The optional Darwin SPI is resolved at runtime and fails explicitly
when unavailable. This adapter is not a product runtime dependency.

Defaults: 60 cycles through eight destinations with a retained editor, real PTY
and 80-turn conversation; four 180-second idle windows plus 600 seconds with the
main window hidden. Checkpoints every five cycles record DOM, scene, animation,
logical cache and driver-handle counts. The original draft and reading anchor
must survive navigation and hiding. Closable tabs are closed through real UI
controls. `vmmap -summary` runs outside sampled windows; no forced collection or
product cache clearing is allowed. `passed` means functional completion; inspect
`performanceBudgetsPassed` and the resource trend separately.

`OPENBITFUN_RESIDENCY_CYCLES`, `OPENBITFUN_RESIDENCY_WINDOW_MS`,
`OPENBITFUN_RESIDENCY_HIDDEN_MS`, `OPENBITFUN_RESIDENCY_EVIDENCE` and
`OPENBITFUN_RESIDENCY_LABEL` select duration and persistent evidence. Short
pilots validate the harness only. CPU uses monotonic boundaries and one-core
percentages. PID/start-time pairs prevent PID reuse from merging unrelated
lifetimes. Arriving/exiting processes report partial coverage. Physical footprint,
RSS, wakeups and disk I/O are distinct metrics; memory-category and system AGX
observations do not establish JS heap or app-exclusive GPU busy/VRAM. Keep other
builds and benchmarks out of measurements. This is local macOS/debug-host coverage
unless the binary override and recorded profile say otherwise.

Protocol v3 retains navigation RAF samples and viewport dimensions/DPR. Before
prewarming, two 400-ms CPU pulses identify the main and pet WebViews against
attributed WebContent processes; this diagnostic is outside measured windows.
`OPENBITFUN_RESIDENCY_DESTINATIONS` selects at least two distinct comma-separated
destination IDs for causal isolation. Different destination sequences are not
optimization A/B results. For matched A/B, set
`OPENBITFUN_RESIDENCY_BASELINE_FRONTEND` and `OPENBITFUN_E2E_FRONTEND_DIR`, then run
`node tests/e2e/scripts/run-residency-pair.mjs`. It alternates three pairs by
default; `OPENBITFUN_RESIDENCY_PAIRS` and `OPENBITFUN_RESIDENCY_PAIR_EVIDENCE`
control repetition and output. The pair runner requires matching protocol,
harness, native binary and environment, and rejects failed optimized speed gates.
Do not edit the harness while a paired run is active.

Workbench protocol v3, pet protocol v4 and residency protocol v5 also enforce
the Desktop target's font profile using the shared build contract. A bare Vite
production build defaults to the generic `harmony-bundled` profile, even on macOS;
Apple Desktop requires `OPENBITFUN_WEB_FONT_PROFILE=apple-system` when building
an independent frontend. The normal Desktop build selects this automatically.
`OPENBITFUN_E2E_EXPECTED_FONT_PROFILE=harmony-bundled` permits an explicit alternate
profile diagnostic on macOS; it is recorded as not matching the Desktop target.
Do not compare different profiles as a product optimization or silently reuse a
generic-web snapshot as the default native baseline. Test the guard with
`node --test tests/e2e/scripts/desktop-frontend-profile.test.mjs`.

`OPENBITFUN_RESIDENCY_ALLOCATION_DIAGNOSTIC=1` additionally captures GPU-process
native heap allocation types after navigation, outside every measured window.
This is neither a JavaScript heap snapshot nor an application VRAM measurement.

For concurrent operations during actual Agent tool execution and bounded streaming:

```bash
node --experimental-strip-types --test tests/e2e/scripts/concurrent-stream-fixture.test.mjs
OPENBITFUN_E2E_FRONTEND_DIR=/absolute/path/to/completed/frontend node --experimental-strip-types tests/e2e/scripts/run-concurrent-workload.mjs
```

This runner uses the same isolated native host, target font-profile guard,
responsibility-based resource sampler and out-of-window WebView attribution.
The loopback model requests four real ExecCommand calls and four real file edits,
then emits exactly 600 Markdown paragraphs (250 initially, the rest every 90 ms).
During output, it types a draft, takes reader control, navigates away and back,
drags both dividers, and completes and verifies persisted content. A second
session cancels an active stream and checks disconnection and draft retention.
Protocol v3 fixes completion at 600 paragraphs and cancellation at 120. The
cancellation stream remains open and unfinished after reaching its output cap.
It does not establish external-model or concurrent multi-session performance.
Protocol v7 retains the new document time-origin fence after fixture refresh,
but does not open an editor. It uses the real panel toggle to open an empty
secondary canvas and asserts zero Monaco editor elements at resource-window endpoints.
Actual Agent file edits still execute against isolated fixture files. Input uses
the scene runner's PointerEvent + MouseEvent sequence, with navigation and cancel
timing starting at pointerdown; navigation observation lasts 700 ms. Do not
compare it directly with the retained-editor / click-start v4 protocol. v5
excludes the editor but leaves native focus uncontrolled. v6's explicit native
focus preparation did not retain foreground focus in this interactive host and
its pilot was rejected. v7 waits for the actual visible, unfocused main window
and document before a measured action or idle settle, without forcing focus.
Wait durations are recorded. Compared endpoints must remain natively unfocused;
document focus/blur/visibility events are retained and an observed transition
also invalidates the comparison. These visible-background results do not prove
sustained foreground performance. Final
tab cleanup selects a visible tab and uses its production Delete shortcut;
hidden hover-only close controls are not valid pointer targets.
WebView attribution runs after startup prewarming; later attribution
waits the normal five-second settle before its two CPU pulses. Ambiguous PID
attribution still fails rather than lowering the identification threshold.

Inspect `functionalPassed` and `performanceBudgetsPassed` separately. Raw frame
and input samples remain in `result.json`; input-to-RAF is not keyboard-to-pixel
latency, and a single navigation sample is not a destination P95. The four idle
windows default to 30 seconds after a 5-second settle. The existing native binary
and frontend overrides apply; `OPENBITFUN_CONCURRENT_EVIDENCE` selects a fresh
evidence directory. `OPENBITFUN_CONCURRENT_INITIAL_PARAGRAPHS`,
`OPENBITFUN_CONCURRENT_MAX_PARAGRAPHS` and `OPENBITFUN_CONCURRENT_IDLE_MS` permit
explicit pilots, marked in coverage. Keep their protocol distinct from a full
baseline. The existence of this runner does not establish a completed run; retain
and inspect actual evidence before recording coverage.

For matched comparisons, set `OPENBITFUN_CONCURRENT_BASELINE_FRONTEND` and
`OPENBITFUN_E2E_FRONTEND_DIR`, then run
`node tests/e2e/scripts/run-concurrent-workload-pair.mjs`.
`OPENBITFUN_CONCURRENT_PAIRS` defaults to three alternating AB/BA pairs;
`OPENBITFUN_CONCURRENT_PAIR_EVIDENCE` selects the output directory. The comparison
requires identical protocol, harness, native binary and environment, consistent
frontend digests within each arm, and matching visible scenes and document focus
at resource-window endpoints, plus the v7 document event observations. Native
focus is read at endpoints, not continuously polled during measured actions.
Fewer than three pairs are marked as pilots. Functional
completion and optimized speed budgets are separate results; resource changes
must be assessed from the attributed per-process data, not an aggregate RSS sum.

For post-close memory attribution, set
`OPENBITFUN_CONCURRENT_MEMORY_DIAGNOSTIC=1` on the concurrent runner and use a
fresh `OPENBITFUN_CONCURRENT_EVIDENCE` directory. It keeps the full bounded
workload and adds three 60-second closed windows, each after a five-second
settle. Weak references observe only transcript roots in the current document;
a refresh resets them, so collection does not prove an earlier document or all
child objects were freed. Logical cache bytes and highlight-range counts remain
separate from native footprint. Main `vmmap`/`heap` and GPU `vmmap` run outside
resource windows and can perturb residency; no GC or product cache eviction is
forced. This separate diagnostic protocol is rejected by the normal pair runner
and cannot establish product optimization acceptance.

For work retained after a real bounded cancellation, run the diagnostic separately:

```bash
OPENBITFUN_CANCEL_TRACE_CALLBACKS=1 OPENBITFUN_E2E_FRONTEND_DIR=/absolute/path/to/completed/frontend node --experimental-strip-types tests/e2e/scripts/run-cancellation-diagnostic.mjs
```

`OPENBITFUN_CANCEL_DIAGNOSTIC_EVIDENCE` selects a fresh evidence directory. The
callback flag observes RAF/timer registrations and DOM mutations after cancel;
it also records native transcript scroll writes and readback without changing
the requested offset. Wrappers restore on exit and retain only diagnostic data.
Pre-existing repeating timers are not wrapped. Instrumentation and geometry
reads add overhead, so these results locate work and never establish A/B gains.
`OPENBITFUN_CANCEL_PROFILE_STACKS=1` adds a separate native stack sample after
the resource window; its sample proportions are not that window's CPU usage.

For separate tool-startup and completed-stream attribution without an editor:

```bash
OPENBITFUN_E2E_FRONTEND_DIR=/absolute/path/to/completed/frontend node --experimental-strip-types tests/e2e/scripts/run-tool-startup-diagnostic.mjs
```

`OPENBITFUN_TOOL_DIAGNOSTIC_EVIDENCE` selects fresh evidence. Three fresh
documents each execute eight real tools and 120 bounded paragraphs, with a
five-second native stack sample at tool startup,
then callback observation during a five-second settle and 30-second idle window.
They share native process age and caches. Instrumentation adds overhead, and
callbacks registered before observation are not all wrapped. This diagnostic
locates work; its frame and CPU values are not uninstrumented A/B acceptance.
Protocol v2 defaults to native sampling without patched layout getters so the
getter stack collection does not dominate the sampled JavaScript work. Set
`OPENBITFUN_TOOL_DIAGNOSTIC_LAYOUT_READS=1` only for a separate layout-attribution
run; the flag is part of the protocol and these modes must not be mixed.

For selected synchronous JavaScript attribution, build a separate instrumented
frontend, generate its revision, and run it only as a diagnostic:

```bash
node --test tests/e2e/scripts/sync-work-diagnostic.test.mjs
OPENBITFUN_WEB_FONT_PROFILE=apple-system OPENBITFUN_SYNC_DIAGNOSTIC_BUILD=/absolute/new/diagnostic/frontend node tests/e2e/scripts/build-sync-work-diagnostic.mjs
node scripts/generate-frontend-revision.mjs /absolute/new/diagnostic/frontend
OPENBITFUN_E2E_FRONTEND_DIR=/absolute/new/diagnostic/frontend OPENBITFUN_SYNC_DIAGNOSTIC_EVIDENCE=/absolute/new/evidence node --experimental-strip-types tests/e2e/scripts/run-sync-work-diagnostic.mjs
```

Finish builds and tests before starting the native workload. The build helper
refuses an existing destination and emits its exact function labels in
`sync-work-instrumentation.json`; ordinary builds do not load this plugin.
The runner requires the diagnostic marker and verifies that real tool processing
and session projection were observed, that each timing stack balances, and that
all eight tools, 120 output paragraphs, persisted endpoints and drafts survive
in each of three fresh documents. No editor opens, and no geometry wrappers or
native stack sampler run. Documents share process age and caches. Counts and
timings cover only the selected synchronous functions/callbacks; a render-function
call is not proof of a React commit or native paint. Inclusive times
overlap and self times subtract only instrumented descendants. A label derived
from a variable assigned a call can name an argument callback rather than the
returned function: inspect its recorded source line before assigning ownership.
Instrumentation adds overhead. Use the normal, uninstrumented matched runner
for speed and process-resource acceptance.

For a heavy code-editor workload using six real files and production controls:

```bash
OPENBITFUN_E2E_FRONTEND_DIR=/absolute/path/to/completed/frontend node --experimental-strip-types tests/e2e/scripts/run-editor-workload.mjs
```

This reuses the native host and attributed sampler above. Two 30,000-line and
four 8,000-line TypeScript files exercise first entry, twelve hot switches,
incremental input, undo/redo, large wheel steps, save, external disk updates and
find. After 45 seconds on Home, the dirty document, cursor and reading offset
must restore through the real file tree. Content readiness requires a populated
Monaco model, rendered lines and two RAF opportunities; a loading container alone
does not count. The exposed editor instance is only read, never used to mutate
the model or trigger commands. Text and wheel input use the embedded driver;
shortcuts use native eval to dispatch DOM KeyboardEvents with legacy `keyCode`,
which Monaco requires and the embedded key source currently omits. These events
do not establish trusted OS keyboard or IME coverage.

Editor workload protocol v2 additionally requires the actual TypeScript language
service to answer for an opened large file, outside timed opening/input phases,
and rejects Worker bootstrap/fallback warnings. Earlier rendered-text-only results
do not establish working diagnostics or completion; do not compare their resource
use to a working language service as a pure performance gain.
Protocol v3 also checks the file row is in a non-inert navigation layer and is the
actual pointer hit target. New files open through the workspace menu/file tree;
retained documents switch through their real scene tabs. Older runs could dispatch
clicks directly to retained, hidden file-tree rows: those timings are not a valid
baseline for this corrected user workflow. Each opening records its trigger kind.
Protocol v4 starts hot switching on the other document, so all twelve samples
change selection; v3 included one already-active-tab click in those twelve.

`OPENBITFUN_EDITOR_EVIDENCE` selects a new evidence directory;
`OPENBITFUN_EDITOR_IDLE_MS` changes the four default 30-second windows and marks
the run as a pilot. The separate 45-second inactive window crosses the existing
30-second view-residency deadline. Pilots establish workflow execution only,
not stable CPU/memory acceptance. Markdown, Diff, remote transport and actual
JS heap/GPU busy remain outside this code-document scenario. Inspect functional
and speed gates separately, and retain failed runs before recording coverage.

`OPENBITFUN_EDITOR_RETENTION_DIAGNOSTIC=1` runs that same workflow with weak
model/editor/DOM observations and a Worker construction/termination probe, followed
by an additional 30-second closed window. Public Monaco model inventory and dispose
events distinguish live documents from disposed objects awaiting collection. The
probe does not retain models, editors, roots or Workers, clear product caches, or
force GC. A live weak reference is not a leak or retained-byte measurement. This
mode is explicitly instrumented and excluded from performance acceptance; its
resource windows locate retention only. The ordinary runner remains uninstrumented.
Adding `OPENBITFUN_EDITOR_EMPTY_WORKER_DIAGNOSTIC=1` deliberately resets the
TypeScript worker after the two unmodified closed windows by reapplying identical
compiler options through Monaco's public API. It requires zero open models, records
termination, samples a separate window, then reopens the saved file and requests
real semantic diagnostics. This causal cache intervention is not a product fix;
its timings cannot establish unchanged completion/diagnostic experience or A/B gains.
Alternatively, `OPENBITFUN_EDITOR_EMPTY_PROGRAM_DIAGNOSTIC=1` requires the same
retention probe and two closed windows, verifies that the existing TypeScript
Worker has no mirror files, then requests compiler-options diagnostics to
synchronize the derived program to that empty inventory. Worker identity and
termination state must stay unchanged. A separate resource window and real file
reopen/semantic check follow. This does not force GC, change compiler settings or
represent a product optimization. Do not combine it with the Worker-reset flag.

`run-editor-language-diagnostic.mjs` separately opens a small real TypeScript file
with a known type error, checks the public semantic service and visible model
markers, then closes it. `OPENBITFUN_EDITOR_LANGUAGE_RESET=1` adds identical-option
worker reset and reopening; `OPENBITFUN_EDITOR_LANGUAGE_EVIDENCE` selects a fresh
directory. The async request reports factory, worker and semantic phases through
short native reads, without a Worker wrapper. This distinguishes initialization
failure from long-file cost or a long-running native eval; it is not a benchmark.
`OPENBITFUN_EDITOR_LANGUAGE_ALL=1` also checks JavaScript, JSON and CSS rendered
validation decorations plus HTML tag completion through the editor shortcut. HTML
opens through the file context menu's source action: its ordinary click deliberately
opens a preview. Diagnostic v6 additionally requires the tree entry to be pointer
reachable; an inactive retained navigation layer is not a ready interaction target.
Earlier routing/menu failures remain recorded separately from language-worker
results. Failure artifacts include the native screenshot and HTML context-menu
event target/path, so selector mistakes can be distinguished from Worker errors.

`node tests/e2e/scripts/run-editor-profile.mjs` is a separate diagnostic using six
files and 24 real tab switches that reconstruct inactive views. It records native
main-WebContent stacks, editor creation and theme-definition timings, and slow
layout reads with call sites. Set `OPENBITFUN_EDITOR_PROFILE_EVIDENCE` to a fresh
directory; completed frontend/native overrides apply. All wrappers restore on
exit, model/editor instances are not kept in diagnostic rows, and line counts
and the real language service are checked. Instrumented timings identify work,
not A/B gains. Run it separately from resource/latency acceptance workloads.

For a sustained terminal workload, build the frontend with the opt-in read-only
terminal diagnostics, then run in isolation:

```bash
OPENBITFUN_E2E_FRONTEND_DIR=/absolute/path/to/completed/frontend node --experimental-strip-types tests/e2e/scripts/run-terminal-workload.mjs
```

This uses the workspace context menu to create three real PTYs. A bounded Python
fixture is launched and controlled through terminal input; a parsed response is
required for readiness. It exercises concurrent ANSI output, input acknowledgments,
wheel scrolling, navigation resizing, tab switching, 45 seconds hidden, restoration,
completion, explicit shell exit and view closure. Normal resource windows are
30 seconds after 5 seconds settling. `OPENBITFUN_TERMINAL_WINDOW_MS` can shorten
them for a pilot, which is explicitly excluded from performance acceptance.
`OPENBITFUN_TERMINAL_EVIDENCE` selects a new evidence directory. The fixture needs
`python3` on the test shell PATH. All data and trace files are isolated.

The diagnostic copies only bounded public xterm buffer data and geometry, never
engine handles or methods. Enter is a synthetic DOM event with the legacy keyCode
xterm needs; other text and wheel actions go through the embedded driver. Command
response timing includes driver dispatch and two RAF opportunities after readback,
not compositor completion. Tab content timing is view readiness, not shell readiness.
Screenshots are outside resource windows. Closing a live terminal view intentionally
detaches its PTY; this runner exits the fixture and shell before closing, and must
not change the product detach contract to make a memory assertion pass. Exit
requires both Exited metadata and reaped shell/fixture PIDs, then a final shell
output marker still readable in xterm. A successful `kill(pid, 0)` also includes
zombies; inspect OS process state before classifying a timeout as lost input.
`run-terminal-exit-diagnostic.mjs` isolates this lifecycle with one PTY and
sanitized API trace counts, without replacing the Tauri invoke function. This is
local macOS coverage, not IME, remote PTY or other-platform evidence.

For callback/DOM attribution during sustained output, use the same frontend,
native binary and evidence environment with
`node tests/e2e/scripts/run-terminal-render-diagnostic.mjs`. It observes visible,
hidden after renderer release, and visible again, then exits the fixture and
shell through UI input. Callback wrappers and mutation observers add overhead;
these measurements must not be used as acceptance CPU or latency results. A
callback group's first registration stack is not evidence for every subsequent
registration. Fixtures deliberately stop before all requested batches complete.

For selection/copy behavior across the hidden DOM fallback, run
`node tests/e2e/scripts/run-terminal-selection.mjs` with the same frontend,
native binary and evidence overrides. A real PTY continues output while the
product select-all shortcut is exercised, the view hides long enough to release
WebGL, then restores. Copied history must survive and grow; a single click must
clear the selection. Before hiding, `WEBGL_lose_context` injects a graphics failure
through the actual canvas to exercise the visible DOM fallback. Text, selection,
focused/inactive colors, actual textarea focus and renderer focus classes must
survive blur/refocus. This is fault injection, not a naturally observed GPU failure.
Hidden row mutations are measured separately and must be
zero for the patched renderer. The unpatched renderer is expected to fail that
last assertion after functional checks finish. Copy uses a private DataTransfer
and the real xterm copy event without touching the OS clipboard. Keyboard legacy
codes and MouseEvent.detail=1 are supplied through native eval because the
embedded driver omits them. This is not trusted OS keyboard/clipboard evidence,
and mutation-observed samples are not performance acceptance windows.

The pinned xterm backport can be checked without Desktop using
`node --test tests/e2e/scripts/xterm-render-pause.test.mjs`. Its provenance and
reproducible source/bundle procedure are in `patches/README.md`. Run before/after
native workloads with the same protocol, measurement harness, native binary and
font profile; do not mix the diagnostic and formal resource results.

`run-terminal-workload-pair.mjs` runs three sequential AB/BA/AB pairs by default.
Set `OPENBITFUN_TERMINAL_BASELINE_FRONTEND` and `OPENBITFUN_E2E_FRONTEND_DIR`
to completed frontends, with `OPENBITFUN_E2E_DESKTOP_BINARY` held constant.
`OPENBITFUN_TERMINAL_PAIR_EVIDENCE` selects a new comparison directory and
`OPENBITFUN_TERMINAL_PAIRS` changes the pair count. The runner rejects shortened
or instrumented workloads and an already-existing evidence directory before
writing artifacts, verifies identical protocol/harness/binary/environment,
and retains failed speed budgets rather than dropping those samples. A functional
failure stops the sequence for investigation. GPU-process CPU/footprint remain
distinct from application GPU utilization and VRAM.

For session-owned Browser workload coverage, run
`node --experimental-strip-types tests/e2e/scripts/run-browser-workload.mjs`
with completed `OPENBITFUN_E2E_FRONTEND_DIR` and
`OPENBITFUN_E2E_DESKTOP_BINARY` snapshots. `OPENBITFUN_BROWSER_EVIDENCE`
selects a new isolated evidence directory. The fixed loopback fixture scripts
model responses and page content; real UI sends, Agent ControlHub calls, native
child WebViews, timers, Workers and Canvas animations run normally. Three pages
each contain 3,000 table rows and 400 animated points. The runner checks typing,
long-page scrolling, twelve session switches, both dividers, hidden execution,
retained input/reading position, explicit reload, presentation closure and explicit
browser closure. Presentation closure must retain session-owned pages; explicit
browser closure must remove both native views and registered targets.

Default resource windows last 30 seconds, with 45 seconds hidden. Shorter
`OPENBITFUN_BROWSER_WINDOW_MS` / `OPENBITFUN_BROWSER_HIDDEN_MS` overrides are
pilots, not formal performance evidence. Do not run builds, other benchmarks or
tests concurrently. Process CPU and physical footprint are separate from GPU
busy, VRAM and JS heap. The fixture server runs outside the app and is excluded
from attributed application CPU. Page-owned background work is expected and must
not be removed to improve an idle result. Native-child presentation uses click,
visibility and two-RAF wall timestamps across contexts, not compositor completion.
Standalone browser lifetime, media playback, HTML gateways, remote paths and
other operating systems need their own coverage.

For matched Browser acceptance, set `OPENBITFUN_BROWSER_BASELINE_FRONTEND` and
`OPENBITFUN_E2E_FRONTEND_DIR` to completed builds, then run
`node tests/e2e/scripts/run-browser-workload-pair.mjs`.
`OPENBITFUN_BROWSER_PAIR_EVIDENCE` selects a new directory;
`OPENBITFUN_BROWSER_PAIRS` defaults to three alternating AB / BA / AB pairs.
The runner rejects reused evidence directories, shortened/instrumented workloads,
and unequal protocols, harnesses, binary or environment. It keeps failed speed
budgets and stops on functional failures. Native presentation must pass separately
from the main-document panel; neither establishes compositor completion.

The Browser pair runner also accepts `OPENBITFUN_BROWSER_BASELINE_BINARY` for a
native-only comparison. In that mode, explicitly select the candidate with
`OPENBITFUN_E2E_DESKTOP_BINARY` and use the same frontend for both arms. It rejects
mixed frontend/native changes and changing either arm's builds between pairs.

For native screenshot/preview encoding changes, build both native binaries and run
`node --experimental-strip-types tests/e2e/scripts/run-browser-capture.mjs` once
per binary with the same completed frontend. Set `OPENBITFUN_CAPTURE_EVIDENCE`
to a new directory and `OPENBITFUN_E2E_DESKTOP_BINARY` to each snapshot; on the
second run, set `OPENBITFUN_CAPTURE_REFERENCE` to the first `result.json`.
This captures the homepage animation at fixed phases plus a session-owned real
Browser with static text, gradients and transparency at two widths/scroll offsets.
It requires identical decoded PNG and JPEG preview pixels, dimensions and layout.
Snapshots are fidelity evidence, never included in speed/resource benchmarks.

For composer compact-width changes, run `node tests/e2e/scripts/run-composer-layout.mjs`
against both completed frontends with separate `OPENBITFUN_COMPOSER_EVIDENCE`
directories. It exercises real editor clear/input at two native window widths,
including wrap, explicit newlines, Chinese text and clearing back to compact.
The previous off-screen clone algorithm is an independent geometry oracle for
the live compact track. Compare both runs' layouts and rectangles by case.
These additional reads are functional evidence, not performance samples or
OS IME coverage.

For a separate Browser switch diagnostic, run
`node tests/e2e/scripts/run-browser-profile.mjs` with the same completed snapshots
and `OPENBITFUN_BROWSER_PROFILE_EVIDENCE`. It samples host, main WebContent and
GPU-process stacks while switching the same three real pages, and records slow
main-document layout reads plus API counters. Diagnostic protocol v2 also records
session-click times and custom-protocol IPC fetch request/response-header times,
with command/label only. It does not retain payloads, consume response bodies or
replace Tauri's immutable invoke/ipc functions. Response decoding/callbacks and
postMessage fallback are outside this trace. Stack sampling and wrappers add
overhead: these durations and CPU observations are not acceptance samples.
Diagnostic protocol v3 accepts `OPENBITFUN_BROWSER_PROFILE_LIGHT=1` to omit stack
sampling and layout-read wrappers while retaining the IPC/click timeline. It also
records numeric requested browser bounds. This reduces probe overhead but remains
instrumented evidence; it does not replace formal matched workloads.
Diagnostic protocol v4 additionally accepts `OPENBITFUN_BROWSER_PREVIEW_DELAY_MS`
(0–1000, default 0). This deliberately postpones the real preview fetch without
changing its payload or response. Requested, dispatched and response-header times
remain separate. Use it only to test causality; delaying preview refresh is not
an accepted product optimization and these runs must not enter matched acceptance.

For installed MiniApps with real compiled UI and native Workers, run in isolation:

```bash
node --test tests/e2e/scripts/miniapp-workload-fixture.test.mjs
OPENBITFUN_E2E_FRONTEND_DIR=/absolute/path/to/completed/frontend OPENBITFUN_E2E_DESKTOP_BINARY=/absolute/path/to/completed/binary node --experimental-strip-types tests/e2e/scripts/run-miniapp-workload.mjs
```

`OPENBITFUN_MINIAPP_EVIDENCE` selects a new evidence directory. The workload creates
30 local installed entries through the production API, then launches three from
their gallery cards. Version 2 seeds the fixture's sidebar preference for
`builtin.miniapps` before measurements, refreshes and waits for the new document;
the legacy `MiniAppEntry` component is not present in the current default layout.
Version 3 also releases stale driver handles from removed iframe documents:
`isConnected` alone can remain true inside a closed iframe. The shared performance
snapshot now checks the owning frame chain, preserving handles in mounted hidden
and nested frames. Earlier post-close memory samples may include automation-owned
references and cannot establish product retention; rerun before/after comparisons
with the same corrected harness. Product caches and GC are unchanged.
Built-in catalog entries remain present and are counted separately from fixtures.
Each running app has 3,000 table rows, Canvas animation,
bounded Worker computation/push every 50 ms and SDK RPC every second. It measures
populated catalog readiness separately from its container, and real iframe
content separately from the scene. It checks input, scrolling, computation,
twelve hot switches, navigation resizing, hidden execution, retained drafts and
reading offsets, closing each app, and reopening after actual Worker exit.
Worker RPC PIDs must match responsibility-attributed native processes and their
start times. Iframes share WebContent; do not attribute the entire main process
footprint to each app or call it exclusive app memory.

Default resource windows are 30 seconds, with 45 seconds hidden. Overrides
`OPENBITFUN_MINIAPP_WINDOW_MS` and `OPENBITFUN_MINIAPP_HIDDEN_MS` mark pilots, not
formal acceptance. Keep real hidden computation, push delivery and polling alive;
stopping business work is not an acceptable idle optimization. This fixture
covers local same-origin apps, not marketplace opaque-origin apps, downloads,
independent Shell, presentation transfer, AI calls or real remote behavior. No
provider credentials or package downloads are needed. The runner's existence
does not establish coverage: retain and inspect a completed native result before
recording functional or performance acceptance.
The focused fixture test runs the actual Node Worker host, checks pushed data and
RPC work limits, and requires exit when its input closes. It validates the workload
contract, not the desktop UI, performance, Bun runtime or remote behavior.

For hidden MiniApp rendering attribution, use the same snapshots with
`node tests/e2e/scripts/run-miniapp-profile.mjs` and a new
`OPENBITFUN_MINIAPP_PROFILE_EVIDENCE` directory. It observes iframe viewport/resize
and business counters, temporarily compares normal, display-none, normal recovery
and direct content-visibility hiding, then restores the original styles and checks
draft/scroll continuity. Native host/main/GPU stack samples are a separate final
phase. These experiments are explicitly instrumented pilots, not product changes
or performance acceptance; arbitrary app RAF logic, media and resize-dependent
behavior need additional compatibility evidence before adopting any strategy.

`run-miniapp-handles.mjs` isolates closed-iframe automation retention with one real
app. `OPENBITFUN_MINIAPP_HANDLES_EVIDENCE` selects a fresh directory. It records
which handles remain after ordinary snapshot cleanup, then releases only stale
automation handles in a separate diagnostic phase; this does not force GC or
establish a product memory benefit. The frame regression below checks that live
nested handles survive snapshot cleanup and removed child documents are released.

For native evaluation transport changes, run
`node tests/e2e/scripts/run-webdriver-evaluation.mjs` with completed frontend and
binary overrides and a new `OPENBITFUN_EVALUATION_FUNCTIONAL_EVIDENCE` directory.
It checks structured Unicode arguments, function-body fallback, callbacks,
Promises, function-expression side effects, errors, timeout recovery, frame
arguments and document replacement, followed by the same frame checks below.
Also run `run-browser-session-isolation.mjs` for real background Browser behavior.

`run-webdriver-evaluation-diagnostic.mjs` separately measures the measurement
bridge on the actual static Todos page. `OPENBITFUN_EVALUATION_MODE` selects
`requests` (400 changing arguments), `fixed-requests` (400 identical arguments)
or `in-page` (one call with 400 computations). Set a fresh
`OPENBITFUN_EVALUATION_EVIDENCE`. All results are instrumented controls; native
allocation reads occur outside windows. Different modes cannot be compared as
product gains. To assess a native transport change, keep mode, frontend, harness,
environment and unfocused-visible window conditions identical and alternate
frozen old/new native binaries. A transport improvement does not establish
product-page latency or memory improvement; old/new native results must not be
mixed into frontend-only comparisons.

For the native driver's same-origin frame commands, run
`node tests/e2e/scripts/run-webdriver-frames.mjs` with the same completed frontend
and binary overrides and a new `OPENBITFUN_FRAME_EVIDENCE` directory. The static
nested-frame fixture checks frame-local user scripts, lookup/input/click/wheel,
labels, clearing, parent/top restoration and frame-index selection. This is a
functional driver regression, not MiniApp SDK or performance evidence. A failure
here must not be reported as MiniApp product latency.

`identify-webview-processes.mjs` accepts explicit child labels for two out-of-window
CPU pulses. It validates child existence with the native WebView inventory:
the embedded driver's window list omits child WebViews and can omit main after
it gains children. More than one label can
belong to the same PID, so never sum per-label memory as exclusive allocations.
Run `node --test tests/e2e/scripts/identify-webview-processes.test.mjs` when changing
this attribution path; ambiguity must fail instead of guessing a PID.
