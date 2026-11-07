/** Selected synchronous product work, without native sampling or geometry wrappers. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { openNativeWorkload } from './native-workload-session.mjs';
import { ConcurrentWorkloadPage } from '../page-objects/ConcurrentWorkloadPage.mjs';
import { createFlowChatStreamFixture } from '../helpers/flowchat-stream-fixture.ts';
import { startSyncWorkProbe, stopSyncWorkProbe } from './sync-work-diagnostic.mjs';
import { probeFrameDistributions } from '../helpers/flowchat-frame-metrics.ts';

const protocol = { name: 'native-sync-work-diagnostic', version: 1, prewarmMs: 15000,
  settleMs: 5000, sampleMs: 2000, cycles: 3, initialParagraphs: 80, maxParagraphs: 120,
  intervalMs: 90, editorOpened: false, secondaryPane: 'empty-canvas', diagnosticOnly: true,
  nativeStackSampling: false, geometryWrappers: false, functionProbe: 'selected-sync-functions-and-effects' };
const run = await openNativeWorkload({ Page: ConcurrentWorkloadPage, protocol, label: 'sync-work-diagnostic',
  evidence: process.env.OPENBITFUN_SYNC_DIAGNOSTIC_EVIDENCE,
  harnessFiles: ['tests/e2e/scripts/run-sync-work-diagnostic.mjs', 'tests/e2e/scripts/sync-work-diagnostic.mjs',
    'tests/e2e/scripts/build-sync-work-diagnostic.mjs', 'tests/e2e/page-objects/ConcurrentWorkloadPage.mjs',
    'tests/e2e/page-objects/SceneVisibilityPage.mjs', 'tests/e2e/helpers/flowchat-stream-fixture.ts',
    'tests/e2e/helpers/flowchat-frame-metrics.ts'] });
const { page, report } = run;
report.coverage.instrumented = true; report.coverage.realAgent = true; report.coverage.loopbackModel = true;
report.limitations.push('Diagnostic-only build adds synchronous clocks; these results are not A/B performance acceptance.',
  'Only selected synchronous functions and effects are timed. React internals and browser work outside those calls remain unattributed.',
  'Inclusive times overlap; self times subtract only instrumented descendants. Native timers may have coarse resolution.',
  'Three documents share process age and caches. Tools and model fixture are local; remote or provider performance is not established.');
report.cycles = [];
let fixture;
const observe = async (name, action) => {
  await startSyncWorkProbe(page); await page.startInteractionProbe();
  const measurement = { name };
  try { await run.measureAction(name, action); }
  finally {
    const frames = await page.stopInteractionProbe();
    measurement.work = await stopSyncWorkProbe(page);
    measurement.frames = probeFrameDistributions({ frames: frames.frames.map(time => ({ time })), wheelTimes: frames.wheelTimes });
  }
  assert.equal(measurement.work.mismatchCount, 0, 'Synchronous timing stack must balance');
  assert.equal(measurement.work.stackDepth, 0, 'No timed call may escape the measurement');
  assert.ok(measurement.work.groups.length > 0, 'The instrumented product must actually execute');
  return measurement;
};
try {
  report.instrumentation = JSON.parse(await readFile(path.join(run.root, 'frontend/sync-work-instrumentation.json'), 'utf8'));
  for (let cycle = 0; cycle < protocol.cycles; cycle++) {
    fixture = await createFlowChatStreamFixture(run.workspace, protocol);
    const sessionId = `sync-work-${cycle}`;
    const configured = await page.configureLiveSession({ url: fixture.url, sessionId, workspace: run.workspace });
    await run.identify();
    const result = { cycle, phases: [] }; report.cycles.push(result);
    result.phases.push(await observe(`tools-${cycle}`, async () => {
      await page.enterDraft('FLOWCHAT_PERF_STREAM');
      await page.click('[data-testid="chat-input-send-btn"]');
      await page.until(() => fixture.textReady || fixture.errors.length, 'real tool results', 60000);
      assert.deepEqual(fixture.errors, []); assert.equal(fixture.results.length, 8);
      assert.ok(fixture.results.every(tool => !tool.is_error));
      await page.execute(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }));
    assert.ok(result.phases[0].work.groups.some(group => group.label.endsWith(':processToolEvent')), 'Observe real event processing');
    assert.ok(result.phases[0].work.groups.some(group => group.label.endsWith(':projectSessionItems')), 'Observe real timeline projection');
    for (let index = 0; index < 4; index++) {
      assert.ok((await readFile(path.join(run.workspace, `flowchat-live-${index}.ts`), 'utf8')).includes('value = 1'));
    }
    result.phases.push(await observe(`output-${cycle}`, async () => {
      fixture.begin();
      await page.until(() => fixture.emitted === protocol.maxParagraphs, 'bounded output'); fixture.finish();
      await page.until(async () => !(await page.visible('[data-testid="chat-input-cancel-btn"]')), 'completed generation');
      await page.execute(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }));
    const persisted = JSON.stringify(await page.invoke('load_session_turns', {
      request: { session_id: sessionId, workspace_id: configured.workspaceId },
    }));
    for (const marker of ['Stream paragraph 0:', `Stream paragraph ${protocol.maxParagraphs - 1}:`, 'FLOWCHAT_STREAM_COMPLETE']) {
      assert.ok(persisted.includes(marker));
    }
    await page.enterDraft(`Retained sync diagnostic draft ${cycle}`);
    result.final = await page.residencySnapshot();
    assert.equal(result.final.monacoEditors, 0); assert.equal(result.final.draft, `Retained sync diagnostic draft ${cycle}`);
    result.tools = fixture.results; result.emitted = fixture.emitted;
    await fixture.close(); fixture = undefined; await run.save();
    console.log(`Synchronous work diagnostic cycle ${cycle + 1}/${protocol.cycles} completed`);
  }
  report.functionalPassed = true; report.passed = true;
} catch (error) {
  report.failure = error.stack || String(error); console.error(report.failure); process.exitCode = 1;
} finally {
  await page.stopInteractionProbe().catch(() => undefined);
  await stopSyncWorkProbe(page).catch(() => undefined);
  await fixture?.close(); await run.close();
}
