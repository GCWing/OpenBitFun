import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'darwin', 'Native fullscreen verification requires macOS');
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'openbitfun-window-close-'));
const run = args => new Promise((resolve, reject) => {
  const child = spawn('cargo', args, {
    cwd: directory, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, CARGO_TARGET_DIR: join(root, 'target/macos-window-close') },
  });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`cargo exited ${code}`)));
});

try {
  // Compile the production native lifecycle directly, without linking the
  // runtime/services graph. No substitute implementation or user data is used.
  await mkdir(join(directory, 'src'));
  await writeFile(join(directory, 'Cargo.toml'), `[package]
name = "openbitfun-window-close-fixture"
version = "0.0.0"
edition = "2021"
[dependencies]
objc2 = "0.6"
block2 = "0.6"
serde = { version = "1", features = ["derive"] }
objc2-foundation = { version = "0.3", default-features = false, features = ["std", "NSGeometry", "NSNotification", "NSOperation", "NSString", "block2"] }
objc2-app-kit = { version = "0.3", default-features = false, features = ["std", "NSWindow", "NSResponder", "NSGraphics", "NSApplication", "NSRunningApplication"] }
`);
  const module = join(root, 'src/apps/desktop/src/macos_window_close.rs');
  const fixture = await readFile(join(root, 'scripts/fixtures/macos-window-close.rs'), 'utf8');
  await writeFile(join(directory, 'src/main.rs'), `#[path = ${JSON.stringify(module)}]\nmod macos_window_close;\n${fixture}`);
  await run(['test', '--offline', '--quiet']);
  await run(['run', '--offline', '--quiet']);
} finally {
  await rm(directory, { recursive: true, force: true });
}
