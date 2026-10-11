const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const load = (file, mocks = {}) => {
  const source = fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets/', file), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  new Function('require', 'exports', js)(name => mocks[name] || {}, exports);
  return exports;
};
const Encoding = {
  randomBytes: size => new Uint8Array(size).fill(7),
  bytesToBase64: bytes => Buffer.from(bytes).toString('base64'),
  base64ToBytes: text => new Uint8Array(Buffer.from(text, 'base64')),
};
const log = { info() {}, warn() {}, error() {} };
const { SettingsController } = load('pages/viewmodel/SettingsController.ets', {
  '../../services/Encoding': { Encoding },
  '../../services/RemoteLogger': { RemoteLogger: log },
});
function fixture(failFirst = false, failSave = false) {
  const events = [];
  const records = new Map();
  const calls = [];
  const store = {
    loadWatchProvisionIdentity: async (relay, user, device) => records.get(`${relay}/${user}/${device}`),
    saveWatchProvisionIdentity: async identity => {
      events.push('save');
      if (failSave) throw new Error('storage failed');
      records.set(`${identity.relayUrl}/${identity.userId}/${identity.deviceId}`, { ...identity });
    },
  };
  const client = { provisionDevice: async (relay, session, device, name, request, secret) => {
    events.push('http');
    calls.push({ relay, user: session.userId, device, request, secret: Encoding.bytesToBase64(secret), buffer: secret });
    if (failFirst && calls.length === 1) throw new Error('response lost');
    return { token: 'watch-token', userId: session.userId, deviceId: device, deviceSecret: new Uint8Array(secret) };
  } };
  const create = (user = 'account', relay = 'https://relay') => {
    const controller = new SettingsController({ sessionStore: store, client });
    controller.cloudSession = { token: 'phone-token', userId: user };
    controller.cloudRelayUrl = relay;
    return controller;
  };
  return { events, calls, create };
}

test('identity is persisted before HTTP; a lost response replays the same key and id after restart', async () => {
  const f = fixture(true);
  await assert.rejects(f.create().provisionWatchCredential('watch', 'Watch', 'first-request'), /response lost/);
  const result = await f.create().provisionWatchCredential('watch', 'Watch', 'new-request');
  assert.deepEqual(f.events, ['save', 'http', 'http']);
  assert.equal(f.calls[0].request, f.calls[1].request);
  assert.equal(f.calls[0].secret, f.calls[1].secret);
  assert.equal(result.token, 'watch-token');
  assert.ok(f.calls.every(call => call.buffer.every(byte => byte === 0)));
});

test('successful but undelivered handoff can be reauthorized without registering a new key', async () => {
  const f = fixture();
  const first = await f.create().provisionWatchCredential('watch', 'Watch', 'first-request');
  const next = await f.create().provisionWatchCredential('watch', 'Watch', 'new-request');
  assert.equal(first.masterKeyBase64, next.masterKeyBase64);
  assert.equal(f.calls[1].request, 'first-request');
});

test('different accounts and relay endpoints do not reuse a provisioning request', async () => {
  const f = fixture();
  await f.create('a').provisionWatchCredential('watch', 'Watch', 'a-request');
  await f.create('b').provisionWatchCredential('watch', 'Watch', 'b-request');
  await f.create('a', 'https://other').provisionWatchCredential('watch', 'Watch', 'other-request');
  assert.deepEqual(f.calls.map(call => call.request), ['a-request', 'b-request', 'other-request']);
});

test('secure storage failure prevents server registration', async () => {
  const f = fixture(false, true);
  await assert.rejects(f.create().provisionWatchCredential('watch', 'Watch', 'request'), /storage failed/);
  assert.equal(f.calls.length, 0);
});

class RequestError extends Error { constructor(code) { super('registration conflict'); this.statusCode = code; } }
const { HarmonyUpgradeIdentityContract } = load('services/HarmonyUpgradeIdentityContract.ets');
const { WatchProvisionProtocol, WATCH_PROVISION_REQUEST_TTL_MS } = load('services/WatchProvisionProtocol.ets', { './HarmonyUpgradeIdentityContract': { HarmonyUpgradeIdentityContract } });
const { WatchProvisionController } = load('services/WatchProvisionController.ets', {
  '../i18n/RemoteI18n': { RemoteI18n: { t: key => key } },
  './RemoteLogger': { RemoteLogger: log },
  './CloudAccountClient': { CloudAccountRequestError: RequestError },
  './WatchProvisionProtocol': { WatchProvisionProtocol },
});
function controllerFixture(provision) {
  const display = { ask() {}, working() {}, fail(message) { this.message = message; } };
  const controller = new WatchProvisionController(display, { canProvision: () => true, provision });
  controller.pending = { requestId: 'request', deviceId: 'watch', deviceName: 'Watch', createdMs: Date.now() };
  return { controller, display };
}

test('a card that expires before approval cannot register a device', async () => {
  let called = false;
  const f = controllerFixture(async () => { called = true; });
  f.controller.pending.createdMs -= WATCH_PROVISION_REQUEST_TTL_MS + 1000;
  await f.controller.approve();
  assert.equal(called, false);
  assert.equal(f.display.message, 'watchProvision.errors.requestExpired');
});

test('a legacy orphaned registration reports conflict rather than network failure', async () => {
  const f = controllerFixture(async () => { throw new RequestError(409); });
  await f.controller.approve();
  assert.equal(f.display.message, 'watchProvision.errors.alreadyRegistered');
});

test('phone retains the existing five-minute lifetime beyond the watch three-minute wait', () => {
  const now = Date.now();
  const request = { createdMs: now - 4 * 60 * 1000 };
  assert.equal(WatchProvisionProtocol.isExpired(request, now), false);
  assert.equal(WatchProvisionProtocol.isExpired(request, now + 2 * 60 * 1000), true);
});

function accountClientFixture(response) {
  let copiedKey;
  const { CloudAccountClient } = load('services/CloudAccountClient.ets', {
    './Encoding': { Encoding: {
      ...Encoding,
      copyBytes: bytes => { copiedKey = new Uint8Array(bytes); return copiedKey; },
    } },
    './X25519': { X25519: { scalarMultBase: () => new Uint8Array(32) } },
    './RemoteCrypto': { HarmonyRemoteCryptoCipher: class {} },
  });
  const client = new CloudAccountClient();
  client.request = response;
  const original = new Uint8Array(32).fill(7);
  const provision = () => client.provisionDevice('https://relay', { token: 'phone', userId: 'account' },
    'watch', 'Watch', 'request', original);
  return { provision, original, copied: () => copiedKey };
}

test('HTTP failure clears the owned copy without destroying the persisted identity input', async () => {
  const failure = new Error('response lost');
  const f = accountClientFixture(async () => { throw failure; });
  await assert.rejects(f.provision(), err => err === failure);
  assert.ok(f.copied().every(byte => byte === 0));
  assert.ok(f.original.every(byte => byte === 7));
});

test('mismatched relay identity clears the copied private key', async () => {
  const f = accountClientFixture(async () => ({ token: 'watch-token', user_id: 'other', device_id: 'watch' }));
  await assert.rejects(f.provision(), /mismatched/);
  assert.ok(f.copied().every(byte => byte === 0));
});

test('successful registration transfers the copied private key to its caller', async () => {
  const f = accountClientFixture(async () => ({ token: 'watch-token', user_id: 'account', device_id: 'watch' }));
  const result = await f.provision();
  assert.equal(result.deviceSecret, f.copied());
  assert.ok(result.deviceSecret.every(byte => byte === 7));
  result.deviceSecret.fill(0);
});
