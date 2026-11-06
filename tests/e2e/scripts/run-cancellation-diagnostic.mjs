/** Identify retained work after real stream cancellation, without replacing product state. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openNativeWorkload } from './native-workload-session.mjs';
import { ConcurrentWorkloadPage } from '../page-objects/ConcurrentWorkloadPage.mjs';
import { createFlowChatStreamFixture } from '../helpers/flowchat-stream-fixture.ts';
import { startCallbackWorkDiagnostic, stopCallbackWorkDiagnostic } from './callback-work-diagnostic.mjs';

const protocol = { name: 'native-cancellation-diagnostic', version: 5, prewarmMs: 15_000,
  editorOpened: false, input: 'native-eval-PointerEvent-and-MouseEvent-sequence', timingStart: 'capture-pointerdown',
  settleMs: 5000, sampleMs: 2000, idleMs: 30_000, initialParagraphs: 80, cancelAtParagraph: 120,
  responseDelayMs: 1800, captureStatusExit: true, boundedCancellation: true, diagnosticOnly: true,
  callbackDiagnostic: process.env.OPENBITFUN_CANCEL_TRACE_CALLBACKS === '1',
  stackDurationSeconds: process.env.OPENBITFUN_CANCEL_PROFILE_STACKS === '1' ? 20 : 0 };
const run = await openNativeWorkload({ Page: ConcurrentWorkloadPage, protocol, label: 'cancel-diagnostic',
  evidence: process.env.OPENBITFUN_CANCEL_DIAGNOSTIC_EVIDENCE,
  harnessFiles: ['tests/e2e/scripts/run-cancellation-diagnostic.mjs', 'tests/e2e/page-objects/ConcurrentWorkloadPage.mjs',
    'tests/e2e/page-objects/SceneVisibilityPage.mjs',
    'tests/e2e/scripts/callback-work-diagnostic.mjs',
    'tests/e2e/helpers/flowchat-stream-fixture.ts'] });
const { page, report } = run;
const fixture = await createFlowChatStreamFixture(run.workspace, {
  initialParagraphs: protocol.initialParagraphs, maxParagraphs: protocol.cancelAtParagraph,
  responseDelayMs: protocol.responseDelayMs,
});
try {
  const configured = await page.configureLiveSession({ url: fixture.url, sessionId: 'cancel-diagnostic', workspace: run.workspace });
  await run.identify();
  await page.startRuntimeStatusProbe();
  await page.enterDraft('FLOWCHAT_PERF_STREAM'); await page.click('[data-testid="chat-input-send-btn"]');
  await page.until(() => fixture.textReady || fixture.errors.length, 'actual tools completed', 60_000);
  assert.deepEqual(fixture.errors, []); assert.equal(fixture.results.length, 8);
  assert.ok(fixture.results.every(result => !result.is_error));
  fixture.begin();
  await page.until(() => fixture.emitted >= protocol.cancelAtParagraph, 'active stream');
  report.cancelMs = await page.cancelTurn();
  await page.until(() => fixture.disconnected, 'stream disconnected');
  report.emitted = fixture.emitted;
  assert.equal(fixture.emitted, protocol.cancelAtParagraph);
  report.statusPlayback = await page.stopRuntimeStatusProbe();
  const exiting = report.statusPlayback.filter(sample => sample.visible === 'false' && sample.opacity > 0);
  report.statusExit = { sampledFrames: report.statusPlayback.length, exitingFrames: exiting.length,
    retainsPlaybackWhilePainted: exiting.every(sample => sample.active === 'true'
      && sample.glyphAnimations.some(animation => animation.state === 'running' && animation.duration === 1800)),
    slotHeights: [...new Set(report.statusPlayback.map(sample => sample.height))],
  };
  assert.ok(exiting.length > 0, 'The real status fade-out must be exercised');
  assert.equal(report.statusExit.retainsPlaybackWhilePainted, true, 'Preserve glyph playback through the painted exit');
  assert.ok(report.statusExit.slotHeights.every(height => Math.abs(height - 24) < 0.001),
    'Resident status geometry must remain fixed (subpixel transform rounding only)');
  if (protocol.callbackDiagnostic) await startCallbackWorkDiagnostic(page);
  await run.idleWindow('after-cancel', protocol.idleMs);
  if (protocol.callbackDiagnostic) report.callbackDiagnostic = await stopCallbackWorkDiagnostic(page);
  report.animationOwners = await page.animationOwners();
  report.presentation = await page.streamPresentation();
  report.persisted = await page.invoke('load_session_turns', {
    request: { session_id: 'cancel-diagnostic', workspace_id: configured.workspaceId },
  });
  await writeFile(path.join(run.root, 'after-cancel.png'), Buffer.from(await page.request(`/session/${page.session}/screenshot`), 'base64'));
  if (protocol.stackDurationSeconds > 0) {
    const main = report.webviews.find(view => view.handle === 'main');
    assert.ok(main, 'Identify the main WebContent before profiling');
    const filename = 'after-cancel-webcontent-sample.txt';
    await promisify(execFile)('sample', [String(main.pid), String(protocol.stackDurationSeconds), '1', '-file', path.join(run.root, filename)],
      { windowsHide: true, maxBuffer: 1024 * 1024 });
    report.stackSample = { pid: main.pid, filename, outsideResourceWindow: true };
  }
  report.functionalPassed = true; report.passed = true;
} catch (error) {
  report.failure = error.stack || String(error); console.error(report.failure); process.exitCode = 1;
} finally {
  await stopCallbackWorkDiagnostic(page).catch(() => undefined);
  await page.stopRuntimeStatusProbe().catch(() => undefined);
  await fixture.close(); await run.close();
}
