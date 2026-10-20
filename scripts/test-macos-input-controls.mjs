import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
assert.equal(process.platform, 'darwin', 'directed input fixture requires macOS');
const latency = process.argv.includes('--latency');
const busyAx = process.argv.includes('--busy-ax');
const foreground = process.argv.includes('--foreground');
const orchestration = process.argv.includes('--orchestration') || process.argv.includes('--semantic') || latency || busyAx || foreground;
const semantic = process.argv.includes('--semantic') || orchestration;
assert.ok(process.argv.length === 2 || (process.argv.length === 3 && semantic), 'Usage: node scripts/test-macos-input-controls.mjs [--semantic | --orchestration | --latency | --busy-ax | --foreground]');
const root = fileURLToPath(new URL('../', import.meta.url));
const run = (command, args, env = process.env, onSpawn) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, env });
  onSpawn?.(child);
  const timer = setTimeout(() => child.kill('SIGTERM'), 30_000);
  child.on('error', error => { clearTimeout(timer); reject(error); });
  child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)); });
});

const nativeTestBinary = async () => process.env.OPENBITFUN_TEST_BINARY || new Promise((resolve, reject) => {
  const build = spawn('cargo', ['test', '--locked', '-p', 'openbitfun-desktop', ...(orchestration ? ['--features', 'devtools', '--test', 'computer_use_native_roundtrip'] : ['--lib']), '--no-run', '--message-format=json'], {
    cwd: root, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true,
  });
  let pending = '';
  let executable;
  build.stdout.on('data', chunk => {
    pending += String(chunk);
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) {
      const message = JSON.parse(line);
      if (message.reason === 'compiler-artifact' && message.target.name === (orchestration ? 'computer_use_native_roundtrip' : 'openbitfun_desktop_lib') && message.executable) executable = message.executable;
      if (message.reason === 'compiler-message' && message.message.rendered) process.stderr.write(message.message.rendered);
    }
  });
  build.once('error', reject);
  build.once('close', code => code === 0 && executable ? resolve(executable) : reject(new Error(`Test build failed (${code}) or produced no executable`)));
});

if (latency) {
  // Compile once, then isolate every case in a fresh target, observer and native
  // host. Child runners retain the ordinary input-idle gates and final checks.
  const testBinary = await nativeTestBinary();
  const measurements = [];
  for (const fixtureCase of ['singles:default', 'batch:default', 'singles:ax', 'batch:ax']) {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--orchestration'], {
        cwd: root, windowsHide: true, stdio: ['ignore', 'inherit', 'pipe'],
        env: { ...process.env, OPENBITFUN_TEST_BINARY: testBinary, OPENBITFUN_INPUT_LATENCY_CASE: fixtureCase },
      });
      let pending = '';
      child.stderr.on('data', chunk => {
        process.stderr.write(chunk);
        pending += String(chunk);
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const line of lines) {
          if (line.startsWith('CUA_NATIVE_LATENCY ')) measurements.push(JSON.parse(line.slice('CUA_NATIVE_LATENCY '.length)));
        }
      });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`Native latency case ${fixtureCase} failed (${code})`)));
    });
  }
  assert.equal(measurements.length, 4, 'every measured case must report after native assertions pass');
  for (const result of measurements) {
    const batched = result.case.startsWith('batch:');
    const images = result.case.endsWith(':default');
    assert.equal(result.input_steps, 5);
    assert.equal(result.tool_calls, batched ? 1 : 5);
    assert.equal(result.returned_observation_count, batched ? 1 : 5);
    assert.equal(result.returned_image_count, images ? result.tool_calls : 0);
    assert.ok(result.initial_node_count > 0);
  }
  console.log(`CUA_NATIVE_LATENCY_COMPARISON ${JSON.stringify({ measurements, scope: 'Same five native inputs in fresh disposable apps; no model latency or remote behavior measured. Timings are measurements, not pass/fail thresholds.' })}`);
  process.exit(0);
}

const directory = await mkdtemp(join(tmpdir(), 'openbitfun-directed-input-'));
let fixture;
let observer;
let harness;
try {
  const binary = join(directory, 'input-fixture');
  const result = join(directory, 'counts.json');
  const bundleExecutable = async (name, identifier) => {
    const contents = join(directory, `${name}.app`, 'Contents');
    await mkdir(join(contents, 'MacOS'), { recursive: true });
    await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleName</key><string>${name}</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>NSHighResolutionCapable</key><true/></dict></plist>`);
    const executable = join(contents, 'MacOS', 'fixture');
    await copyFile(binary, executable);
    return executable;
  };
  await run('xcrun', ['clang', '-fobjc-arc', '-Wall', '-Werror', 'scripts/fixtures/computer-use-input-controls.m', '-framework', 'AppKit', '-o', binary]);
  // Build before opening either fixture window, so compiler latency never
  // leaves the foreground observer sitting above the user's work.
  const testBinary = await nativeTestBinary();
  const targetBinary = await bundleExecutable('OpenBitFun Input Target', 'dev.openbitfun.input-fixture.target');
  const observerBinary = await bundleExecutable('OpenBitFun Input Observer', 'dev.openbitfun.input-fixture.observer');
  await run(binary, ['--wait-input-idle', '20']);
  fixture = spawn(targetBinary, [result], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  const [pid] = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Input fixture failed to become ready')), 10_000);
    let output = '';
    fixture.once('error', error => { clearTimeout(timer); reject(error); });
    fixture.once('exit', code => { clearTimeout(timer); reject(new Error(`Input fixture exited ${code}`)); });
    fixture.stdout.on('data', chunk => {
      output += String(chunk);
      const ready = output.match(/READY (\d+)/);
      if (ready) { clearTimeout(timer); resolve(ready.slice(1)); }
    });
  });
  const initialWindow = JSON.parse(await readFile(result, 'utf8')).window_id;
  const hostReady = join(directory, 'host-ready');
  const testEnvironment = {
    ...process.env, OPENBITFUN_INPUT_FIXTURE_PID: pid,
    OPENBITFUN_INPUT_FIXTURE_APP: join(directory, 'OpenBitFun Input Target.app'),
    OPENBITFUN_INPUT_FIXTURE_RESULT: result, OPENBITFUN_INPUT_OBSERVER_RESULT: `${result}.observer`,
    OPENBITFUN_INPUT_HOST_READY: hostReady,
    ...(busyAx ? { OPENBITFUN_INPUT_BUSY_AX: '1' } : {}),
    ...(foreground ? { OPENBITFUN_INPUT_FOREGROUND: '1' } : {}),
  };
  // Initialize AppKit before creating the foreground observer. Otherwise the
  // test host's own startup can deactivate it before the first tool action.
  let orchestrationResult;
  if (orchestration) {
    orchestrationResult = run(testBinary, [], testEnvironment, child => { harness = child; }).then(() => null, error => error);
    const deadline = Date.now() + 10_000;
    while (true) {
      try { await readFile(hostReady); break; } catch (error) {
        if (error.code !== 'ENOENT' || Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
  }
  // Recheck immediately before foreground activation; the first gate ran
  // before target/host startup. A busy desktop is inconclusive, never PASS.
  await run(binary, ['--wait-input-idle', '5']);
  observer = spawn(observerBinary, ['--observer', `${result}.observer`, String(initialWindow)], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true, env: { ...process.env, OPENBITFUN_INPUT_COVER_TARGET: semantic ? '1' : '0' } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Observer not ready')), 10000);
    observer.stdout.on('data', chunk => { process.stdout.write(String(chunk)); if (String(chunk).includes('READY')) { clearTimeout(timer); resolve(); } });
    observer.once('error', error => { clearTimeout(timer); reject(error); });
    observer.once('exit', code => { clearTimeout(timer); reject(new Error(`Observer exited ${code}`)); });
  });
  const testArgs = orchestration ? [] : [semantic ? 'native_semantic_controls_fixture' : 'native_inactive_controls_fixture', '--ignored', '--test-threads=1', '--nocapture'];
  if (orchestration) {
    const error = await orchestrationResult;
    if (error) throw error;
  } else {
    await run(testBinary, testArgs, { ...testEnvironment, OPENBITFUN_INPUT_OBSERVER_PID: String(observer.pid) });
  }
  // Allow the observer's independent sampling timer to publish the final state.
  await new Promise(resolve => setTimeout(resolve, 90));
  const finalTarget = JSON.parse(await readFile(result, 'utf8'));
  const finalObserver = JSON.parse(await readFile(`${result}.observer`, 'utf8'));
  assert.equal(finalTarget.foreign_actions, 0, 'unbound window must receive no actions');
  if (foreground) {
    assert.equal(finalTarget.active, true);
    assert.equal(finalTarget.key_window, true);
    assert.equal(finalTarget.frontmost_pid, Number(pid));
    assert.equal(finalTarget.field_text, 'foreground✓');
    assert.equal(finalTarget.shortcut_actions, 1);
    assert.deepEqual(finalObserver.input_events, [], 'wrong foreground must receive no input');
    console.log('PASS: explicit foreground recovery keeps the exact target and verifies native input destination');
  } else {
    assert.equal(finalObserver.active, true, 'observer must remain active');
    assert.equal(finalObserver.key_window, true, 'observer must remain key');
    assert.equal(finalObserver.frontmost_pid, observer.pid, 'observer must retain global foreground');
    assert.equal(finalObserver.target_ahead, false, 'target must remain below observer');
    assert.equal(finalObserver.cursor_valid, true, 'system cursor sample must be available');
    assert.deepEqual(finalObserver.cursor, finalObserver.ready_cursor, 'directed input must preserve the system cursor position');
    assert.ok(finalObserver.ready_time > 0, 'observer lifecycle baseline must be recorded');
    const afterReady = event => event.time >= finalObserver.ready_time;
    assert.deepEqual(finalObserver.lifecycle_history.filter(afterReady).filter(event =>
      ['NSApplicationDidResignActiveNotification', 'NSWindowDidResignKeyNotification', 'NSWindowDidResignMainNotification'].includes(event.notification)), [],
    'observer must never transiently resign active/key/main after READY');
    assert.deepEqual(finalObserver.input_events.filter(afterReady), [], 'directed input must not reach the observer');
    for (const event of finalTarget.events) {
      assert.equal(event.window_id, initialWindow, 'mouse input must address only the bound window');
      if (event.outside_frame) {
        assert.equal(event.hit, 'none', 'outside-frame focus event must not hit content');
        assert.equal(event.flags & (1 << 20), 0, 'focus preparation must not add Command');
      }
    }
    console.log(busyAx ? 'PASS: real AX timeout retains one directed click with foreground and cursor unchanged' : semantic ? 'PASS: native AX hit testing and semantic input operate on covered controls without raising the target' : 'PASS: standard controls and non-AX canvas preserve input semantics and foreground state');
  }
} finally {
  if (harness && harness.exitCode === null) await new Promise(resolve => { harness.once('exit', resolve); harness.kill('SIGTERM'); });
  if (observer && observer.exitCode === null) await new Promise(resolve => { observer.once('exit', resolve); observer.kill('SIGTERM'); });
  if (fixture && fixture.exitCode === null) await new Promise(resolve => { fixture.once('exit', resolve); fixture.kill('SIGTERM'); });
  await rm(directory, { recursive: true, force: true });
}
