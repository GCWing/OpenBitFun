import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'darwin', 'Native resize verification requires macOS');
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'openbitfun-window-resize-'));

try {
  await mkdir(join(directory, 'src'));
  await writeFile(join(directory, 'Cargo.toml'), `[package]
name = "openbitfun-window-resize-fixture"
version = "0.0.0"
edition = "2021"
[dependencies]
objc2 = { version = "0.6", default-features = false, features = ["std"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
objc2-foundation = { version = "0.3", default-features = false, features = ["std", "NSGeometry"] }
objc2-app-kit = { version = "0.3", default-features = false, features = ["std", "objc2-core-foundation", "NSView", "NSResponder", "NSBezierPath", "NSColor", "NSWindow"] }
`);
  const module = join(root, 'src/apps/desktop/src/macos_window_resize/geometry.rs');
  const backdrop = join(root, 'src/apps/desktop/src/macos_window_resize/backdrop.rs');
  const fixture = await readFile(join(root, 'scripts/fixtures/macos-window-resize.rs'), 'utf8');
  await writeFile(join(directory, 'src/main.rs'), `#[path = ${JSON.stringify(module)}]\nmod geometry;\n#[path = ${JSON.stringify(backdrop)}]\nmod backdrop;\n${fixture}`);
  // NSViews only: no windows, WebViews, browser control, run loop or user data.
  await new Promise((resolve, reject) => {
    const child = spawn('cargo', ['run', '--offline', '--quiet'], {
      cwd: directory, stdio: 'inherit', windowsHide: true,
      env: { ...process.env, CARGO_TARGET_DIR: join(root, 'target/macos-window-resize') },
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`cargo exited ${code}`)));
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}
