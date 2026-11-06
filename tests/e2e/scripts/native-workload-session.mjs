/** Shared native workload host. Every product action remains in a Page Object. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopFrontendProfile } from './desktop-frontend-profile.mjs';
import { identifyWebviewProcesses } from './identify-webview-processes.mjs';
import { summarizeResidencyWindow } from './residency-metrics.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const exec = promisify(execFile);
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => createHash('sha256').update(value).digest('hex');
const execute = (command, args, extra = {}) => exec(command, args, {
  cwd: repo, windowsHide: true, maxBuffer: 16 * 1024 ** 2, ...extra,
});

export async function openNativeWorkload({ Page, label, protocol, evidence, harnessFiles = [] }) {
  assert.equal(process.platform, 'darwin', 'The attributed native resource adapter is macOS-only');
  const root = path.resolve(evidence || await mkdtemp(path.join(os.tmpdir(), 'openbitfun-workload-')));
  await mkdir(root, { recursive: true });
  const home = path.join(root, 'home'), user = path.join(root, 'user'), workspace = path.join(root, 'workspace');
  await Promise.all([home, user, workspace].map(directory => mkdir(directory)));
  const source = path.resolve(process.env.OPENBITFUN_E2E_FRONTEND_DIR || path.join(repo, 'dist'));
  const revision = await readFile(path.join(source, 'frontend-revision.json'), 'utf8');
  const fontProfile = desktopFrontendProfile(await readFile(path.join(source, 'index.html'), 'utf8'), {
    expectedProfile: process.env.OPENBITFUN_E2E_EXPECTED_FONT_PROFILE,
  });
  // This sampler is macOS-only. Native cp supports independent APFS clones
  // (Node 22's FICLONE returns ENOSYS here), with ordinary-copy fallback.
  // Never hard-link snapshots: later source writes must not alter evidence.
  await execute('/bin/cp', ['-c', '-R', source, path.join(root, 'frontend')]);
  assert.equal(await readFile(path.join(source, 'frontend-revision.json'), 'utf8'), revision);
  const binary = path.join(root, 'openbitfun-desktop');
  await execute('/bin/cp', ['-c', process.env.OPENBITFUN_E2E_DESKTOP_BINARY
    || path.join(repo, 'target/debug/openbitfun-desktop'), binary]);
  const probe = path.join(root, 'process-probe');
  await execute('clang', ['-O2', '-Wall', '-Wextra', '-Werror', path.join(repo, 'tests/e2e/scripts/native-process-probe.c'), '-o', probe]);
  const calibration = JSON.parse((await execute(probe, ['self-test'])).stdout);
  await writeFile(path.join(workspace, 'sample.ts'), Array.from({ length: 1200 }, (_, index) => `export const value${index} = ${index};`).join('\n'));
  await execute('git', ['init', '-q', workspace]);
  await execute(process.execPath, [path.join(repo, 'tests/e2e/scripts/generate-long-session-fixture.mjs'),
    '--workspace', workspace, '--openbitfun-home', home, '--openbitfun-user-root', user,
    '--session-prefix', 'workload-history', '--session-count', '2', '--long-turns', '80',
    '--assistant-chars', '4000', '--tool-items', '3', '--tool-result-chars', '6000']);
  const files = [...new Set([
    'tests/e2e/scripts/native-workload-session.mjs', 'tests/e2e/scripts/native-process-probe.c',
    'tests/e2e/scripts/residency-metrics.mjs', 'tests/e2e/scripts/identify-webview-processes.mjs',
    'tests/e2e/scripts/desktop-frontend-profile.mjs', 'scripts/web-font-profile.mjs',
    'tests/e2e/scripts/generate-long-session-fixture.mjs',
    'tests/e2e/page-objects/WorkbenchPerformancePage.mjs', 'tests/e2e/page-objects/WorkbenchResidencyPage.mjs',
    ...harnessFiles,
  ])].sort();
  const harness = createHash('sha256');
  for (const file of files) {
    assert.ok(!file.split('/').includes('..') && !path.isAbsolute(file));
    const content = await readFile(path.join(repo, file));
    const target = path.join(root, 'harness', file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
    harness.update(file).update('\0').update(content);
  }
  const report = { schemaVersion: 1, label, protocol, protocolHash: hash(JSON.stringify(protocol)),
    harnessHash: harness.digest('hex'), frontend: JSON.parse(revision), binarySha256: hash(await readFile(binary)), calibration,
    sourceCommit: (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim(),
    environment: { platform: process.platform, arch: process.arch, cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model, memoryBytes: os.totalmem(), osRelease: os.release(), fontProfile,
      automaticUpdateChecks: false },
    coverage: { nativeProfile: process.env.OPENBITFUN_E2E_NATIVE_PROFILE || 'debug', productionFrontend: true,
      isolatedProfile: true, localOnly: true, realAgent: false, actualGpuBusy: false, actualJsHeap: false },
    limitations: ['RAF timestamps are presentation opportunities, not compositor completion.',
      'GPU-process CPU/footprint are not application GPU busy or exclusive VRAM.',
      'Physical footprint is distinct from RSS and JavaScript heap.',
      'Automatic application update checks are disabled in the isolated test profile before prewarm; updater work is outside this workload.',
      'Embedded driver input does not establish OS mouse/trackpad behavior or remote coverage.'],
    windows: [], actions: [], checks: [], functionalPassed: false, performanceBudgetsPassed: false, passed: false };
  const save = () => writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  await save();
  console.log(`Native workload evidence: ${root}`);
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
  const exited = once(app, 'exit').catch(() => undefined);
  const page = new Page(`http://127.0.0.1:${port}`);
  let hostPid, closed = false;
  const resource = async () => {
    const native = JSON.parse((await execute(probe, ['sample', String(hostPid)])).stdout);
    assert.ok(native.processes.some(process => process.pid === hostPid && !process.error));
    const raw = (await execute('ioreg', ['-r', '-c', 'AGXAccelerator', '-l'])).stdout;
    const systemGpu = Object.fromEntries(['Device Utilization %', 'Renderer Utilization %', 'Tiler Utilization %', 'In use system memory', 'Alloc system memory']
      .map(key => [key, Number(raw.match(new RegExp(`"${key}"\\s*=\\s*(\\d+)`))?.[1] ?? NaN)])
      .filter(([, value]) => Number.isFinite(value)));
    return { ...native, wallAt: Date.now(), load: os.loadavg(), systemGpu };
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    await save();
    if (page.session) await page.request(`/session/${page.session}`, undefined, 'DELETE').catch(() => undefined);
    app.kill('SIGTERM'); await Promise.race([exited, delay(5000)]);
    if (app.exitCode === null && app.signalCode === null) {
      if (hostPid) try { process.kill(hostPid, 'SIGKILL'); } catch {}
      app.kill('SIGKILL');
    }
    await log.close();
  };
  try {
    hostPid = await page.until(async () => Number(await readFile(path.join(root, 'host.pid'), 'utf8')), 'native host PID');
    report.hostPid = hostPid;
    await page.until(async () => (await page.request('/status')).ready, 'embedded WebDriver', 120_000);
    await page.connect(); await page.request(`/session/${page.session}/timeouts`, { script: 40_000 });
    // Configure only this isolated installation, through the same product
    // capability as Settings. Do not let a network update check land in one arm.
    assert.equal(await page.setAutomaticUpdateChecks(false), false, 'Verify isolated updater preference before prewarm');
    await page.ready();
    report.runtimeFonts = await page.execute(() => ({ profile: document.documentElement.dataset.openbitfunFontProfile,
      family: getComputedStyle(document.body).fontFamily }));
    assert.equal(report.runtimeFonts.profile, fontProfile.actual);
    report.environment.viewport = await page.execute(() => ({ width: innerWidth, height: innerHeight, devicePixelRatio }));
    await delay(protocol.prewarmMs ?? 15_000);
    report.webviews = await identifyWebviewProcesses(page, resource);
    await save();
  } catch (error) {
    report.failure = error.stack || String(error); await close(); throw error;
  }
  const measureAction = async (name, action, destination = report.actions) => {
    const before = await page.residencySnapshot();
    const samples = [await resource()];
    let pending, samplingError;
    const timer = setInterval(() => {
      if (pending) return;
      pending = resource().then(sample => samples.push(sample)).catch(error => { samplingError = error; })
        .finally(() => { pending = undefined; });
    }, protocol.sampleMs ?? 2000);
    const start = performance.now();
    let value, actionError;
    try { value = await action(); } catch (error) { actionError = error; }
    const actionMs = performance.now() - start;
    clearInterval(timer); await pending;
    samples.push(await resource());
    const after = await page.residencySnapshot();
    const result = { name, actionMs, before, after, samples, summary: summarizeResidencyWindow(samples), value,
      error: actionError?.stack || (samplingError && String(samplingError)) };
    destination.push(result); await save();
    if (actionError || samplingError) throw actionError || samplingError;
    return result;
  };
  const idleWindow = async (name, durationMs = 30_000) => {
    await delay(protocol.settleMs ?? 5000);
    console.log(`Resource window ${name} started (${durationMs}ms)`);
    const result = await measureAction(name, () => delay(durationMs), report.windows);
    console.log(`Resource window ${name} completed`);
    return result;
  };
  const identify = async () => {
    // A refreshed editor can still be initializing workers after its UI is
    // ready. Keep that burst out of the causal CPU pulses as well as sampling.
    await delay(protocol.settleMs ?? 5000);
    report.webviews = await identifyWebviewProcesses(page, resource); await save();
  };
  return { root, repo, home, user, workspace, report, save, page, resource, measureAction, idleWindow, identify, close };
}
