/** Attribute real tool-start frames and completed-stream residency without an editor. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openNativeWorkload, delay } from './native-workload-session.mjs';
import { ConcurrentDiagnosticPage } from '../page-objects/ConcurrentDiagnosticPage.mjs';
import { createFlowChatStreamFixture } from '../helpers/flowchat-stream-fixture.ts';
import { probeFrameDistributions } from '../helpers/flowchat-frame-metrics.ts';
import { startCallbackWorkDiagnostic, stopCallbackWorkDiagnostic } from './callback-work-diagnostic.mjs';

const observeLayoutReads = process.env.OPENBITFUN_TOOL_DIAGNOSTIC_LAYOUT_READS === '1';
const protocol = { name: 'native-tool-startup-diagnostic', version: 2, prewarmMs: 15000,
  settleMs: 5000, sampleMs: 2000, cycles: 3, idleMs: 30000,
  initialParagraphs: 80, maxParagraphs: 120, intervalMs: 90,
  stackDurationSeconds: 5, editorOpened: false, secondaryPane: 'empty-canvas',
  input: 'native-eval-PointerEvent-and-MouseEvent-sequence', diagnosticOnly: true,
  layoutReadWrappers: observeLayoutReads };
const run = await openNativeWorkload({ Page: ConcurrentDiagnosticPage, protocol, label: 'tool-startup-diagnostic',
  evidence: process.env.OPENBITFUN_TOOL_DIAGNOSTIC_EVIDENCE,
  harnessFiles: ['tests/e2e/scripts/run-tool-startup-diagnostic.mjs',
    'tests/e2e/page-objects/ConcurrentDiagnosticPage.mjs', 'tests/e2e/page-objects/ConcurrentWorkloadPage.mjs',
    'tests/e2e/page-objects/SceneVisibilityPage.mjs', 'tests/e2e/page-objects/LayoutReadDiagnosticPage.mjs',
    'tests/e2e/scripts/callback-work-diagnostic.mjs', 'tests/e2e/helpers/flowchat-stream-fixture.ts',
    'tests/e2e/helpers/flowchat-frame-metrics.ts'] });
const { page, report } = run;
report.coverage.instrumented = true; report.coverage.realAgent = true; report.coverage.loopbackModel = true;
report.limitations.push('Native sampling and callback observation add overhead; optional layout wrappers add further overhead. These are diagnostic results, not performance acceptance.',
  'Three fresh documents share native process age and caches. Timer callbacks registered before observation are not wrapped.',
  'Actual tools run locally against an isolated workspace and a bounded loopback model. No remote or external-provider latency is established.');
report.cycles = [];
let fixture, sampling;
try {
  for (let cycle = 0; cycle < protocol.cycles; cycle++) {
    const sessionId = `tool-startup-diagnostic-${cycle}`;
    const result = { cycle, sessionId }; report.cycles.push(result);
    fixture = await createFlowChatStreamFixture(run.workspace, protocol);
    const configured = await page.configureLiveSession({ url: fixture.url, sessionId, workspace: run.workspace });
    await run.identify();
    const main = report.webviews.find(view => view.handle === 'main');
    assert.ok(main, 'Identify main WebContent');
    const filename = `tool-startup-${cycle}-sample.txt`;
    sampling = promisify(execFile)('sample', [String(main.pid), String(protocol.stackDurationSeconds), '1', '-file', path.join(run.root, filename)],
      { windowsHide: true, maxBuffer: 1024 * 1024 }).then(() => ({ filename }), error => ({ filename, error: String(error) }));
    await delay(250);
    if (observeLayoutReads) await page.startLayoutReads({ mutations: true });
    await page.startInteractionProbe();
    try {
      await run.measureAction(`tool-startup-${cycle}`, async () => {
        await page.enterDraft('FLOWCHAT_PERF_STREAM');
        await page.click('[data-testid="chat-input-send-btn"]');
        await page.until(() => fixture.textReady || fixture.errors.length, 'actual tool execution', 60000);
        assert.deepEqual(fixture.errors, []); assert.equal(fixture.results.length, 8);
        assert.ok(fixture.results.every(tool => !tool.is_error));
      });
    } finally {
      result.interaction = await page.stopInteractionProbe();
      result.layoutReads = observeLayoutReads ? await page.stopLayoutReads() : null;
    }
    result.frames = probeFrameDistributions({ frames: result.interaction.frames.map(time => ({ time })),
      wheelTimes: result.interaction.wheelTimes });
    result.stackSample = await sampling; sampling = undefined;
    assert.ok(!result.stackSample.error, result.stackSample.error);
    for (let index = 0; index < 4; index++) {
      assert.ok((await readFile(path.join(run.workspace, `flowchat-live-${index}.ts`), 'utf8')).includes('value = 1'));
    }
    fixture.begin();
    await page.until(() => fixture.emitted === protocol.maxParagraphs, 'bounded output');
    fixture.finish();
    await page.until(async () => !(await page.visible('[data-testid="chat-input-cancel-btn"]')), 'completed generation');
    const persisted = JSON.stringify(await page.invoke('load_session_turns', {
      request: { session_id: sessionId, workspace_id: configured.workspaceId },
    }));
    for (const text of ['Stream paragraph 0:', `Stream paragraph ${protocol.maxParagraphs - 1}:`, 'FLOWCHAT_STREAM_COMPLETE']) {
      assert.ok(persisted.includes(text), `Persisted output must include ${text}`);
    }
    await page.enterDraft(`Retained diagnostic draft ${cycle}`);
    await startCallbackWorkDiagnostic(page);
    try { await run.idleWindow(`after-completion-${cycle}`, protocol.idleMs); }
    finally { result.callbacks = await stopCallbackWorkDiagnostic(page); }
    result.final = await page.residencySnapshot();
    assert.equal(result.final.monacoEditors, 0);
    assert.equal(result.final.draft, `Retained diagnostic draft ${cycle}`);
    result.emitted = fixture.emitted; result.tools = fixture.results;
    await fixture.close(); fixture = undefined;
    await run.save(); console.log(`Tool startup and completion diagnostic cycle ${cycle + 1}/${protocol.cycles} completed`);
  }
  report.functionalPassed = true; report.passed = true;
} catch (error) {
  report.failure = error.stack || String(error); console.error(report.failure); process.exitCode = 1;
} finally {
  if (sampling) await sampling;
  await page.stopLayoutReads().catch(() => undefined);
  await page.stopInteractionProbe().catch(() => undefined);
  await stopCallbackWorkDiagnostic(page).catch(() => undefined);
  await fixture?.close(); await run.close();
}
