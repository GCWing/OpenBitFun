/** macOS native resource baseline: isolated storage, production assets, no provider calls. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, open, readFile, writeFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PetPerformancePage } from '../page-objects/PetPerformancePage.mjs';
import { desktopFrontendProfile } from './desktop-frontend-profile.mjs';

assert.equal(process.platform, 'darwin', 'Resource sampler currently supports macOS only');
const exec = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const root = await mkdtemp(path.join(os.tmpdir(), 'openbitfun-pet-perf-'));
const source = path.resolve(process.env.OPENBITFUN_E2E_FRONTEND_DIR || path.join(repo, 'dist'));
const revision = await readFile(path.join(source, 'frontend-revision.json'), 'utf8');
const fontProfile = desktopFrontendProfile(await readFile(path.join(source, 'index.html'), 'utf8'), {
  expectedProfile: process.env.OPENBITFUN_E2E_EXPECTED_FONT_PROFILE,
});
await cp(source, path.join(root, 'frontend'), { recursive: true });
assert.equal(await readFile(path.join(source, 'frontend-revision.json'), 'utf8'), revision);
const binary = path.join(root, 'openbitfun-desktop');
await cp(process.env.OPENBITFUN_E2E_DESKTOP_BINARY || path.join(repo, 'target/debug/openbitfun-desktop'), binary);
const hash = data => createHash('sha256').update(data).digest('hex');
const home = path.join(root, 'home'), user = path.join(root, 'user');
await mkdir(home); await mkdir(user);
const protocol = { version: 4, prewarmMs: 15_000, settleMs: 5000, windowMs: Number(process.env.OPENBITFUN_PET_WINDOW_MS || 20_000),
  mainVisibility: 'hide-before-each-settle-and-assert-both-boundaries',
  phases: ['off', 'rest', 'working-bubble', 'hidden', 'closed'], cadenceOutsideResourceWindows: true };
assert.ok(Number.isFinite(protocol.windowMs) && protocol.windowMs >= 1000);
const report = { schemaVersion: 1, label: process.env.OPENBITFUN_PET_LABEL || 'baseline', protocol,
  harnessHash: hash(Buffer.concat([await readFile(fileURLToPath(import.meta.url)),
    await readFile(path.join(repo, 'tests/e2e/scripts/desktop-frontend-profile.mjs')),
    await readFile(path.join(repo, 'scripts/web-font-profile.mjs')),
    await readFile(path.join(repo, 'tests/e2e/page-objects/PetPerformancePage.mjs'))])),
  frontend: JSON.parse(revision), binarySha256: hash(await readFile(binary)),
  environment: { model: os.cpus()[0]?.model, cpus: os.cpus().length, memory: os.totalmem(), release: os.release(), fontProfile },
  coverage: { nativeDesktop: true, isolatedProfile: true, productionFrontend: true, nativeProfile: 'debug',
    activityFixture: true, realAgent: false, remoteWorkspace: false, remoteControl: false, peerDevice: false, detachedDispatch: false },
  limitations: ['WebKit PIDs are fixed launch candidates, not proven ownership.', 'GPU counters are system-wide, not pet utilization.',
    'RSS is resident process memory, not JS heap or private GPU memory.', 'Cadence uses RAF opportunities, not GPU completion.'],
  windows: [], passed: false };
const save = () => writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
await save();
console.log(`Pet performance evidence: ${root}`);
const processes = async () => (await exec('ps', ['-axo', 'pid=,rss=,time=,comm='], { windowsHide: true })).stdout
  .split('\n').flatMap(line => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d:.-]+)\s+(.+)$/);
    if (!m) return [];
    return [{ pid: +m[1], rssMiB: +m[2] / 1024,
      cpuMs: m[3].replace('-', ':').split(':').reverse().reduce((s, v, i) => s + Number(v) * [1000, 60000, 3600000, 86400000][i], 0),
      role: m[4].split('/').at(-1) }];
  });
const initial = new Set((await processes()).map(p => p.pid));
let candidates = new Set(), app;
const sample = async () => {
  const at = Date.now();
  const rows = (await processes()).filter(p => p.pid === app?.pid || candidates.has(p.pid));
  const { stdout } = await exec('ioreg', ['-r', '-c', 'AGXAccelerator', '-l'], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  const gpu = Object.fromEntries(['Device Utilization %', 'Renderer Utilization %', 'Tiler Utilization %', 'In use system memory', 'Alloc system memory']
    .map(key => [key, Number(stdout.match(new RegExp(`"${key}"\\s*=\\s*(\\d+)`))?.[1] ?? NaN)])
    .filter(([, value]) => Number.isFinite(value)));
  return { at, load: os.loadavg(), processes: rows, gpu };
};
const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const log = await open(path.join(root, 'desktop.log'), 'w');
app = spawn(binary, [], { cwd: repo, windowsHide: true, stdio: ['ignore', log.fd, log.fd], env: {
  ...process.env, OPENBITFUN_HOME: home, OPENBITFUN_E2E_HOME: home, OPENBITFUN_USER_ROOT: user, OPENBITFUN_E2E_USER_ROOT: user,
  OPENBITFUN_E2E_STORAGE_GUARD: '1', OPENBITFUN_E2E_PACKAGED_FRONTEND: '1',
  OPENBITFUN_E2E_FRONTEND_DIR: path.join(root, 'frontend'), OPENBITFUN_E2E_LOG_DIR: path.join(root, 'logs'),
  OPENBITFUN_WEBDRIVER_PORT: String(port), OPENBITFUN_WEBDRIVER_LABEL: 'main',
  WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'webview'),
} });
app.on('error', error => { report.launchError = String(error); });
const page = new PetPerformancePage(`http://127.0.0.1:${port}`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function measure(name, petPresent) {
  // Activating a newly created WebView may restore the app's other windows on
  // macOS. Establish the control condition after selecting that view as well.
  await page.invoke('plugin:window|hide', { label: 'main' });
  await delay(protocol.settleMs);
  assert.equal(await page.invoke('plugin:window|is_visible', { label: 'main' }), false, 'Main must stay hidden during pet measurements');
  const before = petPresent ? await page.snapshot() : null;
  const samples = [await sample()];
  const start = Date.now();
  while (Date.now() - start < protocol.windowMs) {
    await delay(Math.min(1000, Math.max(0, protocol.windowMs - (Date.now() - start))));
    samples.push(await sample());
  }
  const after = petPresent ? await page.snapshot() : null;
  assert.equal(await page.invoke('plugin:window|is_visible', { label: 'main' }), false, 'Main became visible during measurement');
  const first = samples[0], last = samples.at(-1);
  const cpu = last.processes.flatMap(p => {
    const prev = first.processes.find(old => old.pid === p.pid);
    return prev ? [{ pid: p.pid, role: p.role, cpuPercent: (p.cpuMs - prev.cpuMs) / (last.at - first.at) * 100,
      startRssMiB: prev.rssMiB, endRssMiB: p.rssMiB }] : [];
  });
  report.windows.push({ name, before, after, samples, cpu });
  await save();
  console.log(`${name}: ${JSON.stringify(cpu)}`);
}
try {
  await page.until(async () => (await page.request('/status')).ready, 'driver');
  await page.connect();
  await page.until(() => page.execute(() => !!document.querySelector('[data-testid="nav-personal-overview"]')), 'main');
  await delay(protocol.prewarmMs);
  await page.invoke('plugin:window|hide', { label: 'main' });
  await page.invoke('hide_agent_companion_desktop_pet');
  candidates = new Set((await processes()).filter(p => !initial.has(p.pid) && /^com\.apple\.WebKit\./.test(p.role)).map(p => p.pid));
  const beforePet = new Set(candidates);
  await measure('off', false);
  await page.invoke('show_agent_companion_desktop_pet');
  await page.select('agent-companion-pet');
  await page.ready();
  candidates = new Set((await processes()).filter(p => !initial.has(p.pid) && /^com\.apple\.WebKit\./.test(p.role)).map(p => p.pid));
  report.processAttribution = { policy: 'fixed-new-WebKit-candidates-after-pet-ready', pids: [...candidates], hostPid: app.pid,
    petCandidatePids: [...candidates].filter(pid => !beforePet.has(pid)), mainCandidatePids: [...beforePet] };
  await page.activity('rest');
  await measure('rest', true);
  report.restCadence = await page.cadence();
  assert.ok(report.restCadence.positions.length >= 5, 'Visible idle atlas must keep animating');
  const now = Date.now();
  await page.activity('working', [{ sessionId: 'pet-perf-fixture', title: 'Pet performance fixture', mood: 'working', state: 'running',
    labelKey: 'status.running', defaultLabel: 'Running', latestOutput: 'Measuring the native companion renderer.', startedAt: now, updatedAt: now, canReply: false }]);
  await measure('working-bubble', true);
  report.workCadence = await page.cadence();
  assert.ok(report.workCadence.positions.length >= 5, 'Visible working atlas must keep animating');
  await page.activity('rest');
  await page.invoke('plugin:window|hide', { label: 'agent-companion-pet' });
  await measure('hidden', true);
  await page.select('main');
  await page.invoke('hide_agent_companion_desktop_pet');
  await measure('closed', false);
  report.passed = true;
} catch (error) {
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  await save();
  app.kill('SIGTERM');
  await Promise.race([once(app, 'exit').catch(() => {}), delay(5000)]);
  if (app.exitCode === null && app.signalCode === null) app.kill('SIGKILL');
  await log.close();
  await rm(binary, { force: true });
  await rm(path.join(root, 'frontend'), { recursive: true, force: true });
}
