import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderReport } from './long-session-metrics.mjs';
import { MULTI_TOOL_TEMPLATE, resolveTemplateToolItems } from './long-session-multi-tool-template.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const exec = promisify(execFile);
const hash = content => createHash('sha256').update(content).digest('hex');
const options = { turns: 200, repeats: 8, scrollSteps: 120, streamIntervalMs: 90, paragraphChars: 480,
  assistantChars: 4000, toolResultChars: 6000, toolItems: 3, scenario: 'mixed-visible',
  maxLatencyMs: null, maxP95FrameMs: null, evidence: null, suite: 'matrix' };
const names = { '--turns': 'turns', '--repeats': 'repeats', '--scroll-steps': 'scrollSteps',
  '--stream-interval-ms': 'streamIntervalMs', '--paragraph-chars': 'paragraphChars', '--assistant-chars': 'assistantChars',
  '--tool-result-chars': 'toolResultChars', '--tool-items': 'toolItems', '--scenario': 'scenario',
  '--max-latency-ms': 'maxLatencyMs', '--max-p95-frame-ms': 'maxP95FrameMs', '--evidence': 'evidence', '--suite': 'suite' };
if (process.argv.includes('--help')) {
  console.log(`Usage: node tests/e2e/scripts/run-long-session-performance.mjs [options]
${Object.entries(names).map(([flag, key]) => `  ${flag} <value> (default: ${options[key] ?? 'unset'})`).join('\n')}
Uses completed dist assets and target/debug/openbitfun-desktop[.exe] by default.
Overrides: OPENBITFUN_E2E_FRONTEND_DIR, OPENBITFUN_E2E_DESKTOP_BINARY,
OPENBITFUN_E2E_NATIVE_PROFILE (debug or release-fast), OPENBITFUN_E2E_WEBDRIVER_PORT.
Template multi-tool: every historical turn has 26 model rounds and 100 tool calls (25 each of Read/Edit/Write/ExecCommand).
Evidence is never pruned. Smaller workloads are useful pilots; compare identical protocols only.`);
  process.exit(0);
}
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index], key = names[flag], value = process.argv[++index];
  if (!key || value === undefined) throw new Error(`Unknown option or missing value: ${flag}`);
  options[key] = ['scenario', 'evidence', 'suite'].includes(key) ? value : Number(value);
}
options.toolItems = resolveTemplateToolItems(options.scenario, options.toolItems, process.argv.includes('--tool-items'));
for (const [key, value] of Object.entries(options)) {
  if (['scenario', 'evidence', 'suite'].includes(key) || value === null) continue;
  const budget = key === 'maxLatencyMs' || key === 'maxP95FrameMs';
  if (!(budget ? Number.isFinite(value) : Number.isInteger(value)) || value < (key === 'toolItems' ? 0 : budget ? Number.MIN_VALUE : 1)) throw new Error(`Invalid ${key}`);
}
if (options.turns < 8 || options.paragraphChars < 32) throw new Error('Need at least 8 turns and 32 paragraph characters');
if (!['matrix', 'streaming-switch'].includes(options.suite)) throw new Error('Unknown performance suite');
const nativeProfile = process.env.OPENBITFUN_E2E_NATIVE_PROFILE || 'debug';
if (!['debug', 'release-fast'].includes(nativeProfile)) throw new Error('Use a debug or release-fast devtools build');
if (nativeProfile === 'release-fast' && process.platform !== 'win32') {
  throw new Error('Release-fast resource snapshots currently support Windows only; use the debug host on this platform');
}
const root = options.evidence ? path.resolve(options.evidence) : await mkdtemp(path.join(os.tmpdir(), 'openbitfun-long-session-perf-'));
if (options.evidence) await mkdir(root, { recursive: false }); // Never reuse or overwrite evidence.
console.log(`[LongSessionPerf] Evidence: ${root}`);
const workspace = path.join(root, 'workspace'), home = path.join(root, 'home'), user = path.join(root, 'user');
const { evidence: _evidence, ...protocolOptions } = options;
const report = { schemaVersion: 1, protocol: { version: 2, ...protocolOptions, focus: 'main-window-required', states: ['static', 'streaming'],
  scenarios: ['first-open', 'session-switch', 'continuous-scroll-up', 'continuous-scroll-down', 'turn-jump'],
  staticBeforeStreaming: true, wheelDelta: 240, wheelDurationMs: 24, readinessRafOpportunities: 2,
  firstOpen: 'first UI entry; runtime and OS caches may already be warm',
  turnRailReveal: 'programmatic rail scroll outside timed window; navigation through real button' },
  nativeProfile, startedAt: new Date().toISOString(),
  instrumented: Boolean(process.env.OPENBITFUN_LONG_SESSION_CDP_PORT),
  environment: { platform: process.platform, arch: process.arch, release: os.release(), node: process.version,
    cpuModel: os.cpus()[0]?.model, cpuCount: os.cpus().length, memoryBytes: os.totalmem() },
  coverage: { localDesktop: true, realRuntime: true, mockModel: true, actualTools: false,
    remoteWorkspace: false, remoteControl: false, peerDevice: false, detachedDispatch: false,
    compositorFps: false, osColdCache: false },
  samples: [], summary: [], failures: [], functionalPassed: false, performanceBudgetsPassed: null, passed: false };
if (options.suite === 'streaming-switch') Object.assign(report.protocol, {
  version: 5, states: ['streaming'], scenarios: ['session-switch'], staticBeforeStreaming: false,
  initialParagraphs: 96, paragraphsPerSwitch: 16, controlledStreams: true,
  postMeasurementReaderChecks: true,
});
if (options.scenario === MULTI_TOOL_TEMPLATE.id) report.protocol.template = MULTI_TOOL_TEMPLATE;
const save = async (data = report) => {
  const rendered = renderReport(data);
  await Promise.all([writeFile(path.join(root, 'result.json'), JSON.stringify(data, null, 2)),
    writeFile(path.join(root, 'summary.csv'), rendered.csv), writeFile(path.join(root, 'report.html'), rendered.html)]);
};
try {
  await save();
  await Promise.all([workspace, home, user].map(directory => mkdir(directory)));
  await writeFile(path.join(workspace, 'README.md'), '# Isolated long-session benchmark workspace\n');
  const source = path.resolve(process.env.OPENBITFUN_E2E_FRONTEND_DIR || path.join(repo, 'dist'));
  const frontend = nativeProfile === 'release-fast' ? path.join(root, 'frontend', 'dist') : path.join(root, 'frontend');
  const revision = await readFile(path.join(source, 'frontend-revision.json'), 'utf8');
  await cp(source, frontend, { recursive: true });
  if (await readFile(path.join(source, 'frontend-revision.json'), 'utf8') !== revision) throw new Error('Frontend changed during snapshot');
  report.frontend = JSON.parse(revision);
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const binarySource = path.resolve(process.env.OPENBITFUN_E2E_DESKTOP_BINARY || path.join(repo, 'target', nativeProfile, `openbitfun-desktop${suffix}`));
  const binary = path.join(root, `openbitfun-desktop${suffix}`);
  await cp(binarySource, binary);
  if (nativeProfile === 'release-fast') {
    // Windows release hosts resolve Tauri resources beside their executable and ignore debug-only overrides.
    for (const name of ['flashgrep', 'mobile-web', 'resources']) {
      const adjacent = path.join(path.dirname(binarySource), name);
      try { await cp(adjacent, path.join(root, name), { recursive: true }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  report.binarySha256 = hash(await readFile(binary));
  report.sourceCommit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repo, windowsHide: true })).stdout.trim();
  report.sourceDirty = Boolean((await exec('git', ['status', '--porcelain'], { cwd: repo, windowsHide: true })).stdout.trim());
  const fixtures = [];
  for (const prefix of ['perf-static', 'perf-live', 'perf-parking']) {
    const count = prefix === 'perf-parking' ? 1 : 2, turns = count === 1 ? 1 : options.turns;
    const parking = count === 1 && options.scenario === MULTI_TOOL_TEMPLATE.id;
    const result = await exec(process.execPath, [path.join(repo, 'tests/e2e/scripts/generate-long-session-fixture.mjs'),
      '--workspace', workspace, '--openbitfun-home', home, '--openbitfun-user-root', user,
      '--session-prefix', prefix, '--session-count', String(count), '--long-turns', String(turns), '--short-turns', String(turns),
      '--assistant-chars', String(options.assistantChars), '--tool-result-chars', String(options.toolResultChars),
      '--tool-items', String(parking ? 3 : options.toolItems), '--scenario', parking ? 'mixed-visible' : options.scenario], { cwd: repo, windowsHide: true });
    const fixture = JSON.parse(result.stdout); fixtures.push(fixture);
    if (prefix === 'perf-live') for (let index = 0; index < count; index++) {
      const stateFile = path.join(fixture.sessionsRoot, `${prefix}-${String(index).padStart(3, '0')}`, 'state.json');
      const state = JSON.parse(await readFile(stateFile, 'utf8'));
      state.config.auto_compact = false; state.config.enable_context_compression = false;
      state.config.max_context_tokens = 10_000_000;
      await writeFile(stateFile, JSON.stringify(state, null, 2));
    }
  }
  report.fixtures = fixtures;
  const files = ['scripts/run-long-session-performance.mjs', 'scripts/long-session-metrics.mjs',
    'scripts/generate-long-session-fixture.mjs', 'scripts/long-session-multi-tool-template.mjs',
    'config/wdio.long-session-performance.ts', 'config/embedded-driver.ts',
    'helpers/long-session-model.mjs', 'helpers/workspace-helper.ts', 'page-objects/LongSessionPerformancePage.ts',
    'page-objects/FlowChatScrollPage.ts', 'specs/performance/long-session-performance.spec.ts'];
  const harness = createHash('sha256');
  for (const file of files) {
    const content = await readFile(path.join(repo, 'tests/e2e', file));
    const target = path.join(root, 'harness', file); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content);
    harness.update(file).update('\0').update(content);
  }
  report.harnessHash = harness.digest('hex');
  // Fingerprint exact persisted input bytes, including timestamps, before the runtime can modify them.
  const fixtureHash = createHash('sha256'); let fixtureBytes = 0;
  async function digest(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await digest(file);
      else { const content = await readFile(file); fixtureBytes += content.length; fixtureHash.update(path.relative(home, file)).update('\0').update(content); }
    }
  }
  await digest(home); report.fixtureBytes = fixtureBytes; report.fixtureSha256 = fixtureHash.digest('hex');
  report.protocolHash = hash(JSON.stringify(report.protocol));
  await save();
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, [path.join(repo, 'tests/e2e/node_modules/@wdio/cli/bin/wdio.js'),
    'run', './config/wdio.long-session-performance.ts'], {
    cwd: path.join(repo, 'tests/e2e'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OPENBITFUN_LONG_SESSION_EVIDENCE: root,
      OPENBITFUN_E2E_STORAGE_ROOT: root, OPENBITFUN_E2E_HOME: home, OPENBITFUN_HOME: home,
      OPENBITFUN_E2E_USER_ROOT: user, OPENBITFUN_USER_ROOT: user, OPENBITFUN_E2E_LOG_DIR: path.join(root, 'logs'),
      OPENBITFUN_E2E_STORAGE_GUARD: '1', OPENBITFUN_E2E_USE_REAL_PROFILE: '0',
      OPENBITFUN_E2E_APP_PATH: binary, OPENBITFUN_E2E_APP_MODE: nativeProfile,
      OPENBITFUN_E2E_PACKAGED_FRONTEND: '1', OPENBITFUN_E2E_FRONTEND_DIR: frontend,
      OPENBITFUN_E2E_WEBDRIVER_PORT: process.env.OPENBITFUN_E2E_WEBDRIVER_PORT || String(port),
      WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'webview'), E2E_TEST_WORKSPACE: workspace, E2E_LOG_LEVEL: 'warn',
      NO_PROXY: [process.env.NO_PROXY, '127.0.0.1', 'localhost', '::1'].filter(Boolean).join(','),
    },
  });
  const { createWriteStream } = await import('node:fs');
  const log = createWriteStream(path.join(root, 'runner.log'));
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log.write(chunk); process.stdout.write(chunk); });
  const [code] = await once(child, 'exit'); await new Promise(resolve => log.end(resolve));
  const final = JSON.parse(await readFile(path.join(root, 'result.json'), 'utf8'));
  final.runnerExitCode = code;
  if (code !== 0) {
    final.passed = false;
    if (!final.failures.length) final.failures.push(`WebDriver runner exited with status ${code}; inspect runner.log`);
  }
  await save(final);
  if (code !== 0 || !final.passed) { console.error(`[LongSessionPerf] Failed; inspect ${root}`); process.exitCode = 1; }
  else console.log(`[LongSessionPerf] Completed: ${path.join(root, 'report.html')}`);
} catch (error) {
  report.failures.push(error.stack || String(error)); await save(); console.error(error); process.exitCode = 1;
}
