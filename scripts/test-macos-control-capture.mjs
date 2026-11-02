// Compile the production native bridge and exercise only dedicated test windows.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
assert.equal(process.platform, 'darwin', 'ScreenCaptureKit fixture requires macOS');
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 1 && args[0] === '--locked') || (args.length === 2 && args[0] === '--app-pid' && /^[1-9][0-9]*$/.test(args[1])),
  'Usage: node scripts/test-macos-control-capture.mjs [--app-pid PID | --locked]');
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'openbitfun-window-capture-'));
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
    const timeout = setTimeout(() => child.kill('SIGTERM'), 30_000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)); });
  });
}
try {
  const binary = join(directory, 'window-capture-fixture');
  await run('xcrun', ['clang', '-fobjc-arc', '-fblocks', '-Wall', '-Werror', '-Wno-unguarded-availability-new',
    'src/crates/services/computer-use/src/computer_use/macos_capture.m', 'scripts/fixtures/computer-use-capture.m',
    '-framework', 'AppKit', '-framework', 'ScreenCaptureKit', '-framework', 'CoreMedia',
    '-framework', 'CoreVideo', '-framework', 'CoreImage', '-o', binary]);
  if (args.length) {
    // Explicit opt-in: capture metadata only, without any input or pixel files.
    await run(binary, args);
  } else {
    await run(binary, []);
    await run(binary, ['--minimized']);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
