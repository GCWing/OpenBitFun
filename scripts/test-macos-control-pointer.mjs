// Compile the production native bridge and exercise only dedicated test windows.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
assert.equal(process.platform, 'darwin', 'AppKit pointer fixture requires macOS');
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'openbitfun-pointer-'));
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
    const timeout = setTimeout(() => child.kill('SIGTERM'), 30_000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)); });
  });
}
try {
  const binary = join(directory, 'pointer-fixture');
  await run('xcrun', ['clang', '-fobjc-arc', '-fblocks', '-Wall', '-Werror', '-Wno-unguarded-availability-new',
    'scripts/fixtures/computer-use-pointer.m',
    '-framework', 'AppKit', '-framework', 'ScreenCaptureKit', '-framework', 'CoreMedia',
    '-framework', 'CoreVideo', '-framework', 'CoreImage', '-o', binary]);
  await run(binary, process.argv.slice(2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
