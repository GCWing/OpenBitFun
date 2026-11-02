import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'openbitfun-pointer-motion-'));
async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}
try {
  const windows = process.platform === 'win32';
  const binary = join(directory, windows ? 'motion.exe' : 'motion');
  const source = 'scripts/fixtures/computer-use-pointer-motion.c';
  await run(windows ? 'cl' : 'cc', windows
    ? ['/nologo', '/std:c11', '/W4', '/WX', source, `/Fe:${binary}`, `/Fo:${join(directory, 'motion.obj')}`]
    : ['-std=c11', '-Wall', '-Wextra', '-Werror', source, '-lm', '-o', binary]);
  await run(binary, []);
} finally {
  await rm(directory, { recursive: true, force: true });
}
