/** Diagnostic only: native stacks while switching retained heavy scenes. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openNativeWorkload, delay } from './native-workload-session.mjs';
import { SceneDiagnosticPage } from '../page-objects/SceneDiagnosticPage.mjs';

const protocol = { name: 'native-navigation-stack-diagnostic', version: 6, prewarmMs: 15_000,
  cycles: 16, sampleMs: 2000, stackDurationSeconds: 20, stackIntervalMs: 1,
  input: 'native-eval-PointerEvent-and-MouseEvent-sequence', timingStart: 'capture-pointerdown',
  editorOpened: false, terminalOpened: false,
  navigation: ['personal-overview', 'session'], diagnosticOnly: true,
  layoutReadDiagnostic: process.env.OPENBITFUN_NAV_PROFILE_LAYOUT === '1', scenePhaseDiagnostic: true,
  mutationDiagnostic: process.env.OPENBITFUN_NAV_PROFILE_MUTATIONS === '1' };
assert.ok(!protocol.mutationDiagnostic || protocol.layoutReadDiagnostic, 'Mutation attribution requires layout probes');
const run = await openNativeWorkload({ Page: SceneDiagnosticPage, protocol,
  label: 'navigation-stacks', evidence: process.env.OPENBITFUN_NAV_PROFILE_EVIDENCE,
  harnessFiles: ['tests/e2e/scripts/run-navigation-profile.mjs', 'tests/e2e/page-objects/LayoutReadDiagnosticPage.mjs',
    'tests/e2e/page-objects/SceneDiagnosticPage.mjs', 'tests/e2e/page-objects/SceneVisibilityPage.mjs'] });
const { page, report } = run;
report.navigations = [];
report.coverage.instrumented = true;
report.coverage.pilot = true;
report.limitations.push('Native stack sampling perturbs scheduling; latency here is diagnostic, not optimization acceptance.');
if (protocol.mutationDiagnostic) report.limitations.push(
  'DOM mutations are collected between slow reads, not synchronous write stacks or browser invalidation records. CSS animations and engine invalidation may occur without DOM writes.',
  'Mutation batches retain primitive metadata only, capped at 128 records; collection timestamps and current attribute values are not exact write timestamps or intermediate values.');
let sampling;
try {
  const session = '[data-testid="nav-session-item"][data-session-id="workload-history-000"]';
  await page.click(session);
  await page.until(() => page.visible('[data-flowchat-scroller]'), 'retained long conversation');
  await page.enterDraft('Draft retained during navigation stack diagnosis.');
  await page.scrollHistory(); await delay(500);
  report.readingBefore = await page.readingAnchor();
  await page.measureOpen('[data-testid="nav-todos-btn"]',
    '[data-testid="scene-viewport-scene"][data-scene-id="todos"][data-scene-active="true"]');
  const destinations = [['[data-testid="nav-personal-overview"]', 'personal-overview'], [session, 'session']];
  for (const [trigger, id] of destinations) await page.measureOpen(trigger,
    `[data-testid="scene-viewport-scene"][data-scene-id="${id}"][data-scene-active="true"]`);
  await delay(1000);
  await run.identify();
  const main = report.webviews.find(view => view.handle === 'main');
  assert.ok(main);
  if (protocol.layoutReadDiagnostic) await page.startLayoutReads({ mutations: protocol.mutationDiagnostic });
  const output = path.join(run.root, 'main-webcontent-sample.txt');
  sampling = promisify(execFile)('sample', [String(main.pid), String(protocol.stackDurationSeconds),
    String(protocol.stackIntervalMs), '-file', output], { windowsHide: true, maxBuffer: 1024 * 1024 })
    .then(result => ({ output, stdout: result.stdout, stderr: result.stderr }), error => ({ output, error: String(error) }));
  for (let cycle = 0; cycle < protocol.cycles; cycle++) {
    for (const [trigger, id] of destinations) report.navigations.push({ cycle, id,
      ...await page.measureOpen(trigger, `[data-testid="scene-viewport-scene"][data-scene-id="${id}"][data-scene-active="true"]`) });
    await run.save();
  }
  report.stackSample = await sampling;
  assert.ok(!report.stackSample.error, report.stackSample.error);
  report.final = await page.residencySnapshot();
  assert.equal(report.final.monacoEditors, 0);
  assert.equal(report.final.draft, 'Draft retained during navigation stack diagnosis.');
  report.readingAfter = await page.readingAnchor();
  assert.equal(report.readingAfter.key, report.readingBefore.key);
  assert.ok(Math.abs(report.readingAfter.offset - report.readingBefore.offset) <= 8);
  report.functionalPassed = true;
  report.passed = true;
} catch (error) {
  report.failure = error.stack || String(error); console.error(report.failure); process.exitCode = 1;
} finally {
  if (sampling) report.stackSample = await sampling;
  if (protocol.layoutReadDiagnostic) report.layoutReads = await page.stopLayoutReads().catch(error => ({ error: String(error) }));
  await run.close();
}
