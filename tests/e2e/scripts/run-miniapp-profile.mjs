/** Diagnostic only: hidden iframe rendering, native stacks and geometry effects. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openNativeWorkload, delay } from './native-workload-session.mjs';
import { MiniAppDiagnosticPage } from '../page-objects/MiniAppDiagnosticPage.mjs';
import { miniAppFixtureRequests } from '../helpers/miniapp-workload-fixture.mjs';

const protocol = { name: 'native-miniapp-hidden-rendering-diagnostic', version: 1, diagnosticOnly: true,
  prewarmMs: 15000, settleMs: 5000, sampleMs: 2000, installedApps: 30, activeApps: 3,
  rows: 3000, points: 400, workerIntervalMs: 50, workItems: 20000, rpcIntervalMs: 1000,
  windowMs: 15000, stackSeconds: 12 };
const run = await openNativeWorkload({ Page: MiniAppDiagnosticPage, protocol, label: 'miniapp-rendering',
  evidence: process.env.OPENBITFUN_MINIAPP_PROFILE_EVIDENCE,
  harnessFiles: ['tests/e2e/scripts/run-miniapp-profile.mjs', 'tests/e2e/page-objects/MiniAppDiagnosticPage.mjs',
    'tests/e2e/page-objects/MiniAppWorkloadPage.mjs', 'tests/e2e/helpers/miniapp-workload-fixture.mjs'] });
const { page, report } = run;
report.coverage.pilot = true; report.coverage.instrumented = true; report.coverage.realMiniAppWorker = true;
report.limitations.push('Temporary CSS experiments and native stack sampling are diagnostic only, not product changes or acceptance measurements.',
  'Fixture counter continuity does not establish compatibility with arbitrary third-party apps, media, ResizeObserver, or business work implemented with RAF.');
report.experiments = [];
try {
  report.runtime = await page.invoke('miniapp_runtime_status');
  assert.equal(report.runtime.available, true);
  await page.prepareNavigation();
  const requests = miniAppFixtureRequests(protocol, run.workspace);
  await page.install(requests.quiet);
  report.apps = await page.install(requests.active);
  for (const app of report.apps) {
    await page.openGallery();
    app.initial = (await page.measureApp(app.id, page.launch(app.id))).state;
  }
  const active = report.apps.at(-1);
  await page.inApp(active.id, async () => { await page.typeChunks(['retained draft']); await page.scrollApp(); });
  const retained = await page.state(active.id);
  await page.observeGeometry(); await run.identify();
  await run.idleWindow('three-miniapps-one-visible', protocol.windowMs);
  await page.click('[data-testid="nav-personal-overview"]');
  await page.until(async () => (await page.diagnosticStates()).every(state => !state.visible), 'all MiniApps hidden');
  for (const mode of ['normal', 'display-none', 'normal-recovery', 'content-visibility-hidden']) {
    await page.setRenderingExperiment(mode);
    const before = await page.diagnosticStates();
    await run.idleWindow(`hidden-${mode}`, protocol.windowMs);
    const after = await page.diagnosticStates();
    report.experiments.push({ mode, before, after });
    for (let i = 0; i < before.length; i++) {
      assert.equal(after[i].instance, before[i].instance);
      assert.equal(after[i].worker.instance, before[i].worker.instance);
      assert.ok(after[i].messages > before[i].messages && after[i].worker.sequence > before[i].worker.sequence);
      assert.ok(after[i].rpcReplies > before[i].rpcReplies && after[i].uiTicks > before[i].uiTicks);
      assert.deepEqual(after[i].errors, []);
    }
    await run.save();
  }
  await page.setRenderingExperiment('normal'); await delay(protocol.settleMs);
  const main = report.webviews.find(view => view.handle === 'main');
  const gpu = (await run.resource()).processes.find(process => process.name === 'com.apple.WebKit.GPU' && !process.error);
  assert.ok(main && gpu);
  console.log('MiniApp hidden stack sampling started');
  report.stackSamples = await Promise.all([{ name: 'host', pid: report.hostPid }, { name: 'main', pid: main.pid }, { name: 'gpu', pid: gpu.pid }]
    .map(async target => {
      const output = path.join(run.root, `${target.name}-sample.txt`);
      try {
        const result = await promisify(execFile)('sample', [String(target.pid), String(protocol.stackSeconds), '1', '-file', output],
          { windowsHide: true, maxBuffer: 1024 * 1024 });
        return { ...target, output, stdout: result.stdout, stderr: result.stderr };
      } catch (error) { return { ...target, output, error: String(error) }; }
    }));
  assert.ok(report.stackSamples.every(sample => !sample.error), JSON.stringify(report.stackSamples));
  const restored = (await page.measureApp(active.id)).state;
  assert.equal(restored.instance, retained.instance); assert.equal(restored.worker.instance, retained.worker.instance);
  assert.equal(restored.draft, retained.draft); assert.equal(restored.scrollY, retained.scrollY);
  report.restored = restored;
  for (const app of report.apps) await page.closeApp(app.id);
  report.functionalPassed = true; report.passed = true;
  console.log('MiniApp rendering diagnostic completed');
} catch (error) {
  report.failure = error.stack || String(error); console.error(report.failure); process.exitCode = 1;
} finally {
  await page.setRenderingExperiment('normal').catch(() => undefined);
  await run.close();
}
