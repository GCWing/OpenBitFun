/** Real PTY, UI selection/copy, hidden DOM rendering and selection restoration. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { openNativeWorkload, delay } from './native-workload-session.mjs';
import { TerminalSelectionPage } from '../page-objects/TerminalSelectionPage.mjs';
const protocol = { name: 'native-terminal-selection', version: 4, diagnosticOnly: true, prewarmMs: 15000,
  visibleDomFallback: 'WEBGL_lose_context',
  outputWarmMs: 5000, rendererReleaseMs: 35000, hiddenObserveMs: 3000, batches: 1000, batchLines: 10, intervalMs: 100 };
const run = await openNativeWorkload({ Page: TerminalSelectionPage, protocol, label: 'selection',
  evidence: process.env.OPENBITFUN_TERMINAL_EVIDENCE,
  harnessFiles: ['tests/e2e/scripts/run-terminal-selection.mjs', 'tests/e2e/page-objects/TerminalSelectionPage.mjs',
    'tests/e2e/page-objects/TerminalWorkloadPage.mjs', 'tests/e2e/helpers/terminal-workload.py'] });
const { page, report } = run;
report.coverage.instrumented = true; report.coverage.realPty = true;
report.limitations.push('Select-all uses the product Ctrl+Shift+A shortcut. Copy dispatches xterm ClipboardEvent with a private DataTransfer; OS clipboard/key integration is not covered.',
  'Single-click dispatches DOM MouseEvents with detail=1 because the embedded driver omits the click count xterm needs.',
  'WEBGL_lose_context injects a graphics-context failure to exercise the production DOM fallback; it is not a naturally observed GPU failure.',
  'Mutation observation is diagnostic and excluded from acceptance CPU/latency measurement.');
const summarizeCopy = copy => ({ handled: copy.handled, length: copy.text.length,
  hash: createHash('sha256').update(copy.text).digest('hex') });
const screenshot = async name => writeFile(path.join(run.root, name), Buffer.from(await page.request(`/session/${page.session}/screenshot`), 'base64'));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
try {
  const workspace = await page.invoke('get_current_workspace', { request: {} });
  const { terminal } = await page.createTerminal(workspace.id);
  const fixture = path.join(run.workspace, 'terminal-workload.py'), trace = path.join(run.root, 'selection.jsonl');
  await cp(path.join(run.repo, 'tests/e2e/helpers/terminal-workload.py'), fixture);
  await page.command(terminal.sessionId, `python3 ${quote(fixture)} --id selection --trace ${quote(trace)} --batch-lines ${protocol.batchLines} --interval-ms ${protocol.intervalMs}`, 'WORKLOAD_READY_selection');
  await page.command(terminal.sessionId, `RUN ${protocol.batches}`, 'WORKLOAD_RUNNING_selection');
  await delay(protocol.outputWarmMs);
  report.shortcut = await page.selectAllTerminal(terminal.sessionId); assert.equal(report.shortcut.handled, true);
  const before = await page.copyTerminalSelection(terminal.sessionId);
  assert.ok(before.handled && before.text.includes('WORKLOAD_RUNNING_selection') && before.text.includes('selection output'));
  report.selectionBefore = summarizeCopy(before); report.bufferBefore = await page.snapshotTerminal(terminal.sessionId);
  await screenshot('selection-visible.png');
  assert.ok(report.bufferBefore.rendererCanvases > 0, 'The initial renderer must use WebGL for context-loss coverage');
  await page.loseWebglContext(terminal.sessionId);
  await page.until(async () => {
    const state = await page.domSelection(terminal.sessionId);
    return state.visible && state.canvases === 0 && state.renderedOutput && state.selectionRects.some(rect => rect.width > 0 && rect.height > 0);
  }, 'visible selected DOM fallback');
  await page.presentationFrames();
  report.domFocused = await page.domSelection(terminal.sessionId);
  await page.blurTerminal(); report.domBlurred = await page.domSelection(terminal.sessionId);
  assert.equal(report.domBlurred.focused, false, 'DOM selection follows blur');
  assert.equal(report.domBlurred.rendererFocused, false, 'DOM renderer follows blur');
  const fallbackCopy = await page.copyTerminalSelection(terminal.sessionId);
  assert.ok(fallbackCopy.handled && fallbackCopy.text.startsWith(before.text.trimEnd()), 'DOM fallback retains the selected history');
  await page.presentationFrames(); report.domRefocused = await page.domSelection(terminal.sessionId);
  assert.equal(report.domRefocused.focused, true, 'DOM selection follows focus');
  assert.equal(report.domRefocused.rendererFocused, true, 'DOM renderer follows focus');
  assert.equal(report.domRefocused.selectionRects[0]?.background, report.domFocused.selectionRects[0]?.background,
    'Selection focus color is restored');
  assert.notEqual(report.domRefocused.selectionRects[0]?.background, report.domBlurred.selectionRects[0]?.background,
    'Focused and inactive selection retain their distinct default-theme colors');
  report.selectionFallback = summarizeCopy(fallbackCopy);
  await screenshot('selection-dom-fallback.png');
  await page.click('[data-testid="nav-personal-overview"]'); await delay(protocol.rendererReleaseMs);
  const hidden = await page.snapshotTerminal(terminal.sessionId);
  assert.equal(hidden.visible, false); assert.equal(hidden.rendererCanvases, 0);
  await page.execute(selector => {
    const rows = document.querySelector(`${selector} .xterm-rows`);
    if (!rows) throw new Error('DOM fallback rows are not available');
    let mutations = 0;
    const observer = new MutationObserver(records => { mutations += records.length; });
    observer.observe(rows, { subtree: true, childList: true, characterData: true, attributes: true });
    window.__terminalSelectionRows = { stop: () => { observer.disconnect(); return mutations; } };
  }, page.root(terminal.sessionId));
  await delay(protocol.hiddenObserveMs);
  report.hiddenRowMutations = await page.execute(() => { const count = window.__terminalSelectionRows.stop(); delete window.__terminalSelectionRows; return count; });
  report.hiddenBuffer = await page.snapshotTerminal(terminal.sessionId);
  assert.ok(report.hiddenBuffer.baseY > report.bufferBefore.baseY, 'Hidden terminal continues parsing output');
  report.restore = await page.activate(terminal);
  const after = await page.copyTerminalSelection(terminal.sessionId);
  assert.ok(after.handled && after.text.startsWith(before.text.trimEnd()), 'Selection and copied history survive hiding and renderer replacement');
  assert.ok(after.text.length > before.text.length, 'Select-all includes newer output');
  report.selectionAfter = summarizeCopy(after);
  await screenshot('selection-restored.png');
  await page.clickTerminalText(terminal.sessionId);
  const cleared = await page.copyTerminalSelection(terminal.sessionId);
  assert.equal(cleared.text.length, 0, 'Single-click clears the selection'); report.selectionCleared = summarizeCopy(cleared);
  const events = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(!events.some(event => event.event === 'done'), 'Fixture is still producing during selection checks');
  const cursor = await page.historyCursor(terminal.sessionId);
  await page.command(terminal.sessionId, 'EXIT', 'WORKLOAD_EXIT_selection');
  await page.waitForShellPrompt(terminal.sessionId, cursor);
  await page.command(terminal.sessionId, 'exit');
  await page.until(async () => (await page.invoke('terminal_get', { sessionId: terminal.sessionId })).status.startsWith('Exited'), 'shell exit');
  await page.closeClosableTabs();
  report.functionalPassed = true;
  assert.equal(report.hiddenRowMutations, 0, 'Paused terminal rows must not redraw for the held selection');
  report.passed = true;
} catch (error) {
  report.failure = error.stack || String(error); process.exitCode = 1; console.error(report.failure);
  await screenshot('failure.png').catch(() => undefined);
} finally {
  await page.execute(() => { window.__terminalSelectionRows?.stop(); delete window.__terminalSelectionRows; }).catch(() => undefined);
  await run.close();
}
