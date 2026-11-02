import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
assert.equal(process.platform, 'darwin', 'directed input fixture requires macOS');
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'openbitfun-directed-input-'));
const run = (command, args, env = process.env) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, env });
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
});
let fixture;
try {
  const binary = join(directory, 'input-fixture');
  const result = join(directory, 'counts.json');
  await run('xcrun', ['clang', '-fobjc-arc', '-Wall', '-Werror', 'scripts/fixtures/computer-use-directed-input.m', '-framework', 'AppKit', '-o', binary]);
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
  const testArgs = ['native_directed_input_fixture_counts_and_stop_release', '--ignored', '--test-threads=1', '--nocapture'];
  const command = process.env.OPENBITFUN_TEST_BINARY || 'cargo';
  const args = process.env.OPENBITFUN_TEST_BINARY ? testArgs : ['test', '-p', 'openbitfun-computer-use', '--lib', 'native_directed_input_fixture_counts_and_stop_release', '--', ...testArgs.slice(1)];
  await run(command, args, {
    ...process.env, OPENBITFUN_INPUT_FIXTURE_PID: pid, OPENBITFUN_INPUT_FIXTURE_X: x,
    OPENBITFUN_INPUT_FIXTURE_Y: y, OPENBITFUN_INPUT_FIXTURE_RESULT: result,
  });
  const received = JSON.parse(await readFile(result, 'utf8'));
  assert.equal(received.locations.length, 4);
  for (const [localX, localY] of received.locations) {
    assert.ok(Math.abs(localX - 60) < 1 && Math.abs(localY - 110) < 1, `Wrong Cocoa window coordinates: ${localX},${localY}`);
  }
  console.log('PASS: asymmetric target location is (60,110) in Cocoa coordinates for every press and release');
} finally {
  if (fixture && fixture.exitCode === null) await new Promise(resolve => { fixture.once('exit', resolve); fixture.kill('SIGTERM'); });
  await rm(directory, { recursive: true, force: true });
}
