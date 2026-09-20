import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveDevServerPorts } from './dev-server-ports.mjs';
import { prepareSherpaDev } from './prepare-sherpa-dev.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveCommandInvocation, runCommandPrefixed } = require('./dev.cjs');

test('desktop preparation invokes pnpm without the Windows batch shim', () => {
  const invocation = resolveCommandInvocation(
    'pnpm',
    ['run', 'plugin-host:prepare'],
    { npm_execpath: 'E:\\repo\\node_modules\\pnpm\\bin\\pnpm.cjs' },
    'win32',
  );

  assert.equal(invocation.cmd, process.execPath);
  assert.deepEqual(invocation.args, [
    'E:\\repo\\node_modules\\pnpm\\bin\\pnpm.cjs',
    'run',
    'plugin-host:prepare',
  ]);
  assert.equal(invocation.shell, false);
});

test('direct launcher supports spaces and shell metacharacters and preserves exit failures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dev launcher & spaces '));
  const script = join(root, 'fake pnpm.cjs');
  const argument = 'literal & value %PATH% "quoted"';
  writeFileSync(script, `
    if (process.argv[2] !== ${JSON.stringify(argument)}) process.exit(9);
    process.exit(Number(process.argv[3]));
  `);
  // Keep fixtures in the configured temporary root for post-test inspection.
  const command = process.platform === 'win32' ? 'pnpm' : 'node';
  const args = process.platform === 'win32' ? [argument] : [script, argument];
  const env = { npm_execpath: script };
  const results = await Promise.all([0, 7].map(code =>
    runCommandPrefixed('fixture', command, [...args, String(code)], root, env),
  ));
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.equal(results[1].code, 7);
});

test('Windows direct launches without npm_execpath use the installed pnpm entry', () => {
  const invocation = resolveCommandInvocation('pnpm', ['--version'], {}, 'win32');
  assert.match(invocation.args[0], /node_modules[\\/]pnpm[\\/]bin[\\/]pnpm\.cjs$/);
  assert.equal(invocation.shell, false);
  for (const platform of ['linux', 'darwin']) {
    assert.deepEqual(resolveCommandInvocation('pnpm', ['--version'], {}, platform), {
      cmd: 'pnpm', args: ['--version'], shell: false,
    });
  }
});

test('workspace installation finishes before parallel dependency consumers start', () => {
  const source = readFileSync(new URL('./dev.cjs', import.meta.url), 'utf8');
  const install = source.indexOf("await runCommandPrefixed('mobile-web'");
  const consumers = source.indexOf('const prepTasks = [');
  assert.ok(install > 0 && install < consumers);
  assert.equal(source.match(/runCommandPrefixed\('mobile-web'/g).length, 1);
});

test('HTTP and HMR ports share one contract and reject conflicting overrides', () => {
  assert.deepEqual(resolveDevServerPorts({}), { port: 1422, hmrPort: 1421 });
  assert.deepEqual(resolveDevServerPorts({ OPENBITFUN_DEV_PORT: '1432' }), { port: 1432, hmrPort: 1431 });
  assert.deepEqual(resolveDevServerPorts({ OPENBITFUN_DEV_PORT: '1432', OPENBITFUN_DEV_HMR_PORT: '1440' }), { port: 1432, hmrPort: 1440 });
  for (const port of ['abc', '0', '65536', '1.5']) {
    assert.throws(() => resolveDevServerPorts({ OPENBITFUN_DEV_PORT: port }), /ports/);
  }
  assert.throws(() => resolveDevServerPorts({ OPENBITFUN_DEV_PORT: '1432', OPENBITFUN_DEV_HMR_PORT: '1432' }), /distinct/);
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sherpa-dev-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'Cargo.lock'), '[[package]]\nname = "sherpa-onnx-sys"\nversion = "1.13.4"\n');
  return root;
}
const target = 'aarch64-apple-darwin';
const archive = 'sherpa-onnx-v1.13.4-osx-arm64-static-lib.tar.bz2';

test('explicit library and archive paths are preserved', () => {
  for (const key of ['SHERPA_ONNX_LIB_DIR', 'SHERPA_ONNX_ARCHIVE_DIR']) {
    const env = { [key]: '/explicit' };
    prepareSherpaDev('/unused', env, { run: () => assert.fail('must not run commands') });
    assert.deepEqual(env, { [key]: '/explicit' });
  }
});

test('a worktree reuses the matching main checkout library without downloading', t => {
  const root = fixture(t);
  const main = join(root, 'main');
  const library = join(main, 'target/sherpa-onnx-prebuilt', archive.replace('.tar.bz2', ''), 'lib');
  mkdirSync(library, { recursive: true });
  writeFileSync(join(library, 'libsherpa-onnx-c-api.a'), 'fixture');
  const env = {};
  prepareSherpaDev(root, env, { target, run(command) {
    assert.equal(command, 'git');
    return { status: 0, stdout: join(main, '.git') };
  } });
  assert.equal(env.SHERPA_ONNX_LIB_DIR, library);
});

test('downloads the locked archive through curl and reuses it on the next run', t => {
  const root = fixture(t);
  let downloads = 0;
  const run = (command, args, options) => {
    if (command === 'git') return { status: 1 };
    assert.match(command, /^curl(?:\.exe)?$/);
    assert.equal(options.windowsHide, true);
    assert.equal(args.at(-1), `https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.4/${archive}`);
    writeFileSync(args[args.indexOf('--output') + 1], 'archive fixture');
    downloads++;
    return { status: 0 };
  };
  for (let i = 0; i < 2; i++) {
    const env = {};
    prepareSherpaDev(root, env, { target, run });
    assert.equal(readFileSync(join(env.SHERPA_ONNX_ARCHIVE_DIR, archive), 'utf8'), 'archive fixture');
  }
  assert.equal(downloads, 1);
});

test('failed downloads are not published as reusable archives', t => {
  const root = fixture(t);
  const env = {};
  assert.throws(() => prepareSherpaDev(root, env, { target, run(command) {
    return command === 'git' ? { status: 1 } : { status: 22, stderr: 'download failed' };
  } }), /download failed/);
  assert.equal(env.SHERPA_ONNX_ARCHIVE_DIR, undefined);
});
