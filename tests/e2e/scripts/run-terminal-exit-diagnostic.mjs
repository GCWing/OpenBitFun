/** Isolate child completion versus shell input readiness and actual PTY exit. */
import path from 'node:path';
import { cp, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openNativeWorkload, delay } from './native-workload-session.mjs';
import { TerminalWorkloadPage } from '../page-objects/TerminalWorkloadPage.mjs';
const protocol = { name: 'terminal-exit-diagnostic', version: 2, diagnosticOnly: true, prewarmMs: 15_000 };
const run = await openNativeWorkload({ Page: TerminalWorkloadPage, label: 'diagnostic', protocol,
  evidence: process.env.OPENBITFUN_TERMINAL_EVIDENCE,
  harnessFiles: ['tests/e2e/scripts/run-terminal-exit-diagnostic.mjs', 'tests/e2e/page-objects/TerminalWorkloadPage.mjs',
    'tests/e2e/helpers/terminal-workload.py'] });
const { page, report } = run;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const traceWrites = () => page.execute(() => {
  const api = window.__OPENBITFUN_STARTUP_TRACE__?.snapshot()?.api;
  return { at: performance.now(), aggregate: api?.byCommand?.find(row => row.command === 'terminal_write'),
    calls: api?.calls?.filter(row => row.command === 'terminal_write') };
});
try {
  const workspace = await page.invoke('get_current_workspace', { request: {} });
  const { terminal } = await page.createTerminal(workspace.id);
  const fixture = path.join(run.workspace, 'terminal-workload.py'), trace = path.join(run.root, 'exit.jsonl');
  await cp(path.join(run.repo, 'tests/e2e/helpers/terminal-workload.py'), fixture);
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  await page.command(terminal.sessionId, `python3 ${quote(fixture)} --id exit --trace ${quote(trace)}`, 'WORKLOAD_READY_exit');
  const metadata = await page.invoke('terminal_get', { sessionId: terminal.sessionId });
  const cursor = await page.historyCursor(terminal.sessionId);
  await page.command(terminal.sessionId, 'EXIT', 'WORKLOAD_EXIT_exit');
  report.prompt = await page.waitForShellPrompt(terminal.sessionId, cursor);
  report.writeTrace = [{ stage: 'before-shell-exit', value: await traceWrites() }];
  report.enterDispatch = await page.command(terminal.sessionId, "builtin printf 'SHELL_EXIT_TAIL\\n'; builtin exit");
  await delay(500);
  report.writeTrace.push({ stage: 'after-shell-exit', value: await traceWrites() });
  if (alive(metadata.pid)) {
    // kill(pid, 0) also succeeds for an unreaped zombie. Record OS state before
    // classifying this as lost input or a live shell.
    const exec = promisify(execFile);
    report.shellProcess = (await exec('ps', ['-p', String(metadata.pid), '-o', 'pid,ppid,stat,wchan,comm'], { windowsHide: true })).stdout;
  }
  const history = await page.invoke('terminal_get_history', { sessionId: terminal.sessionId, afterOffset: cursor });
  await writeFile(path.join(run.root, 'post-exit-output.json'), JSON.stringify(history));
  await page.until(async () => {
    const current = await page.invoke('terminal_get', { sessionId: terminal.sessionId });
    report.exitObservation = { current, shellPidExists: alive(metadata.pid) };
    return current.status.startsWith('Exited') && !report.exitObservation.shellPidExists;
  }, 'actual shell process and PTY status exit');
  report.finalBuffer = await page.until(async () => {
    const state = await page.snapshotTerminal(terminal.sessionId);
    return state?.tailLines.some(line => line.trim() === 'SHELL_EXIT_TAIL') && state;
  }, 'final shell output remains readable after process exit');
  report.functionalPassed = true; report.passed = true;
} catch (error) {
  report.failure = error.stack || String(error); process.exitCode = 1; console.error(report.failure);
  report.terminals = await page.snapshots().catch(() => null);
  report.ptys = await page.invoke('terminal_list').catch(() => null);
  await writeFile(path.join(run.root, 'failure.png'), Buffer.from(await page.request(`/session/${page.session}/screenshot`), 'base64')).catch(() => undefined);
} finally {
  await run.close();
}
