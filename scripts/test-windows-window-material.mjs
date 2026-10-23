// Exercise the production window material builder with real, hidden Windows
// WebViews. --check only checks types; --build-only leaves the executable in
// CARGO_TARGET_DIR for execution on a separate Windows host.
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const takeFlag = flag => {
  const index = args.indexOf(flag);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
};
const check = takeFlag('--check');
const buildOnly = takeFlag('--build-only');
const xwin = takeFlag('--xwin');
if (check && buildOnly) throw new Error('Choose --check or --build-only.');
if (process.platform !== 'win32' && !check && !buildOnly) {
  throw new Error('Native verification requires Windows. Use --check --target x86_64-pc-windows-msvc or --build-only --xwin --target x86_64-pc-windows-msvc.');
}
const directory = await mkdtemp(join(tmpdir(), 'openbitfun-window-material-'));
const targetDirectory = resolve(process.env.CARGO_TARGET_DIR ?? join(root, 'target/windows-window-material-native'));
const source = path => JSON.stringify(resolve(root, path));
const run = cargoArgs => new Promise((resolveExit, reject) => {
  const child = spawn('cargo', cargoArgs, {
    cwd: directory,
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, CARGO_TARGET_DIR: targetDirectory },
  });
  child.once('error', reject);
  child.once('close', code => resolveExit(code ?? 1));
});

try {
  const [workspace, lock, fixture] = await Promise.all([
    readFile(join(root, 'Cargo.toml'), 'utf8'),
    readFile(join(root, 'Cargo.lock'), 'utf8'),
    readFile(join(root, 'scripts/fixtures/windows-window-material.rs'), 'utf8'),
  ]);
  const version = (name, prefix = '') => {
    const packages = lock.split('[[package]]').map(section => section.match(/\nname = "([^"]+)"\nversion = "([^"]+)"/));
    const found = packages.find(entry => entry?.[1] === name && entry[2].startsWith(prefix));
    if (!found) throw new Error(`Missing locked dependency: ${name} ${prefix}`);
    return found[2];
  };
  const runtimePatches = ['tauri-runtime', 'tauri-runtime-wry', 'tauri-utils'].map(name => {
    const escapedName = name.replaceAll('-', '\\-');
    const entry = workspace.match(new RegExp(`^${escapedName} = \\{ git = "([^"\\n]+)", rev = "([^"\\n]+)" \\}`, 'm'));
    if (!entry) throw new Error(`Missing production Tauri patch: ${name}`);
    return `${name} = { git = ${JSON.stringify(entry[1])}, rev = ${JSON.stringify(entry[2])} }`;
  });
  await mkdir(join(directory, 'src'));
  await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'Cargo.toml'), `[package]
name = "openbitfun-window-material-fixture"
version = "0.0.0"
edition = "2021"
[workspace]
[dependencies]
tauri = { version = "=${version('tauri')}", features = ["unstable"] }
tempfile = "=${version('tempfile')}"
windows-version = "=${version('windows-version')}"
webview2-com = "=${version('webview2-com')}"
windows = { version = "=${version('windows', '0.61.')}", features = [
  "Win32_Foundation", "Win32_Graphics_Dwm", "Win32_Graphics_Gdi",
  "Win32_UI_Shell", "Win32_UI_WindowsAndMessaging"
] }
[build-dependencies]
tauri-build = "=${version('tauri-build')}"
[patch.crates-io]
tao = { path = ${source('third_party/tao')} }
wry = { path = ${source('third_party/wry')} }
${runtimePatches.join('\n')}
[profile.dev]
debug = 0
incremental = false
`);
  await writeFile(join(directory, 'tauri.conf.json'), JSON.stringify({
    productName: 'OpenBitFun Window Material Fixture',
    version: '0.0.0',
    identifier: 'test.openbitfun.window-material',
    build: { frontendDist: 'assets' },
    app: { windows: [] },
    bundle: { active: false, icon: ['icons/icon.ico'] },
  }));
  await mkdir(join(directory, 'icons'));
  await copyFile(join(root, 'src/apps/desktop/icons/openbitfun-app-icon.ico'), join(directory, 'icons/icon.ico'));
  await writeFile(join(directory, 'assets/index.html'), '<!doctype html><title>Hidden window material fixture</title>');
  await writeFile(join(directory, 'build.rs'), 'fn main() { tauri_build::build(); }\n');
  await copyFile(join(root, 'Cargo.lock'), join(directory, 'Cargo.lock'));
  await writeFile(join(directory, 'src/main.rs'), `#[path = ${source('src/apps/desktop/src/window_material.rs')}]
mod window_material;
${fixture}`);
  const cargoArgs = command => [
    ...(xwin ? ['xwin'] : []),
    command,
    '--offline',
    '--manifest-path', join(directory, 'Cargo.toml'),
    ...args,
  ];
  if (check) {
    process.exitCode = await run([...cargoArgs('check'), '--tests']);
  } else if (buildOnly) {
    process.exitCode = await run(cargoArgs('build'));
    if (process.exitCode === 0) {
      process.exitCode = await run([...cargoArgs('test'), '--no-run']);
    }
  } else {
    process.exitCode = await run(cargoArgs('test'));
    if (process.exitCode === 0) process.exitCode = await run(cargoArgs('run'));
  }
  if (buildOnly && process.exitCode === 0) {
    const option = name => {
      const index = args.indexOf(name);
      return index >= 0 ? args[index + 1] : args.find(argument => argument.startsWith(`${name}=`))?.slice(name.length + 1);
    };
    const target = option('--target');
    const profile = option('--profile') ?? (args.includes('--release') ? 'release' : 'debug');
    // Cargo also accepts a JSON target path; its file stem is the output folder.
    const targetFolder = target && isAbsolute(target) ? target.split(/[\\/]/).at(-1).replace(/\.json$/, '') : target;
    console.log(`Native fixture executable: ${join(targetDirectory, ...(targetFolder ? [targetFolder] : []), profile, 'openbitfun-window-material-fixture.exe')}`);
    console.log('Build-only verification does not establish Windows runtime behavior.');
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
