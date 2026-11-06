/** Native scene-only comparison: no file editor, immutable assets and attributed resources. */
import assert from 'node:assert/strict';
import { openNativeWorkload, delay } from './native-workload-session.mjs';
import { SceneVisibilityPage } from '../page-objects/SceneVisibilityPage.mjs';
import { captureHomeVisuals } from './workbench-performance-visuals.mjs';
import { assertResourceMotion, sceneWindowConditions } from './workbench-performance-metrics.mjs';

const protocol = { name: 'native-scene-visibility', version: 2, prewarmMs: 15000, settleMs: 5000, sampleMs: 2000,
  input: 'native-eval-PointerEvent-and-MouseEvent-sequence', timingStart: 'capture-pointerdown',
  cycles: Number(process.env.OPENBITFUN_SCENE_CYCLES || 30),
  idleMs: Number(process.env.OPENBITFUN_SCENE_IDLE_MS || 30000),
  sequence: ['personal-overview', 'session'], editorOpened: false,
  budgets: { feedbackP95Ms: 100, contentP95Ms: 150 }, visualGuardsOutsideWindows: true };
for (const key of ['cycles', 'idleMs']) assert.ok(Number.isInteger(protocol[key]) && protocol[key] > 0);
const run = await openNativeWorkload({ Page: SceneVisibilityPage, protocol,
  label: process.env.OPENBITFUN_SCENE_LABEL || 'scene-visibility', evidence: process.env.OPENBITFUN_SCENE_EVIDENCE,
  harnessFiles: ['tests/e2e/scripts/run-scene-visibility.mjs', 'tests/e2e/page-objects/SceneVisibilityPage.mjs',
    'tests/e2e/scripts/workbench-performance-visuals.mjs', 'tests/e2e/scripts/workbench-performance-metrics.mjs'] });
const { page, report } = run;
const home = '[data-testid="nav-personal-overview"]';
const session = '[data-testid="nav-session-item"][data-session-id="workload-history-000"]';
const todos = '[data-testid="nav-todos-btn"]';
const root = id => `[data-testid="scene-viewport-scene"][data-scene-id="${id}"][data-scene-active="true"]`;
const draft = 'Scene visibility preserves this draft and the historical reading row.';
report.navigations = []; report.hiddenGuards = []; report.transitions = [];
report.coverage.pilot = protocol.cycles < 30 || protocol.idleMs < 30000;
const guard = async name => {
  const rows = await page.hiddenSceneGuards();
  report.hiddenGuards.push({ name, rows });
  assert.ok(rows.length > 0, 'Exercise a retained hidden scene');
  for (const row of rows) {
    assert.ok(row.inert && row.ariaHidden === 'true', `Hidden ${row.id} must retain accessibility isolation`);
    assert.ok(row.opacity === '0' && row.pointerEvents === 'none' && row.contentVisibility === 'hidden');
    assert.ok(!row.focused && !row.hit && !row.descendantVisible, `Hidden ${row.id} must not receive focus or pointer hits`);
  }
};
try {
  await page.click(session);
  await page.until(() => page.visible('[data-flowchat-scroller]'), 'historical conversation');
  await page.until(() => page.execute(() => !document.querySelector('.history-session-loading:not([data-history-loading-phase="idle"])')), 'history ready');
  await page.enterDraft(draft);
  await page.scrollHistory(); await delay(500);
  report.readingBefore = await page.readingAnchor();
  assert.ok(report.readingBefore.key);
  for (const [trigger, id] of [[home, 'personal-overview'], [todos, 'todos'], [session, 'session']]) {
    await page.measureOpen(trigger, root(id));
  }
  await run.identify();
  await run.measureAction('home-history-navigation', async () => {
    for (let cycle = 0; cycle < protocol.cycles; cycle++) {
      for (const [trigger, id] of [[home, 'personal-overview'], [session, 'session']]) {
        report.navigations.push({ cycle, id, ...await page.measureOpen(trigger, root(id)) });
      }
      if ((cycle + 1) % 10 === 0) { await run.save(); console.log(`Navigation cycles ${cycle + 1}/${protocol.cycles}`); }
    }
  });
  report.windowConditions = sceneWindowConditions(report.actions);
  for (const [name, trigger] of [
    ['home-active', home],
    ['todos-static', todos],
    ['home-return', home],
  ]) {
    await page.click(trigger);
    await run.idleWindow(name, protocol.idleMs);
    report.windowConditions.push(...sceneWindowConditions([report.windows.at(-1)]));
  }
  assertResourceMotion({ protocol, resourceWindows: report.windows });
  await guard('home-active');
  report.motionSignature = await page.motionSignature();
  report.homeVisuals = await captureHomeVisuals(page, run.root);
  for (const [trigger, id] of [[session, 'session'], [home, 'personal-overview']]) {
    const frames = await page.transitionFrames(trigger);
    report.transitions.push({ id, frames });
    assert.ok(frames.length > 1 && frames.every(frame => frame.scenes.some(scene => scene.visible && scene.opacity > 0)), 'Scene transition must keep content drawn');
    assert.ok(frames.some(frame => frame.scenes.some(scene => scene.incoming && scene.opacity > 0 && scene.opacity < 1)), 'Exercise the existing incoming fade');
    assert.ok(frames.some(frame => frame.scenes.some(scene => scene.incoming && scene.transitionDuration === '0.48s')), 'Retain the authored entry duration');
    assert.ok(frames.flatMap(frame => frame.scenes).filter(scene => scene.outgoing)
      .every(scene => scene.inert && scene.ariaHidden === 'true'), 'Outgoing scene remains inert');
    assert.deepEqual(frames.at(-1).scenes.filter(scene => scene.visible).map(scene => scene.id), [id]);
    await guard(id);
  }
  await page.click(session); await delay(600);
  report.readingAfter = await page.readingAnchor();
  assert.equal(report.readingAfter.key, report.readingBefore.key);
  assert.ok(Math.abs(report.readingAfter.offset - report.readingBefore.offset) <= 8, 'Retain reading offset');
  report.final = await page.residencySnapshot();
  assert.equal(report.final.draft, draft);
  assert.equal(report.final.monacoEditors, 0, 'This workload must not open the file editor');
  report.functionalPassed = true;
  report.performanceGates = protocol.sequence.flatMap(id => {
    const rows = report.navigations.filter(row => row.id === id);
    return [['visibleMs', 'feedbackP95Ms'], ['contentMs', 'contentP95Ms']].map(([metric, budget]) => {
      const values = rows.map(row => row.milestones[metric]).sort((a, b) => a - b);
      assert.ok(values.every(Number.isFinite));
      const measured = values[Math.ceil(values.length * .95) - 1];
      return { id, metric, count: values.length, measured, budget: protocol.budgets[budget], passed: measured <= protocol.budgets[budget] };
    });
  });
  report.performanceBudgetsPassed = report.performanceGates.every(gate => gate.passed);
  report.passed = report.functionalPassed && report.performanceBudgetsPassed;
  console.log(`Scene workload completed: functional=${report.functionalPassed}, budgets=${report.performanceBudgetsPassed}`);
} catch (error) {
  report.failure = error.stack || String(error); console.error(report.failure); process.exitCode = 1;
} finally { await run.close(); }
