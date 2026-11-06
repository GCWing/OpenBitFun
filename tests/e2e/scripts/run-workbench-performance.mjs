/** Isolated, packaged native E2E baseline for navigation, resizing and retained resources. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkbenchPerformancePage } from '../page-objects/WorkbenchPerformancePage.mjs';
import { desktopFrontendProfile } from './desktop-frontend-profile.mjs';

const exec = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const protocol = {
  version: 3,
  repeats: Number(process.env.OPENBITFUN_WORKBENCH_REPEATS || 8),
  panelsOnly: process.env.OPENBITFUN_WORKBENCH_PANELS_ONLY === '1',
  stateGuards: process.env.OPENBITFUN_WORKBENCH_STATE_GUARDS !== '0',
  stateGuardOrder: 'after-all-timed-windows',
  motionContract: process.env.OPENBITFUN_WORKBENCH_MOTION_CONTRACT === '1',
  visualGuards: true,
  prewarmMs: 7000, prepareNavigationMs: 700,
  idleMs: Number(process.env.OPENBITFUN_WORKBENCH_IDLE_MS || 30_000),
  settleMs: Number(process.env.OPENBITFUN_WORKBENCH_SETTLE_MS || 5000),
  idleSequence: ['home-active', 'todos-static', 'home-return'],
  layout: process.env.OPENBITFUN_WORKBENCH_LAYOUT || 'split',
  side: process.env.OPENBITFUN_WORKBENCH_SIDE || 'right',
  terminalPosition: process.env.OPENBITFUN_WORKBENCH_TERMINAL_POSITION || 'right',
};
for (const key of ['repeats', 'idleMs', 'settleMs']) assert.ok(Number.isFinite(protocol[key]) && protocol[key] >= 0, `Invalid ${key}`);
const protocolHash = createHash('sha256').update(JSON.stringify(protocol)).digest('hex');
const harnessHash = createHash('sha256').update(await readFile(fileURLToPath(import.meta.url)))
  .update(await readFile(path.join(repo, 'tests/e2e/scripts/desktop-frontend-profile.mjs')))
  .update(await readFile(path.join(repo, 'scripts/web-font-profile.mjs')))
  .update(await readFile(path.join(repo, 'tests/e2e/page-objects/WorkbenchPerformancePage.mjs')))
  .update(await readFile(path.join(repo, 'tests/e2e/scripts/verify-subagent-motion.mjs')))
  .update(await readFile(path.join(repo, 'tests/e2e/scripts/workbench-performance-visuals.mjs'))).digest('hex');
const root = process.env.OPENBITFUN_WORKBENCH_EVIDENCE || await mkdtemp(path.join(os.tmpdir(), 'openbitfun-workbench-perf-'));
await mkdir(root, { recursive: true });
const home = path.join(root, 'home'), user = path.join(root, 'user'), workspace = path.join(root, 'workspace');
await Promise.all([home, user, workspace].map(directory => mkdir(directory, { recursive: true })));
const source = path.resolve(process.env.OPENBITFUN_E2E_FRONTEND_DIR || path.join(repo, 'dist'));
const revision = await readFile(path.join(source, 'frontend-revision.json'), 'utf8');
const fontProfile = desktopFrontendProfile(await readFile(path.join(source, 'index.html'), 'utf8'), {
  expectedProfile: process.env.OPENBITFUN_E2E_EXPECTED_FONT_PROFILE,
});
await cp(source, path.join(root, 'frontend'), { recursive: true });
assert.equal(await readFile(path.join(source, 'frontend-revision.json'), 'utf8'), revision);
const binarySource = process.env.OPENBITFUN_E2E_DESKTOP_BINARY || path.join(repo, 'target/debug/openbitfun-desktop');
const binary = path.join(root, 'openbitfun-desktop');
await cp(binarySource, binary);
const binarySha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
const command = (file, args, options = {}) => {
  const result = spawnSync(file, args, { cwd: repo, windowsHide: true, encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${file} failed`);
  return result.stdout.trim();
};
await writeFile(path.join(workspace, 'README.md'), '# Workbench performance fixture\n\nA stable local E2E workspace.\n');
await writeFile(path.join(workspace, 'sample.ts'), Array.from({ length: 1200 }, (_, i) => `export const value${i} = ${i};`).join('\n'));
command('git', ['init', '-q', workspace]);
command(process.execPath, [path.join(repo, 'tests/e2e/scripts/generate-long-session-fixture.mjs'),
  '--workspace', workspace, '--openbitfun-home', home, '--openbitfun-user-root', user,
  '--session-prefix', 'workbench-perf', '--session-count', '2', '--long-turns', '80',
  '--assistant-chars', '4000', '--tool-items', '3', '--tool-result-chars', '6000']);

const report = {
  schemaVersion: 2, label: process.env.OPENBITFUN_WORKBENCH_LABEL || 'baseline',
  protocol, protocolHash, harnessHash,
  sourceCommit: command('git', ['rev-parse', 'HEAD']), frontend: JSON.parse(revision), binarySha256,
  nativeProfile: process.env.OPENBITFUN_E2E_NATIVE_PROFILE || 'debug',
  environment: { platform: process.platform, arch: process.arch, cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model, memoryBytes: os.totalmem(), osRelease: os.release(), fontProfile },
  coverage: { nativeDesktop: true, packagedFrontend: true, isolatedProfile: true,
    fullNavigation: !protocol.panelsOnly,
    terminalPosition: process.env.OPENBITFUN_WORKBENCH_TERMINAL_POSITION || 'right',
    paneLayout: process.env.OPENBITFUN_WORKBENCH_LAYOUT || 'split',
    contentSide: process.env.OPENBITFUN_WORKBENCH_SIDE || 'right',
    trustedOperatingSystemPointer: false,
    remoteWorkspace: false, peerDevice: false, remoteControl: false, detachedDispatch: false },
  limitations: ['RAF measures presentation opportunities, not GPU completion or every composited pixel.',
    'macOS GPU counters are system-wide; new WebKit processes are candidates, not proven application attribution.',
    'First UI entry may have prewarmed code; resource timings distinguish it from cold code loading.',
    'Native debug host timings are not release-host backend benchmarks. JS assets are production bundled.'],
  targets: { feedbackP95Ms: 100, hotContentP95Ms: 150, ordinaryFirstContentMs: 500,
    dragFrameP95Ms: 34, dragFrameMaxMs: 100, blankFrames: 0, stateLoss: 0 },
  samples: [], resourceSamples: [], resourceWindows: [], checks: [], passed: false,
};
const save = () => writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
await save();
console.log(`Workbench performance evidence: ${root}`);
const ps = async () => (await exec('ps', ['-axo', 'pid=,ppid=,rss=,time=,comm='], { windowsHide: true })).stdout;
const parseProcesses = text => text.split('\n').flatMap(line => {
  const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d:.-]+)\s+(.+)$/);
  if (!match) return [];
  const times = match[4].replace('-', ':').split(':').map(Number);
  const cpuMs = times.reverse().reduce((sum, value, i) => sum + value * [1000, 60000, 3600000, 86400000][i], 0);
  return [{ pid: Number(match[1]), ppid: Number(match[2]), rssMiB: Number(match[3]) / 1024, cpuMs, command: match[5] }];
});
const initialPids = new Set(parseProcesses(await ps()).map(item => item.pid));
let phase = 'before-launch', app, sampling, sampleTimer, trackedWebKitPids;
const sampleResources = async () => {
  if (sampling) return sampling;
  const samplePhase = phase;
  sampling = (async () => {
  try {
    const at = Date.now();
    const processRows = parseProcesses(await ps()).filter(item => item.pid === app?.pid
      || (trackedWebKitPids ? trackedWebKitPids.has(item.pid) : !initialPids.has(item.pid) && /com\.apple\.WebKit\.(WebContent|GPU|Networking)$/.test(item.command)));
    let gpu = null;
    if (process.platform === 'darwin') {
      const { stdout } = await exec('ioreg', ['-r', '-c', 'AGXAccelerator', '-l'], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
      gpu = Object.fromEntries(['Device Utilization %', 'Renderer Utilization %', 'Tiler Utilization %', 'In use system memory', 'Alloc system memory']
        .map(key => [key, Number(stdout.match(new RegExp(`"${key}"\\s*=\\s*(\\d+)`))?.[1] ?? NaN)])
        .filter(([, value]) => Number.isFinite(value)));
    }
    const row = { at, phase: samplePhase, loadAverage: os.loadavg(), processes: processRows.map(({ command: name, ...item }) => ({
      ...item, role: item.pid === app?.pid ? 'host' : name.split('/').at(-1), attribution: item.pid === app?.pid ? 'owned' : 'new-process-candidate' })), gpu };
    report.resourceSamples.push(row);
    return row;
  } catch (error) { report.resourceSampleError = String(error); throw error; }
  })();
  try { return await sampling; } finally { sampling = undefined; }
};
await sampleResources();
const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const log = await open(path.join(root, 'desktop.log'), 'w');
const launchedAt = Date.now();
app = spawn(binary, [], { cwd: repo, windowsHide: true, stdio: ['ignore', log.fd, log.fd], env: {
  ...process.env, OPENBITFUN_HOME: home, OPENBITFUN_E2E_HOME: home, OPENBITFUN_USER_ROOT: user, OPENBITFUN_E2E_USER_ROOT: user,
  OPENBITFUN_E2E_STORAGE_GUARD: '1', OPENBITFUN_E2E_PACKAGED_FRONTEND: '1',
  OPENBITFUN_E2E_FRONTEND_DIR: path.join(root, 'frontend'), OPENBITFUN_E2E_LOG_DIR: path.join(root, 'logs'),
  OPENBITFUN_WEBDRIVER_PORT: String(port), OPENBITFUN_WEBDRIVER_LABEL: 'main', OPENBITFUN_PERF_TRACE: '1',
  WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'webview'),
} });
app.on('error', error => { report.launchError = String(error); });
phase = 'startup';
sampleTimer = setInterval(() => { void sampleResources().catch(() => undefined); }, 1000);
const page = new WorkbenchPerformancePage(`http://127.0.0.1:${port}`);
const scene = id => `[data-testid="scene-viewport-scene"][data-scene-id="${id}"][data-scene-active="true"]`;
const homeButton = '[data-testid="nav-personal-overview"]';
const tab = id => `.openbitfun-scene-bar__item[data-scene-tab-id="${id}"] [role="tab"]`;
const summarizeFrames = frames => {
  const values = frames.slice(1).map((time, i) => time - frames[i]).sort((a, b) => a - b);
  const quantile = p => values[Math.max(0, Math.ceil(values.length * p) - 1)] ?? null;
  return { samples: values.length, p50Ms: quantile(.5), p95Ms: quantile(.95), maxMs: values.at(-1) ?? null,
    over33Ms: values.filter(value => value > 1000 / 30).length, over50Ms: values.filter(value => value > 50).length,
    over100Ms: values.filter(value => value > 100).length };
};
async function measure(name, trigger, rootSelector, kind) {
  phase = `${kind}:${name}`;
  const before = await page.snapshot();
  const startedAt = Date.now();
  const result = await page.measureOpen(trigger, rootSelector);
  const after = await page.snapshot();
  const commands = (after.api?.byCommand ?? []).flatMap(entry => {
    const old = before.api?.byCommand.find(item => item.command === entry.command);
    const count = entry.count - (old?.count ?? 0);
    return count ? [{ command: entry.command, count, totalDurationMs: entry.totalDurationMs - (old?.totalDurationMs ?? 0),
      failures: entry.failureCount - (old?.failureCount ?? 0) }] : [];
  });
  report.samples.push({ name, kind, startedAt, endedAt: Date.now(), ...result, frames: summarizeFrames(result.frames), commands,
    domNodes: after.domNodes, animations: after.animations.length,
    newlyLoadedResources: after.resources.filter(entry => !before.resources.some(old => old.name === entry.name)),
  });
  await save();
  console.log(`${kind} ${name}: ${JSON.stringify(result.milestones)}`);
  assert.ok(result.milestones.presentedMs !== undefined, `${name} must become visible`);
  assert.ok(result.milestones.contentMs !== undefined, `${name} must finish its loading state`);
}
async function resourceWindow(name, selector) {
  phase = `settle:${name}`;
  await page.until(() => page.visible(selector), `${name} visible`);
  await new Promise(resolve => setTimeout(resolve, protocol.settleMs));
  const before = await page.snapshot();
  if (sampling) await sampling;
  phase = `resource:${name}`;
  const start = await sampleResources();
  const startedAt = Date.now();
  console.log(`resource ${name} started`);
  await new Promise(resolve => setTimeout(resolve, protocol.idleMs));
  if (sampling) await sampling;
  const end = await sampleResources();
  phase = `snapshot:${name}`;
  const after = await page.snapshot();
  report.resourceWindows.push({ name, startedAt, endedAt: end.at, start, end, before, after });
  await save();
  console.log(`resource ${name} completed`);
}
try {
  await page.until(async () => (await page.request('/status')).ready, 'embedded driver', 120_000);
  await page.connect();
  await page.request(`/session/${page.session}/timeouts`, { script: 40_000 });
  await page.ready();
  report.shellReadyWallMs = Date.now() - launchedAt;
  report.startup = await page.execute(() => window.__OPENBITFUN_STARTUP_TRACE__?.snapshot());
  report.bootSnapshot = await page.snapshot();
  phase = 'startup-prewarm';
  await new Promise(resolve => setTimeout(resolve, protocol.prewarmMs));
  report.prewarmSnapshot = await page.snapshot();
  if (report.coverage.terminalPosition === 'bottom') {
    // Seed this fixture preference through the native config owner, preserving
    // the current persisted schema and defaults. Measured actions use controls.
    await page.execute(async () => window.__TAURI_INTERNALS__.invoke('set_config', {
      request: { path: 'terminal.terminal_panel_position', value: 'bottom' },
    }));
  }
  // Fixture preference setup happens before measurements. All measured navigation uses actual clicks.
  await page.execute((layout, side) => {
    localStorage.setItem('openbitfun:appearance:sidebar', JSON.stringify({ version: 1,
      pinnedIds: ['builtin.todos', 'builtin.agents', 'builtin.assistants', 'builtin.miniapps', 'builtin.skills.installed', 'builtin.insights'] }));
    localStorage.setItem('openbitfun:sessionPaneDisplayMode', layout);
    localStorage.setItem('openbitfun:sessionContentSide', side);
  }, report.coverage.paneLayout, report.coverage.contentSide);
  await page.request(`/session/${page.session}/refresh`, {});
  // Refresh is asynchronous in the embedded driver; do not accept the outgoing DOM.
  await new Promise(resolve => setTimeout(resolve, 1000));
  await page.ready();
  await page.until(() => page.visible('[data-testid="nav-builtin.miniapps"]'), 'pinned navigation after reload');
  report.initial = await page.snapshot();
  const startupProcesses = await sampleResources();
  trackedWebKitPids = new Set(startupProcesses.processes.filter(item => item.role !== 'host').map(item => item.pid));
  report.processAttribution = { policy: 'fixed-new-WebKit-candidates-after-initialization',
    candidates: startupProcesses.processes, limitations: 'Candidates are not proven host ownership; unrelated later launches are excluded.' };
  if (!protocol.panelsOnly) {
    const destinations = [
      ['personal-overview', homeButton], ['todos', '[data-testid="nav-todos-btn"]'],
      ['agents', '[data-testid="nav-builtin.agents"]'], ['assistant', '[data-testid="nav-builtin.assistants"]'],
      ['miniapps', '[data-testid="nav-builtin.miniapps"]'], ['skills', '[data-testid="nav-builtin.skills.installed"]'],
      ['insights', '[data-testid="nav-builtin.insights"]'],
    ];
    const repeats = protocol.repeats;
    for (let round = 0; round <= repeats; round++) for (const [name, trigger] of destinations) {
      if (round || name !== 'personal-overview') {
        await page.click(name === 'personal-overview' ? '[data-testid="nav-todos-btn"]' : homeButton);
        await page.execute(ms => new Promise(resolve => setTimeout(resolve, ms)), protocol.prepareNavigationMs);
      }
      await measure(name, trigger, scene(name), round === 0 ? 'first-ui-entry' : 'repeat-entry');
    }
    phase = 'settings';
    await page.click('[data-testid="nav-footer-settings-item"]');
    await page.until(() => page.visible('[data-testid="nav-settings-open-item"]'), 'settings menu');
    await measure('settings', '[data-testid="nav-settings-open-item"]', scene('settings'), 'first-ui-entry');
    await page.until(() => page.visible('[data-testid="settings-nav-page"]'), 'settings navigation');
    const settings = await page.execute(() => [...document.querySelectorAll('[data-testid="settings-nav-page"]')].map(element => element.getAttribute('data-settings-page')));
    for (const id of settings) await measure(id, `[data-testid="settings-nav-page"][data-settings-page="${id}"]`,
      `.openbitfun-settings-scene[data-settings-page="${id}"] [data-testid="settings-scene-content"]`, 'settings-first-entry');
    for (const id of settings) await measure(id, `[data-testid="settings-nav-page"][data-settings-page="${id}"]`,
      `.openbitfun-settings-scene[data-settings-page="${id}"] [data-testid="settings-scene-content"]`, 'settings-repeat-entry');
    await page.click(tab('personal-overview'));
    await page.until(() => page.visible(homeButton), 'main navigation restored');
    await measure('project-resources', '[data-testid="nav-workspace-project-resources-btn"]',
      '.project-resources', 'first-ui-entry');
    await page.click(tab('personal-overview'));
    await page.click('[data-testid="nav-workspace-menu-btn"]');
    await measure('workspace-files', '[data-testid="nav-workspace-menu-open-directory"]',
      '[role="treeitem"][data-file-path$="sample.ts"]', 'first-ui-entry');
    await measure('code-editor', '[role="treeitem"][data-file-path$="sample.ts"]',
      '.monaco-editor', 'first-ui-entry');
    await page.until(() => page.execute(() => [...document.querySelectorAll('.monaco-editor')]
      .some(editor => editor.checkVisibility({ checkVisibilityCSS: true }) && editor.textContent.includes('value0'))), 'fixture code rendered');
    report.fileSceneTab = await page.execute(() => document.querySelector('.openbitfun-scene-bar__item[title$="sample.ts"]')?.getAttribute('data-scene-tab-id'));
    await page.click(tab('personal-overview'));
  }
  const sessionTrigger = '[data-testid="nav-session-item"][data-session-id="workbench-perf-000"]';
  await page.until(() => page.visible(sessionTrigger), 'fixture session');
  await measure('long-session', sessionTrigger, `${scene('session')} [data-testid="flowchat-container"]`, 'first-ui-entry');
  await page.until(() => page.execute(() => !document.querySelector('.history-session-loading:not([data-history-loading-phase="idle"])')), 'history settled');
  const input = '[data-testid="chat-input-textarea"]';
  const element = await page.request(`/session/${page.session}/element`, { using: 'css selector', value: input });
  await page.request(`/session/${page.session}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/value`, { text: 'Workbench performance draft must survive navigation.' });
  const toggle = '[data-testid="workbench-toggle-panel"]';
  if (await page.execute(selector => document.querySelector(selector)?.getAttribute('aria-pressed') !== 'true', toggle)) await page.click(toggle);
  report.layoutGeometry = await page.execute(() => {
    const root = document.querySelector('.openbitfun-workbench-layout__body > [data-openbitfun-part="root"]');
    const dock = root.querySelector('[data-scene-active="true"] [data-openbitfun-part="primaryDock"]');
    return { layout: root.dataset.layout, side: root.dataset.secondarySide,
      rootWidth: root.getBoundingClientRect().width, dockWidth: dock?.getBoundingClientRect().width,
      secondaryWidth: parseFloat(getComputedStyle(root).getPropertyValue('--_split-view-right-size')) };
  });
  assert.equal(report.layoutGeometry.layout, report.coverage.paneLayout);
  assert.equal(report.layoutGeometry.side, report.coverage.contentSide);
  if (report.coverage.paneLayout === 'overlay') {
    assert.ok(Math.abs(report.layoutGeometry.rootWidth - report.layoutGeometry.secondaryWidth
      - report.layoutGeometry.dockWidth - 1) <= 2, 'overlay composer must retain the exposed primary width');
  }
  const dragTargets = [ ['navigation', '[data-openbitfun-part="navDivider"]', 'x', 70],
    ['content-split', '[data-split-divider] [role="separator"], [data-openbitfun-component="split-view"] [role="separator"]', 'x', 100] ];
  report.drags = [];
  for (const [name, selector, axis, distance] of dragTargets) {
    await page.until(() => page.visible(selector), `${name} divider`);
    for (let repeat = 0; repeat < 4; repeat++) {
      phase = `drag:${name}`;
      const { frames, positions } = await page.drag(selector, axis, distance);
      const travel = Math.max(...positions) - Math.min(...positions);
      report.drags.push({ name, repeat, frames: summarizeFrames(frames), travelPx: travel,
        restoredPositionDeltaPx: positions.at(-1) - positions[0] });
      await save();
      assert.ok(travel > 20, `${name} must actually resize during the pointer gesture (${travel}px)`);
      assert.ok(Math.abs(positions.at(-1) - positions[0]) <= 2, `${name} must return to its original position`);
      console.log(`drag ${name} ${repeat}: ${JSON.stringify(report.drags.at(-1).frames)}`);
    }
  }
  // Optional causal experiment, never included in an unmodified-product baseline.
  if (process.env.OPENBITFUN_WORKBENCH_CONTAINMENT_DIAGNOSTIC) {
    report.coverage.experimentalStyleOverride = true;
    await page.execute(() => {
      const style = document.createElement('style');
      style.id = 'workbench-perf-experimental-containment';
      style.textContent = '.openbitfun-scene-viewport__scene:not(.openbitfun-scene-viewport__scene--visible) { content-visibility: hidden; }';
      document.head.appendChild(style);
    });
    report.containmentDiagnostic = [];
    for (const [name, selector, axis, distance] of dragTargets) for (let repeat = 0; repeat < 2; repeat++) {
      phase = `experimental-containment:${name}`;
      const { frames, positions } = await page.drag(selector, axis, distance);
      report.containmentDiagnostic.push({ name, repeat, frames: summarizeFrames(frames),
        travelPx: Math.max(...positions) - Math.min(...positions) });
      await save();
    }
    await page.execute(() => document.getElementById('workbench-perf-experimental-containment')?.remove());
  }
  for (let cycle = 0; cycle < 4; cycle++) {
    await page.click('[data-testid="workbench-maximize-panel"]');
    await page.click('[data-testid="workbench-maximize-panel"]');
    await page.click(toggle);
    await page.click(toggle);
  }
  report.checks.push('Both dividers visibly moved; four maximize/restore and collapse/restore cycles completed');
  await page.click('[data-testid="nav-workspace-menu-btn"]');
  await measure('terminal', '[data-testid="nav-workspace-menu-create-terminal"]', '.xterm-screen', 'first-ui-entry');
  const bottom = '.openbitfun-bottom-pane-resizer:not([aria-hidden="true"])';
  if (report.coverage.terminalPosition === 'bottom') {
    // The current workspace menu explicitly opens in the contextual canvas.
    // Seed the legacy bottom host through its production event contract using
    // that real PTY. This covers bottom-host resizing, not a user opening flow.
    phase = 'setup:bottom-terminal';
    report.coverage.bottomTerminalFixtureEvent = true;
    await page.execute(() => {
      const sessionId = document.querySelector('.openbitfun-terminal[data-session-id]')?.dataset.sessionId;
      if (!sessionId) throw new Error('The opened native terminal must have a session id');
      window.dispatchEvent(new CustomEvent('bottom-terminal-create-tab', { detail: {
        type: 'terminal', title: 'E2E bottom terminal', data: { sessionId },
        metadata: { terminalCloseBehavior: 'detach' },
      } }));
    });
    await page.until(() => page.visible(bottom), 'fixture bottom terminal divider');
    await page.execute(ms => new Promise(resolve => setTimeout(resolve, ms)), protocol.prepareNavigationMs);
  }
  report.coverage.bottomTerminalDrag = await page.visible(bottom);
  if (report.coverage.terminalPosition === 'bottom') assert.ok(report.coverage.bottomTerminalDrag, 'bottom terminal divider must be present');
  if (report.coverage.bottomTerminalDrag) {
    for (let repeat = 0; repeat < 4; repeat++) {
      phase = 'drag:bottom-terminal';
      const { frames, positions } = await page.drag(bottom, 'y', 50, 60, false);
      assert.ok(Math.max(...positions) - Math.min(...positions) > 20);
      report.drags.push({ name: 'bottom-terminal', repeat, frames: summarizeFrames(frames),
        travelPx: Math.max(...positions) - Math.min(...positions) });
    }
  }
  await page.click(homeButton);
  await resourceWindow('home-active', scene('personal-overview'));
  await page.click('[data-testid="nav-todos-btn"]');
  await resourceWindow('todos-static', scene('todos'));
  await page.click(homeButton);
  await resourceWindow('home-return', scene('personal-overview'));
  report.beforeIdle = report.resourceWindows[0].before;
  report.afterIdle = report.resourceWindows.at(-1).after;
  report.motionSignature = await page.motionSignature();
  const { captureHomeVisuals } = await import('./workbench-performance-visuals.mjs');
  report.homeVisuals = await captureHomeVisuals(page, root);
  await page.click(sessionTrigger);
  await page.until(() => page.visible(input), 'restored composer');
  assert.equal(await page.execute(selector => document.querySelector(selector).textContent, input), 'Workbench performance draft must survive navigation.');
  report.checks.push('Composer draft survived page changes and both divider drags');
  if (protocol.stateGuards) {
    phase = 'guard:reading-position';
    const point = await page.execute(() => {
      const rect = document.querySelector('[data-flowchat-scroller]').getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    });
    await page.request(`/session/${page.session}/actions`, { actions: [{ type: 'wheel', id: 'reading-position',
      actions: [{ type: 'scroll', origin: 'viewport', ...point, deltaX: 0, deltaY: -650, duration: 100 }] }] });
    await page.execute(() => new Promise(resolve => setTimeout(resolve, 300)));
    report.readingGuards = [];
    for (const [name, selector, axis, distance] of dragTargets) {
      const before = await page.readingAnchor();
      await page.drag(selector, axis, distance);
      await page.execute(() => new Promise(resolve => setTimeout(resolve, 150)));
      const after = await page.readingAnchor();
      report.readingGuards.push({ name, before, after });
      assert.ok(before.key, 'a readable transcript row must be present');
      assert.equal(after.key, before.key, `${name} must retain the reading row`);
      assert.ok(Math.abs(after.offset - before.offset) <= 8, `${name} must retain the reading offset`);
    }
    report.checks.push('Reading row and offset survived both resize gestures away from the latest message');
  }
  if (protocol.stateGuards && report.fileSceneTab) {
    phase = 'guard:retained-editor';
    await page.click(tab(report.fileSceneTab));
    await page.until(() => page.execute(() => [...document.querySelectorAll('.monaco-editor')]
      .some(editor => editor.checkVisibility({ checkVisibilityCSS: true }) && editor.textContent.includes('value0'))), 'retained editor restored');
    await page.click(sessionTrigger);
    await page.until(() => page.visible(input), 'composer restored after editor');
    assert.equal(await page.execute(selector => document.querySelector(selector).textContent, input), 'Workbench performance draft must survive navigation.');
    report.checks.push('Code editor restored after resizing and idle view eviction; conversation draft remained intact');
  }
  if (protocol.motionContract) {
    const { verifySubagentMotion } = await import('./verify-subagent-motion.mjs');
    report.motionContract = await verifySubagentMotion(page, repo);
    report.checks.push('All avatar variants preserve authored geometry, opacity and playback lifecycle');
  }
  report.final = await page.snapshot();
  report.functionalPassed = true;
  const gates = [];
  for (const name of new Set(report.samples.filter(sample => sample.kind === 'repeat-entry').map(sample => sample.name))) {
    const samples = report.samples.filter(sample => sample.kind === 'repeat-entry' && sample.name === name);
    const values = samples.map(sample => sample.milestones.contentMs).sort((a, b) => a - b);
    const measured = values[Math.ceil(values.length * .95) - 1];
    gates.push({ name: `hot-content:${name}`, measured, budget: report.targets.hotContentP95Ms, passed: measured <= report.targets.hotContentP95Ms });
  }
  for (const drag of report.drags) {
    gates.push({ name: `drag:${drag.name}:${drag.repeat}:p95`, measured: drag.frames.p95Ms,
      budget: report.targets.dragFrameP95Ms, passed: drag.frames.p95Ms < report.targets.dragFrameP95Ms });
    gates.push({ name: `drag:${drag.name}:${drag.repeat}:max`, measured: drag.frames.maxMs,
      budget: report.targets.dragFrameMaxMs, passed: drag.frames.maxMs < report.targets.dragFrameMaxMs });
  }
  report.performanceGates = gates;
  report.performanceBudgetsPassed = gates.every(gate => gate.passed);
  report.passed = true;
  if (process.env.OPENBITFUN_WORKBENCH_ENFORCE_BUDGETS) assert.ok(report.performanceBudgetsPassed,
    `Performance budgets failed: ${gates.filter(gate => !gate.passed).map(gate => gate.name).join(', ')}`);
} catch (error) {
  report.passed = false;
  report.failure = error.stack || String(error);
  console.error(report.failure);
  if (page.session) {
    report.failureDom = await page.execute(() => [...document.querySelectorAll('[data-testid], [role="separator"]')]
      .filter(element => element.checkVisibility({ checkVisibilityCSS: true }))
      .map(element => ({ testId: element.getAttribute('data-testid'), role: element.getAttribute('role'),
        scene: element.getAttribute('data-scene-id'), class: element.className, text: element.textContent?.slice(0, 100) }))).catch(() => null);
    const screenshot = await page.request(`/session/${page.session}/screenshot`).catch(() => null);
    if (screenshot) await writeFile(path.join(root, 'failure.png'), Buffer.from(screenshot, 'base64'));
  }
  process.exitCode = 1;
} finally {
  clearInterval(sampleTimer);
  await sampleResources();
  await save();
  if (page.session) await page.request(`/session/${page.session}`, undefined, 'DELETE').catch(() => undefined);
  app.kill('SIGTERM');
  await Promise.race([once(app, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
  if (app.exitCode === null && app.signalCode === null) app.kill('SIGKILL');
  await log.close();
}
