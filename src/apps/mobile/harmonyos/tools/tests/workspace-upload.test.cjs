const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');
function fixture(transform = (_request, status) => status) {
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 17, 42);
  let closed = 0, offset = 0, lost = true, target = 'runtime-a';
  const calls = [], reads = [];
  const api = { OpenMode: { READ_ONLY: 0 }, open: async () => ({ fd: 1 }), close: async () => { closed++; }, stat: async () => ({ size: bytes.length, isFile: () => true }), read: async (_fd, buffer, options) => { reads.push(buffer.byteLength); const count = Math.min(buffer.byteLength, bytes.length - options.offset); new Uint8Array(buffer).set(bytes.subarray(options.offset, options.offset + count)); return count; } };
  const dependencies = {
    '@ohos.file.fs': { default: api },
    '@ohos.file.picker': { default: { DocumentSelectOptions: class {}, DocumentViewPicker: class { async select() { return ['file://selected']; } } } },
    '@kit.CryptoArchitectureKit': { cryptoFramework: { createMd() { const h = crypto.createHash('sha256'); return { update: async ({data}) => h.update(data), digest: async () => ({data: h.digest()}) }; } } },
    './Encoding': { Encoding: { randomBytes: crypto.randomBytes, bytesToBase64: bytes => Buffer.from(bytes).toString('base64') } }
  };
  const source = fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets/services/WorkspaceFileUploadClient.ets'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exported = {}; new Function('require', 'exports', compiled)(name => dependencies[name] || {}, exported);
  const manager = { async hostInvoke(command, {request}) {
    assert.equal(command, 'workspace_file_upload'); calls.push(structuredClone(request));
    if (request.action === 'append') { assert.equal(request.offset, offset); offset += Buffer.from(request.contentBase64, 'base64').length; if (lost) { lost = false; throw new Error('ack lost'); } }
    return transform(request, { transferId: request.transferId, nextOffset: offset, totalBytes: bytes.length, completed: request.action === 'finish' });
  } };
  return { client: new exported.WorkspaceFileUploadClient(manager, () => target), calls, reads, bytes, get closed() { return closed; }, setTarget(value) { target = value; } };
}
test('native upload uses bounded reads and queries uncertain accepted chunks without duplication', async () => {
  const f = fixture(); await f.client.select('/runtime/file', undefined, '', () => true, '/runtime');
  await f.client.resume(() => true, () => {});
  assert.equal(f.client.hasPending(), false); assert.equal(f.closed, 1);
  assert.ok(f.reads.every(size => size <= 1024 * 1024));
  assert.equal(f.calls.filter(c => c.action === 'append').length, 3);
  assert.equal(f.calls.filter(c => c.action === 'status').length, 1);
  assert.equal(f.calls[0].sha256, crypto.createHash('sha256').update(f.bytes).digest('hex'));
});
test('selected upload cannot move to a different controlled runtime', async () => {
  const f = fixture(); await f.client.select('/runtime/file', undefined, '', () => true, '/runtime');
  f.setTarget('runtime-b'); await assert.rejects(f.client.resume(() => true, () => {}), /owning runtime/);
  assert.equal(f.calls.length, 0); assert.equal(f.client.hasPending(), true);
});
test('cancel before begin closes the selected local file without issuing a nonexistent transfer mutation', async () => {
  const f = fixture(); await f.client.select('/runtime/file', undefined, '', () => true, '/runtime');
  await f.client.cancel(); assert.equal(f.closed, 1); assert.equal(f.calls.length, 0); assert.equal(f.client.hasPending(), false);
});
test('runtime switch after an acknowledged chunk prevents the next transfer RPC', async () => {
  const f = fixture(); await f.client.select('/runtime/file', undefined, '', () => true, '/runtime');
  await f.client.resume(() => true, () => f.setTarget('runtime-b'));
  assert.equal(f.calls.filter(c=>c.action==='append').length,1);
  assert.equal(f.client.hasPending(),true);
});

test('completed upload with short final cursor retains source for recovery', async () => {
  const f = fixture((request, status) => request.action === 'finish' ? {...status, nextOffset: 0} : status);
  await f.client.select('/runtime/file', undefined, '', () => true, '/runtime');
  await assert.rejects(f.client.resume(() => true, () => {}), /complete/);
  assert.equal(f.client.hasPending(), true);
  assert.equal(f.closed, 0);
  await f.client.cancel();
  assert.equal(f.closed, 1);
});

for (const field of ['transferId', 'totalBytes', 'nextOffset']) {
  test(`upload rejects invalid ${field} on append and recovery acknowledgements`, async () => {
    let invalid = true;
    const f = fixture((request, status) => {
      if (!invalid || !['append', 'status'].includes(request.action)) return status;
      return {...status, [field]: field === 'transferId' ? 'another-transfer' : field === 'totalBytes' ? status.totalBytes + 1 : status.nextOffset + 0.5};
    });
    await f.client.select('/runtime/file', undefined, '', () => true, '/runtime');
    await assert.rejects(f.client.resume(() => true, () => {}), /acknowledgement/);
    assert.equal(f.client.hasPending(), true);
    assert.equal(f.closed, 0);
    assert.equal(f.calls.filter(c => c.action === 'append').length, 1);
    invalid = false;
    await f.client.resume(() => true, () => {});
    assert.equal(f.client.hasPending(), false);
    assert.equal(f.closed, 1);
  });
}

for (const phase of ['begin', 'finish']) {
  test(`lost ${phase} acknowledgement queries state and completes without duplicate mutation`, async () => {
    let completed = false;
    let dropped = false;
    const f = fixture((request, status) => {
      if (request.action === 'finish') completed = true;
      if (request.action === phase && !dropped) { dropped = true; throw new Error(`${phase} ack lost`); }
      return {...status, completed};
    });
    await f.client.select('/runtime/file', undefined, '', () => true, '/runtime');
    await f.client.resume(() => true, () => {});
    assert.equal(f.closed, 1);
    assert.equal(f.client.hasPending(), false);
    assert.equal(f.calls.filter(c => c.action === phase).length, 1);
    assert.equal(f.calls.filter(c => c.action === 'append').length, 3);
    assert.equal(f.calls.filter(c => c.action === 'status').length, 2);
  });
}
test('resuming an already completed upload closes source without another finish', async () => {
  const f = fixture((_request, status) => ({...status, completed: true, nextOffset: status.totalBytes}));
  await f.client.select('/runtime/file', undefined, '', () => true, '/runtime');
  await f.client.resume(() => true, () => {});
  assert.equal(f.closed, 1);
  assert.deepEqual(f.calls.map(c => c.action), ['begin']);
});
