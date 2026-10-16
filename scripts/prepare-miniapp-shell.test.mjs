import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { prepareMiniAppShell, SHELL_NAME } from './prepare-miniapp-shell.mjs';
import { prepareTauriConfig } from './desktop-tauri-build.mjs';

const ROOT = resolve(import.meta.dirname, '..');

test('the standalone shell supplies an existing Windows resource icon', () => {
  const shellDir = join(ROOT, 'src/apps/miniapp-shell');
  const config = JSON.parse(readFileSync(join(shellDir, 'tauri.conf.json'), 'utf8'));
  const icon = config.bundle.icon.find(path => path.endsWith('.ico'));
  assert.ok(icon, 'tauri-build requires an ICO for the Windows executable resource');
  const bytes = readFileSync(resolve(shellDir, icon));
  assert.equal(bytes.readUInt32LE(0), 0x00010000);
  assert.ok(bytes.readUInt16LE(4) > 0, 'the ICO must contain an image');
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'openbitfun-miniapp-shell-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

for (const target of [undefined, 'x86_64-pc-windows-msvc', 'x86_64-unknown-linux-gnu', 'universal-apple-darwin']) {
  test(`prepares a separate optimized sidecar and stages the correct target: ${target || 'host'}`, (t) => {
    const root = fixture(t);
    const calls = [];
    const run = (command, args, options) => {
      calls.push({ command, args, options });
      assert.equal(options.windowsHide, true);
      assert.equal(options.env.TAURI_CONFIG, undefined);
      if (command === 'rustc') return { status: 0, stdout: 'host: aarch64-apple-darwin\n' };
      if (command === 'node') {
        assert.ok(['scripts/generate-miniapp-chat-styles.mjs', 'scripts/generate-miniapp-chrome-theme.mjs'].includes(args[0]));
        return { status: 0 };
      }
      if (command === 'cargo') {
        assert.deepEqual(args.slice(0, 6), ['build', '--locked', '-p', SHELL_NAME, '--profile', 'miniapp-shell']);
        const triple = args.includes('--target') ? args[args.indexOf('--target') + 1] : undefined;
        const binary = join(root, 'target', ...(triple ? [triple] : []), 'miniapp-shell',
          `${SHELL_NAME}${triple?.includes('windows') ? '.exe' : ''}`);
        mkdirSync(dirname(binary), { recursive: true });
        writeFileSync(binary, 'window-only-binary');
      } else if (command === 'lipo') {
        assert.equal(target, 'universal-apple-darwin');
        writeFileSync(args.at(-1), 'universal-window-only-binary');
      } else assert.fail(command);
      return { status: 0 };
    };
    const result = prepareMiniAppShell({ root, target, profile: 'release-fast',
      env: { TAURI_CONFIG: '{"frontendDist":"full-product"}' }, run });
    const expected = target === 'universal-apple-darwin' ? 'universal-window-only-binary' : 'window-only-binary';
    assert.equal(readFileSync(result.stage, 'utf8'), expected);
    assert.equal(readFileSync(result.sidecar, 'utf8'), expected);
    assert.equal(result.bytes, Buffer.byteLength(expected));
    assert.ok(result.stage.includes('release-fast'));
    assert.equal(calls.filter(({ command }) => command === 'cargo').length, target === 'universal-apple-darwin' ? 2 : 1);
    assert.deepEqual(calls.filter(({ command }) => command === 'node').map(({ args }) => args[0]), ['scripts/generate-miniapp-chat-styles.mjs', 'scripts/generate-miniapp-chrome-theme.mjs']);
  });
}

test('a failed shell build never stages the full host as a fallback', (t) => {
  const root = fixture(t);
  assert.throws(() => prepareMiniAppShell({ root, env: {}, run: (command) => command === 'rustc'
    ? { status: 0, stdout: 'host: aarch64-apple-darwin\n' } : { status: 1, stderr: 'build failure' },
  }), /build failure/);
});

test('empty and oversized sidecars fail before staging a system launcher', (t) => {
  for (const bytes of [0, 16 * 1048576 + 1]) {
    const root = fixture(t);
    const binary = join(root, 'target/miniapp-shell', SHELL_NAME);
    const run = (command) => {
      if (command === 'rustc') return { status: 0, stdout: 'host: aarch64-apple-darwin\n' };
      if (command === 'node') return { status: 0 };
      mkdirSync(dirname(binary), { recursive: true });
      writeFileSync(binary, '');
      truncateSync(binary, bytes);
      return { status: 0 };
    };
    assert.throws(() => prepareMiniAppShell({ root, env: {}, run }), /artifact budget or is empty/);
    assert.equal(existsSync(join(root, 'target/debug', SHELL_NAME)), false);
  }
});

test('Desktop packages the shell through externalBin for native signing and sibling placement', (t) => {
  const root = fixture(t);
  const desktopDir = join(root, 'src/apps/desktop');
  const base = join(desktopDir, 'tauri.conf.json');
  mkdirSync(desktopDir, { recursive: true });
  writeFileSync(base, JSON.stringify({ bundle: { resources: {}, externalBin: ['other-sidecar'] } }));
  const sidecarBase = join(desktopDir, 'gen/miniapp-shell', SHELL_NAME);
  const config = JSON.parse(readFileSync(prepareTauriConfig(base, {
    desktopDir, miniappShell: { sidecarBase },
  }), 'utf8'));
  assert.deepEqual(config.bundle.externalBin, ['other-sidecar', `gen/miniapp-shell/${SHELL_NAME}`]);
});

test('the standalone shell dependency graph cannot link product runtime owners', () => {
  const result = spawnSync('cargo', ['tree', '--locked', '-p', SHELL_NAME, '--edges', 'normal', '--prefix', 'none'],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const packages = new Set(result.stdout.split('\n').map((line) => line.split(' ')[0]));
  for (const forbidden of ['openbitfun-desktop', 'openbitfun-core', 'openbitfun-agent-runtime',
    'openbitfun-services-integrations', 'openbitfun-product-capabilities', 'openbitfun-webdriver',
    'openbitfun-tool-packs', 'openbitfun-ai-adapters', 'terminal-core', 'sherpa-onnx']) {
    assert.equal(packages.has(forbidden), false, `${forbidden} must remain in the shared host`);
  }
  assert.ok(packages.has('openbitfun-miniapp-ipc'));
});

test('the resolved shell disables Tauri dev icon overrides independently of the Cargo profile', () => {
  const result = spawnSync('cargo', ['tree', '--locked', '-p', SHELL_NAME, '--edges', 'features', '--prefix', 'none'],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^tauri feature "custom-protocol"/m);
});
