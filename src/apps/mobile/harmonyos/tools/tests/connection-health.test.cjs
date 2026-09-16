const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function load(name, deps = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets', name + '.ets'), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exported = {};
  new Function('require', 'exports', js)(name => deps[name] || {}, exported);
  return exported;
}
const factory = load('services/RemoteCommandFactory');
const { RemoteSessionManager } = load('services/RemoteSessionManager', { './RemoteCommandFactory': factory });
test('health probe forwards a short deadline and preserves transport failures', async () => {
  const manager = Object.create(RemoteSessionManager.prototype);
  const calls = [];
  manager.send = async (command, timeoutMs) => { calls.push({ command, timeoutMs }); return { resp: 'ok' }; };
  assert.equal(await manager.ping(), true);
  assert.equal(calls[0].command.cmd, 'ping');
  assert.equal(calls[0].timeoutMs, 10000);
  const timeout = new Error('Health probe timed out');
  manager.send = async () => { throw timeout; };
  await assert.rejects(manager.ping(), error => error === timeout);
});

test('health deadline includes transport preparation and ignores a late result', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const manager = Object.create(RemoteSessionManager.prototype);
  let complete;
  manager.send = () => new Promise(resolve => { complete = resolve; });
  const pending = manager.ping();
  const rejected = assert.rejects(pending, /health probe timed out/);
  context.mock.timers.tick(10000);
  await rejected;
  complete({ resp: 'ok' });
  manager.send = async () => ({ resp: 'ok' });
  assert.equal(await manager.ping(), true);
});

const { AsyncLifecycleGate } = load('services/AsyncLifecycleGate');
const { RemoteActivityViewModel } = load('pages/viewmodel/RemoteActivityViewModel', {
  '../../i18n/RemoteI18n': { RemoteI18n: { t: key => key } },
  '../../services/ConnectionErrorPolicy': { ConnectionErrorPolicy: { errorText: error => error.message } },
  '../../services/RemoteLogger': { RemoteLogger: { info() {} } },
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function activityFixture() {
  const probe = deferred();
  const events = [];
  const hooks = {
    isConnected: () => true, isReconnecting: () => false,
    isBusy: () => false, hasRemoteBinding: () => true,
    isRemoteChat: () => false, activeSession: () => ({ sessionId: '' }),
    onConnectionState: state => events.push(['state', state]),
    onStatus: status => events.push(['status', status]),
    onConnectionError: async () => false,
    onStartPolling() {}, onStopPolling() {}, onPoll: async () => {},
    onReconnect: async () => events.push(['reconnect']),
    onRestoreSession: async () => {},
  };
  const connection = { ping: () => probe.promise };
  const vm = new RemoteActivityViewModel(
    { stopHeartbeat() {} }, connection, new AsyncLifecycleGate(), hooks,
  );
  return { vm, probe, events, hooks, connection };
}
test('foreground keeps a healthy connection quiet until the host probe completes', async () => {
  const f = activityFixture();
  const pending = f.vm.verifyForeground();
  assert.deepEqual(f.events, []);
  f.probe.resolve(true);
  await pending;
  assert.deepEqual(f.events, [['state', 'connected'], ['status', 'connection.connected']]);
});
test('foreground starts reconnect only after a failed host probe', async () => {
  const f = activityFixture();
  const pending = f.vm.verifyForeground();
  assert.deepEqual(f.events, []);
  f.probe.reject(new Error('Host unavailable'));
  await pending;
  assert.deepEqual(f.events, [['status', 'Host unavailable'], ['state', 'reconnecting'], ['reconnect']]);
});
for (const method of ['verifyForeground', 'checkConnectionHealth']) {
  test(`${method} ignores an old target probe failure`, async () => {
    const f = activityFixture();
    const pending = f.vm[method]();
    f.vm.invalidate();
    f.probe.reject(new Error('Old target unavailable'));
    await pending;
    assert.deepEqual(f.events, []);
  });
  test(`${method} rechecks ownership after asynchronous error handling`, async () => {
    const f = activityFixture();
    const handler = deferred();
    f.hooks.onConnectionError = () => handler.promise;
    const pending = f.vm[method]();
    f.probe.reject(new Error('Old target unavailable'));
    await Promise.resolve();
    f.vm.invalidate();
    handler.resolve(false);
    await pending;
    assert.deepEqual(f.events, []);
  });
}

test('a transcript refresh failure after successful ping does not report a broken connection', async () => {
  const f = activityFixture();
  f.hooks.isRemoteChat = () => true;
  f.hooks.activeSession = () => ({ sessionId: 'active' });
  f.hooks.onPoll = async () => { throw new Error('Transcript refresh failed'); };
  const pending = f.vm.verifyForeground();
  f.probe.resolve(true);
  await pending;
  assert.deepEqual(f.events, [['state', 'connected'], ['status', 'connection.connected'], ['status', 'Transcript refresh failed']]);
});

test('invalidating an old recovery permits health checks for the new target', async () => {
  const f = activityFixture();
  const recovery = deferred();
  f.hooks.isConnected = () => false;
  f.hooks.isReconnecting = () => true;
  let reconnects = 0;
  f.connection.ping = () => { reconnects++; return recovery.promise; };
  const old = f.vm.checkConnectionHealth();
  assert.equal(reconnects, 1);
  f.vm.invalidate();
  const current = f.vm.checkConnectionHealth();
  assert.equal(reconnects, 2);
  recovery.resolve();
  await Promise.all([old, current]);
});

test('old recovery completion cannot clear the new target recovery guard', async () => {
  const f = activityFixture();
  const first = deferred();
  const second = deferred();
  f.hooks.isConnected = () => false;
  f.hooks.isReconnecting = () => true;
  let reconnects = 0;
  f.connection.ping = () => (++reconnects === 1 ? first.promise : second.promise);
  const old = f.vm.checkConnectionHealth();
  f.vm.invalidate();
  const current = f.vm.checkConnectionHealth();
  first.resolve();
  await old;
  await f.vm.checkConnectionHealth();
  assert.equal(reconnects, 2);
  second.resolve();
  await current;
});

const heartbeatModule = load('services/RemoteHeartbeatController');
const { RemoteActivityLifecycleController } = load('services/RemoteActivityLifecycleController', {
  './RemoteHeartbeatController': heartbeatModule,
});
test('foreground monitors host liveness independently of relay and stops on suspension', async () => {
  const f = activityFixture();
  let tick;
  let stopped = false;
  let calls = 0;
  const pendingProbe = deferred();
  const scheduler = {
    setInterval(callback, interval) { assert.equal(interval, 15000); tick = callback; return 1; },
    clearInterval() { stopped = true; tick = undefined; },
  };
  let vm;
  const activity = new RemoteActivityLifecycleController(() => vm.checkConnectionHealth(), 15000, scheduler);
  vm = new RemoteActivityViewModel(activity, { ping: () => { calls++; return pendingProbe.promise; } },
    new AsyncLifecycleGate(), f.hooks);
  vm.startHeartbeat();
  assert.equal(activity.isHeartbeatRunning(), true);
  tick(); tick();
  assert.equal(calls, 1, 'Slow host probes must not overlap');
  pendingProbe.reject(new Error('Host stopped answering while relay remains connected'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.events, [
    ['status', 'Host stopped answering while relay remains connected'], ['state', 'reconnecting'],
  ]);
  vm.suspendKeepingActiveTurnPoll();
  assert.equal(stopped, true);
  assert.equal(activity.isHeartbeatRunning(), false);
});

test('periodic recovery probes the existing target without reselecting or clearing the page', async () => {
  const f = activityFixture();
  f.hooks.isConnected = () => false;
  f.hooks.isReconnecting = () => true;
  const pending = f.vm.checkConnectionHealth();
  assert.deepEqual(f.events, []);
  f.probe.resolve(true);
  await pending;
  assert.deepEqual(f.events, [['state', 'connected'], ['status', 'connection.connected']]);
});

const { RemoteCompactHomePolicy } = load('pages/policy/RemoteCompactHomePolicy');
test('home recovery retains cached rows without cold-load skeletons', () => {
  for (const phase of ['connected', 'reconnecting', 'disconnected', 'failed']) {
    assert.equal(RemoteCompactHomePolicy.shouldShowInitialLoading(phase, 3, true), false);
    assert.equal(RemoteCompactHomePolicy.shouldShowRecentSessions(phase === 'connected', 3), true);
  }
  assert.equal(RemoteCompactHomePolicy.shouldShowInitialLoading('reconnecting', 0, true), false);
  assert.equal(RemoteCompactHomePolicy.shouldShowInitialLoading('pairing', 0, false), true);
  assert.equal(RemoteCompactHomePolicy.shouldShowInitialLoading('connected', 0, true), true);
  assert.equal(RemoteCompactHomePolicy.shouldShowRecentSessions(false, 0), false);
  assert.equal(RemoteCompactHomePolicy.shouldShowRecentSessions(true, 0), true);
});

test('recovery keeps selected device header geometry while unbound home stays empty', () => {
  assert.equal(RemoteCompactHomePolicy.headerSubtitle('connected', 'Studio'), 'Studio');
  assert.equal(RemoteCompactHomePolicy.headerSubtitle('reconnecting', 'Studio'), 'Studio');
  assert.equal(RemoteCompactHomePolicy.headerSubtitle('idle', 'Studio'), '');
  assert.equal(RemoteCompactHomePolicy.headerSubtitle('reconnecting', ''), '');
});
