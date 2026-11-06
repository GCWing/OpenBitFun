/** Quantify the measurement bridge itself on a static product page. */
import assert from 'node:assert/strict';
import { openNativeWorkload } from './native-workload-session.mjs';
import { ConcurrentMemoryPage } from '../page-objects/ConcurrentMemoryPage.mjs';
import { captureConcurrentAllocation } from './concurrent-memory-diagnostic.mjs';
import { unfocusedWindowConditions } from './workbench-performance-metrics.mjs';

const mode = process.env.OPENBITFUN_EVALUATION_MODE || 'requests';
assert.ok(['requests', 'fixed-requests', 'in-page'].includes(mode));
const protocol = { name: 'native-webdriver-evaluation-diagnostic', version: 1, diagnosticOnly: true,
  prewarmMs: 15000, settleMs: 5000, sampleMs: 2000, mode, operations: 400,
  idleMs: 30000, extendedIdleMs: 60000, activeScene: 'todos', forcedGC: false,
  editorOpened: false, nativeAllocationOutsideWindows: true };
const run = await openNativeWorkload({ Page: ConcurrentMemoryPage, protocol, label: `evaluation-${mode}`,
  evidence: process.env.OPENBITFUN_EVALUATION_EVIDENCE,
  harnessFiles: ['tests/e2e/scripts/run-webdriver-evaluation-diagnostic.mjs',
    'tests/e2e/scripts/concurrent-memory-diagnostic.mjs', 'tests/e2e/page-objects/ConcurrentMemoryPage.mjs',
    'tests/e2e/page-objects/ConcurrentWorkloadPage.mjs', 'tests/e2e/page-objects/SceneVisibilityPage.mjs',
    'tests/e2e/scripts/workbench-performance-metrics.mjs'] });
const { page, report } = run;
report.coverage.instrumented = true; report.coverage.pilot = true;
report.memoryAllocations = [];
report.limitations.push('This is a bridge-cost control on a static real page, not a product interaction or frontend optimization benchmark.',
  'The modes intentionally differ in bridge crossings; do not call their difference a product optimization gain.',
  'Native allocation reads can alter residency. No GC, application cache eviction or runtime reconfiguration is forced.');
const observe = async (name, action) => {
  await page.waitForUnfocusedWindow(); await page.startWindowStateProbe();
  let window;
  try { window = await action(); return window; }
  finally {
    const states = await page.stopWindowStateProbe();
    const recorded = window ?? [...report.actions, ...report.windows].findLast(row => row.name === name);
    if (recorded) recorded.windowState = states;
    await run.save();
  }
};
try {
  await page.click('[data-testid="nav-todos-btn"]');
  await page.until(() => page.visible('[data-testid="scene-viewport-scene"][data-scene-id="todos"][data-scene-active="true"]'), 'static todos scene');
  await observe('before-bridge', () => run.idleWindow('before-bridge', protocol.idleMs));
  await captureConcurrentAllocation(run, 'before-bridge');
  report.callMs = [];
  await observe('bridge-work', () => run.measureAction('bridge-work', async () => {
    let checksum = 0;
    if (mode !== 'in-page') {
      for (let index = 0; index < protocol.operations; index++) {
        const value = mode === 'fixed-requests' ? 0 : index;
        const start = performance.now();
        const result = await page.execute(value => ({ echo: value, checksum: value * 7 }), value);
        report.callMs.push(performance.now() - start);
        assert.deepEqual(result, { echo: value, checksum: value * 7 });
        checksum += result.checksum;
      }
    } else {
      const result = await page.execute(count => {
        const operation = value => ({ echo: value, checksum: value * 7 });
        let checksum = 0;
        for (let index = 0; index < count; index++) checksum += operation(index).checksum;
        return { count, checksum };
      }, protocol.operations);
      assert.equal(result.count, protocol.operations); checksum = result.checksum;
    }
    assert.equal(checksum, mode === 'fixed-requests' ? 0 : 7 * protocol.operations * (protocol.operations - 1) / 2);
    return { operations: protocol.operations, bridgeCalls: mode === 'in-page' ? 1 : protocol.operations, checksum };
  }));
  await observe('after-bridge', () => run.idleWindow('after-bridge', protocol.idleMs));
  await observe('after-bridge-extended', () => run.idleWindow('after-bridge-extended', protocol.extendedIdleMs));
  await captureConcurrentAllocation(run, 'after-bridge-extended');
  report.windowConditions = unfocusedWindowConditions([...report.actions, ...report.windows],
    Object.fromEntries(['before-bridge', 'bridge-work', 'after-bridge', 'after-bridge-extended'].map(name => [name, 'todos'])));
  for (const window of [...report.actions, ...report.windows]) {
    assert.equal(window.before.monacoEditors, 0); assert.equal(window.after.monacoEditors, 0);
  }
  report.functionalPassed = true; report.passed = true;
  console.log('WebDriver evaluation diagnostic completed');
} catch (error) {
  report.failure = error.stack || String(error); console.error(report.failure); process.exitCode = 1;
} finally { await page.stopWindowStateProbe().catch(() => undefined); await run.close(); }
