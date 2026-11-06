/** Diagnostic only: native stacks and slow main-document layout reads during Browser switches. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openNativeWorkload, delay } from './native-workload-session.mjs';
import { BrowserWorkloadPage } from '../page-objects/BrowserWorkloadPage.mjs';
import { LayoutReadDiagnosticPage } from '../page-objects/LayoutReadDiagnosticPage.mjs';
import { NativeInvokeDiagnosticPage } from '../page-objects/NativeInvokeDiagnosticPage.mjs';
import { createBrowserWorkloadFixture } from '../helpers/browser-workload-fixture.mjs';
import { identifyWebviewProcesses } from './identify-webview-processes.mjs';

const light = process.env.OPENBITFUN_BROWSER_PROFILE_LIGHT === '1';
const previewRequestDelayMs = Number(process.env.OPENBITFUN_BROWSER_PREVIEW_DELAY_MS || 0);
assert.ok(Number.isFinite(previewRequestDelayMs) && previewRequestDelayMs >= 0 && previewRequestDelayMs <= 1000);
const protocol = { name: 'native-browser-stack-diagnostic', version: 4, diagnosticOnly: true,
  prewarmMs: 15000, settleMs: 5000, rows: 3000, points: 400, workerIntervalMs: 50,
  cycles: 6, sampleSeconds: 15, sampleIntervalMs: 1, stackSampling: !light, layoutReads: !light, previewRequestDelayMs };
const run = await openNativeWorkload({ Page: BrowserWorkloadPage, protocol, label: light ? 'browser-ipc' : 'browser-stacks',
  evidence: process.env.OPENBITFUN_BROWSER_PROFILE_EVIDENCE,
  harnessFiles: ['tests/e2e/scripts/run-browser-profile.mjs', 'tests/e2e/page-objects/BrowserWorkloadPage.mjs',
    'tests/e2e/page-objects/LayoutReadDiagnosticPage.mjs', 'tests/e2e/page-objects/NativeInvokeDiagnosticPage.mjs',
    'tests/e2e/helpers/browser-workload-fixture.mjs'] });
const { page, report } = run;
report.coverage.realAgent = true; report.coverage.instrumented = true; report.coverage.pilot = true;
report.limitations.push('Concurrent native stack sampling and layout-read wrappers perturb scheduling; no timings or CPU percentages here are acceptance measurements.');
report.limitations.push('IPC traces cover custom-protocol fetch until response headers, excluding response decoding/callbacks and postMessage fallback; immutable Tauri invoke/ipc methods are untouched.');
if (previewRequestDelayMs) report.limitations.push('Preview requests are intentionally delayed for causal diagnosis. All captures still execute; this changes preview timing and is not an acceptable product optimization by itself.');
report.browsers = []; report.navigations = [];
let fixture, sampling;
const layout = new LayoutReadDiagnosticPage(page.endpoint); layout.session = page.session;
const invocations = new NativeInvokeDiagnosticPage(page.endpoint); invocations.session = page.session;
try {
  fixture = await createBrowserWorkloadFixture(protocol);
  const sessions = ['browser-workload-a', 'browser-workload-b', 'browser-workload-c'];
  await page.configure({ url: fixture.url, workspace: run.workspace, sessions });
  for (const [index, sessionId] of sessions.entries()) {
    const marker = 'abc'[index];
    await page.select(sessionId); await page.enterDraft(`BROWSER_WORKLOAD_${marker}`);
    await page.click('[data-testid="chat-input-send-btn"]');
    await page.until(() => fixture.results.has(marker) || fixture.errors.length, `real browser tool ${marker}`, 90000);
    assert.deepEqual(fixture.errors, []);
    assert.ok(!fixture.results.get(marker).is_error && JSON.stringify(fixture.results.get(marker)).includes(`BROWSER_WORKLOAD_${marker}`));
    const target = (await page.tool('list_pages', { target: 'builtin' })).pages.find(item => item.url === `${fixture.url}/pages/${marker}`);
    assert.ok(target?.id);
    const browser = { sessionId, marker, handle: target.id };
    await page.until(async () => (await page.childState(browser.handle))?.visibility === 'visible', 'visible native browser');
    report.browsers.push(browser);
  }
  await delay(protocol.settleMs);
  report.webviews = await identifyWebviewProcesses(page, run.resource, 400, report.browsers.map(browser => browser.handle));
  const main = report.webviews.find(view => view.handle === 'main');
  const gpu = (await run.resource()).processes.find(process => process.name === 'com.apple.WebKit.GPU' && !process.error);
  assert.ok(main && gpu);
  report.apiBefore = (await page.snapshot()).api;
  await invocations.startInvokeTrace(protocol.previewRequestDelayMs);
  if (protocol.layoutReads) await layout.startLayoutReads();
  const targets = [{ name: 'host', pid: report.hostPid }, { name: 'main', pid: main.pid }, { name: 'gpu', pid: gpu.pid }];
  if (protocol.stackSampling) sampling = Promise.all(targets.map(async target => {
    const output = path.join(run.root, `${target.name}-sample.txt`);
    try {
      const result = await promisify(execFile)('sample', [String(target.pid), String(protocol.sampleSeconds),
        String(protocol.sampleIntervalMs), '-file', output], { windowsHide: true, maxBuffer: 1024 * 1024 });
      return { ...target, output, stdout: result.stdout, stderr: result.stderr };
    } catch (error) { return { ...target, output, error: String(error) }; }
  }));
  console.log(protocol.stackSampling ? 'Browser stack sampling started' : 'Browser IPC-only diagnostic started');
  for (let cycle = 0; cycle < protocol.cycles; cycle++) for (const browser of report.browsers) {
    report.navigations.push({ cycle, marker: browser.marker, ...await page.activate(browser) });
  }
  report.layoutReads = protocol.layoutReads ? await layout.stopLayoutReads() : { enabled: false };
  report.invocations = await invocations.stopInvokeTrace();
  assert.equal(report.invocations.dropped, 0);
  assert.ok(report.invocations.calls.some(call => call.command === 'browser_webview_capture_preview'), 'Observe the native preview IPC path');
  assert.equal(report.invocations.clicks.length, protocol.cycles * report.browsers.length);
  report.apiAfter = (await page.snapshot()).api;
  report.stackSamples = sampling ? await sampling : [];
  assert.ok(report.stackSamples.every(sample => !sample.error), JSON.stringify(report.stackSamples));
  assert.deepEqual(fixture.errors, []);
  for (const browser of report.browsers) await page.tool('close', { target: 'builtin', session_id: browser.handle });
  report.functionalPassed = true; report.passed = true;
  console.log('Browser diagnostic completed');
} catch (error) {
  report.failure = error.stack || String(error); console.error(report.failure); process.exitCode = 1;
} finally {
  if (sampling) report.stackSamples = await sampling;
  report.layoutReads ??= protocol.layoutReads ? await layout.stopLayoutReads().catch(error => ({ error: String(error) })) : { enabled: false };
  report.invocations ??= await invocations.stopInvokeTrace().catch(error => ({ error: String(error) }));
  await run.close(); await fixture?.close();
}
