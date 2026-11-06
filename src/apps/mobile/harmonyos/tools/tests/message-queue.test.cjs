const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function load(name, dependencies = {}) {
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets', name + '.ets'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  new Function('require', 'exports', 'setTimeout', 'clearTimeout', code)(name => dependencies[name] || {}, exports, () => 1, () => {});
  return exports;
}
const model = load('model/MessageQueue');
const { MessageQueueStore } = load('services/MessageQueueStore', { '../model/MessageQueue': model, './Encoding': { Encoding: { randomId: () => 'operation' } } });
const snapshot = (sessionId = 's', revision = 7, ids = ['a', 'b']) => ({ sessionId, queueEpoch: 'owner', revision, supportsReorder: true, items: ids.map(turnId => ({ turnId, displayContent: turnId, status: 'queued', attachmentCount: 0 })) });
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const requests = [];
  const f = { state: null, respond: async request => snapshot(request.sessionId) };
  f.store = new MessageQueueStore({ supportsMessageQueue: () => true, manageMessageQueue: async request => { requests.push(request); return f.respond(request); } }, state => { f.state = state; }, () => true);
  f.requests = requests;
  return f;
}
test('host-confirmed order and revision fence every move', async () => {
  const f = fixture(); f.store.select('s'); await flush();
  let acknowledge;
  f.respond = () => new Promise(resolve => { acknowledge = resolve; });
  const work = f.store.dispatch({ sessionId: 's', action: 'reorder', turnId: 'b', beforeTurnId: 'a' });
  assert.deepEqual(f.state.items.map(i => i.turnId), ['a', 'b']);
  assert.equal(f.state.busy, true);
  assert.equal(f.requests[1].expectedRevision, 7);
  assert.equal(f.requests[1].queueEpoch, 'owner');
  f.respond = async () => snapshot('s', 8, ['b', 'a']);
  acknowledge(snapshot('s', 8, ['b', 'a'])); await work;
  assert.deepEqual(f.state.items.map(i => i.turnId), ['b', 'a']);
  assert.equal(f.state.revisionKey, 'owner:8');
});
test('old hosts cannot reorder and stale-session actions never leave the controller', async () => {
  const f = fixture(); f.respond = async () => { const value = snapshot(); delete value.supportsReorder; return value; };
  f.store.select('s'); await flush();
  await f.store.dispatch({ sessionId: 's', action: 'reorder', turnId: 'a' });
  assert.equal(f.state.failure, 'unsupported');
  await f.store.dispatch({ sessionId: 'other', action: 'cancel', turnId: 'a' });
  assert.equal(f.requests.length, 1);
});
test('session switches fence late responses without removing the new session', async () => {
  const f = fixture(); let release;
  f.respond = () => new Promise(resolve => { release = resolve; });
  f.store.select('old');
  f.respond = async () => snapshot('new', 1, ['new-message']);
  f.store.select('new'); await flush();
  release(snapshot('old')); await flush();
  assert.equal(f.state.sessionId, 'new');
  assert.deepEqual(f.state.items.map(i => i.turnId), ['new-message']);
});
test('ambiguous mutation retains content and never replays the mutation', async () => {
  const f = fixture(); f.store.select('s'); await flush();
  f.respond = async () => { throw new Error('Disconnected'); };
  await f.store.dispatch({ sessionId: 's', action: 'reorder', turnId: 'a' }); await flush();
  assert.deepEqual(f.state.items.map(i => i.turnId), ['a', 'b']);
  assert.ok(f.state.failure);
  await f.store.dispatch({ sessionId: 's', action: 'reorder', turnId: 'a' });
  assert.equal(f.requests.filter(r => r.action === 'reorder').length, 1);
});
test('offline controllers retain the queue and report why mutations cannot run', async () => {
  const f = fixture(); f.store.select('s'); await flush();
  f.store.canPoll = () => false;
  await f.store.dispatch({ sessionId: 's', action: 'reorder', turnId: 'a' });
  assert.equal(f.state.failure, 'offline');
  assert.deepEqual(f.state.items.map(i => i.turnId), ['a', 'b']);
  assert.equal(f.requests.length, 1);
});
