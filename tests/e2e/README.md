[中文](README.zh-CN.md) | **English**

# OpenBitFun E2E Tests

E2E test framework using WebDriverIO + the embedded OpenBitFun WebDriver.

> For complete documentation, see [E2E-TESTING-GUIDE.md](E2E-TESTING-GUIDE.md)

## Quick Start

### 1. Install Dependencies

```bash
# Build the debug app
cargo build -p openbitfun-desktop

# Install test dependencies
pnpm --dir tests/e2e install
```

### 2. Run Tests

```bash
# L0 smoke tests (fastest)
pnpm --dir tests/e2e run test:l0
pnpm --dir tests/e2e run test:l0:all

# L1 functional tests
pnpm --dir tests/e2e run test:l1

# Run all tests
pnpm --dir tests/e2e test
```

## Long-session performance

Build the desktop host and production frontend, then run from the repository root:

```powershell
cargo build -p openbitfun-desktop
pnpm run build:web
pnpm --dir tests/e2e run test:perf:long-session
# A smaller pilot (same scenarios, fewer samples):
pnpm --dir tests/e2e run test:perf:long-session --turns 80 --repeats 2 --scroll-steps 40
pnpm --dir tests/e2e run test:perf:long-session:contract
```

The default workload creates four 200-turn sessions plus a short parking session
in fresh temporary storage. Each historical turn includes Markdown and tool cards.
Two sessions stay static; two run real Agent turns against a private loopback SSE
model (no provider key or external AI). Both states cover first UI entry, eight
alternating session switches, 120 wheel steps in each direction, and eight jumps
between distant turns through the production turn rail. Runtime submission starts
streaming sessions before their first UI attachment. Static measurements run first.
The model produces 480-character paragraphs every 90 ms and finishes explicitly;
the runner verifies completion in persisted history. Tool cards are persisted mocks;
this workload does not execute tools.

Select the denser `multi-tool` template with:

```powershell
pnpm --dir tests/e2e run test:perf:long-session --scenario multi-tool
```

For a repeatable streaming-switch comparison, use
`--suite streaming-switch --scenario multi-tool --repeats 16`. Both runtime streams
start connected without output, receive 96 initial paragraphs together, and both
transcripts are opened before measurement. Each alternating real session click
releases 16 more paragraphs per stream at the configured interval. Outside the
timed window, the test waits for both batches and the active transcript's final
paragraph before the next click. This keeps output volume equal across builds;
it is a separate protocol from the continuously growing full matrix. Both streams
must advance during each switch and finish into persisted history. Compare
matching protocols/native binaries in independent processes without concurrent builds.
After measurement, the suite checks reading-position restoration, draft retention,
reader takeover while more output arrives, search navigation and bounded row DOM.

For controlled scrolling during live output, use
`--suite streaming-scroll --scenario multi-tool --repeats 2`. One real runtime
stream receives 512 initial paragraphs at 2 ms intervals outside measurement.
Each phase releases another 192 paragraphs at `--stream-interval-ms` (90 ms by
default) while delivering 120 real wheel steps. Both directions cover the live
text and the tool-heavy history immediately before the live turn; `--scroll-area
live|history` selects one area. Preparation, waiting for the complete batch and
returning to its final paragraph occur outside timing. Each measured phase must
receive fresh output, remain streaming and deliver every wheel event. Reader
position is checked again after the batch settles. Compare identical protocol
versions and workload options; this suite is separate from the full matrix.

Optional Windows WebView2 diagnostics: set `OPENBITFUN_LONG_SESSION_CDP_PORT` to a
free debugging port to save `switch.cpuprofile` and `switch-trace.json` for this
suite. `OPENBITFUN_LONG_SESSION_SELECTOR_STATS=1` adds expensive CSS selector and
invalidation tracking. Such reports are marked instrumented; use separate runs
with these variables unset for performance acceptance. RAF is not compositor FPS.
The scrolling suite saves a CPU profile and trace for each phase (`scroll-N.*`).
`OPENBITFUN_LONG_SESSION_ROW_DIAGNOSTIC=1` additionally records scalar row
mount/removal counts and per-frame scroll positions, and marks the run instrumented.

For controlled Turn navigation during output, use
`--suite streaming-jump --scenario multi-tool --turns 200 --repeats 20`.
One real runtime stream receives 96 initial paragraphs at 2 ms intervals outside
measurement. Each real rail click releases another 16 paragraphs at the configured
stream interval (90 ms by default). Targets cycle through ordinal 0, 75%, 25%,
the last historical Turn and the live Turn. Each phase starts with the same output
count across builds and waits for its batch outside timing. It checks the actual
user-message landing and its stability after the additional output settles.
`firstVisit` identifies a target not visited yet; the live Turn is already
visited during setup. It does not prove a cold disk or history-cache miss.
First/already-visited targets should be reported separately.
The normal readiness definition is unchanged; optional milestones additionally
record first target DOM, first visible target and first ready viewport observations.
That definition requires visible target-Turn content, not its user-message header.
`jumpLandingChecksPassed` separately records header visibility and position
stability after continued output; report it alongside latency when comparing
older builds, and require it for accepting an optimized build.
Protocol v3 includes this landing check in overall functional acceptance;
`contentReadyChecksPassed` retains the original content-readiness result so an
older build's positioning failure remains explicit beside its timing samples.
CDP diagnostics save `jump-N.cpuprofile` and `jump-N-trace.json`; row diagnostics
also apply to this suite. Instrumented runs are separate from performance acceptance.

Every historical turn in all four long sessions then has **26 model rounds**:
25 rounds containing a 320-character Markdown explanation followed by Read,
Edit, Write and ExecCommand, and one final Markdown summary controlled by
`--assistant-chars` (4,000 characters by default). This is exactly **100 tool
calls per turn**, with 25 of each tool, across the entire history. The default
200-turn workload therefore contains 20,000 calls per long session and 80,000
across the four sessions. `--turns` still controls the number of user turns.

Read carries a POSIX file path and source content; Edit carries old/new source;
Write carries a destination and generated content; ExecCommand carries `cmd`,
`workdir`, output and exit code. The recorded raw result size follows
`--tool-result-chars` (6,000 characters per tool by default), while Edit/Write
source inputs are capped at 1,200 characters. This creates file-diff, file-write
and command-output payloads, rather than renaming Read cards. No tools execute.
The additional live turn remains the same text-only SSE workload, so static
and streaming cases share the same heavy history. The parking session stays
small. Explicit `--tool-items` values other than 100 are rejected for this
template; the fixed count is recorded in fixture metadata and the report.

The printed evidence directory retains `report.html`, `summary.csv`, `result.json`,
raw RAF timestamps, failures/screenshots, app logs, input data, and independent
frontend/native/harness snapshots with hashes. It never prunes old evidence.
Reports include latency P50/P90/P95/P99, RAF interval quantiles, mean RAF FPS,
slow-frame rates and consecutive stalls. Failed samples stay visible and do not
enter valid-sample distributions. Functional success and optional performance
budgets are separate; a run without budgets reports budget acceptance as unknown.
Supported WebViews also report Long Tasks; unsupported observation stays unknown.
Per-sample focus and visibility, and each summary's focus conditions, are retained.

Opening/switching/jump latency starts at the first delivered pointer/mouse event
and ends when the requested session/turn has visible text, its viewport is settled,
the loading shield is gone, and two further RAF opportunities occur. Continuous
scroll latency measures first wheel to first observed scroll movement. Its frame
window ends two RAF opportunities after the final wheel event; idle preparation
does not dilute the distribution. Revealing a virtualized turn-rail button happens
outside timing; the actual navigation uses its production click handler.

First entry does not imply cold disk or OS caches; streaming setup preloads runtime
history. RAF measures presentation opportunities, not compositor completion or OS
trackpad inertia. Do not compare a debug host with release-fast results, different
workload options, focus states, or concurrent builds. A two-sample first-entry
distribution is descriptive, not a stable tail estimate. Repeat isolated runs for
baseline confidence. These tests exercise local desktop only, not SSH workspaces,
relay/mobile control, Peer Device Mode, or Detached Dispatch.

Use `--help` for all workload options. Examples:

```powershell
$env:OPENBITFUN_E2E_DESKTOP_BINARY = 'E:\builds\openbitfun-desktop.exe'
$env:OPENBITFUN_E2E_FRONTEND_DIR = 'E:\builds\frontend'
$env:OPENBITFUN_E2E_NATIVE_PROFILE = 'release-fast'
pnpm --dir tests/e2e run test:perf:long-session --turns 500 --repeats 20 --max-latency-ms 1000 --max-p95-frame-ms 34
```

The host must support the embedded driver and packaged frontend loading.
`release-fast` resource snapshots currently support Windows; other platforms use
the debug host. Windows release snapshots include adjacent runtime resources and
`frontend/dist`; the loaded frontend revision must match the snapshot. The runner
focuses the main window and rejects samples that lose focus or visibility. Set
`OPENBITFUN_E2E_WEBDRIVER_PORT` only to select a known free port; otherwise one is
allocated. `--evidence` must name a new directory. A failed guard, missing sample,
model error, persistence failure, or exceeded configured budget exits nonzero.

## Test Levels

| Level | Purpose | Run Time | AI Required |
|-------|---------|----------|-------------|
| L0 | Smoke tests - verify basic functionality | < 1 min | No |
| L1 | Functional tests - validate features | 5-15 min | No (mocked) |
| L2 | Planned, not implemented yet | N/A | N/A |

## Directory Structure

```
tests/e2e/
├── specs/           # Test specifications
├── page-objects/    # Page Object Model
├── helpers/         # Utility functions
├── fixtures/        # Test data
└── config/          # Configuration
```

## Troubleshooting

### Embedded WebDriver not ready

The test runner starts OpenBitFun directly and waits for the embedded WebDriver service on `127.0.0.1:4445`.

### App not built

```bash
cargo build -p openbitfun-desktop
```

### Test timeout

Debug builds are slower. Adjust timeouts in config if needed.

## More Information

- [Complete Testing Guide](E2E-TESTING-GUIDE.md) - Test writing guidelines, best practices, test plan
- [OpenBitFun Project Structure](../../AGENTS.md)
