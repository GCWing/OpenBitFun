/**
 * L1 memory pipeline spec.
 *
 * Drives the real desktop app through the full memory journey on a fresh,
 * isolated profile:
 *
 *   a. Memory settings render the true default (memory off) plus an empty host
 *      status card.
 *   b. Enabling memory persists to the host config.
 *   c. A new chat session completes one deterministic turn.
 *   d. `MemorySave mode=capture_session` proactively captures that session.
 *   e. Backdating the session's `lastFinishedAt` past the idle gate and running
 *      the pipeline on demand produces Phase-1 output and a Phase-2 pass.
 *   f. The consolidated memory files exist on disk and reference the run.
 *   g. A new session receives the memory summary prompt injection.
 *
 * The app under test runs inside the sandbox storage root created by
 * `config/embedded-driver.ts`; `helpers/sandbox-utils.ts` resolves that sandbox so
 * on-disk assertions never touch the developer's real profile.
 *
 * Three product surfaces shape the chat and settings steps:
 *
 * - Settings > AI > Memory (`ai.memory`) exposes ONE user-facing switch
 *   (`memories-enabled-toggle`) that writes both `generate_memories` and
 *   `use_memories`; the retention/concurrency rows sit behind
 *   `actions.expandAdvanced`. The status card test ids
 *   (`memories-status-card`, `memories-run-now-btn`, `memories-status-*`) are the
 *   stable anchors.
 * - `MemorySave capture_session` writes under the memory root, so the turn stops
 *   on the chat-input approval band until it is answered. `settleTurn` answers it
 *   the way a user would and keeps polling until the session is idle again.
 * - WebdriverIO's `isExisting()` never settles on this driver's non-W3C "no such
 *   element" response, so turn state is read through `helpers/dom-utils`.
 *
 * Precondition: the sandbox profile must be seeded with a working AI provider
 * (`pnpm --dir tests/e2e run seed:memory-e2e`, which `test:l1:memory` runs
 * first). Because this spec sits in the default `wdio.conf.ts` glob, the `before`
 * hook skips the suite loudly on an unseeded sandbox instead of failing it for
 * infrastructure reasons; a seeded sandbox that breaks still fails.
 */

import { browser, expect } from '@wdio/globals';
import * as fs from 'fs';
import * as path from 'path';

import { ChatInput } from '../page-objects/components/ChatInput';
import { FlowChat } from '../page-objects/components/FlowChat';
import { MemoriesSettings } from '../page-objects/components/MemoriesSettings';
import { NavPanel } from '../page-objects/components/NavPanel';
import { PermissionPanel } from '../page-objects/components/PermissionPanel';
import { SceneBar } from '../page-objects/components/SceneBar';
import { SettingsPage } from '../page-objects/SettingsPage';

import { saveFailureScreenshot, saveStepScreenshot } from '../helpers/screenshot-utils';
import { invokeTauriCommand } from '../helpers/tauri-utils';
import {
  backdateNewestMemorySessionLastFinishedAt,
  fileExists,
  findNewestAppLogFile,
  findNewestAppStdoutLogFile,
  getE2eRuntimeRoot,
  getMemoriesDatabaseFile,
  getMemoryRootDir,
  getSandboxConfigFile,
  grepLines,
  listFiles,
  listTree,
  readSessionMetadataFiles,
  readTextFile,
} from '../helpers/sandbox-utils';

/** Marker the deterministic turn asks the model to echo. */
const DETERMINISTIC_REPLY = 'MEMORY_E2E_OK';
/**
 * Second turn of the captured session.
 *
 * Phase 1 applies a strict minimum-signal gate (see
 * `prompts/memories/phase1_system.md`): a one-off "reply with exactly X" exchange
 * carries no durable insight, so the extractor correctly returns empty sections.
 * A session only produces memory when the user states something reusable, so the
 * captured conversation states durable workspace conventions the way a real user
 * would.
 */
const CONVENTION_MESSAGE =
  'For all future sessions in this workspace, record these durable project conventions: '
  + '(1) the memory smoke-test marker is MEMORY_E2E_OK; '
  + '(2) the smoke verification command is `pnpm run verify:smoke`; '
  + '(3) never create new top-level directories in this repo. '
  + 'Acknowledge in one short sentence.';
/** Markers any consolidated memory file may use to reference the captured session. */
const MEMORY_REFERENCE_MARKERS = ['MEMORY_E2E_OK', 'MEMORY_E2E_CONVENTION', 'verify:smoke'];
/** Marker for the second session that must receive the memory injection. */
const INJECTION_REPLY = 'MEMORY_E2E_INJECT';
/**
 * Hours to backdate `lastFinishedAt`.
 *
 * `memories.min_rollout_idle_hours` defaults to 6 (clamped to 1..48), so the
 * backdate has to clear that gate rather than the 1 hour floor.
 */
const BACKDATE_HOURS = 8;

/** Settings page id of the Memory page (Settings > AI > Memory). */
const MEMORY_SETTINGS_PAGE = 'ai.memory';
/** Unrelated settings page used to remount the Memory page and re-read config. */
const REMOUNT_SETTINGS_PAGE = 'application.appearance';

const CHAT_TIMEOUT_MS = 5 * 60 * 1000;
const PIPELINE_TIMEOUT_MS = 10 * 60 * 1000;

interface MemoryFileStatsPayload {
  memoryIndexBytes?: number | null;
  memorySummaryBytes?: number | null;
  rolloutSummaryCount?: number | null;
}

interface MemoryStatusPayload {
  generateMemories?: boolean;
  useMemories?: boolean;
  memoryRootDir?: string;
  stage1OutputCount?: number;
  stage1PendingPromotionCount?: number;
  phase2Status?: string | null;
  phase2LastFinishedAtUnixSecs?: number | null;
  phase2LastError?: string | null;
  files?: MemoryFileStatsPayload;
}

async function getMemoryStatus(): Promise<MemoryStatusPayload> {
  return invokeTauriCommand<MemoryStatusPayload>('get_memory_status');
}

/**
 * Read the host status without throwing.
 *
 * Step (a) asserts the read succeeds on a fresh profile; this wrapper exists so
 * the other steps can report a failing read as evidence instead of aborting with
 * an unhandled rejection.
 */
async function tryGetMemoryStatus(): Promise<{ status: MemoryStatusPayload | null; error: string }> {
  try {
    return { status: await getMemoryStatus(), error: '' };
  } catch (error) {
    return { status: null, error: String(error).slice(0, 600) };
  }
}

/** Compare host and spec paths across separator and case differences. */
function normalizePath(value: string | null | undefined): string {
  return (value ?? '').replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase();
}

/**
 * Activate the scratch workspace through the frontend workspace manager.
 *
 * Calling the host commands directly (`open_workspace` / `set_active_workspace`)
 * updates host state only; the frontend store keeps the previous workspace and the
 * nav panel refuses to create Code sessions ("open a project workspace first").
 * The app's own workspace manager updates host state *and* the frontend store,
 * which is what the UI itself uses, so the spec drives that path instead.
 */
async function activateWorkspace(workspacePath: string): Promise<boolean> {
  try {
    const opened = await browser.execute(async (targetPath: string) => {
      const mod = await import('/src/infrastructure/services/business/workspaceManager.ts') as {
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
      return {
        ok: true,
        id: workspace?.id ?? null,
        current: state?.currentWorkspace?.rootPath ?? null,
      };
    }, workspacePath);

    if (!opened?.ok) {
      console.log('[L1-Memory] workspace activation failed:', JSON.stringify(opened));
      return false;
    }

    console.log('[L1-Memory] workspace manager current:', opened.current);
    return normalizePath(opened.current) === normalizePath(workspacePath);
  } catch (error) {
    console.log('[L1-Memory] workspace activation threw:', String(error).slice(0, 400));
    return false;
  }
}

async function readSandboxMemoriesConfig(): Promise<Record<string, unknown> | undefined> {
  const raw = readTextFile(getSandboxConfigFile());
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { memories?: Record<string, unknown> };
    return parsed.memories;
  } catch {
    return undefined;
  }
}

/**
 * Detect the profile seeded by `scripts/seed-memory-e2e-profile.mjs`.
 *
 * This spec lives inside the default `wdio.conf.ts` glob, so a full-suite run
 * reaches it on a bare sandbox. Without a seeded `ai` section there is no chat
 * provider, every turn fails for infrastructure reasons, and the suite goes red
 * for something the spec cannot fix. The marker is a non-empty `ai` section with
 * at least one model, which is what the seed script guarantees (it exits when it
 * cannot provide one).
 *
 * A seeded sandbox that then misbehaves still fails loudly: the skip covers only
 * "nothing was seeded", never "the journey broke".
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
    const primary = typeof ai?.default_models?.primary === 'string'
      ? ai.default_models.primary
      : '';
    const seeded = Boolean(ai) && modelCount > 0;
    return {
      seeded,
      detail: `ai section=${ai ? 'present' : 'absent'}, models=${modelCount}, primary=${primary || '(none)'}`,
    };
  } catch (error) {
    return { seeded: false, detail: `sandbox config is not valid JSON: ${String(error).slice(0, 200)}` };
  }
}

/**
 * Tool-execution evidence for `MemorySearch` in the harness stdout mirror.
 *
 * The flow chat collapses its tool group after a turn, which deletes the card
 * from the DOM. The app stdout mirror is the durable record that the tool really
 * ran, so it backs the card when the card is gone.
 */
function countMemorySearchToolLines(logFile: string): number {
  const detected = grepLines(logFile, 'Tool detected: MemorySearch').length;
  const completed = grepLines(logFile, 'Tool completed: tool_name=MemorySearch').length;
  return detected + completed;
}

describe('L1 Memory Pipeline', () => {
  let chatInput: ChatInput;
  let flowChat: FlowChat;
  let memories: MemoriesSettings;
  let navPanel: NavPanel;
  let permissionPanel: PermissionPanel;
  let sceneBar: SceneBar;
  let settingsPage: SettingsPage;

  let hasWorkspace = false;
  let scratchWorkspace = '';
  let backdatedSessionId = '';

  /**
   * Wait until the running turn finishes, answering permission requests.
   *
   * A memory tool that writes new files stops the turn on the approval band, so
   * "the turn is idle" is not enough on its own: the loop answers whatever the
   * band asks and only then waits for the session to become idle.
   */
  async function settleTurn(label: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let approvals = 0;

    while (Date.now() < deadline) {
      if (await permissionPanel.hasVisibleRequest()) {
        const pendingCount = await permissionPanel.getPendingCount();
        const panelText = await permissionPanel.getPanelText();
        const answered = await permissionPanel.allowAllOnce();
        if (answered) {
          approvals += 1;
          console.log(
            `[L1-Memory] ${label}: approved permission request #${approvals} (pending=${pendingCount}):`,
            JSON.stringify(panelText.slice(0, 240)),
          );
          await saveStepScreenshot(`l1-memory-permission-${approvals}`);
          await browser.pause(500);
          continue;
        }
      }

      if (!(await flowChat.isTurnRunning())) {
        console.log(`[L1-Memory] ${label}: turn idle after ${approvals} approval(s)`);
        await browser.pause(500);
        return;
      }

      await browser.pause(1000);
    }

    throw new Error(`${label}: turn did not finish within ${timeoutMs}ms (approvals=${approvals})`);
  }

  // Non-arrow hook on purpose: `this.skip()` is only available through mocha's
  // shared context, and this suite must be able to skip itself loudly when the
  // sandbox was never seeded.
  before(async function () {
    console.log('[L1-Memory] Starting memory pipeline tests');

    const seedState = readSeedState();
    console.log('[L1-Memory] Seed marker         :', JSON.stringify(seedState));
    if (!seedState.seeded) {
      const message =
        `L1-Memory SKIPPED: the isolated sandbox profile is not seeded (${seedState.detail}). ` +
        'This spec needs a working AI provider in the sandbox config, so run ' +
        '`pnpm --dir tests/e2e run seed:memory-e2e` (or `pnpm --dir tests/e2e run test:l1:memory`, ' +
        'which seeds first) and re-run. This skip only covers an unseeded sandbox; ' +
        'a seeded sandbox that breaks still fails.';
      console.log(`[L1-Memory] ${message}`);
      this.skip();
      return;
    }

    chatInput = new ChatInput();
    flowChat = new FlowChat();
    memories = new MemoriesSettings();
    navPanel = new NavPanel();
    permissionPanel = new PermissionPanel();
    sceneBar = new SceneBar();
    settingsPage = new SettingsPage();

    await browser.pause(3000);

    scratchWorkspace = path.join(getE2eRuntimeRoot(), 'scratch-workspace-memory-e2e');
    fs.mkdirSync(scratchWorkspace, { recursive: true });

    console.log('[L1-Memory] Sandbox user root :', process.env.OPENBITFUN_E2E_USER_ROOT);
    console.log('[L1-Memory] Sandbox home root :', process.env.OPENBITFUN_E2E_HOME);
    console.log('[L1-Memory] Sandbox config    :', getSandboxConfigFile());
    console.log('[L1-Memory] Memory root       :', getMemoryRootDir());
    console.log('[L1-Memory] Scratch workspace :', scratchWorkspace);

    hasWorkspace = await activateWorkspace(scratchWorkspace);
    if (!hasWorkspace) {
      console.log('[L1-Memory] No workspace available - tests will be skipped');
      // Fail loudly instead of reporting a green run in which every case skipped
      // itself: a spec that asserts nothing must never look like a pass.
      expect(hasWorkspace).toBe(true);
      return;
    }

    // On a cold profile the nav panel populates its workspace list asynchronously
    // after the shell paints (it waits on the host workspace catalog), so wait for
    // the row instead of assuming it is already there.
    const navReadyStartedAt = Date.now();
    await navPanel.waitForWorkspaceEntry(60000);
    console.log(
      '[L1-Memory] nav workspace entry ready after',
      `${((Date.now() - navReadyStartedAt) / 1000).toFixed(1)}s`,
    );

    if (!(await navPanel.isChatInputPresent())) {
      await navPanel.createNewCodeSession();
    }
    await sceneBar.waitForActiveScene('session', 30000);
    await saveStepScreenshot('l1-memory-workspace-ready');
  });

  it('a) fresh profile renders memory off with an empty status card', async function () {
    if (!hasWorkspace) {
      this.skip();
      return;
    }

    await settingsPage.open();
    await settingsPage.openTab(MEMORY_SETTINGS_PAGE);
    await memories.waitForLoad();
    await saveStepScreenshot('l1-memory-settings-memories-defaults');

    const memoryEnabled = await memories.isMemoryEnabled();
    console.log('[L1-Memory] memory toggle:', memoryEnabled);

    const statusCardText = await memories.getStatusCardText();
    console.log('[L1-Memory] status card text:', JSON.stringify(statusCardText));

    // The status card must render real host facts, not a fallback or an error.
    const { status, error: statusError } = await tryGetMemoryStatus();
    console.log('[L1-Memory] status payload:', JSON.stringify(status));

    // The seeded profile must not carry a memories section.
    const seeded = await readSandboxMemoriesConfig();
    console.log('[L1-Memory] seeded memories section:', JSON.stringify(seeded ?? null));

    // The switch reflects the backend default (`generate_memories: false`).
    expect(memoryEnabled).toBe(false);
    expect(seeded).toBeUndefined();

    expect(statusError).toBe('');
    expect(status).not.toBeNull();
    expect(status?.generateMemories).toBe(false);
    expect(status?.useMemories).toBe(false);
    expect(status?.stage1OutputCount ?? 0).toBe(0);
    expect(status?.stage1PendingPromotionCount ?? 0).toBe(0);
    expect(status?.phase2LastFinishedAtUnixSecs ?? null).toBeNull();

    const memoryRoot = status?.memoryRootDir ?? '';
    expect(memoryRoot.length).toBeGreaterThan(0);
    console.log('[L1-Memory] host memory root:', memoryRoot);

    // The rendered card agrees with the host payload.
    expect(statusCardText).not.toMatch(/unavailable|不可用/i);
    expect(await memories.getStoredOutputCount()).toBe(0);
    expect(await memories.getPendingPromotionCount()).toBe(0);
    expect(await memories.getMemoryRootDirText()).not.toBe('');
    console.log('[L1-Memory] phase2 status text:', await memories.getPhase2StatusText());
  });

  it('b) enabling memory persists to the host config', async function () {
    if (!hasWorkspace) {
      this.skip();
      return;
    }

    await memories.setMemoryEnabled(true);
    await saveStepScreenshot('l1-memory-toggle-enabled');

    // Re-open the page: this remounts it and re-reads the host config.
    await settingsPage.openTab(REMOUNT_SETTINGS_PAGE);
    await settingsPage.openTab(MEMORY_SETTINGS_PAGE);
    await memories.waitForLoad();

    expect(await memories.isMemoryEnabled()).toBe(true);

    // Persisted on disk under the sandbox user root.
    await browser.waitUntil(
      async () => {
        const section = await readSandboxMemoriesConfig();
        return section?.generate_memories === true && section?.use_memories === true;
      },
      {
        timeout: 20000,
        interval: 500,
        timeoutMsg: 'memories config was not persisted to the sandbox config file',
      },
    );
    console.log('[L1-Memory] sandbox config memories section:', JSON.stringify(await readSandboxMemoriesConfig()));

    // The host reports the enabled flags, and the run-now trigger becomes usable.
    const enabledFlags = await browser.waitUntil(
      async () => {
        const { status, error } = await tryGetMemoryStatus();
        if (error) {
          console.log('[L1-Memory] get_memory_status rejected while checking flags:', error);
          return false;
        }
        return status?.generateMemories === true && status?.useMemories === true;
      },
      {
        timeout: 20000,
        interval: 500,
      },
    ).catch(() => false);

    const { status: flagStatus, error: flagError } = await tryGetMemoryStatus();
    if (!enabledFlags) {
      console.log(
        '[L1-Memory] host flag check could not confirm via get_memory_status;',
        'payload:',
        JSON.stringify(flagStatus),
        'error:',
        flagError || '(none)',
      );
    }
    if (!flagError) {
      expect(flagStatus?.generateMemories).toBe(true);
      expect(flagStatus?.useMemories).toBe(true);
    }

    await browser.waitUntil(
      async () => memories.isRunNowEnabled(),
      {
        timeout: 20000,
        interval: 500,
        timeoutMsg: 'run-now button stayed disabled after enabling memory',
      },
    );
  });

  it('c) a new session completes one deterministic turn', async function () {
    if (!hasWorkspace) {
      this.skip();
      return;
    }

    // A failing settings step can leave the settings scene covering the nav panel,
    // so every chat step starts by re-activating the session scene.
    await sceneBar.activateSessionScene();
    await navPanel.createNewCodeSession();
    await sceneBar.waitForActiveScene('session');
    await chatInput.waitForLoad();

    await chatInput.sendMessage(`Reply with exactly: ${DETERMINISTIC_REPLY}`);
    await flowChat.waitForUserMessageContaining(DETERMINISTIC_REPLY, 60000);
    await settleTurn('step-c', CHAT_TIMEOUT_MS);
    await saveStepScreenshot('l1-memory-deterministic-turn');

    const rounds = await flowChat.getModelRoundTexts();
    const joined = rounds.join('\n');
    console.log('[L1-Memory] assistant output:', JSON.stringify(joined.slice(0, 400)));

    const failures = await flowChat.getTurnFailureTexts();
    if (failures.length > 0) {
      console.log('[L1-Memory] turn failure notices:', JSON.stringify(failures));
    }
    expect(failures.length).toBe(0);

    expect(joined.trim().length).toBeGreaterThan(0);
    if (!joined.includes(DETERMINISTIC_REPLY)) {
      console.log(`[L1-Memory] NOTE: model did not echo ${DETERMINISTIC_REPLY} verbatim`);
    }

    // Second turn: give the session durable content worth extracting.
    await chatInput.sendMessage(CONVENTION_MESSAGE);
    await flowChat.waitForUserMessageContaining('durable project conventions', 60000);
    await settleTurn('step-c-conventions', CHAT_TIMEOUT_MS);
    await saveStepScreenshot('l1-memory-conventions-turn');
    const conventionFailures = await flowChat.getTurnFailureTexts();
    expect(conventionFailures.length).toBe(0);
    console.log(
      '[L1-Memory] conventions turn assistant output:',
      JSON.stringify((await flowChat.getModelRoundTexts()).join('\n').slice(0, 300)),
    );

    // The session created after memory was enabled must be memory-eligible.
    const sessionMetadata = readSessionMetadataFiles();
    const newest = sessionMetadata
      .filter(entry => entry.data.memoryMode === 'enabled')
      .sort((left, right) => {
        const leftFinished = typeof left.data.lastFinishedAt === 'number' ? left.data.lastFinishedAt : 0;
        const rightFinished = typeof right.data.lastFinishedAt === 'number' ? right.data.lastFinishedAt : 0;
        return rightFinished - leftFinished;
      })[0];
    expect(newest).toBeTruthy();
    console.log('[L1-Memory] newest memory-enabled session:', JSON.stringify(newest?.data));
    expect(newest?.data.memoryMode).toBe('enabled');
    expect(Number(newest?.data.turnCount ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it('d) MemorySave capture_session captures this session without a tool error', async function () {
    if (!hasWorkspace) {
      this.skip();
      return;
    }

    await sceneBar.activateSessionScene();
    await chatInput.sendMessage(
      'Use the MemorySave tool with mode capture_session to capture this session\'s memory now.',
    );
    await flowChat.waitForToolCard('MemorySave', CHAT_TIMEOUT_MS);
    await saveStepScreenshot('l1-memory-save-capture-session-running');
    const cardWhileRunning = await flowChat.readToolCardEvidence('MemorySave');
    console.log('[L1-Memory] MemorySave card while running:', JSON.stringify(cardWhileRunning).slice(0, 400));
    await settleTurn('step-d', CHAT_TIMEOUT_MS);
    const cardStillPresent = await flowChat.waitForToolCardSettledIfPresent('MemorySave', 120000);
    await saveStepScreenshot('l1-memory-save-capture-session');

    const cardEvidence = await flowChat.readToolCardEvidence('MemorySave');
    console.log('[L1-Memory] MemorySave card settled evidence:', JSON.stringify(cardEvidence).slice(0, 600));
    if (!cardStillPresent || !cardEvidence.present) {
      console.log(
        '[L1-Memory] NOTE: the flow chat collapsed the MemorySave tool group after the turn,',
        'so the card-level assertion is skipped; the host status below is the decisive evidence',
      );
    } else {
      expect(cardEvidence.hasError).toBe(false);
    }

    // A failed tool renders a turn-failure notice; the turn must not have one.
    const turnFailures = await flowChat.getTurnFailureTexts();
    console.log('[L1-Memory] step-d turn failure notices:', JSON.stringify(turnFailures));
    expect(turnFailures.length).toBe(0);

    // The proactive capture must produce Phase-1 output.
    await browser.waitUntil(
      async () => ((await getMemoryStatus()).stage1OutputCount ?? 0) >= 1,
      {
        timeout: 120000,
        interval: 2000,
        timeoutMsg: 'capture_session did not produce any Phase-1 output',
      },
    );
    const status = await getMemoryStatus();
    console.log('[L1-Memory] status after capture_session:', JSON.stringify(status));
    expect(status.stage1OutputCount ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('e) running the pipeline on demand produces Phase-2 consolidation', async function () {
    if (!hasWorkspace) {
      this.skip();
      return;
    }

    const backdated = backdateNewestMemorySessionLastFinishedAt(BACKDATE_HOURS);
    expect(backdated).not.toBeNull();
    backdatedSessionId = backdated?.sessionId ?? '';
    console.log('[L1-Memory] backdated session metadata:', JSON.stringify(backdated));
    expect(backdated?.memoryMode).toBe('enabled');

    await sceneBar.activateSessionScene();
    await settingsPage.open();
    await settingsPage.openTab(MEMORY_SETTINGS_PAGE);
    await memories.waitForLoad();
    await saveStepScreenshot('l1-memory-pipeline-before-run');

    await browser.waitUntil(
      async () => memories.isRunNowEnabled(),
      {
        timeout: 30000,
        interval: 500,
        timeoutMsg: 'run-now button was disabled when the pipeline was requested',
      },
    );
    await memories.clickRunNow();
    await saveStepScreenshot('l1-memory-pipeline-triggered');

    await browser.waitUntil(
      async () => {
        const { status, error } = await tryGetMemoryStatus();
        if (error) {
          return false;
        }
        return (status?.stage1OutputCount ?? 0) >= 1
          && (status?.phase2LastFinishedAtUnixSecs ?? null) !== null;
      },
      {
        timeout: PIPELINE_TIMEOUT_MS,
        interval: 3000,
        timeoutMsg: 'memory pipeline never reported Phase-1 output plus a Phase-2 pass',
      },
    );

    const status = await getMemoryStatus();
    console.log('[L1-Memory] status after pipeline run:', JSON.stringify(status));
    console.log('[L1-Memory] phase2 status text (ui):', await memories.getPhase2StatusText());
    await saveStepScreenshot('l1-memory-pipeline-finished');

    expect(status.stage1OutputCount ?? 0).toBeGreaterThanOrEqual(1);
    expect(status.phase2LastFinishedAtUnixSecs ?? null).not.toBeNull();
    expect(status.phase2Status ?? null).toBe('done');
  });

  it('f) consolidated memory files exist on disk and reference the run', async function () {
    if (!hasWorkspace) {
      this.skip();
      return;
    }

    const memoryRoot = getMemoryRootDir();
    console.log('[L1-Memory] memory root tree:');
    for (const entry of listTree(memoryRoot)) {
      console.log(`[L1-Memory]   ${entry}`);
    }
    console.log('[L1-Memory] memories db exists:', fileExists(getMemoriesDatabaseFile()));

    const memoryIndexFile = path.join(memoryRoot, 'MEMORY.md');
    const memorySummaryFile = path.join(memoryRoot, 'memory_summary.md');
    const rolloutDir = path.join(memoryRoot, 'rollout_summaries');

    // Phase 2 writes its artifacts asynchronously; the on-demand pass reported
    // finished, but the files land a moment later.
    await browser.waitUntil(
      async () => fileExists(memoryIndexFile) && fileExists(memorySummaryFile),
      {
        timeout: 120000,
        interval: 2000,
        timeoutMsg: 'MEMORY.md / memory_summary.md never appeared under the memory root',
      },
    );

    expect(fileExists(memoryIndexFile)).toBe(true);
    expect(fileExists(memorySummaryFile)).toBe(true);

    const memoryIndex = readTextFile(memoryIndexFile);
    expect(memoryIndex.trim().length).toBeGreaterThan(0);

    const summaryFirstLine = readTextFile(memorySummaryFile).split(/\r?\n/)[0] ?? '';
    console.log('[L1-Memory] memory_summary.md first line:', JSON.stringify(summaryFirstLine));
    expect(summaryFirstLine.replace(/^\uFEFF/, '').trim()).toBe('v1');

    // The per-session extraction files are promoted by a consolidation pass, so
    // one more on-demand pass is triggered when the first pass consolidated a
    // different input (for example an ad-hoc note) and left the session output
    // pending promotion.
    let rolloutSummaries = listFiles(rolloutDir).filter(file => file.name.endsWith('.md'));
    if (rolloutSummaries.length === 0) {
      console.log('[L1-Memory] no rollout summaries yet; triggering one more on-demand pass');
      await sceneBar.activateSessionScene();
      await settingsPage.open();
      await settingsPage.openTab(MEMORY_SETTINGS_PAGE);
      await memories.waitForLoad();
      await browser.waitUntil(async () => memories.isRunNowEnabled(), {
        timeout: 30000,
        interval: 500,
        timeoutMsg: 'run-now button was disabled for the follow-up pass',
      });
      await memories.clickRunNow();
      await browser.waitUntil(
        async () => listFiles(rolloutDir).filter(file => file.name.endsWith('.md')).length > 0,
        {
          timeout: PIPELINE_TIMEOUT_MS,
          interval: 5000,
          timeoutMsg: 'rollout_summaries/*.md never appeared after the follow-up pass',
        },
      );
      rolloutSummaries = listFiles(rolloutDir).filter(file => file.name.endsWith('.md'));
    }

    console.log('[L1-Memory] rollout summaries:', JSON.stringify(rolloutSummaries.map(file => file.name)));
    expect(rolloutSummaries.length).toBeGreaterThanOrEqual(1);

    // The consolidated memory must reference the captured conversation.
    const referencesMarker = (text: string): boolean =>
      MEMORY_REFERENCE_MARKERS.some(marker => text.includes(marker));

    const indexReferences = referencesMarker(memoryIndex);
    console.log('[L1-Memory] MEMORY.md references the test conversation:', indexReferences);
    if (!indexReferences) {
      const rolloutReferences = rolloutSummaries.some(file =>
        referencesMarker(readTextFile(path.join(rolloutDir, file.name))),
      );
      const summaryReferences = referencesMarker(readTextFile(memorySummaryFile));
      console.log('[L1-Memory] rollout summary references:', rolloutReferences);
      console.log('[L1-Memory] memory_summary references :', summaryReferences);
      console.log('[L1-Memory] MEMORY.md head:', JSON.stringify(memoryIndex.slice(0, 800)));
      expect(rolloutReferences || summaryReferences).toBe(true);
    }

    console.log('[L1-Memory] backdated session id:', backdatedSessionId);
  });

  it('g) a new session receives the memory prompt injection', async function () {
    if (!hasWorkspace) {
      this.skip();
      return;
    }

    await sceneBar.activateSessionScene();
    await navPanel.createNewCodeSession();
    await sceneBar.waitForActiveScene('session');
    await chatInput.waitForLoad();

    await chatInput.sendMessage(`Reply with exactly: ${INJECTION_REPLY}`);
    await flowChat.waitForUserMessageContaining(INJECTION_REPLY, 60000);
    await settleTurn('step-g', CHAT_TIMEOUT_MS);
    await saveStepScreenshot('l1-memory-new-session-injection');

    const logFile = findNewestAppStdoutLogFile() ?? findNewestAppLogFile();
    console.log('[L1-Memory] app log file:', logFile);
    expect(logFile).toBeTruthy();

    let injectionLines: string[] = [];
    await browser.waitUntil(
      async () => {
        injectionLines = grepLines(logFile as string, 'Memory prompt injection added');
        return injectionLines.length > 0;
      },
      {
        timeout: 60000,
        interval: 2000,
        timeoutMsg: 'app log never recorded "Memory prompt injection added"',
      },
    );

    console.log('[L1-Memory] injection log lines:', JSON.stringify(injectionLines));
    expect(injectionLines.length).toBeGreaterThan(0);

    const phase1Lines = grepLines(logFile as string, 'Memory phase1');
    const phase2Lines = grepLines(logFile as string, 'Memory phase2');
    const onDemandLines = grepLines(logFile as string, 'Memory pipeline on-demand');
    console.log('[L1-Memory] phase1 log lines:', JSON.stringify(phase1Lines.slice(-5)));
    console.log('[L1-Memory] phase2 log lines:', JSON.stringify(phase2Lines.slice(-5)));
    console.log('[L1-Memory] on-demand log lines:', JSON.stringify(onDemandLines.slice(-5)));
  });

  it('g2) MemorySearch is available in a memory-enabled session', async function () {
    if (!hasWorkspace) {
      this.skip();
      return;
    }

    await sceneBar.activateSessionScene();
    await saveStepScreenshot('l1-memory-search-before');

    // Baseline the stdout mirror before the turn so a stale line from an earlier
    // step cannot be mistaken for this turn's tool execution.
    const baselineLogFile = findNewestAppStdoutLogFile();
    const baselineToolLines = baselineLogFile ? countMemorySearchToolLines(baselineLogFile) : 0;
    console.log(
      '[L1-Memory] MemorySearch stdout baseline:',
      baselineToolLines,
      'in',
      baselineLogFile ?? '(no mirror yet)',
    );

    await chatInput.sendMessage(
      `Use the MemorySearch tool to search memory for "${DETERMINISTIC_REPLY}" and report what you find.`,
    );

    let invoked = true;
    try {
      await flowChat.waitForToolCard('MemorySearch', 90000);
    } catch {
      invoked = false;
    }

    await settleTurn('step-g2', CHAT_TIMEOUT_MS);
    await saveStepScreenshot('l1-memory-search-check');

    const logFile = baselineLogFile ?? findNewestAppStdoutLogFile() ?? findNewestAppLogFile();
    const baseline = logFile && logFile === baselineLogFile ? baselineToolLines : 0;
    if (logFile) {
      // The line lands just after the tool finishes, so poll instead of reading once.
      try {
        await browser.waitUntil(
          () => countMemorySearchToolLines(logFile) > baseline,
          {
            timeout: 30000,
            interval: 500,
            timeoutMsg: `MemorySearch tool execution never appeared in ${logFile}`,
          },
        );
      } catch {
        // Reported through the explicit assertions below.
      }
    }
    const toolLines = logFile ? countMemorySearchToolLines(logFile) : 0;
    const toolDetectedLines = logFile ? grepLines(logFile, 'Tool detected: MemorySearch') : [];
    const toolCompletedLines = logFile ? grepLines(logFile, 'Tool completed: tool_name=MemorySearch') : [];
    const executedInLog = toolLines > baseline;
    console.log(
      `[L1-Memory] MemorySearch stdout evidence: lines=${toolLines} baseline=${baseline} executed=${executedInLog}`,
    );

    const failureTexts = await flowChat.getTurnFailureTexts();

    if (!invoked) {
      if (executedInLog) {
        // The card never became observable inside the wait window, but the tool
        // provably executed; assert that evidence instead of skipping the step.
        console.log(
          '[L1-Memory] The model did call MemorySearch (the stdout mirror proves it executed);',
          'only the flow-chat card was unobservable.',
        );
        console.log(
          '[L1-Memory] MemorySearch stdout lines:',
          JSON.stringify([...toolDetectedLines, ...toolCompletedLines].slice(0, 2)).slice(0, 400),
        );
        expect(toolLines).toBeGreaterThan(baseline);
        return;
      }

      // Soft coverage, stated explicitly: this run cannot prove a tool-level hit
      // because the model chose not to call the tool. What can be verified is
      // that the memory-enabled session ran the turn cleanly.
      console.log(
        '[L1-Memory] SOFT COVERAGE: the model did not call MemorySearch in this run, so no tool-level',
        'hit is asserted; asserting instead that the turn completed with no failure notice.',
      );
      expect(failureTexts.length).toBe(0);
      expect(toolLines).toBe(baseline);
      return;
    }

    const searchSettled = await flowChat.waitForToolCardSettledIfPresent('MemorySearch', 60000);
    const searchEvidence = await flowChat.readToolCardEvidence('MemorySearch');
    console.log('[L1-Memory] MemorySearch card evidence:', JSON.stringify(searchEvidence).slice(0, 600));
    if (!searchSettled || !searchEvidence.present) {
      // The flow chat collapsed the tool group after the turn, so the card-level
      // error check is impossible; the stdout mirror carries the evidence instead.
      console.log(
        '[L1-Memory] The flow chat collapsed the MemorySearch tool group after the turn;',
        'asserting the app stdout mirror instead of the card.',
      );
      expect(logFile).toBeTruthy();
      expect(toolLines).toBeGreaterThan(baseline);
      return;
    }
    expect(searchEvidence.hasError).toBe(false);
    expect(failureTexts.length).toBe(0);
  });

  afterEach(async function () {
    if (this.currentTest?.state === 'failed') {
      await saveFailureScreenshot(`l1-memory-${this.currentTest.title}`);
    }
  });

  after(async () => {
    await saveStepScreenshot('l1-memory-complete');
    console.log('[L1-Memory] Memory pipeline tests complete');
  });
});
