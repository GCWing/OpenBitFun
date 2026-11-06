/** Three real session-owned child WebViews: fixed content, UI interaction and native resources. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { openNativeWorkload, delay } from './native-workload-session.mjs';
import { identifyWebviewProcesses } from './identify-webview-processes.mjs';
import { BrowserWorkloadPage } from '../page-objects/BrowserWorkloadPage.mjs';
import { createBrowserWorkloadFixture } from '../helpers/browser-workload-fixture.mjs';
import { latencyDistribution, probeFrameDistributions } from '../helpers/flowchat-frame-metrics.ts';

const protocol = { name: 'native-browser-heavy-workload', version: 5, prewarmMs: 15000, settleMs: 5000, sampleMs: 2000,
  rows: 3000, points: 400, workerIntervalMs: 50, pages: 3, hotCycles: 4, draftChunks: 24,
  windowMs: Number(process.env.OPENBITFUN_BROWSER_WINDOW_MS || 30000),
  hiddenMs: Number(process.env.OPENBITFUN_BROWSER_HIDDEN_MS || 45000),
  budgets: { feedbackP95Ms: 100, panelContentP95Ms: 150, nativePresentationP95Ms: 150,
    frameP95Ms: 34, frameMaxMs: 100, inputRafP95Ms: 100 } };
const run = await openNativeWorkload({ Page: BrowserWorkloadPage, protocol,
  label: process.env.OPENBITFUN_BROWSER_LABEL || 'baseline', evidence: process.env.OPENBITFUN_BROWSER_EVIDENCE,
  harnessFiles: ['tests/e2e/scripts/run-browser-workload.mjs', 'tests/e2e/page-objects/BrowserWorkloadPage.mjs',
    'tests/e2e/helpers/browser-workload-fixture.mjs', 'tests/e2e/helpers/flowchat-frame-metrics.ts'] });
const { page, report } = run;
report.coverage.realAgent = true; report.coverage.realNativeBrowser = true;
report.coverage.pilot = protocol.windowMs !== 30000 || protocol.hiddenMs !== 45000;
report.limitations.push('Loopback page/model fixtures exclude external network and provider latency; the fixture server is not an application process.',
  'Browser content executes its own timers, Worker and Canvas animation; its expected work must not be classified as product idle overhead.',
  'Native presentation uses cross-context Date.now click/visibility/two-RAF timestamps, not compositor completion.',
  'Process attribution identifies WebContent processes, not exclusive per-page memory; multiple WebViews may share a process.',
  'This workload does not cover media playback, HTML resource gateways, remote browsers or standalone unowned view lifetime.');
report.browsers = []; report.openings = []; report.interactions = []; report.dividers = [];
const home = '[data-testid="nav-personal-overview"]';
let fixture;
const states = async () => {
  const snapshots = [];
  for (const browser of report.browsers) snapshots.push({ handle: browser.handle, ...await page.childState(browser.handle) });
  return snapshots;
};
const checkVisibility = async active => {
  // UI dispatch returns before the queued native hide/show has settled.
  // Resource windows start only after actual child visibility is confirmed.
  return page.until(async () => {
    const snapshot = await states();
    return snapshot.every(browser => browser.visibility === (browser.handle === active ? 'visible' : 'hidden')) && snapshot;
  }, `native browser visibility ${active ?? 'all hidden'}`, 5000);
};
const probe = async (name, browser, action) => {
  await page.inChild(browser.handle, async () => {
    await page.startChildProbe();
    try { await action(); }
    finally {
      const raw = await page.stopChildProbe();
      assert.ok(raw.frames.length > 1);
      report.interactions.push({ name, handle: browser.handle, raw,
        frames: probeFrameDistributions({ frames: raw.frames.map(time => ({ time })), wheelTimes: raw.wheelTimes }),
        inputRaf: raw.inputRafMs.length ? latencyDistribution(raw.inputRafMs) : null });
    }
  });
};
try {
  fixture = await createBrowserWorkloadFixture(protocol);
  const sessions = ['browser-workload-a', 'browser-workload-b', 'browser-workload-c'];
  await page.configure({ url: fixture.url, workspace: run.workspace, sessions });
  await page.click(home); await run.identify();
  await run.idleWindow('before-browsers', protocol.windowMs);
  for (let index = 0; index < sessions.length; index++) {
    const marker = 'abc'[index], sessionId = sessions[index];
    await page.select(sessionId);
    await page.enterDraft(`BROWSER_WORKLOAD_${marker}`);
    const start = performance.now();
    await page.click('[data-testid="chat-input-send-btn"]');
    await page.until(() => fixture.results.has(marker) || fixture.errors.length, `real browser tool ${marker}`, 90000);
    assert.deepEqual(fixture.errors, []);
    const toolResult = fixture.results.get(marker);
    assert.ok(!toolResult.is_error && JSON.stringify(toolResult).includes(`BROWSER_WORKLOAD_${marker}`), 'Real browser must read the matching page');
    const inventory = await page.tool('list_pages', { target: 'builtin' });
    const target = inventory.pages.find(item => item.url === `${fixture.url}/pages/${marker}`);
    assert.ok(target?.id, 'New real native browser registered');
    const browser = { sessionId, marker, handle: target.id };
    report.browsers.push(browser);
    await page.until(async () => {
      const state = await page.childState(browser.handle);
      return state?.ready === 'complete' && state.workerMessages > 0 && state.frames > 0 && state.visibility === 'visible';
    }, 'loaded visible browser content');
    report.openings.push({ kind: 'agent-open', marker, durationMs: performance.now() - start });
    browser.initial = await page.childState(browser.handle);
    assert.equal(browser.initial.rows, protocol.rows);
    await run.save();
    console.log(`Opened native browser ${marker}`);
  }
  await delay(protocol.settleMs);
  report.webviews = await identifyWebviewProcesses(page, run.resource, 400, report.browsers.map(browser => browser.handle));
  await run.save();
  const active = report.browsers[2];
  await checkVisibility(active.handle);
  await run.idleWindow('three-browsers-one-visible', protocol.windowMs);
  const chunks = Array.from({ length: protocol.draftChunks }, (_, index) => `draft${index} `);
  await run.measureAction('browser-input', () => probe('input', active, () => page.typeChunks('#draft', chunks)));
  assert.equal((await page.childState(active.handle)).draft, chunks.join(''));
  assert.ok(report.interactions.find(row => row.name === 'input').inputRaf.samples >= protocol.draftChunks);
  await run.measureAction('browser-long-page-scroll', () => probe('scroll', active, () => page.scrollChild()));
  active.retained = await page.childState(active.handle);
  assert.ok(active.retained.scrollY > 1000, 'Real wheel actions moved the long page');
  await run.measureAction('browser-session-switches', async () => {
    for (let cycle = 0; cycle < protocol.hotCycles; cycle++) for (const browser of report.browsers) {
      report.openings.push({ kind: 'hot', marker: browser.marker, cycle, ...await page.activate(browser) });
      await checkVisibility(browser.handle);
    }
  });
  for (const [selector, distance] of [
    ['[data-openbitfun-part="navDivider"]', 70],
    ['[data-split-divider] [role="separator"], [data-openbitfun-component="split-view"] [role="separator"]', 100],
  ]) {
    if (!await page.visible(selector)) throw new Error(`Required browser divider unavailable: ${selector}`);
    const raw = await page.drag(selector, 'x', distance);
    assert.ok(Math.max(...raw.positions) - Math.min(...raw.positions) > distance, 'Divider follows pointer');
    assert.ok(Math.abs(raw.positions.at(-1) - raw.positions[0]) <= 3, 'Divider returns to initial position');
    report.dividers.push({ selector, raw, frames: probeFrameDistributions({ frames: raw.frames.map(time => ({ time })) }) });
  }
  const beforeHidden = await states();
  const hideStarted = performance.now();
  await page.click(home);
  // Navigation changes the leading scene; the independent right Browser panel
  // intentionally remains visible. Exercise its actual collapse control.
  await page.click('[data-testid="workbench-toggle-panel"]');
  await checkVisibility(null);
  report.hideReadbackMs = performance.now() - hideStarted;
  await run.idleWindow('all-browsers-hidden', protocol.hiddenMs);
  const afterHidden = await checkVisibility(null);
  for (let index = 0; index < beforeHidden.length; index++) {
    assert.equal(afterHidden[index].instance, beforeHidden[index].instance);
    assert.ok(afterHidden[index].ticks > beforeHidden[index].ticks, 'Hidden page timers must continue');
    assert.ok(afterHidden[index].workerMessages > beforeHidden[index].workerMessages, 'Hidden page workers must continue');
  }
  report.checks.push({ name: 'hidden-execution', before: beforeHidden, after: afterHidden });
  report.openings.push({ kind: 'restore', marker: active.marker,
    ...await page.activate(active, '[data-testid="workbench-toggle-panel"]') });
  const restored = await page.childState(active.handle);
  assert.equal(restored.instance, active.retained.instance); assert.equal(restored.draft, active.retained.draft);
  assert.ok(Math.abs(restored.scrollY - active.retained.scrollY) <= 1, 'Retain page reading offset');
  await run.idleWindow('browser-restored', protocol.windowMs);
  await page.click('[data-testid="browser-refresh-button"]');
  await page.until(async () => {
    const state = await page.childState(active.handle);
    return state?.ready === 'complete' && state.instance !== restored.instance && state.workerMessages > 0;
  }, 'explicit reload creates a new document');
  const reloaded = await page.childState(active.handle);
  assert.equal(reloaded.draft, '');
  report.checks.push({ name: 'explicit-reload', before: restored, after: reloaded });
  report.closedBrowserPresentations = [];
  for (const browser of report.browsers) {
    await page.closePresentation(browser);
    report.closedBrowserPresentations.push(browser.handle);
  }
  report.closedSceneTabs = await page.closeClosableTabs();
  await page.click(home);
  assert.equal((await page.tool('list_pages', { target: 'builtin' })).pages.length, protocol.pages,
    'Closing presentation retains session-owned native pages');
  await checkVisibility(null);
  await run.idleWindow('presentation-closed-pages-retained', protocol.windowMs);
  for (const browser of report.browsers) await page.tool('close', { target: 'builtin', session_id: browser.handle });
  await page.until(async () => (await page.tool('list_pages', { target: 'builtin' })).pages.length === 0, 'explicit close removes native targets');
  const handles = (await page.invoke('plugin:webview|get_all_webviews')).map(view => view.label);
  assert.ok(report.browsers.every(browser => !handles.includes(browser.handle)), 'Closed native WebViews removed');
  report.checks.push({ name: 'explicit-close', handles });
  await run.idleWindow('after-browsers-close', protocol.windowMs);
  assert.deepEqual(fixture.errors, []);
  report.fixture = { requests: fixture.requests, errors: fixture.errors, completedTools: [...fixture.results.keys()] };
  const hot = report.openings.filter(row => row.kind === 'hot');
  report.navigation = { feedback: latencyDistribution(hot.map(row => row.milestones.visibleMs)),
    panelContent: latencyDistribution(hot.map(row => row.milestones.contentMs)),
    nativePresentation: latencyDistribution(hot.map(row => row.nativePresentationMs)) };
  report.gates = {
    feedback: report.navigation.feedback.p95Ms <= protocol.budgets.feedbackP95Ms,
    panelContent: report.navigation.panelContent.p95Ms <= protocol.budgets.panelContentP95Ms,
    nativePresentation: report.navigation.nativePresentation.p95Ms <= protocol.budgets.nativePresentationP95Ms,
    frames: [...report.interactions, ...report.dividers].every(row => row.frames.phase.p95Ms < protocol.budgets.frameP95Ms && row.frames.phase.maxMs < protocol.budgets.frameMaxMs),
    input: report.interactions.every(row => !row.inputRaf || row.inputRaf.p95Ms <= protocol.budgets.inputRafP95Ms),
  };
  report.functionalPassed = true; report.performanceBudgetsPassed = Object.values(report.gates).every(Boolean);
  report.passed = report.functionalPassed && report.performanceBudgetsPassed;
  console.log(JSON.stringify({ functionalPassed: report.functionalPassed, performanceBudgetsPassed: report.performanceBudgetsPassed }));
} catch (error) {
  report.failure = error.stack || String(error); console.error(report.failure); process.exitCode = 1;
  report.fixture = fixture && { requests: fixture.requests, errors: fixture.errors, completedTools: [...fixture.results.keys()] };
  report.failureState = await page.execute(() => ({ text: document.body.innerText.slice(-5000),
    panels: [...document.querySelectorAll('[data-webview-label]')].map(node => ({ label: node.dataset.webviewLabel,
      rect: node.getBoundingClientRect().toJSON(), visible: node.checkVisibility({ checkVisibilityCSS: true }) })) })).catch(String);
  await writeFile(path.join(run.root, 'failure.png'), Buffer.from(await page.request(`/session/${page.session}/screenshot`), 'base64')).catch(() => undefined);
} finally {
  await run.close();
  await fixture?.close();
}
