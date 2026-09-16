const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function load(relative, dependencies = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets', relative + '.ets'), 'utf8')
    .replace(/@ObservedV2\s*/g, '').replace(/@Trace\s*/g, '');
  const js = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
  } }).outputText;
  const exports = {};
  new Function('require', 'exports', js)(name => dependencies[name] || {}, exports);
  return exports;
}
const stateModule = load('pages/state/DeviceDirectoryState');
const { DeviceDirectoryViewModel } = load('pages/viewmodel/DeviceDirectoryViewModel', {
  '../state/DeviceDirectoryState': stateModule,
  '../../services/RemoteLogger': { RemoteLogger: { info() {}, warn() {} } },
  '../../services/RemoteSessionIdentity': load('services/RemoteSessionIdentity'),
  '../../services/DeviceDirectoryCoordinator': { DeviceDirectoryCoordinator: class {
    constructor(source) { this.source = source; }
    loadWorkspaceCatalog(id) { return this.source.listWorkspaceCatalog(id); }
  } }
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(store) {
  const state = new stateModule.DeviceDirectoryState();
  const calls = [];
  let binding = { session: { token: 'token-a', userId: 'account-a', masterKey: new Uint8Array(32) }, relayUrl: 'relay' }, activeId = '';
  const vm = new DeviceDirectoryViewModel(state, {
    credentials: () => binding, activeDeviceId: () => activeId, activeDeviceConnected: () => !!activeId
  }, store, { listWorkspaceCatalog: () => {
    const call = deferred(); calls.push(call); return call.promise;
  } });
  vm.syncDevices([{ deviceId: 'desktop', deviceName: 'Desktop', online: true }]);
  return { state, vm, calls, account(value) { binding = value; }, active(value) { activeId = value; } };
}
const catalog = path => ({ source: 'opened', workspaces: [{ path }], recentWorkspaces: [{ path }] });

for (const outcome of ['success', 'failure']) {
  test(`old account ${outcome} cannot publish or release a newer device request`, async () => {
    const f = fixture();
    const old = f.vm.retryDevice('desktop');
    f.state.clear();
    f.account({ session: { token: 'token-b', userId: 'account-b', masterKey: new Uint8Array(32) }, relayUrl: 'relay' });
    f.vm.syncDevices([{ deviceId: 'desktop', online: true }]);
    const current = f.vm.retryDevice('desktop');
    assert.equal(f.calls.length, 2);
    if (outcome === 'success') f.calls[0].resolve(catalog('/old'));
    else f.calls[0].reject(Error('Old connection failed'));
    await old;
    assert.equal(f.state.find('desktop').status, 'loading');
    assert.deepEqual(f.state.find('desktop').workspaces, []);
    await f.vm.retryDevice('desktop');
    assert.equal(f.calls.length, 2, 'old finally must not remove the current request');
    f.calls[1].resolve(catalog('/new'));
    await current;
    assert.equal(f.state.find('desktop').status, 'ready');
    assert.equal(f.state.find('desktop').workspaces[0].path, '/new');
  });
}

test('account replacement invalidates reads even when the directory row is retained', async () => {
  const f = fixture();
  const old = f.vm.retryDevice('desktop');
  f.account({ session: { token: 'token-b', userId: 'account-b', masterKey: new Uint8Array(32) }, relayUrl: 'relay' });
  const current = f.vm.retryDevice('desktop');
  assert.equal(f.calls.length, 2);
  f.calls[0].reject(Error('Old account failure'));
  await old;
  assert.equal(f.state.find('desktop').status, 'loading');
  f.calls[1].resolve(catalog('/current'));
  await current;
  assert.equal(f.state.find('desktop').workspaces[0].path, '/current');
});

test('live catalog takeover owns status despite a late directory error', async () => {
  const f = fixture();
  const pending = f.vm.retryDevice('desktop');
  f.active('desktop');
  f.vm.beginLiveCatalog('desktop');
  f.vm.completeLiveCatalog('desktop', [], 'opened', [{ path: '/history' }]);
  f.calls[0].reject(Error('Abandoned directory error'));
  await pending;
  assert.equal(f.state.find('desktop').status, 'ready');
  assert.equal(f.state.find('desktop').catalogSource, 'opened');
  assert.deepEqual(f.state.find('desktop').workspaces, []);
});

test('offline transition permits a fresh request without waiting for the old one', async () => {
  const f = fixture();
  const old = f.vm.retryDevice('desktop');
  f.vm.syncDevices([{ deviceId: 'desktop', online: false }]);
  assert.equal(f.state.find('desktop').status, 'idle');
  f.vm.syncDevices([{ deviceId: 'desktop', online: true }]);
  const current = f.vm.retryDevice('desktop');
  assert.equal(f.calls.length, 2);
  f.calls[1].resolve(catalog('/current')); await current;
  f.calls[0].resolve(catalog('/stale')); await old;
  assert.equal(f.state.find('desktop').workspaces[0].path, '/current');
});

test('late cache cannot replace live session list or authoritative empty catalog', async () => {
  const cache = deferred();
  const f = fixture({ loadWorkspaces: () => cache.promise,
    loadList: async () => ({ sessions: [{ id: 'cached', workspacePath: '/closed' }] }) });
  const hydrate = f.vm.hydrateKnownDevices();
  f.vm.completeLiveCatalog('desktop', [], 'opened', []);
  f.state.find('desktop').sessions = [{ id: 'live', deviceId: 'desktop' }];
  cache.resolve([{ path: '/closed' }]); await hydrate;
  assert.deepEqual(f.state.find('desktop').workspaces, []);
  assert.equal(f.state.find('desktop').sessions[0].id, 'live');
  assert.equal(f.state.find('desktop').status, 'ready');
});

test('late cache never populates a signed-out account row', async () => {
  const cache = deferred();
  const f = fixture({ loadWorkspaces: () => cache.promise,
    loadList: async () => ({ sessions: [{ id: 'private' }] }) });
  const entry = f.state.find('desktop');
  const hydrate = f.vm.hydrateKnownDevices();
  f.state.clear(); f.account(undefined);
  cache.resolve([{ path: '/private' }]); await hydrate;
  assert.deepEqual(f.state.devices, []);
  assert.deepEqual(entry.sessions, []);
  assert.deepEqual(entry.workspaces, []);
});

test('same-path SSH workspace disclosure and load ownership remain independent', () => {
  const state = new stateModule.DeviceDirectoryState();
  state.setWorkspaceExpanded('desktop', '/project', true, 'a', 'host-a');
  assert.equal(state.workspaceExpanded('desktop', '/project', 'a', 'host-a'), true);
  assert.equal(state.workspaceExpanded('desktop', '/project', 'b', 'host-b'), false);
  assert.equal(state.workspaceExpanded('desktop', '/project'), false);
  const a = state.workspaceLoadState('desktop', '/project', 'a', 'host-a');
  const b = state.workspaceLoadState('desktop', '/project', 'b', 'host-b');
  assert.notEqual(a, b);
  assert.equal(state.isCurrentWorkspaceLoad(a), true);
  assert.equal(state.isCurrentWorkspaceLoad(b), true);
});

test('manual refresh preserves rows on failure, deduplicates clicks and clears error on retry', async () => {
  const f = fixture();
  const pending = deferred(); let loads = 0, refreshes = 0;
  f.vm.refreshExpandedWorkspaceSessions = async () => { refreshes++; };
  const oldRows = f.state.devices;
  const first = f.vm.refreshDevices(() => { loads++; return pending.promise; });
  await f.vm.refreshDevices(async () => { loads++; });
  assert.equal(loads, 1);
  assert.equal(f.state.refreshing, true);
  pending.reject(new Error('Device directory offline')); await first;
  assert.equal(f.state.devices, oldRows);
  assert.equal(f.state.refreshError, 'Device directory offline');
  assert.equal(f.state.refreshing, false);
  assert.equal(refreshes, 0);
  await f.vm.refreshDevices(async () => {});
  assert.equal(f.state.refreshError, '');
  assert.equal(refreshes, 1);
});

test('old account manual refresh cannot fail or release replacement refresh', async () => {
  const f = fixture(); const old = deferred(), current = deferred();
  f.vm.refreshExpandedWorkspaceSessions = async () => {};
  const first = f.vm.refreshDevices(() => old.promise);
  f.state.clear();
  f.account({ session: { token: 'new', userId: 'new' }, relayUrl: 'relay' });
  const second = f.vm.refreshDevices(() => current.promise);
  old.reject(new Error('Old failure')); await first;
  assert.equal(f.state.refreshError, '');
  assert.equal(f.state.refreshing, true);
  current.resolve(); await second;
  assert.equal(f.state.refreshing, false);
});
