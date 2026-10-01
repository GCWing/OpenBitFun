import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LAN, OFFICIAL, RelayFixture, connected, disconnect, invitation, launchBrowser, readAccount,
  signIn, signOut, startSourceServer, until } from './helpers/browser-account-harness.mjs';

let browser;
let source;
before(async () => { source = await startSourceServer(); browser = await launchBrowser(); });
after(async () => {
  try {
    await Promise.race([
      browser?.close(),
      new Promise(resolve => setTimeout(resolve, 3000)),
    ]);
  } catch {}
  try {
    await source?.close();
  } catch {}
  setTimeout(() => process.exit(0), 500);
});

for (const endpoint of [LAN, OFFICIAL]) {
  test(`one login serves fresh tabs and reloads with one connected browser: ${endpoint}`, { timeout: 40_000 }, async () => {
    const context = await browser.createIncognitoBrowserContext();
    const relay = new RelayFixture();
    try {
      const first = await relay.page(context, source.origin, invitation(endpoint));
      if (endpoint === LAN) assert.equal(await first.evaluate(() => window.isSecureContext), false);
      await signIn(first); await connected(first);
      const original = await readAccount(first);
      // context.newPage has no opener and no copied sessionStorage.
      const second = await relay.page(context, source.origin, invitation(endpoint));
      await connected(second);
      for (const page of [first, second, first]) { await page.reload(); await connected(page); }
      assert.deepEqual(await readAccount(second), original);
      assert.equal(relay.logins.length, 1);
      assert.equal(relay.devices.size, 1);
      assert.equal(relay.clients.size, 1);
      assert.ok(relay.pings.length >= 5);
      assert.ok(relay.pings.every(ping => ping.client.id === original.controllerDeviceId && ping.controller === original.controllerDeviceId));
      assert.deepEqual(relay.errors, []);
    } finally { await context.close(); }
  });
}

test('two simultaneous first visits share one identity and sign-in propagates to a waiting tab', { timeout: 40_000 }, async () => {
  const context = await browser.createIncognitoBrowserContext();
  const relay = new RelayFixture();
  try {
    const [first, second] = await Promise.all([
      relay.page(context, source.origin, invitation()), relay.page(context, source.origin, invitation(LAN, 'desktop-b')),
    ]);
    assert.deepEqual(await readAccount(first), await readAccount(second));
    await signIn(first);
    await Promise.all([connected(first), connected(second, 'desktop-b')]);
    assert.equal(relay.logins.length, 1);
    // Login is shared; each tab still controls the device from its own invitation.
    await first.reload(); await connected(first);
    await connected(second, 'desktop-b');
    await signOut(first);
    await second.waitForSelector('.pairing-page__form');
    assert.equal((await readAccount(second)).token, null);
    const third = await relay.page(context, source.origin, invitation());
    await third.waitForSelector('.pairing-page__form');
    assert.equal((await readAccount(third)).controllerDeviceId, relay.logins[0].device_id);
    assert.deepEqual(relay.errors, []);
  } finally { await context.close(); }
});

test('storage notifications synchronize tabs when BroadcastChannel is unavailable', { timeout: 40_000 }, async () => {
  const context = await browser.createIncognitoBrowserContext();
  const relay = new RelayFixture();
  const disableChannel = () => { window.BroadcastChannel = undefined; };
  try {
    const first = await relay.page(context, source.origin, invitation(), disableChannel);
    const second = await relay.page(context, source.origin, invitation(), disableChannel);
    await signIn(first); await connected(first); await connected(second);
    await signOut(first);
    await second.waitForSelector('.pairing-page__form');
    assert.equal((await readAccount(second)).token, null);
    assert.equal(relay.logins.length, 1);
    assert.equal(relay.clients.size, 1);
    assert.deepEqual(relay.errors, []);
  } finally { await context.close(); }
});

test('simultaneous sign-ins register the same key and keep only the winning token', { timeout: 40_000 }, async () => {
  const context = await browser.createIncognitoBrowserContext();
  const relay = new RelayFixture();
  relay.holdLogins = true;
  try {
    const pages = await Promise.all([relay.page(context, source.origin), relay.page(context, source.origin)]);
    for (const page of pages) await signIn(page);
    await until(() => relay.pendingLogins.length === 2, 'both sign-in requests must reach the Relay');
    relay.pendingLogins.forEach(release => release());
    await Promise.all(pages.map(page => connected(page)));
    await until(() => relay.revoked.length === 1, 'the losing login token must be revoked');
    assert.equal(relay.devices.size, 1);
    assert.equal(relay.logins[0].public_key, relay.logins[1].public_key);
    assert.deepEqual(await readAccount(pages[0]), await readAccount(pages[1]));
    assert.equal(relay.tokens.size, 1);
    assert.equal(relay.clients.size, 1);
    assert.deepEqual(relay.errors, []);
  } finally {
    relay.pendingLogins.forEach(release => release());
    await context.close();
  }
});

test('sign-out wins over a login response that arrives later in another tab', { timeout: 40_000 }, async () => {
  const context = await browser.createIncognitoBrowserContext();
  const relay = new RelayFixture();
  relay.holdLogins = true;
  try {
    const first = await relay.page(context, source.origin);
    const second = await relay.page(context, source.origin);
    await signIn(first); await signIn(second);
    await until(() => relay.pendingLogins.length === 2, 'both login responses should be held');
    relay.pendingLogins[0]();
    await connected(first); await connected(second);
    await signOut(first);
    await second.waitForSelector('.pairing-page__form');
    relay.pendingLogins[1]();
    await until(() => relay.revoked.length === 2, 'the signed-out and late login tokens must both be revoked');
    await first.reload(); await second.reload();
    await Promise.all([first, second].map(page => page.waitForSelector('.pairing-page__form')));
    assert.equal((await readAccount(first)).token, null);
    assert.equal((await readAccount(second)).token, null);
    assert.equal(relay.devices.size, 1);
    assert.deepEqual(relay.errors, []);
  } finally {
    relay.pendingLogins.forEach(release => release());
    await context.close();
  }
});

test('disconnect affects only the current tab and remains disconnected after reload', { timeout: 40_000 }, async () => {
  const context = await browser.createIncognitoBrowserContext();
  const relay = new RelayFixture();
  try {
    const first = await relay.page(context, source.origin);
    await signIn(first); await connected(first);
    const second = await relay.page(context, source.origin);
    await connected(second);
    await disconnect(first);
    await first.reload();
    await first.waitForSelector('.devices-page__description');
    assert.equal(await first.evaluate(async () => (await import('/src/services/store.ts')).useMobileStore.getState().controlTarget), null);
    await connected(second);
    assert.equal(relay.logins.length, 1);
    assert.equal((await readAccount(first)).token, (await readAccount(second)).token);
    // An explicit selection reconnects without another OAuth/login request.
    await first.evaluate(() => [...document.querySelectorAll('.devices-page__device')]
      .find(row => row.textContent.includes('desktop-b')).click());
    await connected(first, 'desktop-b');
    await connected(second);
    assert.equal(relay.logins.length, 1);
    assert.deepEqual(relay.errors, []);
  } finally { await context.close(); }
});

test('browser profiles remain separate even with the same user agent and GitHub account', { timeout: 40_000 }, async () => {
  const contexts = await Promise.all([browser.createIncognitoBrowserContext(), browser.createIncognitoBrowserContext()]);
  const relay = new RelayFixture();
  try {
    const pages = await Promise.all(contexts.map(context => relay.page(context, source.origin)));
    for (const page of pages) await signIn(page);
    await Promise.all(pages.map(page => connected(page)));
    assert.notEqual((await readAccount(pages[0])).controllerDeviceId, (await readAccount(pages[1])).controllerDeviceId);
    assert.equal(relay.devices.size, 2);
    assert.equal(relay.clients.size, 2);
    assert.equal(new Set([...relay.clients.values()].map(client => client.name)).size, 1, 'same display name is not a device identity');
    await signOut(pages[0]);
    await pages[1].reload(); await connected(pages[1]);
    assert.deepEqual(relay.errors, []);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('a closed and reopened browser profile retains its login and controller key', { timeout: 40_000 }, async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'openbitfun-browser-account-'));
  const relay = new RelayFixture();
  let persistent;
  try {
    persistent = await launchBrowser({ userDataDir: profile });
    const first = await relay.page(persistent.defaultBrowserContext(), source.origin);
    await signIn(first); await connected(first);
    const identity = await readAccount(first);
    await persistent.close();
    persistent = await launchBrowser({ userDataDir: profile });
    const reopened = await relay.page(persistent.defaultBrowserContext(), source.origin);
    await connected(reopened);
    assert.deepEqual(await readAccount(reopened), identity);
    assert.equal(relay.logins.length, 1);
    assert.equal(relay.clients.size, 1);
    assert.deepEqual(relay.errors, []);
  } finally {
    await persistent?.close();
    try { await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  }
});

test('legacy tab credentials migrate with their keys and navigation without reviving a signed-out account', { timeout: 40_000 }, async () => {
  const context = await browser.createIncognitoBrowserContext();
  const relay = new RelayFixture();
  relay.register(LAN, 'legacy-a', new Uint8Array(32).fill(7), '123', 'legacy-token-a');
  relay.register(LAN, 'legacy-b', new Uint8Array(32).fill(8), '123', 'legacy-token-b');
  try {
    const first = await relay.page(context, source.origin, invitation(), () => {
      sessionStorage.setItem('openbitfun.mobile.account_session.v2', JSON.stringify({
        version: 2, relay_url: location.origin, username: '123', token: 'legacy-token-a', user_id: '123',
        controller_device_id: 'legacy-a', device_secret: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
      }));
      sessionStorage.setItem('openbitfun.mobile.navigation.v1', JSON.stringify({ version: 1, accountId: '123',
        relayUrl: location.origin, controllerDeviceId: 'legacy-a', routeKey: location.pathname + location.hash,
        deviceId: 'desktop-b' }));
    });
    await connected(first, 'desktop-b');
    const second = await relay.page(context, source.origin, invitation(), () => {
      sessionStorage.setItem('openbitfun.mobile.account_session.v2', JSON.stringify({
        version: 2, relay_url: location.origin, username: '123', token: 'legacy-token-b', user_id: '123',
        controller_device_id: 'legacy-b', device_secret: btoa(String.fromCharCode(...new Uint8Array(32).fill(8))),
      }));
      sessionStorage.setItem('openbitfun.mobile.navigation.v1', JSON.stringify({ version: 1, accountId: '123',
        relayUrl: location.origin, controllerDeviceId: 'legacy-b', routeKey: location.pathname + location.hash,
        deviceId: 'desktop-a' }));
    });
    await connected(second);
    assert.equal((await readAccount(second)).controllerDeviceId, 'legacy-a');
    assert.equal(relay.logins.length, 0);
    assert.ok(relay.pings.every(ping => ping.controller === 'legacy-a' && ping.client.id === 'legacy-a'));
    assert.equal(await second.evaluate(() => JSON.parse(sessionStorage.getItem('openbitfun.mobile.navigation.v1')).controllerDeviceId), 'legacy-a');
    await signOut(first);
    await second.waitForSelector('.pairing-page__form');
    await second.reload(); // init script deliberately reintroduces a stale legacy token.
    await second.waitForSelector('.pairing-page__form');
    assert.equal((await readAccount(second)).token, null);
    assert.equal(relay.logins.length, 0);
    assert.deepEqual(relay.errors, []);
  } finally { await context.close(); }
});

test('transient Relay errors preserve login; genuine expiry signs out tabs without rotating identity', { timeout: 45_000 }, async () => {
  const context = await browser.createIncognitoBrowserContext();
  const relay = new RelayFixture();
  try {
    const first = await relay.page(context, source.origin);
    await signIn(first); await connected(first);
    const original = await readAccount(first);
    const second = await relay.page(context, source.origin);
    await connected(second);
    relay.directoryStatus = 503;
    await first.reload();
    await first.waitForSelector('.devices-page__error', { timeout: 15_000 });
    assert.equal((await readAccount(first)).token, original.token);
    relay.directoryStatus = 200;
    await first.reload(); await connected(first);
    assert.equal(relay.logins.length, 1);
    relay.tokens.delete(original.token);
    await first.reload();
    await Promise.all([first, second].map(page => page.waitForSelector('.pairing-page__form')));
    assert.match(await first.$eval('.pairing-page__error', el => el.textContent), /expired/);
    await signIn(second); await connected(second); await connected(first);
    assert.equal((await readAccount(first)).controllerDeviceId, original.controllerDeviceId);
    assert.equal(relay.devices.size, 1);
    assert.equal(relay.logins.length, 2);
    assert.deepEqual(relay.errors, []);
  } finally { await context.close(); }
});

test('IndexedDB serializes concurrent first-use reads and rejects stale commits and late 401s', { timeout: 40_000 }, async () => {
  const context = await browser.createIncognitoBrowserContext();
  const relay = new RelayFixture();
  try {
    const pages = await Promise.all([0, 1, 2].map(() => relay.page(context, source.origin, `${LAN}/?account-store-test`)));
    const identities = (await Promise.all(pages.map(page => page.evaluate(async () => {
      const { getBrowserAccountStore, releaseBrowserAccount } = await import('/src/services/BrowserAccountStore.ts');
      const store = getBrowserAccountStore(location.origin);
      return Promise.all(Array.from({ length: 12 }, async () => {
        const saved = await store.read();
        const result = { id: saved.controllerDeviceId, key: Array.from(saved.privateKey).join(','), revision: saved.revision };
        releaseBrowserAccount(saved); return result;
      }));
    })))).flat();
    assert.equal(new Set(identities.map(identity => identity.id)).size, 1);
    assert.equal(new Set(identities.map(identity => identity.key)).size, 1);
    assert.ok(identities.every(identity => identity.revision === 0));
    assert.deepEqual(await pages[0].evaluate(async () => {
      const { getBrowserAccountStore, releaseBrowserAccount } = await import('/src/services/BrowserAccountStore.ts');
      const store = getBrowserAccountStore(location.origin);
      const original = await store.read();
      const signedIn = await store.saveSession(original, { token: 'token-a', userId: '123', masterKey: original.privateKey });
      await store.clearSession('token-a', 'signed-out');
      let staleRejected = false;
      try { await store.saveSession(original, { token: 'late-token', userId: '123', masterKey: original.privateKey }); }
      catch (error) { staleRejected = error.name === 'BrowserAccountChangedError'; }
      const next = await store.read();
      let cancelledRejected = false;
      try { await store.saveSession(next, { token: 'cancelled-token', userId: '456', masterKey: next.privateKey }, () => false); }
      catch (error) { cancelledRejected = error.name === 'BrowserAccountChangedError'; }
      const replacement = await store.saveSession(next, { token: 'token-b', userId: '456', masterKey: next.privateKey });
      await store.clearSession('token-a', 'expired');
      const current = await store.read();
      const result = { staleRejected, cancelledRejected, token: current.session.token, userId: current.session.userId,
        sameDevice: current.controllerDeviceId === original.controllerDeviceId, sameKey: current.privateKey.every((b, i) => b === original.privateKey[i]) };
      [original, signedIn, next, replacement, current].forEach(releaseBrowserAccount);
      return result;
    }), { staleRejected: true, cancelledRejected: true, token: 'token-b', userId: '456', sameDevice: true, sameKey: true });
    assert.equal((await readAccount(pages[1])).token, 'token-b');
    assert.deepEqual(relay.errors, []);
  } finally { await context.close(); }
});

test('unreadable future records are retained and the UI reports the storage problem', { timeout: 30_000 }, async () => {
  const context = await browser.createIncognitoBrowserContext();
  const relay = new RelayFixture();
  try {
    const page = await relay.page(context, source.origin, `${LAN}/?account-store-test`);
    await page.evaluate(async () => {
      const { getBrowserAccountStore, releaseBrowserAccount } = await import('/src/services/BrowserAccountStore.ts');
      releaseBrowserAccount(await getBrowserAccountStore(location.origin).read());
      await new Promise((resolve, reject) => {
        const request = indexedDB.open('openbitfun-mobile-account', 1);
        request.onerror = reject;
        request.onsuccess = () => {
          const tx = request.result.transaction('accounts', 'readwrite');
          tx.objectStore('accounts').put({ relayUrl: location.origin, version: 99, futureData: 'keep-this-record' });
          tx.oncomplete = () => { request.result.close(); resolve(); };
          tx.onerror = reject;
        };
      });
    });
    await page.goto(invitation(), { waitUntil: 'networkidle0' });
    await page.waitForSelector('.pairing-page__error');
    assert.match(await page.$eval('.pairing-page__error', el => el.textContent), /has been kept/);
    assert.deepEqual(await page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('openbitfun-mobile-account', 1);
      request.onerror = reject;
      request.onsuccess = () => {
        const read = request.result.transaction('accounts').objectStore('accounts').get(location.origin);
        read.onsuccess = () => { request.result.close(); resolve(read.result); };
        read.onerror = reject;
      };
    })), { relayUrl: LAN, version: 99, futureData: 'keep-this-record' });
    assert.equal(relay.logins.length, 0);
    assert.deepEqual(relay.errors, []);
  } finally { await context.close(); }
});

test('unavailable persistent storage shows an actionable state without silently minting tab identities', { timeout: 30_000 }, async () => {
  const context = await browser.createIncognitoBrowserContext();
  const relay = new RelayFixture();
  try {
    const page = await relay.page(context, source.origin, invitation(), () => {
      Object.defineProperty(window, 'indexedDB', { get() { throw new DOMException('Blocked', 'SecurityError'); } });
    });
    await page.waitForSelector('.pairing-page__error');
    assert.match(await page.$eval('.pairing-page__error', el => el.textContent), /Allow site storage/);
    assert.equal(relay.logins.length, 0);
    assert.equal(relay.pings.length, 0);
    assert.deepEqual(relay.errors, []);
  } finally { await context.close(); }
});

test('mobile question clicks acknowledge once, input remains editable, and failures retry', { timeout: 40_000 }, async () => {
  const context = await browser.createIncognitoBrowserContext();
  try {
    const page = await context.newPage();
    await page.setViewport({ width: 390, height: 844 });
    await page.goto(source.origin);
    await page.evaluate(async () => {
      window.questionFixture = await import('/tests/helpers/question-card-fixture.tsx');
      window.questionFixture.showQuestion('question-one');
    });
    const card = '#question-fixture .chat-ask-card';
    await page.waitForSelector(card);
    const events = () => page.evaluate(() => window.questionFixture.events);
    assert.deepEqual(await events(), []);
    await page.click(`${card} .chat-ask-card__option`);
    await until(async () => (await events()).length === 1);
    assert.equal((await events())[0].type, 'interaction');
    await page.click(`${card} .chat-ask-card__option:last-child`);
    await page.waitForSelector(`${card} input`);
    await page.focus(`${card} input`);
    await page.type(`${card} input`, 'Custom format');
    assert.equal((await events()).length, 1, 'Repeated activity must not submit or send duplicate acknowledgements');
    await page.click(`${card} .chat-ask-card__submit`);
    await until(async () => (await events()).length === 2);
    assert.deepEqual((await events())[1], { type: 'answer', toolId: 'question-one', answers: { 0: 'Custom format' } });
    await page.evaluate(() => {
      window.questionFixture.rejectNextInteraction();
      window.questionFixture.showQuestion('question-two');
    });
    await page.waitForFunction(() => !document.querySelector('#question-fixture .chat-ask-card__option').disabled);
    await page.click(`${card} .chat-ask-card__option`);
    await until(async () => (await events()).length === 3);
    await page.click(`${card} .chat-ask-card__option`);
    await until(async () => (await events()).length === 4);
    assert.deepEqual((await events()).slice(2), [
      { type: 'interaction', toolId: 'question-two' }, { type: 'interaction', toolId: 'question-two' },
    ]);
  } finally { await context.close(); }
});

test('a retired official relay token stays archived and is never rebound to the current endpoint', {timeout:40000}, async()=>{
 const context=await browser.createIncognitoBrowserContext();const fixture=new RelayFixture();
 try {
  const page=await fixture.page(context,source.origin,OFFICIAL+'/?account-store-test=1');
  const result=await page.evaluate(async endpoint=>{
   const {BrowserAccountStore}=await import('/src/services/BrowserAccountStore.ts');
   const retired=endpoint.replace(/\/v\/[^/]+$/, '/v/retired');
   const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('openbitfun-mobile-account',1);request.onupgradeneeded=()=>request.result.createObjectStore('accounts',{keyPath:'relayUrl'});request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});
   const old={version:1,relayUrl:retired,controllerDeviceId:'old-controller',privateKey:btoa(String.fromCharCode(...new Uint8Array(32).fill(3))),revision:1,session:{token:'old-database-token',userId:'42'}};
   await new Promise((resolve,reject)=>{const tx=db.transaction('accounts','readwrite');tx.objectStore('accounts').put(old);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});
   const snapshot=await new BrowserAccountStore(endpoint).read();
   const retained=await new Promise((resolve,reject)=>{const request=db.transaction('accounts').objectStore('accounts').get(retired);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});
   db.close();return{session:snapshot.session,retained,old};
  },OFFICIAL);
  assert.equal(result.session,null);assert.deepEqual(result.retained,result.old);
 }finally{await context.close();}
});

test('sign-in uses a separate popup, can cancel and reopen a closed window, and closes on success', { timeout: 40_000 }, async () => {
  const context = await browser.createIncognitoBrowserContext();
  const relay = new RelayFixture();
  try {
    const page = await relay.page(context, source.origin, invitation());
    await page.waitForSelector('.pairing-page__form button[type="submit"]');
    await page.evaluate(async () => {
      const { CloudAccountClient } = await import('/src/services/CloudAccountClient.ts');
      CloudAccountClient.prototype.authorize = async (popup, signal) => {
        window.authFixturePopup = popup;
        return new Promise((resolve, reject) => {
          window.completeAuthFixture = () => resolve('fixture-user-123');
          signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
        });
      };
    });
    const open = async (selector) => {
      await page.evaluate(() => { window.completeAuthFixture = undefined; });
      const targetPromise = browser.waitForTarget(target => target.opener() === page.target() && target.type() === 'page');
      await page.click(selector);
      const target = await targetPromise;
      const popupPage = await target.page();
      await page.waitForFunction(() => typeof window.completeAuthFixture === 'function');
      await popupPage.setRequestInterception(true);
      popupPage.on('request', request => request.respond({ status: 200, contentType: 'text/html', body: '<h1>Authentication fixture</h1>' }));
      await popupPage.goto('https://auth.openbitfun.com/sign-in');
      assert.equal(await popupPage.evaluate(() => window.opener !== null), true);
      const parentSession = await page.target().createCDPSession();
      const popupSession = await target.createCDPSession();
      const parentWindow = await parentSession.send('Browser.getWindowForTarget');
      const authWindow = await popupSession.send('Browser.getWindowForTarget');
      assert.notEqual(authWindow.windowId, parentWindow.windowId);
      assert.ok(authWindow.bounds.width <= 500);
      await parentSession.detach(); await popupSession.detach();
      return popupPage;
    };
    const first = await open('.pairing-page__retry');
    await page.click('.pairing-page__action button:last-child');
    await until(() => first.isClosed());
    assert.equal(relay.logins.length, 0);
    const second = await open('.pairing-page__retry');
    await second.close();
    // The return action starts a fresh attempt if the user closed the popup.
    const third = await open('.pairing-page__retry');
    await page.evaluate(() => window.completeAuthFixture());
    await connected(page);
    await until(() => third.isClosed());
    assert.equal(relay.logins.length, 1);
    assert.deepEqual(relay.errors, []);
  } finally { await context.close(); }
});
