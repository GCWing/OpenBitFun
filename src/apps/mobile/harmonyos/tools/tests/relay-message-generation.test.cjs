const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function loadService(name, dependencies = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets/services', `${name}.ets`), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  new Function('require', 'exports', code)(name => dependencies[name] || {}, exports);
  return exports;
}

const { AccountRealtime } = loadService('AccountRealtime');
function connectionFixture() {
  const writes = [];
  const connection = Object.assign(Object.create(AccountRealtime.prototype), {
    closed: false, connected: true, epoch: 1, nextAck: 0,
    peerEncodings: new Set(['host']), pending: new Map(),
    payloads: { uploadIfLarge: async value => value, resolve: async value => value },
  });
  connection.socket = {
    send: async data => {
      writes.push(data);
      const id = Number(data.substring(2, data.indexOf('[')));
      const pending = connection.pending.get(id);
      clearTimeout(pending.timer);
      connection.pending.delete(id);
      pending.resolve({ resp: 'ok' });
      return true;
    },
  };
  return { connection, writes };
}

test('prepared ciphertext cannot move to another capability generation', async () => {
  const { connection, writes } = connectionFixture();
  const prepared = connection.peerEncodings;
  connection.peerEncodings = new Set();
  await assert.rejects(connection.call('host', {}, 5000, prepared), /capabilities changed.*not submitted/);
  assert.equal(writes.length, 0);
});

test('presence invalidation during bulk upload prevents submission', async () => {
  const { connection, writes } = connectionFixture();
  const prepared = connection.peerEncodings;
  connection.payloads.uploadIfLarge = async value => {
    connection.peerEncodings = new Set();
    return value;
  };
  await assert.rejects(connection.call('host', {}, 5000, prepared), /capabilities changed.*not submitted/);
  assert.equal(writes.length, 0);
});

test('an acknowledged response survives a later capability invalidation', async () => {
  const { connection, writes } = connectionFixture();
  connection.payloads.resolve = async value => {
    connection.peerEncodings = new Set();
    return value;
  };
  assert.deepEqual(await connection.call('host', {}, 5000, connection.peerEncodings), { resp: 'ok' });
  assert.equal(writes.length, 1);
});

test('codec facade awaits native work and bounds a stalled worker', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let finish;
  const { RelayMessageEncoding } = loadService('RelayMessageEncoding', {
    'libopenbitfun_crypto.so': { default: {
      encodeRelayMessage: () => new Promise(resolve => { finish = resolve; }),
      decodeRelayMessage: () => new Promise(() => {}),
    } },
  });
  const bytes = new Uint8Array([1, 2, 3]);
  const pending = RelayMessageEncoding.encode(bytes);
  finish(bytes);
  assert.equal(await pending, bytes);
  const timedOut = assert.rejects(RelayMessageEncoding.decode(bytes), /codec timed out/);
  context.mock.timers.tick(15000);
  await timedOut;
});
