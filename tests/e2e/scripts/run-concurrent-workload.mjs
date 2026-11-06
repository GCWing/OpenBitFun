/** Actual Agent tools + bounded loopback model output while operating production controls. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { openNativeWorkload, delay } from './native-workload-session.mjs';
import { ConcurrentWorkloadPage } from '../page-objects/ConcurrentWorkloadPage.mjs';
import { ConcurrentMemoryPage } from '../page-objects/ConcurrentMemoryPage.mjs';
import { captureConcurrentAllocation } from './concurrent-memory-diagnostic.mjs';
import { unfocusedWindowConditions } from './workbench-performance-metrics.mjs';
import { createFlowChatStreamFixture } from '../helpers/flowchat-stream-fixture.ts';
import { latencyDistribution, probeFrameDistributions } from '../helpers/flowchat-frame-metrics.ts';

const memoryDiagnostic = process.env.OPENBITFUN_CONCURRENT_MEMORY_DIAGNOSTIC === '1';
const protocol = {
  name: memoryDiagnostic ? 'native-concurrent-memory-diagnostic' : 'native-concurrent-workload',
  version: memoryDiagnostic ? 1 : 7, prewarmMs: 15_000, settleMs: 5000, sampleMs: 2000,
  ...(memoryDiagnostic ? { diagnosticOnly: true, forcedGC: false, weakRoots: 'current-document-only',
    nativeAllocationOutsideWindows: true, extendedClosedWindows: 3, extendedClosedWindowMs: 60000 } : {}),
  editorOpened: false, secondaryPane: 'empty-canvas',
  focus: 'visible-unfocused-native-main-and-document-with-focus-event-observation',
  input: 'native-eval-PointerEvent-and-MouseEvent-sequence', timingStart: 'capture-pointerdown',
  initialParagraphs: Number(process.env.OPENBITFUN_CONCURRENT_INITIAL_PARAGRAPHS || 250),
  maxParagraphs: Number(process.env.OPENBITFUN_CONCURRENT_MAX_PARAGRAPHS || 600), intervalMs: 90,
  idleMs: Number(process.env.OPENBITFUN_CONCURRENT_IDLE_MS || 30_000),
  draftChunks: 24, typingIntervalMs: 80, wheelSteps: 24, wheelDeltaY: -100,
  navigation: ['personal-overview', 'todos', 'session'],
  sessionReady: 'visible composer inside active scene with retained transcript; generation may remain busy',
  sessionSetup: 'new document timeOrigin and real panel toggle after refresh; no file opened',
  attributionSettleMs: 5000,
  dividers: ['navigation', 'content'], realExecCommands: 4, realEdits: 4,
  cancelInitialParagraphs: 80, cancelAfterParagraphs: 120, boundedCancellation: true,
  budgets: { feedbackP95Ms: 100, contentP95Ms: 150, inputRafP95Ms: 100, frameP95Ms: 34, frameMaxMs: 100 },
};
assert.ok(Number.isInteger(protocol.initialParagraphs) && protocol.initialParagraphs >= 80);
assert.ok(Number.isInteger(protocol.maxParagraphs) && protocol.maxParagraphs >= protocol.initialParagraphs + 200);
assert.ok(Number.isFinite(protocol.idleMs) && protocol.idleMs > 0);
const run = await openNativeWorkload({ Page: memoryDiagnostic ? ConcurrentMemoryPage : ConcurrentWorkloadPage, protocol,
  label: process.env.OPENBITFUN_CONCURRENT_LABEL || 'baseline', evidence: process.env.OPENBITFUN_CONCURRENT_EVIDENCE,
  harnessFiles: ['tests/e2e/scripts/run-concurrent-workload.mjs', 'tests/e2e/page-objects/ConcurrentWorkloadPage.mjs',
    'tests/e2e/page-objects/SceneVisibilityPage.mjs',
    'tests/e2e/scripts/workbench-performance-metrics.mjs', 'tests/e2e/scripts/run-concurrent-workload-pair.mjs',
    'tests/e2e/helpers/flowchat-stream-fixture.ts', 'tests/e2e/helpers/flowchat-frame-metrics.ts',
    ...(memoryDiagnostic ? ['tests/e2e/page-objects/ConcurrentMemoryPage.mjs', 'tests/e2e/scripts/concurrent-memory-diagnostic.mjs'] : [])],
});
const { page, report } = run;
report.coverage.realAgent = true;
report.coverage.loopbackModel = true;
report.coverage.multiConcurrentSessions = false;
report.coverage.pilot = protocol.idleMs !== 30_000 || protocol.initialParagraphs !== 250 || protocol.maxParagraphs !== 600;
if (memoryDiagnostic) {
  report.coverage.instrumented = true; report.coverage.pilot = true;
  report.coverage.memoryDiagnostic = true; report.memoryAllocations = [];
  report.limitations.push('Weak transcript references and logical resource-budget entries do not enumerate the JavaScript heap or its retaining paths.',
    'Weak references reset on document refresh; collection of current-document roots does not prove release of earlier documents.',
    'Native heap/vmmap inspect allocation categories outside sampled windows and can affect residency; this mode is diagnostic, not speed/resource A/B acceptance.');
}
report.limitations.push('Input-to-RAF is a renderer opportunity, not end-to-end keyboard-to-pixel latency.',
  'Divider motion uses native-evaluated PointerEvent because the embedded W3C driver emits MouseEvent.',
  'Completion and cancellation have bounded output; cancellation still exercises an open unfinished stream.',
  'Loopback model timing does not establish external provider/network latency.');
report.interactions = []; report.navigations = []; report.dividers = [];
report.focusPreparations = [];
const observeWindow = async (name, action) => {
  report.focusPreparations.push({ name, ...await page.waitForUnfocusedWindow() });
  await page.startWindowStateProbe();
  let result;
  try { result = await action(); }
  finally {
    const windowState = await page.stopWindowStateProbe();
    const recorded = result ?? [...report.actions, ...report.windows].findLast(window => window.name === name);
    if (recorded) recorded.windowState = windowState;
    await run.save();
  }
  return result;
};
const idleWindow = name => observeWindow(name, () => run.idleWindow(name, protocol.idleMs));
const measureAction = (name, action) => observeWindow(name, () => run.measureAction(name, action));
let fixture;
const scene = id => `[data-testid="scene-viewport-scene"][data-scene-id=${JSON.stringify(id)}][data-scene-active="true"]`;
const check = (name, data) => { report.checks.push({ name, ...data }); };
const probe = async (name, action) => {
  console.log(`Interaction ${name} started`);
  await page.startInteractionProbe();
  let value;
  try { value = await action(); }
  finally {
    const raw = await page.stopInteractionProbe();
    assert.ok(raw?.frames.length > 1, `Missing frames for ${name}`);
    report.interactions.push({ name, raw, value,
      frames: probeFrameDistributions({ frames: raw.frames.map(time => ({ time })), wheelTimes: raw.wheelTimes }),
      inputRaf: raw.inputRafMs.length ? latencyDistribution(raw.inputRafMs) : null });
    await run.save();
  }
  console.log(`Interaction ${name} completed`);
  return value;
};
const ensureTools = async () => {
  assert.deepEqual(fixture.errors, []);
  assert.equal(fixture.results.length, 8);
  assert.ok(fixture.results.every(result => !result.is_error), 'Real tools must succeed');
  for (let index = 0; index < 4; index++) {
    assert.ok((await readFile(path.join(run.workspace, `flowchat-live-${index}.ts`), 'utf8')).includes('value = 1'));
  }
};
const beginTurn = async () => {
  await page.enterDraft('FLOWCHAT_PERF_STREAM');
  await page.click('[data-testid="chat-input-send-btn"]');
  await page.until(() => fixture.textReady || fixture.errors.length, 'real tool results', 60_000);
  await ensureTools();
};
const assertReader = async (before, label) => {
  const after = await page.readingAnchor();
  check(label, { before, after });
  assert.equal(after.key, before.key, `${label}: reading row`);
  assert.ok(Math.abs(after.offset - before.offset) < 3, `${label}: reading offset`);
};
try {
  fixture = await createFlowChatStreamFixture(run.workspace, protocol);
  const sessionId = 'concurrent-completion';
  const configured = await page.configureLiveSession({ url: fixture.url, sessionId, workspace: run.workspace });
  await run.identify();
  await idleWindow('before-generation');
  if (memoryDiagnostic) await captureConcurrentAllocation(run, 'before-generation');
  await measureAction('real-tools-startup', () => probe('tools-startup', beginTurn));
  await measureAction('bounded-stream-with-concurrent-input', async () => {
    await probe('first-arrival', async () => {
      fixture.begin();
      await page.until(() => fixture.emitted >= protocol.initialParagraphs + 5, 'initial output');
      await page.until(async () => (await page.streamPresentation()).characters > 0, 'visible incremental text');
    });
    const chunks = Array.from({ length: protocol.draftChunks }, (_, index) => `draft${index} `);
    const draft = chunks.join('');
    await probe('typing-during-generation', () => page.typeDraftChunks(chunks, protocol.typingIntervalMs));
    assert.equal(await page.draftText(), draft, 'Typing must retain every chunk');
    await probe('reader-scroll-during-generation', () => page.scrollTranscript(protocol.wheelDeltaY, protocol.wheelSteps));
    await delay(400);
    assert.equal((await page.scrollPosition()).following, false, 'Reader must take over from follow mode');
    const reading = await page.readingAnchor(), emittedAtHold = fixture.emitted;
    await probe('reader-hold-during-generation', async () => {
      await page.until(() => fixture.emitted >= emittedAtHold + 16, 'continued reader output');
    });
    await assertReader(reading, 'reader-hold');
    const emittedAtNavigation = fixture.emitted;
    await probe('navigation-during-generation', async () => {
      for (const [trigger, id] of [
        ['[data-testid="nav-personal-overview"]', 'personal-overview'],
        ['[data-testid="nav-todos-btn"]', 'todos'], [configured.trigger, 'session'],
      ]) {
        // Streaming/tool indicators are expected to stay busy while the user
        // returns to an interactive session. Do not wait for generation to end.
        const readyRoot = id === 'session'
          ? `${scene(id)}:has([data-flowchat-scroller]) [data-testid="chat-input-textarea"]` : scene(id);
        const result = await page.measureOpen(trigger, readyRoot);
        report.navigations.push({ id, ...result });
        assert.ok(result.milestones.contentMs !== undefined, `Missing ready content for ${id}`);
      }
    });
    assert.ok(fixture.emitted > emittedAtNavigation, 'Hidden session must continue receiving output');
    assert.equal(await page.draftText(), draft, 'Navigation must preserve the draft');
    await assertReader(reading, 'reader-after-navigation');
    for (const [name, selector, distance] of [
      ['navigation', '[data-openbitfun-part="navDivider"]', 70],
      ['content', '[data-split-divider] [role="separator"], [data-openbitfun-component="split-view"] [role="separator"]', 100],
    ]) {
      const before = await page.readingAnchor(), emittedBefore = fixture.emitted;
      await probe(`drag-${name}-during-generation`, async () => {
        const raw = await page.drag(selector, 'x', distance);
        const travelPx = Math.max(...raw.positions) - Math.min(...raw.positions);
        assert.ok(travelPx > distance, `${name} divider must actually move`);
        report.dividers.push({ name, raw, travelPx,
          frames: probeFrameDistributions({ frames: raw.frames.map(time => ({ time })) }).phase });
      });
      assert.ok(fixture.emitted > emittedBefore, 'Output must continue during resize');
      assert.equal(await page.draftText(), draft, 'Resize must preserve the draft');
      await assertReader(before, `reader-after-${name}-resize`);
    }
    assert.ok(fixture.emitted < protocol.maxParagraphs, 'Concurrent operations must occur while output is active');
    await probe('return-latest-and-finish', async () => {
      await page.click('.scroll-to-latest-bar[data-visible="true"] button');
      await page.until(() => fixture.emitted === protocol.maxParagraphs, 'bounded output finished', 90_000);
      fixture.finish();
      await page.until(() => page.execute(() => document.querySelector('[data-testid="flowchat-message-list"]')
        ?.textContent?.includes('FLOWCHAT_STREAM_COMPLETE')), 'completion text', 30_000);
      await page.until(async () => !(await page.visible('[data-testid="chat-input-cancel-btn"]')), 'completed controls');
    });
    assert.equal(await page.draftText(), draft, 'Completion must preserve the draft');
    return { emitted: fixture.emitted, tools: fixture.results.length, draftCharacters: draft.length };
  });
  await ensureTools();
  const persisted = JSON.stringify(await page.invoke('load_session_turns', {
    request: { session_id: sessionId, workspace_id: configured.workspaceId },
  }));
  for (const marker of ['Stream paragraph 0:', `Stream paragraph ${protocol.maxParagraphs - 1}:`, 'FLOWCHAT_STREAM_COMPLETE']) {
    assert.ok(persisted.includes(marker), `Persisted output missing ${marker}`);
  }
  check('bounded-output-persisted', { emitted: fixture.emitted, toolResults: fixture.results });
  await idleWindow('after-completion');
  await fixture.close();
  fixture = await createFlowChatStreamFixture(run.workspace, {
    initialParagraphs: protocol.cancelInitialParagraphs, maxParagraphs: protocol.cancelAfterParagraphs,
  });
  await page.configureLiveSession({ url: fixture.url, sessionId: 'concurrent-cancel', workspace: run.workspace });
  await run.identify();
  await measureAction('cancel-active-generation', async () => {
    await beginTurn(); fixture.begin();
    const draft = 'Draft survives cancellation.';
    await page.enterDraft(draft);
    await page.until(() => fixture.emitted >= protocol.cancelAfterParagraphs, 'cancel workload');
    const emittedBefore = fixture.emitted;
    const feedbackMs = await probe('cancel-during-generation', () => page.cancelTurn());
    await page.until(() => fixture.disconnected, 'model stream disconnect', 30_000);
    const emittedAfter = fixture.emitted;
    await delay(500);
    assert.equal(fixture.emitted, emittedAfter, 'Cancellation must stop model stream consumption');
    assert.equal(await page.draftText(), draft, 'Cancellation must retain draft');
    report.cancel = { feedbackMs, emittedBefore, emittedAfter, disconnected: fixture.disconnected };
    assert.equal(emittedAfter, protocol.cancelAfterParagraphs, 'Cancellation must have equal output work');
    return report.cancel;
  });
  await idleWindow('after-cancellation');
  report.cancelAnimationOwners = await page.animationOwners();
  await page.click('[data-testid="nav-personal-overview"]');
  report.closedTabs = await page.closeClosableTabs();
  if (memoryDiagnostic) report.closedAt = Date.now();
  await idleWindow('after-close');
  if (memoryDiagnostic) {
    for (let index = 1; index <= protocol.extendedClosedWindows; index++) {
      const window = await observeWindow(`after-close-extended-${index}`,
        () => run.idleWindow(`after-close-extended-${index}`, protocol.extendedClosedWindowMs));
      window.elapsedSinceCloseMs = Date.now() - report.closedAt;
      await run.save();
    }
    await captureConcurrentAllocation(run, 'after-close-extended');
    report.memoryWindowConditions = unfocusedWindowConditions([...report.actions, ...report.windows], {
      'real-tools-startup': 'session', 'bounded-stream-with-concurrent-input': 'session',
      'cancel-active-generation': 'session', 'before-generation': 'session',
      'after-completion': 'session', 'after-cancellation': 'session', 'after-close': 'personal-overview',
      ...Object.fromEntries(Array.from({ length: protocol.extendedClosedWindows }, (_, index) =>
        [`after-close-extended-${index + 1}`, 'personal-overview'])),
    });
    assert.ok(report.windows.find(window => window.name === 'after-cancellation').before.memory.roots.observed > 0,
      'Observe a real transcript before checking its detached lifetime');
  }
  for (const window of [...report.actions, ...report.windows]) {
    assert.equal(window.before.monacoEditors, 0, 'No editor in concurrent workload');
    assert.equal(window.after.monacoEditors, 0, 'No editor in concurrent workload');
  }
  report.functionalPassed = true;
  report.performanceGates = report.interactions.map(row => ({ name: row.name,
    frameP95Passed: row.frames.phase.p95Ms < protocol.budgets.frameP95Ms,
    frameMaxPassed: row.frames.phase.maxMs < protocol.budgets.frameMaxMs,
    inputPassed: row.inputRaf ? row.inputRaf.p95Ms <= protocol.budgets.inputRafP95Ms : null }));
  report.navigationGates = report.navigations.map(row => ({ id: row.id,
    feedbackPassed: row.milestones.visibleMs <= protocol.budgets.feedbackP95Ms,
    contentPassed: row.milestones.contentMs <= protocol.budgets.contentP95Ms }));
  report.performanceBudgetsPassed = report.performanceGates.every(row => row.frameP95Passed && row.frameMaxPassed && row.inputPassed !== false)
    && report.navigationGates.every(row => row.feedbackPassed && row.contentPassed)
    && report.cancel.feedbackMs <= protocol.budgets.feedbackP95Ms;
  report.passed = report.functionalPassed && report.performanceBudgetsPassed;
  console.log(JSON.stringify({ functionalPassed: report.functionalPassed, performanceBudgetsPassed: report.performanceBudgetsPassed }));
} catch (error) {
  report.failure = error.stack || String(error);
  console.error(report.failure);
  try {
    await writeFile(path.join(run.root, 'failure.png'), Buffer.from(await page.request(`/session/${page.session}/screenshot`), 'base64'));
  } catch (screenshotError) { report.screenshotError = String(screenshotError); }
  process.exitCode = 1;
} finally {
  report.fixtureErrors = fixture?.errors;
  await page.stopWindowStateProbe().catch(() => undefined);
  await fixture?.close(); await run.close();
}
