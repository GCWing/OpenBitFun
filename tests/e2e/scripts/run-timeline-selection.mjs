/** Native selection residency regression; no performance acceptance or file editor. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openNativeWorkload, delay } from './native-workload-session.mjs';
import { TimelineSelectionPage } from '../page-objects/TimelineSelectionPage.mjs';

const protocol = { name: 'native-timeline-selection', version: 1, prewarmMs: 15000,
  editorOpened: false, nativeSelectionEvents: true, wheelDelta: -10000, functionalOnly: true };
const run = await openNativeWorkload({ Page: TimelineSelectionPage, protocol, label: 'timeline-selection',
  evidence: process.env.OPENBITFUN_SELECTION_EVIDENCE,
  harnessFiles: ['tests/e2e/scripts/run-timeline-selection.mjs', 'tests/e2e/page-objects/TimelineSelectionPage.mjs',
    'tests/e2e/page-objects/SceneVisibilityPage.mjs'] });
const { page, report } = run;
const digest = value => createHash('sha256').update(value).digest('hex');
const record = async name => {
  const snapshot = await page.selectionSnapshot();
  report.checks.push({ name, ...snapshot, text: undefined, textLength: snapshot.text.length, textDigest: digest(snapshot.text) });
  await run.save(); return snapshot;
};
report.limitations.push('DOM Range selection is API-generated; OS drag selection, system clipboard and remote input are not exercised.');
try {
  await page.click('[data-testid="nav-session-item"][data-session-id="workload-history-000"]');
  await page.until(() => page.visible('[data-flowchat-scroller]'), 'historical conversation');
  await page.until(() => page.execute(() => !document.querySelector('.history-session-loading:not([data-history-loading-phase="idle"])')), 'history ready');
  const draft = 'Draft retained during native text selection regression.';
  await page.enterDraft(draft); await page.scrollHistory(); await delay(700);
  const selected = await page.selectRows(); await delay(250);
  const before = await record('selected-two-rows');
  assert.equal(before.text, selected.text); assert.ok(before.text.length >= 48);
  await page.scrollSelection(protocol.wheelDelta); await delay(700);
  const retained = await record('selected-after-recycling');
  assert.ok(Math.abs(retained.scrollTop - before.scrollTop) > 1000, 'Exercise a changed virtual window');
  assert.equal(retained.text, selected.text);
  assert.ok(retained.anchorConnected && retained.focusConnected);
  assert.ok(selected.keys.every(key => retained.keys.includes(key)), 'Keep selected endpoints mounted');

  const outside = await page.selectOutside(); await delay(300);
  assert.ok(outside.length > 0);
  assert.equal((await record('moved-selection-outside')).text, outside);
  await page.scrollSelection(protocol.wheelDelta); await delay(700);
  const released = await record('released-after-external-selection');
  assert.ok(selected.keys.some(key => !released.keys.includes(key)), 'Release old selection leases');

  report.crossing = await page.selectAcrossScroller(); await delay(250);
  assert.ok(report.crossing.textLength > 0 && report.crossing.anchorOutside && report.crossing.focusOutside && report.crossing.intersects);
  const crossing = await record('crossing-with-both-endpoints-outside');
  assert.ok(crossing.anchorConnected && crossing.focusConnected && !crossing.collapsed);
  await page.clearSelection(); await delay(250);
  assert.equal((await record('cleared')).text, '');
  report.final = await page.residencySnapshot();
  assert.equal(report.final.draft, draft); assert.equal(report.final.monacoEditors, 0);
  report.functionalPassed = true; report.passed = true;
  console.log('Native timeline selection checks passed');
} catch (error) {
  report.failure = error.stack || String(error); console.error(report.failure); process.exitCode = 1;
} finally { await run.close(); }
