/** Three real PTYs: sustained output, input, scroll, resize, hide/restore and exit. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { openNativeWorkload, delay } from './native-workload-session.mjs';
import { TerminalWorkloadPage } from '../page-objects/TerminalWorkloadPage.mjs';
import { latencyDistribution, probeFrameDistributions } from '../helpers/flowchat-frame-metrics.ts';
import { startCallbackWorkDiagnostic, stopCallbackWorkDiagnostic } from './callback-work-diagnostic.mjs';

const protocol = { name: 'native-terminal-heavy-workload', version: 3, prewarmMs: 15_000, settleMs: 5000, sampleMs: 2000,
  resizeDiagnostic: process.env.OPENBITFUN_TERMINAL_RESIZE_DIAGNOSTIC === '1',
  terminals: 3, batches: 2400, batchLines: 50, intervalMs: 50, hotCycles: 4, pings: 12,
  windowMs: Number(process.env.OPENBITFUN_TERMINAL_WINDOW_MS || 30_000), hiddenMs: 45_000,
  budgets: { feedbackP95Ms: 100, hotContentP95Ms: 150, inputRafP95Ms: 100, frameP95Ms: 34, frameMaxMs: 100 } };
const run = await openNativeWorkload({ Page: TerminalWorkloadPage, protocol,
  label: process.env.OPENBITFUN_TERMINAL_LABEL || 'baseline', evidence: process.env.OPENBITFUN_TERMINAL_EVIDENCE,
  harnessFiles: ['tests/e2e/scripts/run-terminal-workload.mjs', 'tests/e2e/page-objects/TerminalWorkloadPage.mjs',
    'tests/e2e/helpers/terminal-workload.py', 'tests/e2e/helpers/flowchat-frame-metrics.ts',
    'tests/e2e/scripts/callback-work-diagnostic.mjs'] });
const { page, report } = run;
report.coverage.pilot = protocol.windowMs !== 30_000 || protocol.resizeDiagnostic;
report.coverage.instrumented = protocol.resizeDiagnostic;
report.coverage.realPty = true; report.coverage.trustedOsKeys = false;
report.limitations.push('Terminal ready requires a response from a Python fixture launched through the real PTY, not just xterm DOM.',
  'Command response latency includes driver dispatch of Enter and two RAF opportunities after xterm buffer readback; it is not key-to-pixel latency.',
  'xterm diagnostics copy public buffer data only; no terminal engine methods are invoked for actions.',
  'Enter uses a synthetic DOM KeyboardEvent with legacy keyCode because the embedded key source omits it.',
  'The resource windows include three finite output producers; their actual duration is recorded, not assumed to match requested cadence.',
  'Views close only after explicit shell exit. Closing a live view intentionally detaches its PTY and is a separate scenario.');
report.terminals = []; report.openings = []; report.interactions = []; report.responses = [];
const home = '[data-testid="nav-personal-overview"]';
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const traces = async terminal => (await readFile(terminal.trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const pidExists = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const capture = async name => writeFile(path.join(run.root, name), Buffer.from(await page.request(`/session/${page.session}/screenshot`), 'base64'));
const phase = async (name, action) => {
  await page.startFrameProbe();
  try { return await action(); }
  finally {
    const raw = await page.stopFrameProbe();
    report.interactions.push({ name, raw,
      frames: probeFrameDistributions({ frames: raw.frames.map(time => ({ time })), wheelTimes: raw.wheelTimes }) });
    await run.save();
  }
};
const liveOutput = async label => {
  for (const terminal of report.terminals) {
    const events = await traces(terminal);
    assert.ok(events.some(row => row.event === 'run'), `${label}: output started`);
    assert.ok(!events.some(row => row.event === 'done' || row.event === 'exit'), `${label}: output remains active`);
  }
};
try {
  const fixture = path.join(run.workspace, 'terminal-workload.py');
  await cp(path.join(run.repo, 'tests/e2e/helpers/terminal-workload.py'), fixture);
  await page.click(home);
  await run.idleWindow('before-terminals', protocol.windowMs);
  const workspace = await page.invoke('get_current_workspace', { request: {} });
  for (let index = 0; index < protocol.terminals; index++) {
    const id = `pty${index}`, trace = path.join(run.root, `${id}.jsonl`);
    const { terminal, timing } = await page.createTerminal(workspace.id);
    assert.ok(terminal.sceneId, 'Fixture terminal opens in its real main resource tab');
    report.openings.push({ kind: 'first-ui-entry', sessionId: terminal.sessionId, ...timing });
    const tracked = { ...terminal, id, trace };
    report.terminals.push(tracked);
    const command = `python3 ${quote(fixture)} --id ${id} --trace ${quote(trace)} --batch-lines ${protocol.batchLines} --interval-ms ${protocol.intervalMs}`;
    const ready = await page.command(terminal.sessionId, command, `WORKLOAD_READY_${id}`);
    const metadata = await page.invoke('terminal_get', { sessionId: terminal.sessionId });
    assert.ok(metadata.pid); assert.match(metadata.status, /Active/);
    const events = await traces(tracked);
    tracked.shellPid = metadata.pid; tracked.fixturePid = events.find(row => row.event === 'ready').pid;
    report.checks.push({ name: 'real-pty-ready', id, ready, metadata, trace: events });
  }
  for (const terminal of report.terminals) {
    await page.activate(terminal);
    await page.command(terminal.sessionId, `RUN ${protocol.batches}`, `WORKLOAD_RUNNING_${terminal.id}`);
  }
  const active = report.terminals.at(-1);
  await phase('input-during-three-outputs', async () => {
    for (let index = 0; index < protocol.pings; index++) {
      const token = `input${index}`;
      report.responses.push({ token, ...await page.command(active.sessionId, `PING ${token}`, `WORKLOAD_ACK_${active.id}_${token}`) });
    }
  });
  await phase('scroll-during-three-outputs', async () => {
    await page.wheel(active.sessionId, -1000);
    const before = await page.snapshotTerminal(active.sessionId);
    assert.ok(before.viewportY < before.baseY, 'Wheel must leave the output tail');
    await delay(400);
    const after = await page.snapshotTerminal(active.sessionId);
    assert.ok(after.viewportY < after.baseY, 'Output must not force a reader to the tail');
    report.checks.push({ name: 'reader-during-output', before, after });
    await page.wheel(active.sessionId, 100000, 4);
  });
  if (protocol.resizeDiagnostic) {
    await page.startResizeDiagnostic(); await startCallbackWorkDiagnostic(page);
  }
  await phase('resize-during-three-outputs', async () => {
    const raw = await page.drag('[data-openbitfun-part="navDivider"]', 'x', 70);
    assert.ok(Math.max(...raw.positions) - Math.min(...raw.positions) > 70, 'Divider actually moves');
    const before = await page.snapshotTerminal(active.sessionId);
    await page.resizeNavigation(60);
    const { changed, metadata } = await page.until(async () => {
      const state = await page.snapshotTerminal(active.sessionId);
      const value = await page.invoke('terminal_get', { sessionId: active.sessionId });
      report.resizeObservation = { before, changed: state, metadata: value };
      return state.cols !== before.cols && value.cols === state.cols && value.rows === state.rows
        && { changed: state, metadata: value };
    }, 'PTY geometry matches xterm').catch(async error => {
      await page.command(active.sessionId, 'STATE');
      await delay(200); report.resizeFixtureEvents = await traces(active);
      throw error;
    });
    await page.command(active.sessionId, 'STATE');
    const events = await page.until(async () => {
      const rows = await traces(active); return rows.some(row => row.event === 'state'
        && row.cols === changed.cols && row.rows === changed.rows) && rows;
    }, 'output process observes the new PTY geometry');
    report.checks.push({ name: 'resize-output', raw, before, changed, metadata, events });
    await page.resizeNavigation(-60);
  });
  if (protocol.resizeDiagnostic) report.resizeDiagnostic = {
    callbacks: await stopCallbackWorkDiagnostic(page), api: await page.stopResizeDiagnostic(),
  };
  for (let cycle = 0; cycle < protocol.hotCycles; cycle++) for (const terminal of report.terminals) {
    report.openings.push({ kind: 'hot-output', cycle, sessionId: terminal.sessionId, ...await page.activate(terminal) });
  }
  await liveOutput('before active window');
  const outputWindow = await run.idleWindow('three-outputs-one-visible', protocol.windowMs);
  for (const terminal of report.terminals) for (const pid of [terminal.shellPid, terminal.fixturePid]) {
    assert.ok(outputWindow.summary.processes.some(row => row.pid === pid && row.completeWindow),
      'Attributed resource samples must include the real shell and output producer');
  }
  await liveOutput('after active window');
  const activeStates = await page.snapshots();
  report.checks.push({ name: 'active-output-buffers', states: activeStates });
  await page.click(home);
  await run.idleWindow('three-outputs-hidden', protocol.hiddenMs);
  await liveOutput('after hidden window');
  const hiddenStates = await page.snapshots();
  for (const terminal of report.terminals) {
    const latestLine = states => Math.max(...states.find(row => row.sessionId === terminal.sessionId).tailLines
      .flatMap(line => [...line.matchAll(/output (\d+)/g)].map(match => Number(match[1]))));
    assert.ok(latestLine(hiddenStates) > latestLine(activeStates), 'Hidden xterm keeps receiving real output');
  }
  report.checks.push({ name: 'hidden-output-buffers', states: hiddenStates });
  for (const terminal of report.terminals) {
    report.openings.push({ kind: 'restore-output', sessionId: terminal.sessionId, ...await page.activate(terminal) });
    await page.command(terminal.sessionId, 'PING restored', `WORKLOAD_ACK_${terminal.id}_restored`);
    const metadata = await page.invoke('terminal_get', { sessionId: terminal.sessionId });
    const original = report.checks.find(row => row.name === 'real-pty-ready' && row.id === terminal.id);
    assert.equal(metadata.pid, original.metadata.pid, 'Same PTY after hiding and renderer release');
    report.checks.push({ name: 'restored-output', id: terminal.id, metadata, state: await page.snapshotTerminal(terminal.sessionId) });
  }
  for (const terminal of report.terminals) {
    const events = await page.until(async () => {
      const current = await traces(terminal); return current.some(row => row.event === 'done') && current;
    }, `bounded output ${terminal.id}`, 180_000);
    const done = events.find(row => row.event === 'done'), started = events.find(row => row.event === 'run');
    assert.equal(done.lines, protocol.batches * protocol.batchLines);
    assert.ok(!events.some(row => row.event === 'invalid-command'));
    terminal.output = { lines: done.lines, durationMs: (done.atNs - started.atNs) / 1e6 };
    await page.activate(terminal);
    await page.until(async () => (await page.snapshotTerminal(terminal.sessionId))?.tailLines
      .some(line => line.trim() === `WORKLOAD_DONE_${terminal.id}_${protocol.batches}`), `parsed final output ${terminal.id}`);
    const state = await page.snapshotTerminal(terminal.sessionId);
    assert.ok(state.bufferLength <= 10000 + state.rows, 'Keep existing finite scrollback policy');
  }
  await capture('output-complete.png');
  await run.idleWindow('three-terminals-output-complete', protocol.windowMs);
  for (const terminal of report.terminals) {
    await page.activate(terminal);
    const cursor = await page.historyCursor(terminal.sessionId);
    await page.command(terminal.sessionId, 'EXIT', `WORKLOAD_EXIT_${terminal.id}`);
    await page.waitForShellPrompt(terminal.sessionId, cursor);
    const tailMarker = `SHELL_EXIT_TAIL_${terminal.id}`;
    await page.command(terminal.sessionId, `printf '${tailMarker}\\n'; exit`);
    const metadata = await page.until(async () => {
      const value = await page.invoke('terminal_get', { sessionId: terminal.sessionId });
      return value.status.startsWith('Exited') && !pidExists(terminal.shellPid) && !pidExists(terminal.fixturePid) && value;
    }, `shell exited ${terminal.id}`);
    terminal.finalBuffer = await page.until(async () => {
      const state = await page.snapshotTerminal(terminal.sessionId);
      return state?.tailLines.some(line => line.trim() === tailMarker) && state;
    }, `final output retained after shell exit ${terminal.id}`);
    terminal.finalMetadata = metadata; terminal.processesReaped = true; terminal.events = await traces(terminal);
  }
  report.closedTabs = await page.closeClosableTabs();
  await page.click(home);
  await run.idleWindow('after-shell-exit-and-view-close', protocol.windowMs);
  assert.equal((await page.snapshots()).length, 0, 'Closed views release diagnostic registrations');
  const hot = report.openings.filter(row => row.kind === 'hot-output');
  assert.ok(hot.every(row => row.milestones.contentMs !== undefined), 'All hot views became visible');
  report.navigation = { feedback: latencyDistribution(hot.map(row => row.milestones.visibleMs)),
    content: latencyDistribution(hot.map(row => row.milestones.contentMs)) };
  report.input = latencyDistribution(report.responses.flatMap(row => row.inputRafMs));
  report.commandResponse = latencyDistribution(report.responses.map(row => row.responseMs));
  assert.ok(report.input.samples >= protocol.pings, 'Every input is observed');
  report.performanceGates = report.interactions.map(row => ({ name: row.name,
    frameP95Passed: row.frames.phase.p95Ms < protocol.budgets.frameP95Ms,
    frameMaxPassed: row.frames.phase.maxMs < protocol.budgets.frameMaxMs }));
  report.functionalPassed = true;
  report.performanceBudgetsPassed = report.performanceGates.every(row => row.frameP95Passed && row.frameMaxPassed)
    && report.navigation.feedback.p95Ms <= protocol.budgets.feedbackP95Ms
    && report.navigation.content.p95Ms <= protocol.budgets.hotContentP95Ms
    && report.input.p95Ms <= protocol.budgets.inputRafP95Ms;
  report.passed = report.functionalPassed && report.performanceBudgetsPassed;
  console.log(JSON.stringify({ functionalPassed: report.functionalPassed, performanceBudgetsPassed: report.performanceBudgetsPassed }));
} catch (error) {
  report.failure = error.stack || String(error); console.error(report.failure); process.exitCode = 1;
  report.failureTerminals = await page.snapshots().catch(() => null);
  report.failurePtys = await page.invoke('terminal_list').catch(() => null);
  await capture('failure.png').catch(() => undefined);
} finally {
  if (protocol.resizeDiagnostic && !report.resizeDiagnostic) report.resizeDiagnostic = {
    callbacks: await stopCallbackWorkDiagnostic(page).catch(() => null), api: await page.stopResizeDiagnostic().catch(() => null),
  };
  await page.stopFrameProbe().catch(() => undefined);
  await run.close();
}
