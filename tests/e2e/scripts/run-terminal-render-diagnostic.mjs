/** Diagnostic attribution only; never an acceptance CPU/latency comparison. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openNativeWorkload, delay } from './native-workload-session.mjs';
import { TerminalWorkloadPage } from '../page-objects/TerminalWorkloadPage.mjs';
import { startCallbackWorkDiagnostic, stopCallbackWorkDiagnostic } from './callback-work-diagnostic.mjs';
const protocol = { name: 'terminal-render-attribution', version: 1, diagnosticOnly: true,
  prewarmMs: 15000, sampleMs: 2000, terminals: 3, batches: 3000, batchLines: 50, intervalMs: 50,
  warmOutputMs: 25000, hiddenRendererWaitMs: 30000, settleMs: 5000, observeMs: 12000 };
const run = await openNativeWorkload({ Page: TerminalWorkloadPage, label: 'diagnostic', protocol,
  evidence: process.env.OPENBITFUN_TERMINAL_EVIDENCE,
  harnessFiles: ['tests/e2e/scripts/run-terminal-render-diagnostic.mjs', 'tests/e2e/page-objects/TerminalWorkloadPage.mjs',
    'tests/e2e/helpers/terminal-workload.py', 'tests/e2e/scripts/callback-work-diagnostic.mjs'] });
const { page, report } = run;
report.coverage.instrumented = true; report.coverage.realPty = true;
report.limitations.push('Callback wrappers and mutation observers add overhead; resource figures are diagnostic, not optimization acceptance.',
  'A callback group records its first registration stack, not the origin of every subsequent registration.',
  'The output fixture intentionally exits while work remains after attribution; this does not replace bounded-completion coverage.');
report.terminals = []; report.attribution = [];
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const traces = async terminal => (await readFile(terminal.trace, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const pidExists = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const live = async () => {
  for (const terminal of report.terminals) {
    const events = await traces(terminal);
    assert.ok(events.some(row => row.event === 'run') && !events.some(row => row.event === 'done' || row.event === 'exit'));
  }
};
const observe = async name => {
  await delay(protocol.settleMs); await live();
  const before = await page.snapshots();
  await startCallbackWorkDiagnostic(page);
  try { await run.measureAction(name, () => delay(protocol.observeMs)); }
  finally { report.attribution.push({ name, before, callbacks: await stopCallbackWorkDiagnostic(page), after: await page.snapshots() }); }
  await live(); await run.save(); console.log(`Terminal attribution completed: ${name}`);
};
try {
  const workspace = await page.invoke('get_current_workspace', { request: {} });
  const fixture = path.join(run.workspace, 'terminal-workload.py');
  await cp(path.join(run.repo, 'tests/e2e/helpers/terminal-workload.py'), fixture);
  for (let index = 0; index < protocol.terminals; index++) {
    const { terminal } = await page.createTerminal(workspace.id);
    const id = `trace${index}`, trace = path.join(run.root, `${id}.jsonl`);
    await page.command(terminal.sessionId, `python3 ${quote(fixture)} --id ${id} --trace ${quote(trace)} --batch-lines ${protocol.batchLines} --interval-ms ${protocol.intervalMs}`, `WORKLOAD_READY_${id}`);
    const metadata = await page.invoke('terminal_get', { sessionId: terminal.sessionId });
    report.terminals.push({ ...terminal, id, trace, shellPid: metadata.pid });
  }
  for (const terminal of report.terminals) {
    await page.activate(terminal);
    await page.command(terminal.sessionId, `RUN ${protocol.batches}`, `WORKLOAD_RUNNING_${terminal.id}`);
  }
  const active = report.terminals.at(-1);
  await delay(protocol.warmOutputMs);
  await observe('visible');
  await page.click('[data-testid="nav-personal-overview"]');
  await delay(protocol.hiddenRendererWaitMs);
  await observe('hidden-after-renderer-release');
  await page.activate(active);
  await observe('visible-again');
  const mainPid = report.webviews.find(view => view.handle === 'main').pid;
  try {
    await promisify(execFile)('sample', [String(mainPid), '1', '1', '-file', path.join(run.root, 'main-sample.txt')], { windowsHide: true });
  } catch (error) { report.nativeSampleUnavailable = error.message; }
  for (const terminal of report.terminals) {
    await page.activate(terminal);
    const cursor = await page.historyCursor(terminal.sessionId);
    await page.command(terminal.sessionId, 'EXIT', `WORKLOAD_EXIT_${terminal.id}`);
    await page.waitForShellPrompt(terminal.sessionId, cursor);
    await page.command(terminal.sessionId, 'exit');
    await page.until(async () => (await page.invoke('terminal_get', { sessionId: terminal.sessionId })).status.startsWith('Exited')
      && !pidExists(terminal.shellPid), 'shell exits after diagnostic');
    terminal.events = await traces(terminal);
  }
  await page.closeClosableTabs();
  report.functionalPassed = true; report.passed = true;
} catch (error) {
  report.failure = error.stack || String(error); process.exitCode = 1; console.error(report.failure);
} finally { await stopCallbackWorkDiagnostic(page).catch(() => undefined); await run.close(); }
