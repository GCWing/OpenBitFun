/** Installed apps with actual compiled UI, SDK RPC and native Worker processes. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { openNativeWorkload } from './native-workload-session.mjs';
import { MiniAppWorkloadPage } from '../page-objects/MiniAppWorkloadPage.mjs';
import { miniAppFixtureRequests } from '../helpers/miniapp-workload-fixture.mjs';
import { latencyDistribution, probeFrameDistributions } from '../helpers/flowchat-frame-metrics.ts';

const protocol = { name: 'native-miniapp-heavy-workload', version: 3,
  prewarmMs: 15000, settleMs: 5000, sampleMs: 2000,
  installedApps: 30, activeApps: 3, rows: 3000, points: 400,
  workerIntervalMs: 50, workItems: 20000, rpcIntervalMs: 1000,
  hotCycles: 4, draftChunks: 24, computeClicks: 6,
  windowMs: Number(process.env.OPENBITFUN_MINIAPP_WINDOW_MS || 30000),
  hiddenMs: Number(process.env.OPENBITFUN_MINIAPP_HIDDEN_MS || 45000),
  budgets: { galleryFirstMs: 500, firstContentMs: 1000, feedbackP95Ms: 100,
    contentP95Ms: 150, frameP95Ms: 34, frameMaxMs: 100, inputRafP95Ms: 100 } };
const run = await openNativeWorkload({ Page: MiniAppWorkloadPage, protocol,
  label: process.env.OPENBITFUN_MINIAPP_LABEL || 'baseline', evidence: process.env.OPENBITFUN_MINIAPP_EVIDENCE,
  harnessFiles: ['tests/e2e/scripts/run-miniapp-workload.mjs', 'tests/e2e/page-objects/MiniAppWorkloadPage.mjs',
    'tests/e2e/helpers/miniapp-workload-fixture.mjs', 'tests/e2e/helpers/flowchat-frame-metrics.ts'] });
const { page, report } = run;
report.coverage.realMiniAppWorker = true;
report.coverage.pilot = protocol.windowMs !== 30000 || protocol.hiddenMs !== 45000;
report.limitations.push('Locally created same-origin apps do not cover marketplace opaque-origin frames, installation/downloads, independent Shell or presentation transfer.',
  'Fixtures need no npm downloads, model credentials or file/network permissions; UI and Worker workloads run through production compile, launch and SDK paths.',
  'Worker PIDs come from their real RPC responses and must match native responsibility attribution and process start time.',
  'Iframe UI shares the main WebContent; its DOM count and frame timing do not establish exclusive per-app memory or JS heap.',
  'Hidden Worker jobs, RPC updates and timers are expected business work and must continue; they are not all idle overhead.',
  'First UI entry follows startup prewarming and fixture creation, not cold startup or cold installation.');
report.apps = []; report.openings = []; report.interactions = []; report.dividers = []; report.workerProcesses = [];
const home = '[data-testid="nav-personal-overview"]';
const states = async () => Promise.all(report.apps.map(async app => ({ id: app.id, ...await page.state(app.id) })));
const sameInstance = (before, after) => {
  assert.equal(after.instance, before.instance, 'Retain the application document');
  assert.equal(after.worker.instance, before.worker.instance, 'Retain the Worker instance');
  assert.equal(after.worker.pid, before.worker.pid, 'Retain the Worker process');
  assert.deepEqual(after.errors, []);
};
const identifyWorker = async app => {
  const state = await page.state(app.id);
  const native = await run.resource();
  const process = native.processes.find(row => row.pid === state.worker.pid && !row.error);
  assert.ok(process?.startTicks, `Worker ${app.id} must be attributed to this app host`);
  const identity = { appId: app.id, workerInstance: state.worker.instance,
    pid: process.pid, startTicks: process.startTicks, name: process.name, runtime: state.worker.runtime };
  report.workerProcesses.push(identity);
  return identity;
};
const waitForWorkerExit = async identity => page.until(async () => {
  const sample = await run.resource();
  return !sample.processes.some(row => row.pid === identity.pid && row.startTicks === identity.startTicks);
}, `reaped MiniApp Worker ${identity.pid}`, 30000);
const probe = async (name, app, action) => page.inApp(app.id, async () => {
  await page.startProbe();
  let actionError;
  try { await action(); } catch (error) { actionError = error; }
  let raw;
  try { raw = await page.stopProbe(); } catch (error) { if (!actionError) throw error; }
  report.interactions.push({ name, appId: app.id, raw, error: actionError?.stack,
    frames: raw && probeFrameDistributions({ frames: raw.frames.map(time => ({ time })), wheelTimes: raw.wheelTimes }),
    inputRaf: raw?.inputRafMs.length ? latencyDistribution(raw.inputRafMs) : null });
  if (actionError) throw actionError;
  assert.ok(raw.frames.length > 1, 'Record active document frames');
});
try {
  report.runtime = await page.invoke('miniapp_runtime_status');
  assert.equal(report.runtime.available, true, 'A real MiniApp Worker runtime must be available');
  report.environment.miniappRuntime = { kind: report.runtime.kind, version: report.runtime.version };
  await page.prepareNavigation();
  const requests = miniAppFixtureRequests(protocol, run.workspace);
  report.catalogApps = await page.install(requests.quiet);
  report.apps = await page.install(requests.active);
  assert.equal(report.catalogApps.length + report.apps.length, protocol.installedApps);
  const allIds = [...report.catalogApps, ...report.apps].map(app => app.id);
  assert.ok(!(await page.invoke('miniapp_worker_list_running')).some(id => allIds.includes(id)), 'Installing must not launch Workers');
  await page.click(home); await run.identify();
  await run.idleWindow('installed-apps-not-running', protocol.windowMs);
  report.gallery = await page.measureGallery(allIds);
  await page.until(async () => {
    const ids = await page.installedIds();
    return allIds.every(id => ids.includes(id));
  }, 'all installed catalog entries rendered');
  report.installedIds = await page.installedIds();
  for (const app of report.apps) {
    await page.openGallery();
    const opening = await page.measureApp(app.id, page.launch(app.id));
    assert.equal(opening.state.rows, protocol.rows);
    app.initial = opening.state;
    report.openings.push({ kind: 'first', appId: app.id, ...opening });
    await identifyWorker(app); await run.save();
    console.log(`Opened real MiniApp ${app.name}`);
  }
  await run.identify();
  await run.idleWindow('three-miniapps-one-visible', protocol.windowMs);
  const active = report.apps.at(-1);
  const chunks = Array.from({ length: protocol.draftChunks }, (_, index) => `draft${index} `);
  await run.measureAction('miniapp-input', () => probe('input', active, () => page.typeChunks(chunks)));
  assert.equal((await page.state(active.id)).draft, chunks.join(''));
  assert.ok(report.interactions.find(row => row.name === 'input').inputRaf.samples >= protocol.draftChunks);
  await run.measureAction('miniapp-long-page-scroll', () => probe('scroll', active, () => page.scrollApp()));
  assert.ok((await page.state(active.id)).scrollY > 1000, 'Wheel actions move the long document');
  await run.measureAction('miniapp-worker-compute', () => probe('compute', active, () => page.compute(protocol.computeClicks)));
  active.retained = await page.state(active.id);
  assert.equal(active.retained.computations, protocol.computeClicks);
  assert.equal(active.retained.lastComputation.iterations, protocol.workItems * 10);
  assert.ok(active.retained.lastComputation.checksum >= 0);
  await run.measureAction('miniapp-tab-switches', async () => {
    for (let cycle = 0; cycle < protocol.hotCycles; cycle++) for (const app of report.apps) {
      const opening = await page.measureApp(app.id);
      sameInstance(app.initial, opening.state);
      report.openings.push({ kind: 'hot', appId: app.id, cycle, ...opening });
    }
  });
  const selector = '[data-openbitfun-part="navDivider"]';
  assert.ok(await page.visible(selector));
  const raw = await page.drag(selector, 'x', 70);
  assert.ok(Math.max(...raw.positions) - Math.min(...raw.positions) > 70, 'Divider follows pointer');
  assert.ok(Math.abs(raw.positions.at(-1) - raw.positions[0]) <= 3, 'Divider returns to its initial position');
  report.dividers.push({ selector, raw, frames: probeFrameDistributions({ frames: raw.frames.map(time => ({ time })) }) });
  const beforeHidden = await states();
  await page.click(home);
  await page.until(async () => (await states()).every(state => !state.visible), 'all MiniApps hidden');
  await run.idleWindow('all-miniapps-hidden', protocol.hiddenMs);
  const afterHidden = await states();
  for (let index = 0; index < beforeHidden.length; index++) {
    const before = beforeHidden[index], after = afterHidden[index];
    sameInstance(before, after);
    assert.ok(after.worker.sequence > before.worker.sequence && after.worker.processedItems > before.worker.processedItems,
      'Hidden business computation must continue');
    assert.ok(after.messages > before.messages && after.rpcReplies > before.rpcReplies && after.uiTicks > before.uiTicks,
      'Hidden push, SDK polling and timers must continue');
    assert.equal(after.visible, false);
  }
  report.checks.push({ name: 'hidden-execution', before: beforeHidden, after: afterHidden });
  const restored = await page.measureApp(active.id);
  report.openings.push({ kind: 'restore', appId: active.id, ...restored });
  sameInstance(active.retained, restored.state);
  assert.equal(restored.state.draft, active.retained.draft);
  assert.ok(Math.abs(restored.state.scrollY - active.retained.scrollY) <= 1, 'Retain reading position');
  await run.idleWindow('miniapp-restored', protocol.windowMs);
  for (const [index, app] of report.apps.entries()) {
    await page.closeApp(app.id);
    await waitForWorkerExit(report.workerProcesses.find(row => row.appId === app.id));
    const running = await page.invoke('miniapp_worker_list_running');
    assert.ok(report.apps.slice(index + 1).every(other => running.includes(other.id)), 'Closing one app preserves other Workers');
  }
  await page.click(home);
  await run.idleWindow('after-miniapps-close', protocol.windowMs);
  await page.openGallery();
  const reopenedApp = report.apps[0];
  const reopened = await page.measureApp(reopenedApp.id, page.launch(reopenedApp.id));
  assert.notEqual(reopened.state.instance, reopenedApp.initial.instance, 'Explicit close/reopen creates a new document');
  assert.notEqual(reopened.state.worker.instance, reopenedApp.initial.worker.instance, 'Explicit close/reopen creates a new Worker');
  assert.equal(reopened.state.draft, '', 'Fixture has no persistent draft');
  report.openings.push({ kind: 'reopen', appId: reopenedApp.id, ...reopened });
  const identity = await identifyWorker(reopenedApp);
  await page.closeApp(reopenedApp.id); await waitForWorkerExit(identity);
  await page.click(home);
  await run.idleWindow('after-miniapp-reopen-close', protocol.windowMs);
  const hot = report.openings.filter(row => row.kind === 'hot');
  report.navigation = { feedback: latencyDistribution(hot.map(row => row.milestones.visibleMs)),
    panelContent: latencyDistribution(hot.map(row => row.milestones.contentMs)),
    frameContent: latencyDistribution(hot.map(row => row.frameContentMs)) };
  report.gates = {
    gallery: report.gallery.populatedContentMs <= protocol.budgets.galleryFirstMs,
    firstContent: report.openings.filter(row => ['first', 'reopen'].includes(row.kind))
      .every(row => row.frameContentMs <= protocol.budgets.firstContentMs),
    feedback: report.navigation.feedback.p95Ms <= protocol.budgets.feedbackP95Ms,
    content: report.navigation.frameContent.p95Ms <= protocol.budgets.contentP95Ms,
    frames: [...report.interactions, ...report.dividers].every(row => row.frames.phase.p95Ms < protocol.budgets.frameP95Ms
      && row.frames.phase.maxMs < protocol.budgets.frameMaxMs),
    input: report.interactions.every(row => !row.inputRaf || row.inputRaf.p95Ms <= protocol.budgets.inputRafP95Ms),
  };
  report.functionalPassed = true; report.performanceBudgetsPassed = Object.values(report.gates).every(Boolean);
  report.passed = report.functionalPassed && report.performanceBudgetsPassed;
  console.log(JSON.stringify({ functionalPassed: report.functionalPassed, performanceBudgetsPassed: report.performanceBudgetsPassed }));
} catch (error) {
  report.failure = error.stack || String(error); console.error(report.failure); process.exitCode = 1;
  report.failureState = await page.residencySnapshot().catch(String);
  report.failureText = await page.execute(() => document.body.innerText.slice(-5000)).catch(String);
  await writeFile(path.join(run.root, 'failure.png'), Buffer.from(await page.request(`/session/${page.session}/screenshot`), 'base64')).catch(() => undefined);
} finally {
  await run.close();
}
