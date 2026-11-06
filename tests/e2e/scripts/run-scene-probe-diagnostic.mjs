/** Same product/interaction, with and without repeated presentation queries. */
import assert from 'node:assert/strict';
import { openNativeWorkload, delay } from './native-workload-session.mjs';
import { SceneProbeDiagnosticPage } from '../page-objects/SceneProbeDiagnosticPage.mjs';

const protocol = { name: 'native-scene-observer-calibration', version: 1, prewarmMs: 15000,
  sampleMs: 2000, cyclesPerPhase: 8, phases: ['full', 'frame-only', 'full-restored'],
  editorOpened: false, diagnosticOnly: true, layoutReadDiagnostic: true,
  input: 'native-eval-PointerEvent-and-MouseEvent-sequence', timingStart: 'capture-pointerdown' };
const run = await openNativeWorkload({ Page: SceneProbeDiagnosticPage, protocol,
  label: 'scene-observer-calibration', evidence: process.env.OPENBITFUN_SCENE_PROBE_EVIDENCE,
  harnessFiles: ['tests/e2e/scripts/run-scene-probe-diagnostic.mjs',
    'tests/e2e/page-objects/SceneProbeDiagnosticPage.mjs', 'tests/e2e/page-objects/SceneDiagnosticPage.mjs',
    'tests/e2e/page-objects/LayoutReadDiagnosticPage.mjs', 'tests/e2e/page-objects/SceneVisibilityPage.mjs'] });
const { page, report } = run;
report.phases = []; report.coverage.instrumented = true; report.coverage.pilot = true;
report.limitations.push('Frame-only observations do not measure feedback or content latency and cannot pass those budgets.',
  'Getter wrappers add overhead. Their inclusive elapsed time can include pending product layout; it is not pure observer CPU.',
  'Sequential phases share process age and caches. This calibrates observation, not a product optimization.');
const session = '[data-testid="nav-session-item"][data-session-id="workload-history-000"]';
const destinations = [['[data-testid="nav-personal-overview"]', 'personal-overview'], [session, 'session']];
const root = id => `[data-testid="scene-viewport-scene"][data-scene-id="${id}"][data-scene-active="true"]`;
const draft = 'Observation calibration retains this draft and reading position.';
try {
  await page.click(session);
  await page.until(() => page.visible('[data-flowchat-scroller]'), 'retained conversation');
  await page.until(() => page.execute(() => !document.querySelector('.history-session-loading:not([data-history-loading-phase="idle"])')), 'history ready');
  await page.enterDraft(draft); await page.scrollHistory(); await delay(500);
  report.readingBefore = await page.readingAnchor();
  await page.measureOpen('[data-testid="nav-todos-btn"]', root('todos'));
  for (const [trigger, id] of destinations) await page.measureOpen(trigger, root(id));
  await run.identify();
  for (const name of protocol.phases) {
    const phase = { name, navigations: [] }; report.phases.push(phase);
    await delay(1000);
    await page.startLayoutReads();
    try {
      await run.measureAction(name, async () => {
        for (let cycle = 0; cycle < protocol.cyclesPerPhase; cycle++) {
          for (const [trigger, id] of destinations) {
            const observation = name === 'frame-only'
              ? await page.measureFrameOnlyOpen(trigger, root(id)) : await page.measureOpen(trigger, root(id));
            if (name === 'frame-only') assert.equal(observation.ready, true, 'Reach the requested settled scene');
            else assert.ok(Number.isFinite(observation.milestones.contentMs));
            phase.navigations.push({ cycle, id, ...observation });
          }
        }
      });
    } finally { phase.layoutReads = await page.stopLayoutReads(); }
    await run.save(); console.log(`Observer calibration phase ${name} completed`);
  }
  report.final = await page.residencySnapshot();
  report.readingAfter = await page.readingAnchor();
  assert.equal(report.final.monacoEditors, 0);
  assert.equal(report.final.draft, draft);
  assert.equal(report.readingAfter.key, report.readingBefore.key);
  assert.ok(Math.abs(report.readingAfter.offset - report.readingBefore.offset) <= 8);
  report.functionalPassed = true; report.passed = true;
} catch (error) {
  report.failure = error.stack || String(error); console.error(report.failure); process.exitCode = 1;
} finally { await run.close(); }
