import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
assert.equal(process.platform, 'darwin', 'ComputerUse tool roundtrip fixture requires macOS');
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'openbitfun-control-roundtrip-'));
const run = (command, args, env = process.env, onSpawn) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, env });
  onSpawn?.(child);
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
});
let fixture;
let observer;
let harness;
try {
  const binary = join(directory, 'input-fixture');
  const result = join(directory, 'counts.json');
  const contents = join(directory, 'OpenBitFun Roundtrip Observer.app', 'Contents');
  await mkdir(join(contents, 'MacOS'), { recursive: true });
  await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.openbitfun.roundtrip-fixture.observer</string><key>CFBundleName</key><string>OpenBitFun Roundtrip Observer</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  const observerBinary = join(contents, 'MacOS', 'fixture');
  await run('xcrun', ['clang', '-fobjc-arc', '-Wall', '-Werror', 'scripts/fixtures/computer-use-roundtrip.m', '-framework', 'AppKit', '-o', binary]);
  await run('xcrun', ['clang', '-fobjc-arc', '-Wall', '-Werror', 'scripts/fixtures/computer-use-input-controls.m', '-framework', 'AppKit', '-o', observerBinary]);
  // Build before either disposable window is opened. The host's AppKit startup
  // must also finish before the observer establishes the foreground baseline.
  if (!process.env.OPENBITFUN_TEST_BINARY) await run('cargo', ['test', '-p', 'openbitfun-desktop', '--features', 'devtools', '--test', 'computer_use_native_roundtrip', '--no-run']);
  fixture = spawn(binary, [result], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  const [pid, x, y] = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Input fixture failed to become ready')), 10_000);
    let output = '';
    fixture.once('error', error => { clearTimeout(timer); reject(error); });
    fixture.once('exit', code => { clearTimeout(timer); reject(new Error(`Input fixture exited ${code}`)); });
    fixture.stdout.on('data', chunk => {
      output += String(chunk);
      const ready = output.match(/READY (\d+) ([\d.-]+) ([\d.-]+)/);
      if (ready) { clearTimeout(timer); resolve(ready.slice(1)); }
    });
  });
  const command = process.env.OPENBITFUN_TEST_BINARY || 'cargo';
  const args = process.env.OPENBITFUN_TEST_BINARY ? [] : ['test', '-p', 'openbitfun-desktop', '--features', 'devtools', '--test', 'computer_use_native_roundtrip'];
  const hostReady = join(directory, 'host-ready');
  const observerResult = join(directory, 'observer.json');
  const roundtrip = run(command, args, {
    ...process.env, OPENBITFUN_ROUNDTRIP_FIXTURE_PID: pid, OPENBITFUN_ROUNDTRIP_FIXTURE_X: x,
    OPENBITFUN_ROUNDTRIP_FIXTURE_Y: y, OPENBITFUN_ROUNDTRIP_FIXTURE_RESULT: result,
    OPENBITFUN_INPUT_HOST_READY: hostReady, OPENBITFUN_INPUT_OBSERVER_RESULT: observerResult,
  }, child => { harness = child; }).then(() => null, error => error);
  const deadline = Date.now() + 10_000;
  while (true) {
    try { await readFile(hostReady); break; } catch (error) {
      if (error.code !== 'ENOENT' || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  observer = spawn(observerBinary, ['--observer', observerResult], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  const failure = await roundtrip;
  if (failure) throw failure;
  const foreground = JSON.parse(await readFile(observerResult, 'utf8'));
  assert.equal(foreground.active, true);
  assert.equal(foreground.key_window, true);
  assert.equal(foreground.frontmost_pid, observer.pid);
  const received = JSON.parse(await readFile(result, 'utf8'));
  assert.equal(received.downs, 1);
  assert.equal(received.ups, 1);
  assert.equal(received.activations, 1);
  assert.equal(received.enters, 1);
  assert.equal(received.text, '背景输入 Test');
  console.log('PASS: tool observation/action/verification loop delivered exactly one click, semantic activation and Enter with exact Unicode text');
} finally {
  if (harness && harness.exitCode === null) await new Promise(resolve => { harness.once('exit', resolve); harness.kill('SIGTERM'); });
  if (observer && observer.exitCode === null) await new Promise(resolve => { observer.once('exit', resolve); observer.kill('SIGTERM'); });
  if (fixture && fixture.exitCode === null) await new Promise(resolve => { fixture.once('exit', resolve); fixture.kill('SIGTERM'); });
  await rm(directory, { recursive: true, force: true });
}
