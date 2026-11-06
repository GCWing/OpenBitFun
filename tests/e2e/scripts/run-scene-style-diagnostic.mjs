/** Reversible CSS ablation: isolate matching cost, never accept changed UX. */
import assert from 'node:assert/strict';
import { openNativeWorkload, delay } from './native-workload-session.mjs';
import { SceneStyleDiagnosticPage } from '../page-objects/SceneStyleDiagnosticPage.mjs';

const protocol = { name: 'native-scene-style-diagnostic', version: 4, prewarmMs: 15000,
  sampleMs: 2000, cyclesPerPhase: 8, phases: ['original', 'suspended', 'restored'],
  mode: process.env.OPENBITFUN_STYLE_DIAGNOSTIC_MODE || 'scrollbars',
  focusOnly: process.env.OPENBITFUN_STYLE_DIAGNOSTIC_FOCUS_ONLY === '1',
  diagnosticOnly: true, layoutReadDiagnostic: true, editorOpened: false,
  input: 'native-eval-PointerEvent-and-MouseEvent-sequence', timingStart: 'capture-pointerdown' };
assert.ok(['scrollbars', 'session-display', 'session-inert'].includes(protocol.mode), 'Select a supported style diagnostic');
assert.ok(protocol.mode === 'scrollbars' || !protocol.focusOnly, 'Focus filtering applies only to scrollbar diagnostics');
const run = await openNativeWorkload({ Page: SceneStyleDiagnosticPage, protocol,
  label: 'scene-style-diagnostic', evidence: process.env.OPENBITFUN_STYLE_DIAGNOSTIC_EVIDENCE,
  harnessFiles: ['tests/e2e/scripts/run-scene-style-diagnostic.mjs',
    'tests/e2e/page-objects/SceneStyleDiagnosticPage.mjs', 'tests/e2e/page-objects/SceneDiagnosticPage.mjs',
    'tests/e2e/page-objects/LayoutReadDiagnosticPage.mjs', 'tests/e2e/page-objects/SceneVisibilityPage.mjs'] });
const { page, report } = run;
report.coverage.instrumented = true; report.coverage.pilot = true;
report.limitations.push('Style rules are temporarily changed in an isolated diagnostic; changed presentation or hidden layout semantics are not an accepted product optimization.',
  'Sequential phases share caches and process age; differences localize possible cost, not stable production gains.');
if (protocol.mode === 'session-inert') report.limitations.push(
  'The isolated diagnostic suppresses only the retained session root inert attribute writes. It deliberately changes interaction isolation and is never an accepted product change.');
report.phases = [];
const session = '[data-testid="nav-session-item"][data-session-id="workload-history-000"]';
const destinations = [['[data-testid="nav-personal-overview"]', 'personal-overview'], [session, 'session']];
const root = id => `[data-testid="scene-viewport-scene"][data-scene-id="${id}"][data-scene-active="true"]`;
const draft = 'CSS diagnostics retain this draft and the reading position.';
try {
  await page.click(session);
  await page.until(() => page.visible('[data-flowchat-scroller]'), 'historical conversation');
  await page.until(() => page.execute(() => !document.querySelector('.history-session-loading:not([data-history-loading-phase="idle"])')), 'history ready');
  await page.enterDraft(draft); await page.scrollHistory(); await delay(500);
  report.readingBefore = await page.readingAnchor();
  await page.measureOpen('[data-testid="nav-todos-btn"]', root('todos'));
  for (const [trigger, id] of destinations) await page.measureOpen(trigger, root(id));
  await run.identify();
  for (const name of protocol.phases) {
    const phase = { name, navigations: [] }; report.phases.push(phase);
    if (name === 'suspended') {
      if (protocol.mode !== 'scrollbars') {
        phase.styles = protocol.mode === 'session-display'
          ? await page.suspendHiddenSessionLayout() : await page.suspendSessionInertness();
        assert.equal(phase.styles.mode, protocol.mode);
      } else {
        phase.styles = await page.suspendSharedScrollbarRules(protocol.focusOnly);
        assert.equal(phase.styles.focusOnly, protocol.focusOnly, 'Apply the requested diagnostic scope');
        assert.ok(phase.styles.removed.length > 0, 'Exercise actual shared scrollbar rules');
        assert.equal(phase.styles.inaccessible.length, 0, 'Inspect all loaded stylesheets');
      }
    } else if (name === 'restored') {
      phase.restoration = await page.restoreSharedScrollbarRules();
      assert.equal(phase.restoration.exact, true, 'Restore exact CSSOM text');
    }
    await delay(1000);
    if (protocol.mode !== 'scrollbars') {
      await page.measureOpen(destinations[0][0], root(destinations[0][1]));
      phase.hiddenLayout = await page.sessionLayoutState();
      assert.equal(phase.hiddenLayout.visible, false);
      assert.equal(phase.hiddenLayout.ariaHidden, 'true');
      assert.equal(phase.hiddenLayout.inert, !(protocol.mode === 'session-inert' && name === 'suspended'));
      assert.equal(phase.hiddenLayout.display, protocol.mode === 'session-display' && name === 'suspended' ? 'none' : 'flex');
      if (protocol.mode === 'session-display' && name === 'suspended') assert.equal(phase.hiddenLayout.scrollerHeight, 0);
      else assert.ok(phase.hiddenLayout.scrollerHeight > 0);
      await page.measureOpen(session, root('session'));
    }
    phase.geometry = await page.styleGeometry();
    if (protocol.focusOnly || protocol.mode !== 'scrollbars') assert.deepEqual(phase.geometry, report.phases[0].geometry,
      'The active scroller and tab viewport geometry must remain equivalent');
    await page.startLayoutReads();
    try {
      await run.measureAction(name, async () => {
        for (let cycle = 0; cycle < protocol.cyclesPerPhase; cycle++) {
          for (const [trigger, id] of destinations) phase.navigations.push({ cycle, id,
            ...await page.measureOpen(trigger, root(id)) });
        }
      });
    } finally { phase.layoutReads = await page.stopLayoutReads(); }
    await run.save(); console.log(`Style diagnostic phase ${name} completed`);
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
} finally {
  report.finalRestoration = await page.restoreSharedScrollbarRules().catch(error => ({ error: String(error) }));
  await run.close();
}
