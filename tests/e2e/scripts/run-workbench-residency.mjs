/** Native long-residency E2E: real UI, immutable assets, no forced GC or cache clearing. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkbenchResidencyPage } from '../page-objects/WorkbenchResidencyPage.mjs';
import { summarizeResidencyWindow } from './residency-metrics.mjs';
import { identifyWebviewProcesses } from './identify-webview-processes.mjs';
import { desktopFrontendProfile } from './desktop-frontend-profile.mjs';

assert.equal(process.platform, 'darwin', 'This resource adapter is macOS-only');
const exec = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const execute = (command, args, extra = {}) => exec(command, args, { cwd: repo, windowsHide: true, maxBuffer: 16 * 1024 ** 2, ...extra });
const hash = value => createHash('sha256').update(value).digest('hex');
const protocol = { version: 5, cycles: Number(process.env.OPENBITFUN_RESIDENCY_CYCLES || 60),
  windowMs: Number(process.env.OPENBITFUN_RESIDENCY_WINDOW_MS || 180_000),
  hiddenMs: Number(process.env.OPENBITFUN_RESIDENCY_HIDDEN_MS || 600_000),
  prewarmMs: 15_000, settleMs: 5000, sampleMs: 2000, checkpointEvery: 5,
  navigation: ['personal-overview', 'todos', 'agents', 'assistant', 'miniapps', 'skills', 'insights', 'session'],
  sampler: 'proc_pid_rusage-v4-mach-timebase', attribution: 'isolated-Darwin-responsible-pid',
  webviewAttribution: 'two-400ms-CPU-pulses-before-prewarm',
  diagnosticsOutsideWindows: true, forcedGC: false,
  allocationDiagnostic: process.env.OPENBITFUN_RESIDENCY_ALLOCATION_DIAGNOSTIC === '1',
};
if (process.env.OPENBITFUN_RESIDENCY_DESTINATIONS) {
  const requested = process.env.OPENBITFUN_RESIDENCY_DESTINATIONS.split(',');
  assert.ok(requested.length >= 2 && new Set(requested).size === requested.length
    && requested.every(id => protocol.navigation.includes(id)), 'Select at least two distinct supported destinations');
  protocol.navigation = requested;
}
for (const field of ['cycles', 'windowMs', 'hiddenMs']) assert.ok(Number.isInteger(protocol[field]) && protocol[field] > 0, field);
const root = path.resolve(process.env.OPENBITFUN_RESIDENCY_EVIDENCE || await mkdtemp(path.join(os.tmpdir(), 'openbitfun-residency-')));
await mkdir(root, { recursive: true });
const home = path.join(root, 'home'), user = path.join(root, 'user'), workspace = path.join(root, 'workspace');
await Promise.all([home, user, workspace].map(dir => mkdir(dir))); // Refuse accidental evidence/profile reuse.
const frontendSource = path.resolve(process.env.OPENBITFUN_E2E_FRONTEND_DIR || path.join(repo, 'dist'));
const revision = await readFile(path.join(frontendSource, 'frontend-revision.json'), 'utf8');
const fontProfile = desktopFrontendProfile(await readFile(path.join(frontendSource, 'index.html'), 'utf8'), {
  expectedProfile: process.env.OPENBITFUN_E2E_EXPECTED_FONT_PROFILE,
});
await cp(frontendSource, path.join(root, 'frontend'), { recursive: true });
assert.equal(await readFile(path.join(frontendSource, 'frontend-revision.json'), 'utf8'), revision);
const binary = path.join(root, 'openbitfun-desktop');
await cp(process.env.OPENBITFUN_E2E_DESKTOP_BINARY || path.join(repo, 'target/debug/openbitfun-desktop'), binary);
const probeSource = path.join(repo, 'tests/e2e/scripts/native-process-probe.c'), probe = path.join(root, 'process-probe');
await execute('clang', ['-O2', '-Wall', '-Wextra', '-Werror', probeSource, '-o', probe]);
const calibration = JSON.parse((await execute(probe, ['self-test'])).stdout);
await writeFile(path.join(workspace, 'sample.ts'), Array.from({ length: 1200 }, (_, i) => `export const value${i} = ${i};`).join('\n'));
await execute('git', ['init', '-q', workspace]);
await execute(process.execPath, [path.join(repo, 'tests/e2e/scripts/generate-long-session-fixture.mjs'),
  '--workspace', workspace, '--openbitfun-home', home, '--openbitfun-user-root', user,
  '--session-prefix', 'residency-perf', '--session-count', '2', '--long-turns', '80',
  '--assistant-chars', '4000', '--tool-items', '3', '--tool-result-chars', '6000']);
const harnessFiles = ['scripts/run-workbench-residency.mjs', 'scripts/native-process-probe.c',
  'scripts/residency-metrics.mjs', 'scripts/identify-webview-processes.mjs', 'scripts/desktop-frontend-profile.mjs',
  'page-objects/WorkbenchResidencyPage.mjs', 'page-objects/WorkbenchPerformancePage.mjs'];
// Retain the exact sampler and driver sources alongside every report. Later
// diagnostic extensions must not make a recorded harness hash unrecoverable.
for (const file of harnessFiles) {
  const target = path.join(root, 'harness', file);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(repo, 'tests/e2e', file), target);
}
const fontProfileContract = await readFile(path.join(repo, 'scripts/web-font-profile.mjs'));
await writeFile(path.join(root, 'harness', 'web-font-profile.mjs'), fontProfileContract);
const report = { schemaVersion: 1, label: process.env.OPENBITFUN_RESIDENCY_LABEL || 'baseline',
  protocol, protocolHash: hash(JSON.stringify(protocol)),
  harnessHash: hash(Buffer.concat([...(await Promise.all(harnessFiles.map(file => readFile(path.join(repo, 'tests/e2e', file))))), fontProfileContract])),
  frontend: JSON.parse(revision), binarySha256: hash(await readFile(binary)), calibration,
  sourceCommit: (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim(),
  environment: { platform: process.platform, arch: process.arch, cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model, memoryBytes: os.totalmem(), osRelease: os.release(), fontProfile },
  coverage: { nativeProfile: process.env.OPENBITFUN_E2E_NATIVE_PROFILE || 'debug',
    productionFrontend: true, isolatedProfile: true, localOnly: true, realAgent: false,
    actualGpuBusy: false, actualJsHeap: false },
  limitations: ['Darwin responsibility identifies accounting ownership, not individual WebView identity.',
    'Physical footprint is an OS memory ledger; it is not JS heap or exclusive VRAM.',
    'GPU process CPU and system AGX counters are not application GPU utilization.',
    'Finite soak cannot establish absence of all leaks; exited processes have partial CPU coverage.',
    'The launcher uses optional Darwin responsibility SPI; unavailable attribution fails explicitly.'],
  windows: [], checkpoints: [], navigations: [], diagnostics: [], passed: false,
};
const save = () => writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
await save(); console.log(`Residency evidence: ${root}`);
const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
const log = await open(path.join(root, 'desktop.log'), 'w');
const app = spawn(probe, ['launch', path.join(root, 'host.pid'), binary], {
  cwd: repo, windowsHide: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env,
    OPENBITFUN_HOME: home, OPENBITFUN_E2E_HOME: home, OPENBITFUN_USER_ROOT: user, OPENBITFUN_E2E_USER_ROOT: user,
    OPENBITFUN_E2E_STORAGE_GUARD: '1', OPENBITFUN_E2E_PACKAGED_FRONTEND: '1',
    OPENBITFUN_E2E_FRONTEND_DIR: path.join(root, 'frontend'), OPENBITFUN_E2E_LOG_DIR: path.join(root, 'logs'),
    OPENBITFUN_WEBDRIVER_PORT: String(port), OPENBITFUN_WEBDRIVER_LABEL: 'main', OPENBITFUN_PERF_TRACE: '1',
    WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'webview'),
  },
});
app.on('error', error => { report.launchError = String(error); });
const appExited = once(app, 'exit');
const page = new WorkbenchResidencyPage(`http://127.0.0.1:${port}`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const scene = id => `[data-testid="scene-viewport-scene"][data-scene-id="${id}"][data-scene-active="true"]`;
const homeButton = '[data-testid="nav-personal-overview"]';
const sessionButton = '[data-testid="nav-session-item"][data-session-id="residency-perf-000"]';
const draft = 'Residency draft must survive navigation, hiding and restoration.';
let hostPid;
const resource = async () => {
  const native = JSON.parse((await execute(probe, ['sample', String(hostPid)])).stdout);
  assert.ok(native.processes.some(p => p.pid === hostPid && !p.error));
  const raw = (await execute('ioreg', ['-r', '-c', 'AGXAccelerator', '-l'])).stdout;
  const systemGpu = Object.fromEntries(['Device Utilization %', 'Renderer Utilization %', 'Tiler Utilization %', 'In use system memory', 'Alloc system memory']
    .map(key => [key, Number(raw.match(new RegExp(`"${key}"\\s*=\\s*(\\d+)`))?.[1] ?? NaN)]).filter(([, value]) => Number.isFinite(value)));
  return { ...native, wallAt: Date.now(), load: os.loadavg(), systemGpu };
};
async function checkpoint(name) {
  const row = { name, at: Date.now(), state: await page.residencySnapshot(), resource: await resource() };
  report.checkpoints.push(row); await save(); return row;
}
async function diagnostic(name) {
  const snap = await resource();
  for (const process of snap.processes.filter(p => p.pid === hostPid || /WebContent|GPU/.test(p.name))) {
    const filename = `${name}-${process.pid}-vmmap.txt`;
    try {
      const result = await execute('vmmap', ['-summary', String(process.pid)], { timeout: 20_000 });
      await writeFile(path.join(root, filename), result.stdout + result.stderr);
      report.diagnostics.push({ name, pid: process.pid, filename, available: true });
    } catch (error) { report.diagnostics.push({ name, pid: process.pid, available: false, error: String(error) }); }
  }
  if (protocol.allocationDiagnostic && name === 'after-cycles') {
    for (const process of snap.processes.filter(p => /WebKit.GPU/.test(p.name))) {
      const filename = `${name}-${process.pid}-heap.txt`;
      try {
        const result = await execute('heap', ['--sortBySize', '--showSizes', '--guessNonObjects', '--noContent', String(process.pid)], { timeout: 30_000 });
        await writeFile(path.join(root, filename), result.stdout + result.stderr);
        report.diagnostics.push({ name, pid: process.pid, filename, available: true, kind: 'allocation-types' });
      } catch (error) {
        report.diagnostics.push({ name, pid: process.pid, available: false, kind: 'allocation-types', error: String(error) });
      }
    }
  }
  await save();
}
async function window(name, durationMs = protocol.windowMs, expectedVisible = true) {
  await delay(protocol.settleMs);
  assert.equal(await page.invoke('plugin:window|is_visible', { label: 'main' }), expectedVisible);
  const before = await page.residencySnapshot();
  const samples = [await resource()];
  console.log(`Resource window ${name} started (${durationMs}ms)`);
  const start = performance.now();
  while (performance.now() - start < durationMs) {
    await delay(Math.min(protocol.sampleMs, durationMs - (performance.now() - start)));
    samples.push(await resource());
  }
  const after = await page.residencySnapshot();
  assert.equal(await page.invoke('plugin:window|is_visible', { label: 'main' }), expectedVisible);
  report.windows.push({ name, before, after, samples, summary: summarizeResidencyWindow(samples) });
  await save(); console.log(`Resource window ${name} completed`);
}
try {
  hostPid = await page.until(async () => Number(await readFile(path.join(root, 'host.pid'), 'utf8')), 'native host pid');
  report.hostPid = hostPid;
  await page.until(async () => (await page.request('/status')).ready, 'embedded WebDriver', 120_000);
  await page.connect(); await page.request(`/session/${page.session}/timeouts`, { script: 40_000 });
  await page.ready();
  report.runtimeFonts = await page.execute(() => ({
    profile: document.documentElement.dataset.openbitfunFontProfile,
    family: getComputedStyle(document.body).fontFamily,
    faces: [...document.fonts].map(face => ({ family: face.family, status: face.status })),
  }));
  assert.equal(report.runtimeFonts.profile, fontProfile.actual, 'The native WebView must load the selected build profile');
  report.environment.viewport = await page.execute(() => ({ width: innerWidth, height: innerHeight, devicePixelRatio }));
  report.webviews = await identifyWebviewProcesses(page, resource);
  await delay(protocol.prewarmMs);
  await page.execute(() => localStorage.setItem('openbitfun:appearance:sidebar', JSON.stringify({ version: 1,
    pinnedIds: ['builtin.todos', 'builtin.agents', 'builtin.assistants', 'builtin.miniapps', 'builtin.skills.installed', 'builtin.insights'] })));
  await page.request(`/session/${page.session}/refresh`, {}); await delay(1000); await page.ready();
  await page.until(() => page.visible('[data-testid="nav-builtin.miniapps"]'), 'pinned navigation');
  await page.click(homeButton); await checkpoint('cold-home');
  await page.click('[data-testid="nav-workspace-menu-btn"]');
  await page.click('[data-testid="nav-workspace-menu-open-directory"]');
  await page.until(() => page.visible('[role="treeitem"][data-file-path$="sample.ts"]'), 'fixture file');
  await page.click('[role="treeitem"][data-file-path$="sample.ts"]');
  await page.until(() => page.visible('.monaco-editor'), 'code editor');
  report.editorTab = await page.execute(() => document.querySelector('.openbitfun-scene-bar__item[title$="sample.ts"]')?.dataset.sceneTabId);
  await page.click(homeButton); await page.click(sessionButton);
  await page.until(() => page.visible('[data-testid="chat-input-textarea"]'), 'composer');
  await page.enterDraft(draft);
  await page.click('[data-testid="nav-workspace-menu-btn"]');
  await page.click('[data-testid="nav-workspace-menu-create-terminal"]');
  await page.until(() => page.visible('.xterm-screen'), 'terminal');
  await page.click(sessionButton);
  await page.until(() => page.visible('[data-flowchat-scroller]'), 'transcript');
  await delay(500);
  const wheelPoint = await page.execute(() => {
    const rect = document.querySelector('[data-flowchat-scroller]').getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  });
  await page.request(`/session/${page.session}/actions`, { actions: [{ type: 'wheel', id: 'residency-reader',
    actions: [{ type: 'scroll', origin: 'viewport', ...wheelPoint, deltaX: 0, deltaY: -650, duration: 100 }] }] });
  await delay(500);
  report.readingBefore = await page.readingAnchor();
  assert.ok(report.readingBefore.key, 'A retained reading row must exist');
  const allDestinations = [[homeButton, 'personal-overview'], ['[data-testid="nav-todos-btn"]', 'todos'],
    ['[data-testid="nav-builtin.agents"]', 'agents'], ['[data-testid="nav-builtin.assistants"]', 'assistant'],
    ['[data-testid="nav-builtin.miniapps"]', 'miniapps'], ['[data-testid="nav-builtin.skills.installed"]', 'skills'],
    ['[data-testid="nav-builtin.insights"]', 'insights'], [sessionButton, 'session']];
  const destinations = protocol.navigation.map(id => allDestinations.find(([, candidate]) => candidate === id));
  for (let cycle = 0; cycle < protocol.cycles; cycle++) {
    for (const [trigger, id] of destinations) {
      const measured = await page.measureOpen(trigger, scene(id));
      report.navigations.push({ cycle, id, milestones: measured.milestones,
        loadingFrames: measured.loadingFrames, missingFrames: measured.missingFrames, frames: measured.frames });
    }
    assert.equal(await page.execute(() => document.querySelector('[data-testid="chat-input-textarea"]').textContent), draft);
    if (cycle % protocol.checkpointEvery === 0 || cycle === protocol.cycles - 1) {
      await checkpoint(`cycle-${cycle + 1}`); console.log(`Cycle ${cycle + 1}/${protocol.cycles} completed`);
    }
  }
  await diagnostic('after-cycles');
  await page.click(homeButton); await window('home-retained');
  await page.click('[data-testid="nav-todos-btn"]'); await window('todos-retained');
  await page.invoke('plugin:window|hide', { label: 'main' }); await window('window-hidden', protocol.hiddenMs, false);
  await page.invoke('plugin:window|show', { label: 'main' });
  await page.invoke('plugin:window|set_focus', { label: 'main' });
  await page.click(sessionButton); await page.until(() => page.visible('[data-testid="chat-input-textarea"]'), 'restored composer');
  assert.equal(await page.execute(() => document.querySelector('[data-testid="chat-input-textarea"]').textContent), draft);
  await delay(500);
  report.readingAfter = await page.readingAnchor();
  assert.equal(report.readingAfter.key, report.readingBefore.key, 'Hiding and navigation must preserve the reading row');
  assert.ok(Math.abs(report.readingAfter.offset - report.readingBefore.offset) <= 8, 'Reading offset must be preserved');
  assert.ok(report.editorTab, 'Editor tab must be retained');
  await page.click(`.openbitfun-scene-bar__item[data-scene-tab-id=${JSON.stringify(report.editorTab)}] [role="tab"]`);
  await page.until(() => page.execute(() => [...document.querySelectorAll('.monaco-editor')]
    .some(node => node.checkVisibility({ checkVisibilityCSS: true }) && node.textContent.includes('value0'))), 'retained editor content');
  await page.click(homeButton); await window('home-restored');
  report.closedTabs = await page.closeClosableTabs();
  await page.click(homeButton); await window('after-close');
  await checkpoint('final'); await diagnostic('final');
  report.functionalPassed = true;
  report.performanceGates = protocol.navigation.map(id => {
    const rows = report.navigations.filter(row => row.id === id && row.cycle > 0);
    const percentile = key => {
      const values = rows.map(row => row.milestones[key]).sort((a, b) => a - b);
      return values.length ? values[Math.ceil(values.length * .95) - 1] : null;
    };
    const feedbackP95Ms = percentile('visibleMs'), contentP95Ms = percentile('contentMs');
    return { id, samples: rows.length, feedbackP95Ms, contentP95Ms,
      passed: feedbackP95Ms !== null && feedbackP95Ms <= 100 && contentP95Ms <= 150 };
  });
  report.performanceBudgetsPassed = report.performanceGates.every(gate => gate.passed);
  report.passed = true;
} catch (error) {
  report.failure = error.stack || String(error); console.error(report.failure); process.exitCode = 1;
  if (page.session) {
    report.failureState = await page.residencySnapshot().catch(() => null);
    const screenshot = await page.request(`/session/${page.session}/screenshot`).catch(() => null);
    if (screenshot) await writeFile(path.join(root, 'failure.png'), Buffer.from(screenshot, 'base64'));
  }
} finally {
  await save();
  if (page.session) await page.request(`/session/${page.session}`, undefined, 'DELETE').catch(() => undefined);
  app.kill('SIGTERM');
  await Promise.race([appExited, delay(5000)]);
  if (app.exitCode === null && app.signalCode === null) {
    if (hostPid) try { process.kill(hostPid, 'SIGKILL'); } catch {}
    app.kill('SIGKILL');
  }
  await log.close();
}
