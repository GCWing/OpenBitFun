// Popup compositing and routing on a disposable fixture: one main window with a
// same-process popup panel that closes on outside presses, like a real menu.
// Runs once with an attached child-window popup and once with an independent
// pop-up-menu-level popup.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
assert.equal(process.platform, 'darwin', 'popup overlay fixture requires macOS');
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'openbitfun-popup-overlay-'));
const run = (command, args, env = process.env) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, env });
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
});
const stop = fixture => fixture && fixture.exitCode === null
  ? new Promise(resolve => { fixture.once('exit', resolve); fixture.kill('SIGTERM'); })
  : Promise.resolve();
let fixture;
try {
  const binary = join(directory, 'popup-fixture');
  await run('xcrun', ['clang', '-fobjc-arc', '-Wall', '-Werror', 'scripts/fixtures/computer-use-popup.m', '-framework', 'AppKit', '-o', binary]);
  for (const mode of ['child', 'menu']) {
    const result = join(directory, `popup-${mode}.json`);
    fixture = spawn(binary, [result, mode], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    const pid = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Popup fixture failed to become ready')), 10_000);
      let output = '';
      fixture.once('error', error => { clearTimeout(timer); reject(error); });
      fixture.once('exit', code => { clearTimeout(timer); reject(new Error(`Popup fixture exited ${code}`)); });
      fixture.stdout.on('data', chunk => {
        output += String(chunk);
        const ready = output.match(/READY (\d+)/);
        if (ready) { clearTimeout(timer); resolve(ready[1]); }
      });
    });
    const testArgs = ['native_popup_overlay_fixture', '--ignored', '--test-threads=1', '--nocapture'];
    const command = process.env.OPENBITFUN_TEST_BINARY || 'cargo';
    const args = process.env.OPENBITFUN_TEST_BINARY ? testArgs : ['test', '-p', 'openbitfun-desktop', '--lib', 'native_popup_overlay_fixture', '--', ...testArgs.slice(1)];
    await run(command, args, { ...process.env, OPENBITFUN_POPUP_FIXTURE_PID: pid, OPENBITFUN_POPUP_FIXTURE_RESULT: result });
    const final = JSON.parse(await readFile(result, 'utf8'));
    assert.equal(final.popup_presses.length, 2, `${mode}: popup received exactly one press and release`);
    assert.ok(final.popup_presses.every(press => press.window_id === final.popup_window_id), `${mode}: presses carry the popup window`);
    assert.equal(final.popup_dismissed, true, `${mode}: outside press dismissed the popup`);
    await stop(fixture);
    fixture = undefined;
    console.log(`PASS (${mode}): popup pixels are composited, popup presses reach the popup without dismissing it, and outside presses reach the bound window`);
  }
} finally {
  await stop(fixture);
  await rm(directory, { recursive: true, force: true });
}
