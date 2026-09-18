import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function loadSource(relativePath, imports = {}) {
  const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
  let code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React },
  }).outputText;
  code = code.replace(/from (['"])([^'"]+)\1/g, (_, quote, specifier) => (
    `from ${JSON.stringify(imports[specifier] ?? import.meta.resolve(specifier))}`
  ));
  return { url: `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`, source };
}

const links = await loadSource('../src/services/pairingLink.ts');
const selection = await loadSource('../src/services/accountDeviceSelection.ts');
const { selectAccountDevice } = await import(selection.url);
const offline = { device_id: 'desktop-a', device_name: 'Offline desktop', online: false };
const online = { device_id: 'desktop-b', device_name: 'Online desktop', online: true };
const controller = { device_id: 'browser', device_name: 'Browser', online: true };

const agentContract = await loadSource('../../shared/agent-harness/contract.generated.ts');
const navigationModule = await loadSource('../src/services/MobileNavigationStore.ts', {
  '../../../shared/agent-harness/contract.generated': agentContract.url,
});
const { loadMobileNavigation, saveMobileNavigation, clearMobileNavigation } = await import(navigationModule.url);

test('same-tab reload restores the selected device and session only within the authenticated QR scope', () => {
  const entries = new Map();
  const storage = {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: key => entries.delete(key),
  };
  const scope = {
    accountId: 'account-a', controllerDeviceId: 'browser-a',
    relayUrl: 'https://relay.example.com', routeKey: '/relay/r/room/#/pair?did=desktop-a',
  };
  const navigation = { deviceId: 'desktop-b', session: { id: 'session-b', name: 'Task B', agentType: 'agentic' } };
  saveMobileNavigation(scope, navigation, storage);
  assert.deepEqual(loadMobileNavigation(scope, storage), {
    ...navigation, session: { ...navigation.session, agentType: 'Standard' },
  });
  for (const replacement of [
    { accountId: 'account-b' }, { controllerDeviceId: 'browser-b' },
    { relayUrl: 'https://another-relay.example.com' }, { routeKey: '/relay/r/new/#/pair?did=desktop-c' },
  ]) {
    assert.equal(loadMobileNavigation({ ...scope, ...replacement }, storage), null);
  }
  clearMobileNavigation(storage);
  assert.equal(loadMobileNavigation(scope, storage), null);
});

test('unsupported or unreadable navigation stays intact and unavailable browser storage is optional', () => {
  for (const raw of ['{', JSON.stringify({ version: 2, deviceId: 'future' })]) {
    let retained = raw;
    const storage = { getItem: () => retained, setItem: value => { retained = value; }, removeItem: () => { retained = ''; } };
    assert.equal(loadMobileNavigation({}, storage), null);
    assert.equal(retained, raw);
  }
  const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
  assert.equal(loadMobileNavigation({}, blocked), null);
  assert.doesNotThrow(() => saveMobileNavigation({}, { deviceId: 'device' }, blocked));
  assert.doesNotThrow(() => clearMobileNavigation(blocked));
});

test('empty, offline and controller-only directories leave the account without a target', () => {
  for (const devices of [[], [offline], [controller], [offline, controller]]) {
    assert.equal(selectAccountDevice(devices, 'browser'), null);
  }
});

test('online selection preserves exact QR targeting and supports later device availability', () => {
  assert.equal(selectAccountDevice([controller, offline, online], 'browser'), online);
  assert.equal(selectAccountDevice([online], 'browser', offline.device_id), null);
  assert.equal(selectAccountDevice([offline, online], 'browser', offline.device_id), null);
  const reconnected = { ...offline, online: true };
  assert.equal(selectAccountDevice([reconnected, online], 'browser', offline.device_id), reconnected);
});

test('GitHub login registers the browser store key without generating another identity', async () => {
  const encryption = await loadSource('../src/services/E2EEncryption.ts');
  const { deriveDeviceMessageKey } = await import(encryption.url);
  const { x25519 } = await import('@noble/curves/ed25519.js');
  const authModule = await loadSource('../src/services/CloudAccountClient.ts', { './E2EEncryption': encryption.url, './pairingLink': links.url });
  const { CloudAccountClient } = await import(authModule.url);
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const requests = [];
  globalThis.window = { setTimeout, clearTimeout };
  const browserPrivateKey = new Uint8Array(32).fill(7);
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://remote.openbitfun.com/v/1.0.1/api/auth/login');
    const body = JSON.parse(options.body);
    requests.push(body);
    assert.equal(body.access_token, 'verified-github-token');
    assert.equal(body.device_id, 'browser');
    assert.equal(body.password_hash, undefined);
    assert.equal(Buffer.from(body.public_key, 'base64').length, 32);
    return Response.json({ token: 'test-account-token', user_id: '101' });
  };
  try {
    const first = await new CloudAccountClient('https://remote.openbitfun.com/v/1.0.1').login('verified-github-token', 'browser', browserPrivateKey);
    const second = await new CloudAccountClient('https://remote.openbitfun.com/v/1.0.1').login('verified-github-token', 'browser', browserPrivateKey);
    assert.equal(first.userId, '101');
    assert.deepEqual(first.masterKey, second.masterKey);
    assert.equal(requests[0].public_key, requests[1].public_key);
    assert.deepEqual(Buffer.from(requests[0].public_key, 'base64'), Buffer.from(x25519.getPublicKey(first.masterKey)));
    assert.deepEqual(deriveDeviceMessageKey(first.masterKey, x25519.getPublicKey(second.masterKey)),
      deriveDeviceMessageKey(second.masterKey, x25519.getPublicKey(first.masterKey)));
    assert.throws(() => deriveDeviceMessageKey(first.masterKey, new Uint8Array(32)));
    assert.equal(Buffer.from(deriveDeviceMessageKey(new Uint8Array(32).fill(7), x25519.getPublicKey(new Uint8Array(32).fill(11)))).toString('hex'), '6e8f5da837e91e9ddb09c5aa7dee229e731fc94499d29d10dcf5f1437193f56c');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('account UI entry precedes discovery and mounts no remote workspace surface', async () => {
  const pairing = await readFile(new URL('../src/pages/PairingPage.tsx', import.meta.url), 'utf8');
  const direct = pairing.slice(pairing.indexOf('const connect ='), pairing.indexOf('  useEffect('));
  assert.doesNotMatch(direct, /saveSession|saveCloudAccountSession/, 'restoring account state must not republish a new login');
  assert.match(pairing, /accountStore\.saveSession\(browser, candidate, isCurrent\)/);
  assert.match(direct, /store\.setControlTarget\(null\)/);
  assert.match(direct, /onPairedRef\.current/);
  assert.doesNotMatch(direct, /listDevices\(|sendDeviceRpc\(|\.online|throw new Error/);
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /useConnectionHealth\(accountDirectoryOpen \? null : sessionMgr\)/);
  assert.match(app, /!accountDirectoryOpen && page !== 'pairing' && sessionMgrRef\.current/);
  assert.equal((app.match(/\{renderDetailPage\(\)\}/g) || []).length, 1, 'one gated detail tree must preserve chat state across layout changes');
  const devices = await readFile(new URL('../src/pages/DevicesPage.tsx', import.meta.url), 'utf8');
  assert.match(devices, /if \(!d.online \|\| switchingId\) return/);
  assert.match(devices, /automaticSelectionAttemptedRef\.current = true/);
  assert.match(devices, /selectDevice\(target, false\)/, 'initial account selection must not require a new peer command');
  assert.ok(devices.indexOf('await client.sendDeviceRpc') < devices.indexOf('client.setTargetDeviceId(d.device_id)'));
});

test('authorization follows the central GitHub OAuth URL and rejects lookalike destinations', async () => {
  const encryption = await loadSource('../src/services/E2EEncryption.ts');
  const authModule = await loadSource('../src/services/CloudAccountClient.ts', { './E2EEncryption': encryption.url, './pairingLink': links.url });
  const { CloudAccountClient } = await import(authModule.url);
  const previous = { fetch: globalThis.fetch, window: globalThis.window, setTimeout: globalThis.setTimeout };
  globalThis.window = { setTimeout: previous.setTimeout, clearTimeout };
  globalThis.setTimeout = callback => { queueMicrotask(callback); return 0; };
  try {
    for (const authorizationUrl of [
      'https://github.com/login/oauth/authorize?state=test',
      'https://auth.openbitfun.com/sign-in#ticket=test',
      'https://auth.openbitfun.com.evil.example/sign-in',
      'https://user@auth.openbitfun.com/sign-in',
      'https://auth.openbitfun.com/other',
      'https://github.com.attacker.example/login/oauth/authorize',
      'https://github.com/login', 'https://user@github.com/login/oauth/authorize',
      'http://github.com/login/oauth/authorize',
    ]) {
      let polls = 0;
      globalThis.fetch = async url => {
        if (url.endsWith('/start?methods=all')) return Response.json({
          transactionId: 'txn', transactionSecret: 'secret', authorizationUrl,
          expiresAt: Date.now() / 1000 + 60, pollIntervalSeconds: 3,
        });
        polls++;
        return Response.json({ status: 'authorized', tokens: { accessToken: 'verified' } });
      };
      const popup = { location: { href: 'about:blank' } };
      const result = new CloudAccountClient('https://remote.openbitfun.com/v/1.0.1').authorize(popup, new AbortController().signal);
      if (authorizationUrl === 'https://github.com/login/oauth/authorize?state=test' || authorizationUrl === 'https://auth.openbitfun.com/sign-in#ticket=test') {
        assert.equal(await result, 'verified');
        assert.equal(popup.location.href, authorizationUrl.startsWith('https://auth.openbitfun.com') ? authorizationUrl.replace('/sign-in#', '/sign-in?locale=en-US#') : authorizationUrl);
        assert.equal(polls, 1);
      } else {
        await assert.rejects(result, /Untrusted/);
        assert.equal(popup.location.href, 'about:blank');
        assert.equal(polls, 0);
      }
    }
  } finally {
    globalThis.fetch = previous.fetch;
    globalThis.setTimeout = previous.setTimeout;
    if (previous.window === undefined) delete globalThis.window;
    else globalThis.window = previous.window;
  }
});


test('official and local invitations share strict device-only targeting', async () => {
  const { currentRelayUrl, pairingRelayUrl, accountDeviceIdFromHash } = await import(links.url);
  for (const base of ['https://remote.openbitfun.com/v/1.0.1/', 'http://192.168.1.9:9700/']) {
    const url = new URL(`${base}#/pair?did=desktop-1`);
    assert.equal(currentRelayUrl(url), base.replace(/\/$/, ''));
    assert.equal(accountDeviceIdFromHash(url.hash), 'desktop-1');
    for (const hash of ['did=a&did=b', 'did=a&pk=untrusted', 'did=a&relay=https://evil.example',
      'did=%2Fother', 'room=room&pk=key', 'did=..']) {
      assert.equal(accountDeviceIdFromHash(`#/pair?${hash}`), null);
    }
  }
  for (const base of ['https://evil.example/', 'https://remote.openbitfun.com.evil.example/v/1.0.0/',
    'https://user@remote.openbitfun.com/v/1.0.1/', 'http://remote.openbitfun.com/v/1.0.1/',
    'https://remote.openbitfun.com/relay/']) {
    assert.equal(pairingRelayUrl(base), null);
  }
  assert.equal(accountDeviceIdFromHash('#/pair?did=desktop'), 'desktop');
  assert.equal(accountDeviceIdFromHash('#/chat?did=desktop'), null);
});

const githubModule = await loadSource('../src/services/GitHubAccountProfile.ts');
const { loadGitHubAccountProfile, normalizeGitHubProfile } = await import(githubModule.url);
const githubUser = { id: 123, login: 'example', avatar_url: 'https://avatars.githubusercontent.com/u/123' };

test('GitHub public profile validates stable identity and never forwards account credentials', async () => {
  assert.throws(() => normalizeGitHubProfile('124', githubUser));
  assert.equal(normalizeGitHubProfile('123', { ...githubUser, avatar_url: 'https://other.example/avatar' }).avatarUrl, '');
  const profiles = [];
  await loadGitHubAccountProfile('123', p => profiles.push(p), new AbortController().signal, null, async (url, options) => {
    assert.equal(url, 'https://api.github.com/user/123');
    assert.equal(options.credentials, 'omit');
    assert.deepEqual(options.headers, { Accept: 'application/vnd.github+json' });
    return { ok: true, json: async () => githubUser };
  });
  assert.equal(profiles[0].login, 'example');
});

test('GitHub cached profiles survive refresh failure and fresh cache avoids a request', async () => {
  for (const age of [0, 2 * 86400000]) {
    const profile = { ...normalizeGitHubProfile('123', githubUser), fetchedAt: Date.now() - age };
    let requests = 0;
    const applied = [];
    await loadGitHubAccountProfile('123', p => applied.push(p), new AbortController().signal,
      { getItem: () => JSON.stringify(profile), setItem: () => assert.fail('must retain cache') },
      async () => { requests++; throw new Error('offline'); });
    assert.equal(applied[0].login, 'example');
    assert.equal(requests, age ? 1 : 0);
  }
});

test('GitHub profile ignores corrupt/foreign cache and stale account responses', async () => {
  for (const raw of ['{', JSON.stringify({ userId: '456', fetchedAt: Date.now(), login: 'another' })]) {
    const controller = new AbortController();
    await loadGitHubAccountProfile('123', () => assert.fail('stale profile applied'), controller.signal,
      { getItem: () => raw, setItem: () => assert.fail('stale profile cached') },
      async () => {
        controller.abort();
        return { ok: true, json: async () => githubUser };
      });
  }
});


function memoryStorage() {
  const entries = new Map();
  return {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: key => entries.delete(key),
  };
}

const encryptionModule = await loadSource('../src/services/E2EEncryption.ts');
const accountStoreModule = await loadSource('../src/services/CloudAccountSessionStore.ts', {
  './E2EEncryption': encryptionModule.url, './pairingLink': links.url,
});
const accountStore = await import(accountStoreModule.url);
const storedAccount = {
  relayUrl: 'http://192.168.1.9:9700', username: '123', controllerDeviceId: 'browser-a',
  session: { token: 'test-token', userId: '123', masterKey: new Uint8Array(32).fill(7) },
};

test('legacy v2 account proof remains readable and scoped for migration', () => {
  const storage = memoryStorage();
  const legacy = JSON.stringify({
    version: 2, relay_url: storedAccount.relayUrl, username: '123', token: 'test-token',
    user_id: '123', device_secret: Buffer.alloc(32, 7).toString('base64'), controller_device_id: 'browser-a',
  });
  storage.setItem('openbitfun.mobile.account_session.v2', legacy);
  const restored = accountStore.loadMatchingCloudAccountSession(storedAccount.relayUrl, '', 'browser-a', storage);
  assert.deepEqual(restored, storedAccount);
  accountStore.saveCloudAccountSession(restored, storage);
  assert.deepEqual(JSON.parse(storage.getItem('openbitfun.mobile.account_session.v2')), JSON.parse(legacy));
  for (const [relay, username, controllerId] of [
    ['https://remote.openbitfun.com/v/1.0.1', '', 'browser-a'],
    [storedAccount.relayUrl, '', 'browser-b'], [storedAccount.relayUrl, '456', 'browser-a'],
  ]) assert.equal(accountStore.loadMatchingCloudAccountSession(relay, username, controllerId, storage), null);
  assert.equal(storage.getItem('openbitfun.mobile.account_session.v2'), legacy);
  accountStore.clearCloudAccountSession(storage);
  assert.equal(accountStore.loadMatchingCloudAccountSession(storedAccount.relayUrl, '', 'browser-a', storage), null);
  for (const raw of ['{', JSON.stringify({ version: 99 })]) {
    storage.setItem('openbitfun.mobile.account_session.v2', raw);
    assert.equal(accountStore.loadMatchingCloudAccountSession(storedAccount.relayUrl, '', 'browser-a', storage), null);
    assert.equal(storage.getItem('openbitfun.mobile.account_session.v2'), raw);
  }
});


test('presence uses the authenticated browser ID across managers, tabs and reloads', async () => {
  const module = await loadSource('../src/services/controlClientIdentity.ts');
  const { getControlClientIdentity } = await import(module.url);
  const identity = getControlClientIdentity('browser-device-a');
  assert.equal(identity.id, 'browser-device-a');
  assert.ok(identity.name);
  const { getControlClientIdentity: reloaded } = await import(`${module.url}#reloaded`);
  assert.deepEqual(reloaded('browser-device-a'), identity);
  assert.notEqual(reloaded('browser-device-b').id, identity.id);
});

test('tab navigation preserves explicit disconnect and migrates only a matching legacy controller', async () => {
  const { migrateMobileNavigationController } = await import(navigationModule.url);
  const storage = memoryStorage();
  const scope = { accountId: 'account-a', controllerDeviceId: 'tab-a', relayUrl: storedAccount.relayUrl, routeKey: '/' };
  saveMobileNavigation(scope, { deviceId: 'desktop-a', disconnected: true }, storage);
  migrateMobileNavigationController('other-account', scope.relayUrl, 'tab-a', 'browser-a', storage);
  assert.equal(loadMobileNavigation({ ...scope, controllerDeviceId: 'browser-a' }, storage), null);
  migrateMobileNavigationController(scope.accountId, scope.relayUrl, 'tab-a', 'browser-a', storage);
  assert.deepEqual(loadMobileNavigation({ ...scope, controllerDeviceId: 'browser-a' }, storage), {
    deviceId: 'desktop-a', disconnected: true, session: undefined,
  });
});

const encryptionStub = `data:text/javascript;base64,${Buffer.from(
  'export const toB64 = (bytes) => Buffer.from(bytes).toString("base64");',
).toString('base64')}`;
const accountClient = await loadSource('../src/services/CloudAccountClient.ts', {
  './E2EEncryption': encryptionStub,
  './pairingLink': links.url,
});
const {
  CloudAccountClient, CloudAccountRequestError, CloudAccountTransportError,
  retryableAuthorizationPollError,
} = await import(accountClient.url);

test('a sign-in poll retries what the next tick can fix and stops at what the relay meant', () => {
  for (const retryable of [
    new CloudAccountTransportError('Account request timed out.'),
    new CloudAccountRequestError('Slow down.', 429),
    new CloudAccountRequestError('Relay is restarting.', 503),
  ]) assert.equal(retryableAuthorizationPollError(retryable), true);
  for (const fatal of [
    new CloudAccountRequestError('Unknown transaction.', 404),
    new CloudAccountRequestError('Bad secret.', 401),
    new Error('Untrusted account authorization URL.'),
  ]) assert.equal(retryableAuthorizationPollError(fatal), false);
});

/**
 * Drives authorize() against a scripted relay on a virtual clock: every wait
 * returns at once and advances the poll window by what it asked to sleep, so
 * the whole five-minute window plays out inside the test. The last scripted
 * answer repeats for as long as the window lasts.
 */
async function runAuthorization(pollAnswers) {
  const realSetTimeout = globalThis.setTimeout;
  const realNow = Date.now;
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  let clock = realNow();
  const start = {
    transactionId: 'tx-1', transactionSecret: 'secret-1',
    authorizationUrl: 'https://github.com/login/oauth/authorize?client_id=x',
    expiresAt: Math.floor(clock / 1000) + 300, pollIntervalSeconds: 5,
  };
  const polls = [];
  Date.now = () => clock;
  globalThis.setTimeout = (fn, ms) => { clock += ms ?? 0; return realSetTimeout(fn, 0); };
  globalThis.window = { setTimeout: () => 0, clearTimeout: () => {} };
  globalThis.fetch = async (url) => {
    if (String(url).includes('/start')) {
      return { ok: true, status: 200, text: async () => JSON.stringify(start) };
    }
    const answer = pollAnswers[Math.min(polls.length, pollAnswers.length - 1)];
    polls.push(answer);
    if (answer.throws) throw answer.throws;
    return {
      ok: (answer.httpStatus ?? 200) < 400,
      status: answer.httpStatus ?? 200,
      text: async () => JSON.stringify(answer.body ?? {}),
    };
  };
  try {
    const client = new CloudAccountClient('http://localhost:8787');
    const outcome = await client
      .authorize({ location: { href: '' } }, new AbortController().signal)
      .then((token) => ({ token }), (error) => ({ error }));
    return { ...outcome, polls };
  } finally {
    Date.now = realNow;
    globalThis.setTimeout = realSetTimeout;
    globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  }
}

test('a dropped connection mid-sign-in is retried instead of ending the attempt', async () => {
  const flaky = await runAuthorization([
    { throws: new TypeError('Failed to fetch') },
    { httpStatus: 503, body: { error: 'Relay is restarting.' } },
    { body: { status: 'authorized', tokens: { accessToken: 'token-1' } } },
  ]);
  assert.equal(flaky.token, 'token-1');
  assert.equal(flaky.polls.length, 3);

  const refused = await runAuthorization([{ httpStatus: 401, body: { error: 'Bad secret.' } }]);
  assert.equal(refused.token, undefined);
  assert.equal(refused.error.status, 401);
  assert.equal(refused.polls.length, 1);

  const denied = await runAuthorization([{ body: { status: 'denied' } }]);
  assert.match(denied.error.message, /Sign-in expired\. Try again\./);
  assert.equal(denied.polls.length, 1);

  // A window that ran out while every poll was failing is a network problem,
  // and must not be reported as a sign-in the user let expire.
  const offline = await runAuthorization([{ throws: new TypeError('Failed to fetch') }]);
  assert.ok(offline.error instanceof CloudAccountTransportError);
  assert.equal(offline.error.message, 'Could not reach the account service.');
  assert.equal(offline.polls.length, 60);
});
