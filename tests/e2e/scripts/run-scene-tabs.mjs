/** Native tab overflow/navigation regression, separate from performance sampling. */
import assert from 'node:assert/strict';
import { openNativeWorkload, delay } from './native-workload-session.mjs';
import { SceneTabsPage } from '../page-objects/SceneTabsPage.mjs';

const protocol = { name: 'native-scene-tab-navigation', version: 4, prewarmMs: 15000,
  functionalOnly: true, editorOpened: false, input: 'native-eval-PointerEvent-and-MouseEvent-sequence',
  keyboard: 'DOM-KeyboardEvent-through-real-TabGroup', narrowPhysicalWidth: 1800, fixturePinsBeforeOpening: true,
  explicitScenes: ['personal-overview', 'todos', 'agents', 'assistant', 'skills', 'insights', 'session'],
  closeAndReopenScene: 'insights' };
const run = await openNativeWorkload({ Page: SceneTabsPage, protocol, label: 'scene-tabs',
  evidence: process.env.OPENBITFUN_SCENE_TABS_EVIDENCE,
  harnessFiles: ['tests/e2e/scripts/run-scene-tabs.mjs', 'tests/e2e/page-objects/SceneTabsPage.mjs',
    'tests/e2e/page-objects/SceneVisibilityPage.mjs'] });
const { page, report } = run;
const snapshot = async name => {
  const value = await page.tabsSnapshot(); report.checks.push({ name, ...value }); await run.save(); return value;
};
const assertSelectedVisible = snapshot => {
  const selected = snapshot.tabs.filter(tab => tab.selected);
  assert.equal(selected.length, 1);
  assert.ok(selected[0].left >= -2 && selected[0].right <= snapshot.width + 2,
    `Selected tab must be within the scroll viewport: ${JSON.stringify(snapshot)}`);
  return selected[0];
};
let original;
try {
  original = await page.request(`/session/${page.session}/window/rect`);
  await page.prepareNavigation();
  for (const [selector, id] of [
    ['[data-testid="nav-personal-overview"]', 'personal-overview'],
    ['[data-testid="nav-todos-btn"]', 'todos'],
    ['[data-testid="nav-builtin.agents"]', 'agents'],
    ['[data-testid="nav-builtin.assistants"]', 'assistant'],
    ['[data-testid="nav-builtin.skills.installed"]', 'skills'],
    ['[data-testid="nav-builtin.insights"]', 'insights'],
    ['[data-testid="nav-session-item"][data-session-id="workload-history-000"]', 'session'],
  ]) {
    await page.click(selector);
    await page.until(() => page.visible(`[data-testid="scene-viewport-scene"][data-scene-id="${id}"][data-scene-active="true"]`), id);
    await delay(600);
  }
  await page.enterDraft('Tab overflow must preserve this draft.');
  await page.request(`/session/${page.session}/window/rect`, { ...original, width: protocol.narrowPhysicalWidth });
  await delay(700);
  const crowded = await snapshot('overflow');
  assert.ok(crowded.tabs.length >= 7 && crowded.extent > crowded.width + 50, 'Exercise real overflow');
  await page.pressTabKey('Home'); await delay(650);
  const first = await snapshot('keyboard-home');
  assert.equal(assertSelectedVisible(first).id, first.tabs[0].id);
  assert.ok(first.tabs[0].focused);

  report.pointerFrames = await page.traceScroll(() => page.click('[data-testid="nav-builtin.insights"]'));
  const pointer = await snapshot('pointer-last');
  assert.equal(assertSelectedVisible(pointer).id, 'insights');
  assert.ok(new Set(report.pointerFrames.map(frame => Math.round(frame.left))).size >= 3, 'Retain smooth pointer reveal');

  await page.pressTabKey('Home'); await delay(650);
  report.keyboardFrames = await page.traceScroll(() => page.pressTabKey('End'));
  const last = await snapshot('keyboard-end');
  assert.equal(assertSelectedVisible(last).id, last.tabs.at(-1).id);
  assert.ok(last.tabs.at(-1).focused);

  await page.pressTabKey('Home'); await delay(650);
  const beforeWheel = await snapshot('before-wheel');
  await page.wheelTabs(32); await delay(650);
  const wheeled = await snapshot('after-wheel');
  assert.ok(wheeled.left > beforeWheel.left + 10, 'Vertical wheel scrolls the tab strip');
  assert.equal(wheeled.tabs.find(tab => tab.selected).id, beforeWheel.tabs.find(tab => tab.selected).id);

  await page.click('[data-openbitfun-component="scene-bar"] [data-openbitfun-part="scrollNext"]');
  await delay(650); const paged = await snapshot('page-forward');
  assert.ok(paged.left > wheeled.left + 10, 'Page control advances the strip');
  await page.click('[data-openbitfun-component="scene-bar"] [data-openbitfun-part="scrollPrevious"]');
  await delay(650); const back = await snapshot('page-back');
  assert.ok(back.left < paged.left - 10, 'Page control returns the strip');
  await page.pressTabKey('End'); await delay(650);
  assertSelectedVisible(await snapshot('reselected-last'));
  await page.request(`/session/${page.session}/window/rect`, original); await delay(700);
  assertSelectedVisible(await snapshot('restored-width'));
  await page.pressTabKey('End');
  await page.pressTabKey('Delete');
  await page.until(() => page.execute(() => !document.querySelector(
    '[data-testid="scene-viewport-scene"][data-scene-id="insights"]')), 'closed scene unmounted');
  const closed = await snapshot('closed-insights');
  assert.ok(!closed.tabs.some(tab => tab.id === 'insights'));
  await page.click('[data-testid="nav-builtin.insights"]');
  await page.until(() => page.visible('[data-testid="scene-viewport-scene"][data-scene-id="insights"][data-scene-active="true"]'), 'reopened scene visible');
  await delay(650);
  assert.equal(assertSelectedVisible(await snapshot('reopened-insights')).id, 'insights');
  report.final = await page.residencySnapshot();
  assert.equal(report.final.monacoEditors, 0);
  assert.equal(report.final.draft, 'Tab overflow must preserve this draft.');
  report.functionalPassed = true; report.passed = true;
  console.log('Native scene tab navigation checks passed');
} catch (error) {
  report.failureSnapshot = await page.tabsSnapshot().catch(() => null);
  report.failure = error.stack || String(error); console.error(report.failure); process.exitCode = 1;
} finally {
  if (original) await page.request(`/session/${page.session}/window/rect`, original).catch(() => undefined);
  await run.close();
}
