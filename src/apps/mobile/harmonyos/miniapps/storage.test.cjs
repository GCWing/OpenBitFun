const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the production ArkTS owner against a real temporary filesystem.
// Only platform APIs are adapted; storage ordering and path policy are unchanged.
async function hostFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'builtin-miniapp-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const handles = new Map();
  let failWrite = false;
  const io = {
    OpenMode: { CREATE: 1, READ_WRITE: 2, TRUNC: 4 },
    readText: async file => {
      try { return await fs.readFile(file, 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') error.code = 13900002; throw error; }
    },
    mkdir: file => fs.mkdir(file, { recursive: true }),
    open: async file => { const handle = await fs.open(file, 'w'); handles.set(handle.fd, handle); return handle; },
    write: async (fd, value) => { if (failWrite) throw Error('disk full'); await handles.get(fd).writeFile(value); },
    fsync: fd => handles.get(fd).sync(),
    close: async handle => { handles.delete(handle.fd); await handle.close(); },
    rename: fs.rename
  };
  const source = await fs.readFile(path.resolve(__dirname, '../entry/src/main/ets/services/BuiltinMiniAppHost.ets'), 'utf8');
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports,
    require: name => {
      if (name === '@kit.CoreFileKit') return { fileIo: io };
      if (name.endsWith('RemoteI18n')) return { RemoteI18n: { t: key => key } };
      return {};
    }
  });
  const create = () => new exports.BuiltinMiniAppHost(() => ({ filesDir: directory }));
  return { host: create(), create, directory, failWrite: () => { failWrite = true; } };
}

test('legacy records and unknown fields survive read/reopen; apps remain isolated', async t => {
  const fixture = await hostFixture(t);
  const dir = path.join(fixture.directory, 'miniapps');
  await fs.mkdir(dir);
  const record = '{"wins":3,"future_field":{"keep":true}}';
  const file = path.join(dir, 'builtin-gomoku-stats.json');
  await fs.writeFile(file, record);
  const result = await fixture.create().call('builtin-gomoku', 'storage.get', { key: 'stats' });
  assert.equal(JSON.stringify(result), record);
  assert.equal(await fs.readFile(file, 'utf8'), record);
  assert.equal(await fixture.host.call('builtin-daily-divination', 'storage.get', { key: 'lastReading' }), null);
  await assert.rejects(fixture.host.call('builtin-daily-divination', 'storage.get', { key: 'stats' }));
  await assert.rejects(fixture.host.call('../escape', 'storage.get', { key: 'stats' }));
});

test('corrupt records return errors without removing or resetting data', async t => {
  const fixture = await hostFixture(t);
  const dir = path.join(fixture.directory, 'miniapps');
  await fs.mkdir(dir);
  const file = path.join(dir, 'builtin-gomoku-stats.json');
  await fs.writeFile(file, '{broken');
  await assert.rejects(fixture.host.call('builtin-gomoku', 'storage.get', { key: 'stats' }));
  assert.equal(await fs.readFile(file, 'utf8'), '{broken');
});

test('queued saves are durable across host recreation and retain large regex input', async t => {
  const fixture = await hostFixture(t);
  const value = { text: 'x'.repeat(20000), flags: ['g'], future: true };
  const first = fixture.host.call('builtin-regex-playground', 'storage.set', { key: 'regex-state', value: {} });
  const second = fixture.host.call('builtin-regex-playground', 'storage.set', { key: 'regex-state', value });
  await Promise.all([first, second]);
  const stored = await fixture.create().call('builtin-regex-playground', 'storage.get', { key: 'regex-state' });
  assert.equal(JSON.stringify(stored), JSON.stringify(value));
});

test('failed writes preserve the last saved record and do not poison reads', async t => {
  const fixture = await hostFixture(t);
  await fixture.host.call('builtin-gomoku', 'storage.set', { key: 'stats', value: { wins: 1 } });
  fixture.failWrite();
  await assert.rejects(fixture.host.call('builtin-gomoku', 'storage.set', { key: 'stats', value: { wins: 2 } }), /disk full/);
  assert.equal((await fixture.host.call('builtin-gomoku', 'storage.get', { key: 'stats' })).wins, 1);
});
