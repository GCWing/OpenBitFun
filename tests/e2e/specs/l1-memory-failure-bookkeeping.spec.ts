/**
 * L1 memory failure-bookkeeping spec.
 *
 * Drives the real desktop app through the failed-extraction surfaces of
 * Settings > AI > Session & Memory > Memory and proves they are wired to the
 * host memory database:
 *
 *   1. The failed-sessions list renders one compact entry per persisted
 *      `memory_stage1` error row: a localized failure date, a short error
 *      summary, the full message on `title`, and the danger pill for a row whose
 *      retry budget is exhausted. The phase-2 error row renders short too, and
 *      the stored phase-1 output count is reported.
 *   2. "Clear failed records" opens a real confirm dialog; confirming deletes the
 *      failure bookkeeping only (the status list empties, the stored outputs and
 *      the global phase-2 job survive) and hides the action.
 *   3. Re-seeded failures plus an on-demand run prove the expiry sweep: a row
 *      failed 20 days ago is expired by
 *      `prune_failed_stage1_jobs(max_failure_report_days)` (default 14), while a
 *      row failed 1 day ago survives, and the stored outputs are untouched.
 *   4. Soft coverage: the `Memory phase2 consolidation timeout computed`
 *      diagnostic, if a consolidation actually ran during this pass.
 *
 * The fixtures are written straight into the sandbox database by
 * `scripts/seed-memory-failure-fixtures.mjs`, so no provider outage is required.
 * The sandbox is resolved through `helpers/sandbox-utils` and the fixture script
 * refuses any path outside `tests/e2e`, so the developer's real profile is never
 * touched.
 *
 * Precondition: the profile must be seeded with a working AI provider
 * (`pnpm --dir tests/e2e run test:l1:memory-failure` runs
 * `seed:memory-e2e` first). Because this spec sits in the default `wdio.conf.ts`
 * glob, the `before` hook skips the suite loudly on an unseeded sandbox instead
 * of failing it for infrastructure reasons; a seeded sandbox that breaks still
 * fails.
 *
 * Settings navigation note: upstream consolidated the settings pages, so the
 * former `ai.memory` page is now the `memory` section of `ai.session-memory`
 * (`SessionMemorySettingsPage` -> `MemorySettingsSection`). The spec drives the
 * new page id; `settingsDestinationMigrations.json` maps the old id for legacy
 * deep links only.
 */

import { browser, expect } from '@wdio/globals';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { MemoriesSettings } from '../page-objects/components/MemoriesSettings';
import { NavPanel } from '../page-objects/components/NavPanel';
import { SettingsPage } from '../page-objects/SettingsPage';

import { domClick, domClickable, probeSelector } from '../helpers/dom-utils';
import { saveFailureScreenshot, saveStepScreenshot } from '../helpers/screenshot-utils';
import { invokeTauriCommand } from '../helpers/tauri-utils';
import {
  findNewestAppStdoutLogFile,
  getE2eRuntimeRoot,
  getMemoriesDatabaseFile,
  getSandboxConfigFile,
  grepLines,
  readTextFile,
} from '../helpers/sandbox-utils';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const E2E_DIR = path.resolve(PROJECT_ROOT, 'tests', 'e2e');
const FIXTURE_SCRIPT = path.join(E2E_DIR, 'scripts', 'seed-memory-failure-fixtures.mjs');

/** Settings page id + section that owns the memory surface after the page consolidation. */
const MEMORY_SETTINGS_PAGE = 'ai.session-memory';
/** Unrelated settings page used to remount the memory page and re-read host state. */
const REMOUNT_SETTINGS_PAGE = 'application.general';

/** Fixture session ids (also the phase-1 `jobs.job_key`), mirrored from the seed script. */
const STALE_SESSION_ID = 'a1111111-1111-4111-8111-111111111111';
const RECENT_SESSION_ID = 'b2222222-2222-4222-8222-222222222222';

/** Default `memories.max_failure_report_days`; the stale fixture is 20 days old. */
const DEFAULT_MAX_FAILURE_REPORT_DAYS = 14;

/** Fixture error strings, mirrored verbatim from `seed-memory-failure-fixtures.mjs`. */
const STALE_LAST_ERROR =
  'Service error: Memory phase1 model call failed: OpenAI Streaming API client error '
  + '403 Forbidden: {"error":{"message":"Access to model denied. Please make sure you are '
  + 'eligible for using the model.","id":"33890c86-aa3d-485c-96e6-f985832b7706",'
  + '"type":"AccessDenied.Unpurchased","code":"AccessDenied.Unpurchased"}}';
const RECENT_LAST_ERROR =
  "Timeout: Subagent 'MemoryPhase2' timed out after 1200 seconds";

/** Documented visible-error character budget (`MEMORY_ERROR_SUMMARY_MAX_CHARS`). */
const MEMORY_ERROR_SUMMARY_MAX_CHARS = 120;

const DIALOG_SURFACE =
  '[data-openbitfun-component="dialog"][data-openbitfun-part="surface"][role="alertdialog"]';
const CLEAR_FAILED_BTN = '[data-testid="memories-clear-failed-btn"]';
const FAILED_LIST = '[data-testid="memories-status-stage1-failed"]';
const FAILURE_ENTRY = '[data-testid="memories-status-stage1-failed-entry"]';

const ON_DEMAND_EXPIRY_LOG = 'Memory pipeline on-demand run expired stale stage1 failure records';
const PHASE2_TIMEOUT_LOG = 'Memory phase2 consolidation timeout computed';

const STATUS_POLL_TIMEOUT_MS = 60 * 1000;
const LOG_POLL_TIMEOUT_MS = 30 * 1000;

interface MemoryStage1FailureInfo {
  sessionId?: string;
  lastError?: string;
  retryExhausted?: boolean;
  failedAtUnixSecs?: number | null;
}

interface MemoryStatusPayload {
  generateMemories?: boolean;
  useMemories?: boolean;
  memoryRootDir?: string;
  stage1OutputCount?: number;
  stage1PendingPromotionCount?: number;
  stage1Failed?: MemoryStage1FailureInfo[];
  phase2Status?: string | null;
  phase2LastFinishedAtUnixSecs?: number | null;
  phase2LastError?: string | null;
  files?: { rolloutSummaryCount?: number | null };
}

interface FailureEntryProbe {
  sessionId: string | null;
  sessionText: string;
  failedAtText: string | null;
  errorText: string;
  errorTitle: string | null;
  dangerPillText: string | null;
  entryText: string;
}

interface FailureViewProbe {
  documentLang: string | null;
  failedListCount: number;
  entries: FailureEntryProbe[];
  memorySectionText: string;
  clearButtonCount: number;
  clearButtonUsable: boolean;
  pipelineErrorText: string | null;
  pipelineErrorTitle: string | null;
  storedOutputsText: string | null;
  phase2StatusText: string | null;
  workspaceEntryCount: number;
}

interface DialogProbe {
  count: number;
  text: string;
  buttonTexts: string[];
}

/** Last host status payload, embedded in every assertion message for triage. */
let lastStatusPayload: MemoryStatusPayload | null = null;

async function getMemoryStatus(): Promise<MemoryStatusPayload> {
  const status = await invokeTauriCommand<MemoryStatusPayload>('get_memory_status');
  lastStatusPayload = status;
  return status;
}

/** Read the host status without throwing, so a broken read is reported as evidence. */
async function tryGetMemoryStatus(): Promise<{ status: MemoryStatusPayload | null; error: string }> {
  try {
    return { status: await getMemoryStatus(), error: '' };
  } catch (error) {
    return { status: null, error: String(error).slice(0, 600) };
  }
}

/**
 * Hard assertion whose message carries the last status payload.
 *
 * The memory surfaces render host state, so a failing assertion is only
 * actionable together with the payload the card was built from.
 */
function assertStatus(condition: boolean, label: string): void {
  if (condition) {
    return;
  }
  throw new Error(
    `[L1-MemoryFailure] ${label}\n`
    + `  status payload: ${JSON.stringify(lastStatusPayload)}`,
  );
}

function describeStatus(status: MemoryStatusPayload | null): string {
  if (!status) {
    return '(no status payload)';
  }
  return JSON.stringify({
    generateMemories: status.generateMemories,
    stage1OutputCount: status.stage1OutputCount,
    stage1Failed: (status.stage1Failed ?? []).map(failure => ({
      sessionId: failure.sessionId,
      retryExhausted: failure.retryExhausted,
      failedAtUnixSecs: failure.failedAtUnixSecs,
      lastErrorPrefix: (failure.lastError ?? '').slice(0, 80),
    })),
    phase2Status: status.phase2Status,
    phase2LastErrorPrefix: (status.phase2LastError ?? '').slice(0, 80),
  });
}

/** One synchronous DOM probe of the whole memory status card. */
async function readFailureView(): Promise<FailureViewProbe> {
  const probe = await browser.execute(
    () => {
      const textOf = (element: Element | null | undefined): string => (
        element ? (element as HTMLElement).innerText ?? element.textContent ?? '' : ''
      );
      const entries = Array.from(
        document.querySelectorAll('[data-testid="memories-status-stage1-failed-entry"]'),
      ).map((entry) => {
        const head = entry.querySelector('.openbitfun-memory-settings__failure-head');
        const sessionSpan = head?.querySelector('span[title]') ?? entry.querySelector('span[title]');
        const failedAt = entry.querySelector('[data-testid="memories-status-stage1-failed-at"]');
        const error = entry.querySelector('[data-testid="memories-status-stage1-failed-error"]');
        const pill = entry.querySelector(
          '[data-openbitfun-component="status-pill"][data-tone="danger"]',
        );
        return {
          sessionId: sessionSpan?.getAttribute('title') ?? null,
          sessionText: textOf(sessionSpan),
          failedAtText: failedAt ? textOf(failedAt) : null,
          errorText: textOf(error),
          errorTitle: error?.getAttribute('title') ?? null,
          dangerPillText: pill ? textOf(pill) : null,
          entryText: textOf(entry),
        };
      });

      const clearButton = document.querySelector(
        '[data-testid="memories-clear-failed-btn"]',
      ) as HTMLElement | null;
      const section = document.getElementById('settings-section-memory')
        ?? document.querySelector('.openbitfun-memories-config');
      const pipelineError = document.querySelector(
        '[data-testid="memories-status-phase2-last-error"]',
      );
      // The full message sits on the inner text node; the test-id container is a
      // layout wrapper without a `title` of its own.
      const pipelineErrorFull = pipelineError?.querySelector('[title]') ?? pipelineError;
      const storedOutputs = document.querySelector('[data-testid="memories-status-stored-outputs"]');
      const phase2 = document.querySelector('[data-testid="memories-status-phase2"]');

      return {
        documentLang: document.documentElement.getAttribute('lang'),
        failedListCount: document.querySelectorAll(
          '[data-testid="memories-status-stage1-failed"]',
        ).length,
        entries,
        memorySectionText: textOf(section),
        clearButtonCount: document.querySelectorAll(
          '[data-testid="memories-clear-failed-btn"]',
        ).length,
        clearButtonUsable: Boolean(clearButton)
          && !clearButton?.hasAttribute('disabled')
          && getComputedStyle(clearButton as Element).display !== 'none',
        pipelineErrorText: pipelineError ? textOf(pipelineError) : null,
        pipelineErrorTitle: pipelineErrorFull?.getAttribute('title') ?? null,
        storedOutputsText: storedOutputs ? textOf(storedOutputs) : null,
        phase2StatusText: phase2 ? textOf(phase2) : null,
        workspaceEntryCount: document.querySelectorAll('[data-testid="nav-workspace-item"]').length,
      };
    },
  );

  return probe as FailureViewProbe;
}

async function readDialogProbe(): Promise<DialogProbe> {
  const probe = await browser.execute((selector: string) => {
    const surface = document.querySelector(selector);
    if (!surface) {
      return { count: 0, text: '', buttonTexts: [] as string[] };
    }
    const textOf = (element: Element): string => (
      (element as HTMLElement).innerText ?? element.textContent ?? ''
    );
    return {
      count: document.querySelectorAll(selector).length,
      text: textOf(surface),
      buttonTexts: Array.from(surface.querySelectorAll('button')).map(button => textOf(button)),
    };
  }, DIALOG_SURFACE);

  return (probe ?? { count: 0, text: '', buttonTexts: [] }) as DialogProbe;
}

/** Click the confirm action of the open confirm dialog (the last footer button). */
async function clickDialogConfirm(): Promise<boolean> {
  const clicked = await browser.execute((selector: string) => {
    const surface = document.querySelector(selector);
    if (!surface) {
      return false;
    }
    const buttons = Array.from(surface.querySelectorAll('button')) as HTMLElement[];
    const confirm = buttons[buttons.length - 1];
    if (!confirm) {
      return false;
    }
    confirm.click();
    return true;
  }, DIALOG_SURFACE);

  return clicked === true;
}

/** Read `app.language` from the sandbox config; the seeded copy mirrors the developer's. */
function readSandboxLanguage(): string {
  const raw = readTextFile(getSandboxConfigFile());
  if (!raw) {
    return 'en-US';
  }
  try {
    const parsed = JSON.parse(raw) as { app?: { language?: string } };
    const language = parsed.app?.language;
    return typeof language === 'string' && language.trim() ? language.trim() : 'en-US';
  } catch {
    return 'en-US';
  }
}

type LocaleLookup = (key: string) => string;

/**
 * Read the memory locale catalogue from the repository.
 *
 * The card's copy is localized, so the spec asserts against the same catalogue
 * the app renders instead of hard-coding one translation.
 */
function loadMemoryLocale(language: string): { language: string; lookup: LocaleLookup } {
  const candidates = [language, 'en-US'];
  for (const candidate of candidates) {
    const file = path.join(PROJECT_ROOT, 'src', 'web-ui', 'src', 'locales', candidate, 'settings', 'memory.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      const lookup = (key: string): string => {
        let node: unknown = parsed;
        for (const segment of key.split('.')) {
          if (typeof node !== 'object' || node === null) {
            return '';
          }
          node = (node as Record<string, unknown>)[segment];
        }
        return typeof node === 'string' ? node : '';
      };
      return { language: candidate, lookup };
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(
    `[L1-MemoryFailure] could not read the settings/memory locale catalogue for ${language} `
    + `or en-US under ${PROJECT_ROOT}`,
  );
}

/** `Failed {{time}}` -> `Failed`; the visible label a user reads in front of the date. */
function failedAtPrefix(lookup: LocaleLookup): string {
  return lookup('status.failed.failedAt').replace(/\{\{\s*time\s*\}\}/, '').trim();
}

/** The short date the app renders for that locale (`formatDate(..., dateStyle: 'short')`). */
function expectedShortDate(unixSecs: number, language: string): string {
  return new Intl.DateTimeFormat(language, { dateStyle: 'short' }).format(new Date(unixSecs * 1000));
}

/**
 * Assert a rendered label carries the localized failure date.
 *
 * The app formats through `Intl.DateTimeFormat(locale, { dateStyle: 'short' })`,
 * so the expected string is computed the same way in this process. If a CLDR
 * version skew between Node and the WebView changes only the separators, the
 * numeric component order is compared instead, and the fallback is logged.
 */
function assertLocalizedFailureDate(
  renderedText: string | null,
  unixSecs: number,
  language: string,
  label: string,
): void {
  assertStatus(typeof renderedText === 'string' && renderedText.length > 0, `${label}: no date rendered`);
  const rendered = renderedText ?? '';
  const expected = expectedShortDate(unixSecs, language);
  if (rendered.includes(expected)) {
    console.log(`[L1-MemoryFailure] ${label}: rendered as ${JSON.stringify(rendered)} (exact match)`);
    return;
  }

  const digits = (value: string): string[] => value.match(/\d+/g) ?? [];
  const renderedDigits = digits(rendered);
  const expectedDigits = digits(expected);
  const sameOrder = renderedDigits.length === expectedDigits.length
    && renderedDigits.every((part, index) => Number(part) === Number(expectedDigits[index]));
  if (sameOrder) {
    console.log(
      `[L1-MemoryFailure] ${label}: rendered as ${JSON.stringify(rendered)}; `
      + `separators differ from this process's ICU rendering of ${JSON.stringify(expected)} `
      + '(numeric date components match)',
    );
    return;
  }

  throw new Error(
    `[L1-MemoryFailure] ${label}: expected the localized short date ${JSON.stringify(expected)} `
    + `for locale ${language}, observed ${JSON.stringify(rendered)}.\n`
    + `  status payload: ${JSON.stringify(lastStatusPayload)}`,
  );
}

function findEntry(view: FailureViewProbe, sessionId: string): FailureEntryProbe | undefined {
  return view.entries.find(entry => entry.sessionId === sessionId);
}

/** Run the fixture seed script against the isolated sandbox and report its output. */
function runFixtureSeed(): void {
  const result = spawnSync(process.execPath, [FIXTURE_SCRIPT], {
    cwd: E2E_DIR,
    env: process.env,
    encoding: 'utf8',
    timeout: 120000,
    // A headless/redirected host must not flash a console window.
    windowsHide: true,
  });

  console.log('[L1-MemoryFailure] fixture seed stdout:');
  for (const line of (result.stdout ?? '').trim().split(/\r?\n/)) {
    if (line.trim()) {
      console.log(`[L1-MemoryFailure]   ${line}`);
    }
  }
  if (result.stderr && result.stderr.trim()) {
    console.log('[L1-MemoryFailure] fixture seed stderr:', result.stderr.trim().slice(0, 1200));
  }

  if (result.error) {
    throw new Error(`[L1-MemoryFailure] fixture seed could not start: ${String(result.error)}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `[L1-MemoryFailure] fixture seed exited with code ${result.status}; see the captured output above`,
    );
  }
}

/** Count occurrences of `needle` in the newest app stdout mirror. */
function countLogLines(needle: string): { file: string | null; lines: string[] } {
  const file = findNewestAppStdoutLogFile();
  return { file, lines: file ? grepLines(file, needle) : [] };
}

/** Wait until the newest stdout mirror contains more than `baseline` matching lines. */
async function waitForLogLines(
  needle: string,
  baseline: number,
  timeoutMs: number,
): Promise<{ file: string | null; lines: string[] }> {
  try {
    await browser.waitUntil(
      () => countLogLines(needle).lines.length > baseline,
      {
        timeout: timeoutMs,
        interval: 1000,
        timeoutMsg: `stdout mirror never recorded "${needle}"`,
      },
    );
  } catch {
    // Reported by the caller: the log line is diagnostic, the DB/UI state is the
    // decisive evidence.
  }
  return countLogLines(needle);
}

/**
 * Detect the profile seeded by `scripts/seed-memory-e2e-profile.mjs`.
 *
 * A bare sandbox has no chat provider, so the suite would go red for something it
 * cannot fix. The marker is a non-empty `ai` section with at least one model,
 * which the seed script guarantees (it exits when it cannot provide one).
 */
function readSeedState(): { seeded: boolean; detail: string } {
  const configFile = getSandboxConfigFile();
  const raw = readTextFile(configFile);
  if (!raw) {
    return { seeded: false, detail: `no config file at ${configFile}` };
  }
  try {
    const parsed = JSON.parse(raw) as {
      ai?: { models?: unknown[]; default_models?: { primary?: unknown } };
    };
    const ai = parsed.ai;
    const modelCount = Array.isArray(ai?.models) ? ai.models.length : 0;
    const primary = typeof ai?.default_models?.primary === 'string' ? ai.default_models.primary : '';
    return {
      seeded: Boolean(ai) && modelCount > 0,
      detail: `ai section=${ai ? 'present' : 'absent'}, models=${modelCount}, primary=${primary || '(none)'}`,
    };
  } catch (error) {
    return { seeded: false, detail: `sandbox config is not valid JSON: ${String(error).slice(0, 200)}` };
  }
}

/**
 * Activate the scratch workspace through the frontend workspace manager.
 *
 * Calling host commands directly updates host state only; the frontend store
 * keeps the previous workspace and the nav panel keeps its welcome state, so the
 * settings footer entry never appears. The app's own workspace manager updates
 * both, which is what the UI itself uses.
 */
async function activateWorkspace(workspacePath: string): Promise<boolean> {
  try {
    const opened = await browser.execute(async (targetPath: string) => {
      // A non-literal specifier keeps this runtime-only app path out of the
      // spec's TypeScript module graph (the same pattern the other specs use).
      const managerModulePath = '/src/infrastructure/services/business/workspaceManager.ts';
      const mod = await import(managerModulePath) as {
        workspaceManager?: {
          openWorkspace: (path: string) => Promise<{ id?: string; rootPath?: string }>;
          setActiveWorkspace: (workspaceId: string) => Promise<unknown>;
          getState?: () => { currentWorkspace?: { rootPath?: string } | null };
        };
      };
      const manager = mod.workspaceManager;
      if (!manager) {
        return { ok: false, reason: 'workspaceManager module is unavailable' };
      }
      const workspace = await manager.openWorkspace(targetPath);
      if (workspace?.id) {
        await manager.setActiveWorkspace(workspace.id);
      }
      const state = manager.getState?.();
      return { ok: true, id: workspace?.id ?? null, current: state?.currentWorkspace?.rootPath ?? null };
    }, workspacePath);

    const normalize = (value: string): string => value.replace(/\\/g, '/').toLowerCase();
    if (!opened?.ok) {
      console.log('[L1-MemoryFailure] workspace activation failed:', JSON.stringify(opened));
      return false;
    }
    console.log('[L1-MemoryFailure] workspace manager current:', opened.current);
    return normalize(opened.current ?? '') === normalize(workspacePath);
  } catch (error) {
    console.log('[L1-MemoryFailure] workspace activation threw:', String(error).slice(0, 400));
    return false;
  }
}

describe('L1 Memory failure bookkeeping', () => {
  let memories: MemoriesSettings;
  let navPanel: NavPanel;
  let settingsPage: SettingsPage;

  let hasWorkspace = false;
  let locale: { language: string; lookup: LocaleLookup } = { language: 'en-US', lookup: () => '' };
  let phase2TimeoutLogBaseline = 0;

  before(async function () {
    console.log('[L1-MemoryFailure] Starting memory failure-bookkeeping tests');

    const seedState = readSeedState();
    console.log('[L1-MemoryFailure] Seed marker       :', JSON.stringify(seedState));
    if (!seedState.seeded) {
      const message =
        `L1-MemoryFailure SKIPPED: the isolated sandbox profile is not seeded (${seedState.detail}). `
        + 'This spec needs a working AI provider in the sandbox config, so run '
        + '`pnpm --dir tests/e2e run seed:memory-e2e` (or `pnpm --dir tests/e2e run test:l1:memory-failure`, '
        + 'which seeds first) and re-run. This skip only covers an unseeded sandbox; '
        + 'a seeded sandbox that breaks still fails.';
      console.log(`[L1-MemoryFailure] ${message}`);
      this.skip();
      return;
    }

    memories = new MemoriesSettings();
    navPanel = new NavPanel();
    settingsPage = new SettingsPage();

    console.log('[L1-MemoryFailure] Sandbox user root :', process.env.OPENBITFUN_E2E_USER_ROOT);
    console.log('[L1-MemoryFailure] Sandbox home root :', process.env.OPENBITFUN_E2E_HOME);
    console.log('[L1-MemoryFailure] Sandbox config    :', getSandboxConfigFile());
    console.log('[L1-MemoryFailure] Memories database :', getMemoriesDatabaseFile());

    // The app is already running; the memory database is read per command, so
    // writing the fixtures now is what the next status read observes.
    runFixtureSeed();

    const status = await getMemoryStatus();
    console.log('[L1-MemoryFailure] seeded status    :', describeStatus(status));
    assertStatus(
      (status.stage1Failed ?? []).length === 2,
      'the seeded sandbox did not report the two fixture failures through get_memory_status',
    );
    assertStatus(
      status.stage1OutputCount === 1,
      'the seeded sandbox did not report exactly one stored stage1 output',
    );

    const scratchWorkspace = path.join(getE2eRuntimeRoot(), 'scratch-workspace-memory-failure-e2e');
    fs.mkdirSync(scratchWorkspace, { recursive: true });
    console.log('[L1-MemoryFailure] Scratch workspace :', scratchWorkspace);

    hasWorkspace = await activateWorkspace(scratchWorkspace);
    if (!hasWorkspace) {
      console.log('[L1-MemoryFailure] No workspace available - failing instead of reporting a green no-op');
      expect(hasWorkspace).toBe(true);
      return;
    }

    await navPanel.waitForWorkspaceEntry(60000);

    await browser.waitUntil(
      async () => (await probeSelector('[data-testid="nav-footer-settings-item"]')).count > 0,
      {
        timeout: 60000,
        interval: 500,
        timeoutMsg: 'nav panel never rendered the settings footer entry',
      },
    );

    locale = loadMemoryLocale(readSandboxLanguage());
    console.log('[L1-MemoryFailure] Locale catalogue :', locale.language);

    const baseline = countLogLines(PHASE2_TIMEOUT_LOG);
    phase2TimeoutLogBaseline = baseline.lines.length;
    console.log(
      `[L1-MemoryFailure] phase2 timeout log baseline: ${phase2TimeoutLogBaseline} in ${baseline.file ?? '(no mirror yet)'}`,
    );

    await saveStepScreenshot('l1-memory-failure-workspace-ready');
  });

  it('1) renders the failed sessions as compact localized entries', async function () {
    if (!hasWorkspace) {
      this.skip();
      return;
    }

    await settingsPage.open();
    await settingsPage.openTab(MEMORY_SETTINGS_PAGE);
    await memories.waitForLoad();
    await saveStepScreenshot('l1-memory-failure-list');

    const status = await getMemoryStatus();
    console.log('[L1-MemoryFailure] status payload:', describeStatus(status));
    assertStatus(status.generateMemories === false, 'the seeded profile must start with memory off');

    const view = await readFailureView();
    console.log('[L1-MemoryFailure] failure card view:', JSON.stringify(view.entries));
    console.log('[L1-MemoryFailure] section text    :', JSON.stringify(view.memorySectionText.slice(0, 700)));

    // 1a. Exactly two entries: one per fixture failure row.
    assertStatus(view.failedListCount === 1, 'the failed-sessions list container did not render');
    assertStatus(
      view.entries.length === 2,
      `expected exactly 2 failed-session entries, observed ${view.entries.length}`,
    );
    assertStatus(
      (status.stage1Failed ?? []).length === 2,
      'the host reported a different number of failures than the list rendered',
    );

    // Entries are ordered by failure time (newest first).
    assertStatus(
      view.entries[0]?.sessionId === RECENT_SESSION_ID && view.entries[1]?.sessionId === STALE_SESSION_ID,
      `entries are not ordered newest-first: ${JSON.stringify(view.entries.map(entry => entry.sessionId))}`,
    );

    const nowSecs = Math.floor(Date.now() / 1000);
    const staleEntry = findEntry(view, STALE_SESSION_ID);
    const recentEntry = findEntry(view, RECENT_SESSION_ID);
    assertStatus(Boolean(staleEntry), 'the stale (20 days old) fixture entry is missing');
    assertStatus(Boolean(recentEntry), 'the recent (1 day old) fixture entry is missing');

    const failedAtLabel = failedAtPrefix(locale.lookup);
    const retryExhaustedLabel = locale.lookup('status.failed.retryExhausted');
    console.log('[L1-MemoryFailure] localized labels:', JSON.stringify({ failedAtLabel, retryExhaustedLabel }));

    // 1b. Entry A: danger pill, localized date, short error, full text on title.
    const staleFailure = (status.stage1Failed ?? []).find(failure => failure.sessionId === STALE_SESSION_ID);
    assertStatus(staleFailure?.retryExhausted === true, 'the stale fixture row must report an exhausted retry budget');
    assertStatus(
      Boolean(staleEntry?.dangerPillText),
      `the retry-exhausted entry rendered no danger pill (observed ${JSON.stringify(staleEntry?.dangerPillText)})`,
    );
    assertStatus(
      retryExhaustedLabel !== '' && (staleEntry?.dangerPillText ?? '').includes(retryExhaustedLabel),
      `the danger pill text ${JSON.stringify(staleEntry?.dangerPillText)} is not the localized `
      + `${JSON.stringify(retryExhaustedLabel)}`,
    );
    assertStatus(
      failedAtLabel !== '' && (staleEntry?.failedAtText ?? '').includes(failedAtLabel),
      `the stale entry date ${JSON.stringify(staleEntry?.failedAtText)} does not carry the localized `
      + `label ${JSON.stringify(failedAtLabel)}`,
    );
    assertLocalizedFailureDate(
      staleEntry?.failedAtText ?? null,
      staleFailure?.failedAtUnixSecs ?? nowSecs - 20 * 24 * 60 * 60,
      locale.language,
      'stale entry failure date',
    );
    assertStatus(
      staleEntry?.errorTitle === STALE_LAST_ERROR,
      `the stale entry title is not the full stored error: ${JSON.stringify(staleEntry?.errorTitle)}`,
    );
    const staleVisibleError = staleEntry?.errorText ?? '';
    assertStatus(staleVisibleError.length > 0, 'the stale entry rendered no error text');
    assertStatus(
      staleVisibleError.length <= MEMORY_ERROR_SUMMARY_MAX_CHARS,
      `the stale entry error summary is ${staleVisibleError.length} characters, above the `
      + `${MEMORY_ERROR_SUMMARY_MAX_CHARS} budget`,
    );
    assertStatus(
      staleVisibleError.length < STALE_LAST_ERROR.length,
      'the rendered error summary is not shorter than the stored provider payload',
    );
    for (const forbidden of ['AccessDenied', '{"error', 'Unpurchased']) {
      assertStatus(
        !staleVisibleError.includes(forbidden),
        `the visible stale error summary leaked the raw provider payload (${forbidden}): `
        + JSON.stringify(staleVisibleError),
      );
    }
    assertStatus(
      staleVisibleError.includes('403 Forbidden'),
      `the visible stale error summary dropped the human sentence: ${JSON.stringify(staleVisibleError)}`,
    );
    assertStatus(
      !(staleEntry?.entryText ?? '').includes('AccessDenied'),
      `the raw provider payload is visible somewhere in the stale entry: ${JSON.stringify(staleEntry?.entryText)}`,
    );

    // 1c. Entry B: no danger pill, and a short error that is already the whole message.
    const recentFailure = (status.stage1Failed ?? []).find(failure => failure.sessionId === RECENT_SESSION_ID);
    assertStatus(
      recentFailure?.retryExhausted === false,
      'the recent fixture row must still have retry budget left',
    );
    assertStatus(
      !recentEntry?.dangerPillText,
      `the entry with retry budget left rendered a danger pill: ${JSON.stringify(recentEntry?.dangerPillText)}`,
    );
    assertStatus(
      failedAtLabel !== '' && (recentEntry?.failedAtText ?? '').includes(failedAtLabel),
      `the recent entry date ${JSON.stringify(recentEntry?.failedAtText)} does not carry the localized label`,
    );
    assertLocalizedFailureDate(
      recentEntry?.failedAtText ?? null,
      recentFailure?.failedAtUnixSecs ?? nowSecs - 24 * 60 * 60,
      locale.language,
      'recent entry failure date',
    );
    assertStatus(
      recentEntry?.errorText === RECENT_LAST_ERROR,
      `the recent entry error text is ${JSON.stringify(recentEntry?.errorText)}, expected the stored timeout message`,
    );
    assertStatus(
      recentEntry?.errorTitle === RECENT_LAST_ERROR,
      `the recent entry title is ${JSON.stringify(recentEntry?.errorTitle)}, expected the stored timeout message`,
    );
    assertStatus(
      (staleEntry?.failedAtText ?? '') !== (recentEntry?.failedAtText ?? ''),
      'both entries rendered the same failure date, so the date is not read from the row timestamp',
    );

    // 1d. The phase-2 error row is short as well, and keeps the full message on `title`.
    assertStatus(
      view.pipelineErrorText !== null,
      'the phase-2 last-error row did not render although the global job carries a last_error',
    );
    assertStatus(
      view.pipelineErrorTitle === RECENT_LAST_ERROR,
      `the phase-2 error title is ${JSON.stringify(view.pipelineErrorTitle)}, expected the stored timeout message`,
    );
    assertStatus(
      (view.pipelineErrorText ?? '').length <= MEMORY_ERROR_SUMMARY_MAX_CHARS,
      `the phase-2 error row exceeds the ${MEMORY_ERROR_SUMMARY_MAX_CHARS} character summary budget: `
      + JSON.stringify(view.pipelineErrorText),
    );
    assertStatus(
      !view.memorySectionText.includes('AccessDenied'),
      'the memory card renders the raw provider payload somewhere in its visible text',
    );

    // 1e. The stored phase-1 output count survives the failure rows.
    assertStatus(
      status.stage1OutputCount === 1,
      `expected exactly one stored stage1 output, observed ${status.stage1OutputCount}`,
    );
    assertStatus(
      (view.storedOutputsText ?? '').includes('1'),
      `the status card did not render the stored output count: ${JSON.stringify(view.storedOutputsText)}`,
    );
    assertStatus(
      status.phase2Status === 'done',
      `expected the seeded phase-2 job to report done, observed ${JSON.stringify(status.phase2Status)}`,
    );

    // 1f. The clear action is offered while failures are listed.
    assertStatus(view.clearButtonCount === 1, 'the clear-failed-records action did not render');
    assertStatus(view.clearButtonUsable, 'the clear-failed-records action rendered disabled');
    await saveStepScreenshot('l1-memory-failure-list-verified');
  });

  it('2) clearing the records deletes the failure bookkeeping only', async function () {
    if (!hasWorkspace) {
      this.skip();
      return;
    }

    const before = await getMemoryStatus();
    const outputsBefore = before.stage1OutputCount ?? 0;
    const failuresBefore = (before.stage1Failed ?? []).length;
    console.log('[L1-MemoryFailure] status before clear:', describeStatus(before));
    assertStatus(failuresBefore === 2, `expected 2 failures before clearing, observed ${failuresBefore}`);
    assertStatus(outputsBefore === 1, `expected 1 stored output before clearing, observed ${outputsBefore}`);

    // The inline action opens the real confirm dialog first.
    assertStatus(await domClickable(CLEAR_FAILED_BTN), 'the clear action is not clickable');
    await domClick(CLEAR_FAILED_BTN);
    await browser.waitUntil(
      async () => (await readDialogProbe()).count > 0,
      {
        timeout: 15000,
        interval: 200,
        timeoutMsg: 'clicking "clear failed records" never opened a confirm dialog',
      },
    );
    await saveStepScreenshot('l1-memory-failure-clear-confirm-dialog');

    const dialog = await readDialogProbe();
    console.log('[L1-MemoryFailure] confirm dialog:', JSON.stringify(dialog));
    const confirmTitle = locale.lookup('status.failed.clearConfirmTitle');
    const confirmMessage = locale.lookup('status.failed.clearConfirm');
    const confirmAction = locale.lookup('status.failed.clearConfirmAction');
    assertStatus(
      confirmTitle !== '' && dialog.text.includes(confirmTitle),
      `the confirm dialog does not show the localized title ${JSON.stringify(confirmTitle)}: ${JSON.stringify(dialog.text)}`,
    );
    assertStatus(
      confirmMessage !== '' && dialog.text.includes(confirmMessage),
      'the confirm dialog does not show the localized failure-record message',
    );
    assertStatus(
      dialog.buttonTexts.some(text => text.trim() === confirmAction),
      `the confirm dialog has no ${JSON.stringify(confirmAction)} action: ${JSON.stringify(dialog.buttonTexts)}`,
    );

    assertStatus(await clickDialogConfirm(), 'the confirm dialog had no confirm button to click');

    // The status is re-polled after the action; wait for the host list to empty.
    await browser.waitUntil(
      async () => {
        const { status, error } = await tryGetMemoryStatus();
        if (error) {
          return false;
        }
        return (status?.stage1Failed ?? []).length === 0;
      },
      {
        timeout: STATUS_POLL_TIMEOUT_MS,
        interval: 1000,
        timeoutMsg: 'the failed-sessions list never emptied after confirming the clear action',
      },
    );

    const after = await getMemoryStatus();
    console.log('[L1-MemoryFailure] status after clear:', describeStatus(after));
    assertStatus(
      (after.stage1Failed ?? []).length === 0,
      `the host still reports ${(after.stage1Failed ?? []).length} failures after clearing`,
    );
    assertStatus(
      after.phase2Status === 'done',
      'the global phase-2 job must survive the clear action as current-run diagnostics',
    );

    // The stored outputs are kept: clearing stops the list from repeating, it does
    // not discard extracted memory.
    assertStatus(
      (after.stage1OutputCount ?? 0) === outputsBefore,
      `the clear action changed the stored output count from ${outputsBefore} to ${after.stage1OutputCount}`,
    );

    // The rendered card agrees: no list, the localized empty state, no action.
    await browser.waitUntil(
      async () => {
        const view = await readFailureView();
        return view.failedListCount === 0 && view.clearButtonCount === 0;
      },
      {
        timeout: STATUS_POLL_TIMEOUT_MS,
        interval: 1000,
        timeoutMsg: 'the memory card still renders the failed list (or its clear action) after clearing',
      },
    );

    const view = await readFailureView();
    console.log('[L1-MemoryFailure] failure card view after clear:', JSON.stringify(view.entries));
    assertStatus(view.entries.length === 0, `the card still renders ${view.entries.length} failure entries`);
    assertStatus(view.clearButtonCount === 0, 'the clear action is still rendered with no failures listed');
    const noneText = locale.lookup('status.failed.none');
    assertStatus(
      noneText !== '' && view.memorySectionText.includes(noneText),
      `the card does not render the localized empty state ${JSON.stringify(noneText)}`,
    );
    assertStatus(
      (view.storedOutputsText ?? '').includes(String(outputsBefore)),
      `the card no longer reports the stored output count: ${JSON.stringify(view.storedOutputsText)}`,
    );
    await saveStepScreenshot('l1-memory-failure-cleared');
  });

  it('3) an on-demand run expires the stale failure and keeps the recent one', async function () {
    if (!hasWorkspace) {
      this.skip();
      return;
    }

    // Re-seed so both failures exist again, including the one the clear action
    // deleted. Seeding is an upsert, so this restores the original fixture state.
    runFixtureSeed();

    await settingsPage.openTab(REMOUNT_SETTINGS_PAGE);
    await settingsPage.openTab(MEMORY_SETTINGS_PAGE);
    await memories.waitForLoad();

    await browser.waitUntil(
      async () => {
        const { status, error } = await tryGetMemoryStatus();
        if (error) {
          return false;
        }
        const ids = (status?.stage1Failed ?? []).map(failure => failure.sessionId);
        return ids.includes(STALE_SESSION_ID) && ids.includes(RECENT_SESSION_ID);
      },
      {
        timeout: STATUS_POLL_TIMEOUT_MS,
        interval: 1000,
        timeoutMsg: 'the re-seeded failures never reached the memory status after remounting the page',
      },
    );

    let view = await readFailureView();
    assertStatus(
      view.entries.length === 2,
      `expected 2 re-seeded failure entries, observed ${view.entries.length}`,
    );
    await saveStepScreenshot('l1-memory-failure-reseeded');

    // The sweep only runs inside a memory pass, and the on-demand pass is gated on
    // `generate_memories`, so the toggle has to be on first.
    const statusBeforeEnable = await getMemoryStatus();
    if (statusBeforeEnable.generateMemories !== true) {
      await memories.setMemoryEnabled(true);
    }
    await browser.waitUntil(
      async () => memories.isRunNowEnabled(),
      {
        timeout: 30000,
        interval: 500,
        timeoutMsg: 'the run-now action stayed disabled after enabling memory',
      },
    );
    await saveStepScreenshot('l1-memory-failure-memory-enabled');

    const outputsBefore = (await getMemoryStatus()).stage1OutputCount ?? 0;
    const expiryLogBaseline = countLogLines(ON_DEMAND_EXPIRY_LOG).lines.length;

    await memories.clickRunNow();
    await saveStepScreenshot('l1-memory-failure-run-now-triggered');

    await browser.waitUntil(
      async () => {
        const { status, error } = await tryGetMemoryStatus();
        if (error) {
          return false;
        }
        const ids = (status?.stage1Failed ?? []).map(failure => failure.sessionId);
        return !ids.includes(STALE_SESSION_ID) && ids.includes(RECENT_SESSION_ID);
      },
      {
        timeout: STATUS_POLL_TIMEOUT_MS,
        interval: 1000,
        timeoutMsg:
          `the on-demand run never expired the ${STALE_SESSION_ID} failure `
          + `(max_failure_report_days=${DEFAULT_MAX_FAILURE_REPORT_DAYS}) while keeping ${RECENT_SESSION_ID}`,
      },
    );

    const after = await getMemoryStatus();
    console.log('[L1-MemoryFailure] status after on-demand run:', describeStatus(after));
    const remainingIds = (after.stage1Failed ?? []).map(failure => failure.sessionId);
    assertStatus(
      !remainingIds.includes(STALE_SESSION_ID),
      'the 20-day-old failure is still listed although the default report window is 14 days',
    );
    assertStatus(
      remainingIds.includes(RECENT_SESSION_ID),
      'the 1-day-old failure was expired although it is inside the report window',
    );
    assertStatus(
      remainingIds.length === 1,
      `expected exactly one surviving failure, observed ${JSON.stringify(remainingIds)}`,
    );
    assertStatus(
      (after.stage1OutputCount ?? 0) === outputsBefore && outputsBefore === 1,
      `the expiry sweep changed the stored output count from ${outputsBefore} to ${after.stage1OutputCount}`,
    );

    view = await readFailureView();
    assertStatus(
      view.entries.length === 1 && view.entries[0]?.sessionId === RECENT_SESSION_ID,
      `the card does not show exactly the surviving failure: ${JSON.stringify(view.entries.map(entry => entry.sessionId))}`,
    );
    await saveStepScreenshot('l1-memory-failure-expiry-sweep');

    // The sweep logs its decision; the DB/UI state above is the decisive evidence.
    const expiryLog = await waitForLogLines(ON_DEMAND_EXPIRY_LOG, expiryLogBaseline, LOG_POLL_TIMEOUT_MS);
    const newExpiryLines = expiryLog.lines.slice(expiryLogBaseline);
    console.log('[L1-MemoryFailure] on-demand expiry log lines:', JSON.stringify(newExpiryLines));
    if (newExpiryLines.length === 0) {
      console.log(
        '[L1-MemoryFailure] SOFT COVERAGE: the on-demand sweep log line is absent from',
        `${expiryLog.file ?? '(no mirror)'}; the expiry is already proven by the host status`,
        '("' + STALE_SESSION_ID + '" gone, "' + RECENT_SESSION_ID + '" listed) and the stored output count.',
      );
    } else {
      assertStatus(
        newExpiryLines.some(line => line.includes('expired=1')),
        `the sweep removed a different number of rows than the single stale failure: ${JSON.stringify(newExpiryLines)}`,
      );
    }
  });

  it('4) records the phase-2 consolidation timeout diagnostic when consolidation runs', async function () {
    if (!hasWorkspace) {
      this.skip();
      return;
    }

    const observed = await waitForLogLines(PHASE2_TIMEOUT_LOG, phase2TimeoutLogBaseline, LOG_POLL_TIMEOUT_MS);
    const newLines = observed.lines.slice(phase2TimeoutLogBaseline);
    console.log(
      `[L1-MemoryFailure] phase2 timeout log lines: ${observed.lines.length} `
      + `(baseline ${phase2TimeoutLogBaseline}) in ${observed.file ?? '(no mirror)'}`,
    );

    if (newLines.length === 0) {
      const status = await getMemoryStatus();
      console.log(
        '[L1-MemoryFailure] SOFT COVERAGE: no memory consolidation ran in this pass, so',
        `"${PHASE2_TIMEOUT_LOG}" is not asserted. Reason: the pass had no new phase-2 input to`,
        'consolidate, and the diagnostic is only emitted right before a consolidation turn.',
        'Phase-2 state at this point:',
        JSON.stringify({
          phase2Status: status.phase2Status,
          phase2LastFinishedAtUnixSecs: status.phase2LastFinishedAtUnixSecs,
        }),
      );
    } else {
      console.log('[L1-MemoryFailure] phase2 timeout log lines:', JSON.stringify(newLines.slice(-3)));
    }

    await saveStepScreenshot('l1-memory-failure-phase2-log');
  });

  afterEach(async function () {
    if (this.currentTest?.state === 'failed') {
      await saveFailureScreenshot(`l1-memory-failure-${this.currentTest.title}`);
    }
  });

  after(async () => {
    await saveStepScreenshot('l1-memory-failure-complete');
    console.log('[L1-MemoryFailure] Memory failure-bookkeeping tests complete');
  });
});
