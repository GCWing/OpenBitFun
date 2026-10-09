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
