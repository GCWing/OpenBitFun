const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function fixture() {
  const source = fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets/pages/viewmodel/WorkspaceToolsViewModel.ets'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exported = {};
  new Function('require', 'exports', compiled)(name => name.endsWith('WorkspaceFileUploadClient') ? { WorkspaceFileUploadClient: class {} } : {}, exported);
  const state = { visible: true, terminalId: '', output: '', error: '' };
  const subscriptions = [], reads = [];
  const manager = {
    subscribeSession(id, callbacks) { subscriptions.push(callbacks); return { close() {} }; },
    hostInvoke(command, args) { return new Promise((resolve, reject) => reads.push({ args, resolve, reject })); },
  };
  const vm = new exported.WorkspaceToolsViewModel(state, manager, () => 'runtime');
  vm.owner = 'runtime';
  return { vm, state, subscriptions, reads };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const page = data => ({ data, nextOffset: data.length, cursor: data.length, truncated: false });

test('reattaching the same terminal rejects old stream callbacks and hands history reading to the new attachment', async () => {
  const f = fixture();
  f.vm.attach('same');
  const stale = f.subscriptions[0];
  f.vm.attach('same');
  stale.onError(new Error('Old stream disconnected'));
  await stale.onCaughtUp();
  assert.equal(f.state.error, '');
  assert.equal(f.reads.length, 1);
  f.reads[0].resolve(page('stale output'));
  await flush();
  assert.equal(f.state.output, '');
  assert.equal(f.reads.length, 2);
  f.reads[1].resolve(page('current output'));
  await flush();
  assert.equal(f.state.output, 'current output');
  f.subscriptions[1].onError(new Error('Current stream disconnected'));
  assert.equal(f.state.error, 'Current stream disconnected');
});

test('failed history from the previous terminal does not leak its error or block the selected terminal', async () => {
  const f = fixture();
  f.vm.attach('first'); f.vm.attach('second');
  f.reads[0].reject(new Error('Old history unavailable'));
  await flush();
  assert.equal(f.state.error, '');
  assert.equal(f.reads[1].args.sessionId, 'second');
  f.reads[1].resolve(page('second output'));
  await flush();
  assert.equal(f.state.output, 'second output');
});


test('non-advancing terminal history fails once and preserves rendered output', async () => {
  const f = fixture();
  f.vm.attach('first');
  f.reads[0].resolve({ data: 'hello', nextOffset: 5, cursor: 11, truncated: false });
  await flush();
  f.reads[1].resolve({ data: 'duplicate', nextOffset: 5, cursor: 11, truncated: false });
  await flush();
  assert.equal(f.reads.length, 2);
  assert.equal(f.state.output, 'hello');
  assert.match(f.state.error, /made no progress/);
});

test('truncated history can reset its cursor and finish on an empty final page', async () => {
  const f = fixture();
  f.vm.attach('first');
  f.reads[0].resolve(page('old output'));
  await flush();
  const refresh = f.subscriptions[0].onCaughtUp();
  f.reads[1].resolve({ data: 'new', nextOffset: 3, cursor: 4, truncated: true });
  await flush();
  f.reads[2].resolve({ data: '!', nextOffset: 4, cursor: 4, truncated: false });
  await refresh;
  assert.equal(f.state.output, 'new!');
  const final = f.subscriptions[0].onCaughtUp();
  f.reads[3].resolve({ data: '', nextOffset: 4, cursor: 4, truncated: false });
  await final;
  assert.equal(f.state.output, 'new!');
  assert.equal(f.state.error, '');
});


test('empty recovered history clears its connection error without erasing unrelated errors', async () => {
  const f = fixture();
  f.vm.attach('first'); f.reads[0].resolve(page('hello')); await flush();
  f.subscriptions[0].onError(new Error('Disconnected'));
  const recovery = f.subscriptions[0].onCaughtUp();
  f.reads[1].resolve({data:'', nextOffset:5, cursor:5, truncated:false});
  await recovery;
  assert.equal(f.state.error, ''); assert.equal(f.state.output, 'hello');
  f.subscriptions[0].onError(new Error('Disconnected'));
  f.state.error = 'Input failed';
  const next = f.subscriptions[0].onCaughtUp();
  f.reads[2].resolve({data:'', nextOffset:5, cursor:5, truncated:false});
  await next;
  assert.equal(f.state.error, 'Input failed');
});
