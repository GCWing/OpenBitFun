const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets/services/ChatSessionController.ets'), 'utf8');
const exported = {};
new Function('require', 'exports', ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText)(name => ({
  './InteractionMailboxStore': { InteractionMailboxStore: class { select() {} } },
  './DurableSessionReducer': { DurableSessionReducer: class { messages() { return []; } } },
}[name] || {}), exported);
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const requests = [], streams = [], snapshots = [], errors = [];
  const manager = {
    getModelCatalog(sessionId) { return new Promise((resolve, reject) => requests.push({sessionId, resolve, reject})); },
    subscribeSession(sessionId, callbacks) { streams.push(callbacks); return {close() {}, isClosed() {return false;}}; },
  };
  const controller = new exported.ChatSessionController(manager, {canPoll: () => true, onSnapshot: value => snapshots.push(value), onError: error => errors.push(error)});
  const start = id => controller.start(id, {pollVersion: 0, knownMessageCount: 0, knownModelCatalogVersion: 0});
  return {controller, start, requests, streams, snapshots, errors};
}
test('initial model read does not block transcript and cannot cross session navigation', async () => {
  const f = fixture();
  f.start('old'); await f.streams[0].onCaughtUp();
  assert.equal(f.snapshots.length, 1);
  assert.equal(f.requests[0].sessionId, 'old');
  f.start('new'); await f.streams[1].onCaughtUp();
  f.requests[0].resolve({version: 1, session_model_id: 'old-model'}); await flush();
  assert.equal(f.snapshots.some(x => x.modelCatalog), false);
  f.requests[1].resolve({version: 2, session_model_id: 'new-model'}); await flush();
  assert.equal(f.snapshots.at(-1).modelCatalog.session_model_id, 'new-model');
  assert.equal(f.snapshots.at(-1).sessionId, 'new');
  f.controller.stop();
});
test('catalog waits for initial records and is delivered once', async () => {
  const f = fixture(); f.start('s');
  f.requests[0].resolve({version: 2, session_model_id: 'model'}); await flush();
  assert.equal(f.snapshots.length, 0);
  await f.streams[0].onCaughtUp();
  assert.equal(f.snapshots.at(-1).modelCatalog.session_model_id, 'model');
  await f.streams[0].onCaughtUp();
  assert.equal(f.snapshots.at(-1).modelCatalog, undefined);
  f.controller.stop();
});
test('confirmed model changes fence a pending initial read', async () => {
  const f = fixture(); f.start('s'); await f.streams[0].onCaughtUp();
  f.controller.updateKnownModelCatalogVersion(3);
  f.requests[0].resolve({version: 2, session_model_id: 'old-model'}); await flush();
  assert.equal(f.snapshots.some(x => x.modelCatalog), false);
  f.controller.stop();
});
test('late catalog failure after stop is ignored', async () => {
  const f = fixture(); f.start('s'); f.controller.stop();
  f.requests[0].reject(Error('offline')); await flush();
  assert.equal(f.errors.length, 0);
});

test('catalog invalidation refreshes the current session and supersedes an older read', async () => {
  const f = fixture(); f.start('s'); await f.streams[0].onCaughtUp();
  const pending = f.controller.refreshModelCatalog();
  assert.equal(f.requests[1].sessionId, 's');
  f.requests[0].resolve({version: 1, session_model_id: 'stale'}); await flush();
  assert.equal(f.snapshots.some(x => x.modelCatalog), false);
  f.requests[1].resolve({version: 2, session_model_id: 'external'}); await pending;
  assert.equal(f.snapshots.at(-1).modelCatalog.session_model_id, 'external');
  f.controller.stop(); await f.controller.refreshModelCatalog();
  assert.equal(f.requests.length, 2);
});
