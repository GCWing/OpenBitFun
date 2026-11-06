/** Diagnostic only: determine whether automation retains a closed iframe. */
import assert from 'node:assert/strict';
import { openNativeWorkload } from './native-workload-session.mjs';
import { MiniAppHandlesPage } from '../page-objects/MiniAppHandlesPage.mjs';
import { miniAppFixtureRequests } from '../helpers/miniapp-workload-fixture.mjs';

const protocol = { name: 'native-miniapp-driver-handle-diagnostic', version: 1, diagnosticOnly: true,
  prewarmMs: 15000, settleMs: 5000, sampleMs: 2000, installedApps: 1, activeApps: 1,
  rows: 3000, points: 400, workerIntervalMs: 50, workItems: 20000, rpcIntervalMs: 1000, windowMs: 15000 };
const run = await openNativeWorkload({ Page: MiniAppHandlesPage, protocol, label: 'miniapp-handles',
  evidence: process.env.OPENBITFUN_MINIAPP_HANDLES_EVIDENCE,
  harnessFiles: ['tests/e2e/scripts/run-miniapp-handles.mjs', 'tests/e2e/page-objects/MiniAppHandlesPage.mjs',
    'tests/e2e/page-objects/MiniAppWorkloadPage.mjs', 'tests/e2e/helpers/miniapp-workload-fixture.mjs'] });
const { page, report } = run;
report.coverage.pilot = true; report.coverage.instrumented = true;
report.limitations.push('Only stale automation handles are released; product caches and GC are not changed.',
  'Short diagnostic windows and one app do not establish steady-state memory recovery or an optimization benefit.');
try {
  await page.prepareNavigation();
  const [app] = await page.install(miniAppFixtureRequests(protocol, run.workspace).active);
  await page.openGallery(); await page.measureApp(app.id, page.launch(app.id));
  await page.inApp(app.id, () => page.typeChunks(['retained draft']));
  report.open = await page.inspectHandles();
  await page.closeApp(app.id); await page.click('[data-testid="nav-personal-overview"]');
  // Exercise the ordinary sampler's current disconnected-node cleanup first.
  await page.residencySnapshot();
  report.closed = await page.inspectHandles();
  await run.idleWindow('closed-before-driver-handle-release', protocol.windowMs);
  report.release = await page.inspectHandles(true);
  report.afterRelease = await page.inspectHandles();
  assert.equal(report.afterRelease.detached.length, 0);
  await run.idleWindow('closed-after-driver-handle-release', protocol.windowMs);
  report.functionalPassed = true; report.passed = true;
  console.log(JSON.stringify({ closed: report.closed, release: report.release }));
} catch (error) {
  report.failure = error.stack || String(error); console.error(report.failure); process.exitCode = 1;
} finally { await run.close(); }
