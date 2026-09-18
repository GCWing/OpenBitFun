import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { WebSocketServer } from 'ws';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { gcm } from '@noble/ciphers/aes.js';

export const LAN = 'http://192.168.50.7:9700';
export const OFFICIAL = 'https://remote.openbitfun.com/v/1.0.2';
// The reverse proxy strips the official version prefix before the Relay sees a path.
const OFFICIAL_PREFIX = new URL(OFFICIAL).pathname.replace(/\/+$/, '');
export const invitation = (endpoint = LAN, device = 'desktop-a') => `${endpoint}/#/pair?did=${device}`;
const mobileRoot = fileURLToPath(new URL('../../', import.meta.url));
const realtimeFixtures = new Map();
let nextFixtureId = 0;
const hostPrivateKey = new Uint8Array(32).fill(11);
const hostPublicKey = x25519.getPublicKey(hostPrivateKey);

function messageKey(publicKey) {
  const shared = x25519.getSharedSecret(hostPrivateKey, publicKey);
  const sorted = [hostPublicKey, publicKey].sort((a, b) => Buffer.compare(a, b));
  return hkdf(sha256, shared, new TextEncoder().encode('OpenBitFun Relay v1.0.0 device key'),
    Buffer.concat(sorted.map(key => Buffer.from(key))), 32);
}

export async function until(check, message, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail(message);
}

export async function launchBrowser(options = {}) {
  const executablePath = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    process.env.PROGRAMFILES && `${process.env.PROGRAMFILES}/Google/Chrome/Application/chrome.exe`,
  ].find(path => path && existsSync(path));
  assert.ok(executablePath, 'Set PUPPETEER_EXECUTABLE_PATH to an installed Chrome/Chromium browser.');
  return puppeteer.launch({ executablePath, headless: 'new',
    // Fixture pages use remote-looking origins while their simulated Relay is loopback.
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-timer-throttling',
      '--disable-features=LocalNetworkAccessChecks'], ...options });
}

export async function startSourceServer() {
  const vite = await createServer({ root: mobileRoot, configFile: `${mobileRoot}/vite.config.ts`,
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
  const sockets = new WebSocketServer({ noServer: true });
  vite.httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://fixture');
    if (!url.pathname.startsWith('/__relay_fixture/')) return;
    const fixture = realtimeFixtures.get(url.pathname.split('/').pop());
    if (!fixture) { socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, ws => fixture.socket(ws, url.searchParams.get('endpoint')));
  });
  await vite.listen();
  return { origin: `http://127.0.0.1:${vite.httpServer.address().port}`, close: async () => { for (const socket of sockets.clients) socket.terminate(); sockets.close(); realtimeFixtures.clear(); await vite.close(); } };
}

/** Real browser fetches and encrypted RPC envelopes; only Relay/host IO is simulated. */
export class RelayFixture {
  devices = new Map();
  tokens = new Map();
  logins = [];
  revoked = [];
  pings = [];
  clients = new Map();
  errors = [];
  directoryStatus = 200;
  holdLogins = false;
  pendingLogins = [];
  online = true;
  /** Host-owned streams served over `read_stream`; the simulated Relay stores none. */
  streams = new Map();
  streamReads = [];
  streamUnsubscribes = [];
  sockets = new Set();
  /** Emulate a host from before host streams: no capability, no `read_stream`. */
  legacyHost = false;

  stream(id) {
    let stream = this.streams.get(id);
    if (!stream) { stream = { epoch: 1000 + this.streams.size, events: [] }; this.streams.set(id, stream); }
    return stream;
  }
  appendStreamEvent(id, event, payload) {
    const stream = this.stream(id);
    stream.events.push({ seq: stream.events.length + 1, event, payload });
    return stream.events.length;
  }
  restartStream(id) { const stream = this.stream(id); stream.epoch += 1; stream.events = []; }
  readStream(request) {
    this.streamReads.push(request);
    const stream = this.stream(request.stream_id);
    const limit = request.limit ?? 200;
    let events, hasMore;
    if (request.after !== undefined && request.after !== null) {
      const rest = stream.events.filter(event => event.seq > request.after); events = rest.slice(0, limit); hasMore = rest.length > limit;
    } else {
      const before = request.before ?? Number.MAX_SAFE_INTEGER;
      const rest = stream.events.filter(event => event.seq < before); events = rest.slice(-limit); hasMore = rest.length > limit;
    }
    return { resp: 'stream_page', stream_id: request.stream_id, epoch: stream.epoch, events, has_more: hasMore,
      cursor: stream.events.length, oldest_seq: stream.events[0]?.seq ?? stream.events.length + 1, truncated: false };
  }
  /** Encrypted `host-stream-changed` hint from `hostDeviceId` to every connected controller socket. */
  emitStreamHint(hostDeviceId, streamId) {
    const stream = this.stream(streamId);
    const plaintext = JSON.stringify({ cmd: 'device_event', event: 'host-stream-changed',
      payload: { stream_id: streamId, epoch: stream.epoch, cursor: stream.events.length } });
    for (const { ws, auth, endpoint } of this.sockets) {
      const key = messageKey(this.devices.get(`${endpoint}:${auth.userId}:${auth.deviceId}`));
      const nonce = randomBytes(12);
      const encrypted = gcm(key, nonce).encrypt(new TextEncoder().encode(plaintext));
      ws.send('42' + JSON.stringify(['ephemeral', { type: 'device-event', sourceDeviceId: hostDeviceId,
        params: { encrypted_data: Buffer.from(encrypted).toString('base64'), nonce: nonce.toString('base64') } }]));
    }
  }

  register(endpoint, deviceId, privateKey, userId = '123', token = `fixture-${this.tokens.size + 1}`) {
    this.devices.set(`${endpoint}:${userId}:${deviceId}`, Buffer.from(x25519.getPublicKey(privateKey)));
    this.tokens.set(token, { endpoint, userId, deviceId });
    return token;
  }

  async api(endpoint, path, request) {
    const json = body => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    const authorization = request.headers().authorization ?? '';
    const token = authorization.replace(/^Bearer /, '');
    const auth = this.tokens.get(token);
    if (path === '/api/auth/login') {
      const body = JSON.parse(request.postData());
      assert.match(body.access_token, /^fixture-user-/);
      const userId = body.access_token.slice('fixture-user-'.length);
      const publicKey = Buffer.from(body.public_key, 'base64');
      const deviceKey = `${endpoint}:${userId}:${body.device_id}`;
      const existing = this.devices.get(deviceKey);
      if (existing) assert.deepEqual(publicKey, existing, 'concurrent sign-ins rotated an existing device key');
      this.devices.set(deviceKey, publicKey);
      const issued = `fixture-login-${this.logins.length + 1}`;
      this.tokens.set(issued, { endpoint, userId, deviceId: body.device_id });
      this.logins.push({ ...body, token: issued });
      if (this.holdLogins) await new Promise(resolve => this.pendingLogins.push(resolve));
      return json({ token: issued, user_id: userId });
    }
    if (!auth || auth.endpoint !== endpoint) return { status: 401, body: 'Unauthorized' };
    if (path === '/api/auth/logout') {
      this.tokens.delete(token); this.revoked.push(token);
      return { status: 204, body: '' };
    }
    if (path === '/api/devices') {
      if (this.directoryStatus !== 200) return { status: this.directoryStatus, body: 'Unavailable' };
      return json(['desktop-a', 'desktop-b'].map(device_id => ({ device_id, device_name: device_id, online: this.online })));
    }
    // The Relay of this release keeps no session history; earlier routes are gone.
    if (/^\/v[13]\/sessions(\/|$)/.test(path)) {
      return { status: 410, contentType: 'application/json', body: JSON.stringify({ error: 'relay_session_history_retired', message: 'This relay does not store session history.' }) };
    }
    const keyPath = path.match(/^\/api\/devices\/([^/]+)\/key$/);
    if (keyPath) return json({ device_id: keyPath[1], public_key: Buffer.from(hostPublicKey).toString('base64') });
    throw new Error(`Unhandled Relay route: ${path}`);
  }

  rpc(endpoint, auth, target, envelope) {
    const key = messageKey(this.devices.get(`${endpoint}:${auth.userId}:${auth.deviceId}`));
    const command = JSON.parse(new TextDecoder().decode(gcm(key, Buffer.from(envelope.nonce, 'base64'))
      .decrypt(Buffer.from(envelope.encrypted_data, 'base64'))));
    let response;
    switch (command.cmd) {
      case 'ping': {
        const ping = { endpoint, target, controller: auth.deviceId, client: command.client };
        this.pings.push(ping);
        this.clients.set(`${endpoint}:${target}:${command.client.id}`, command.client);
        response = { resp: 'pong' }; break;
      }
      case 'get_session_key': response = { resp: 'error', message: 'Relay-stored session history has been retired; session content is now read directly from the online host. Update the controlling app to continue.' }; break;
      case 'read_stream': response = this.legacyHost ? { resp: 'error', message: 'invalid RPC command: unknown variant `read_stream`, expected one of `get_session_key`, `get_workspace_info`' } : this.readStream(command); break;
      case 'unsubscribe_stream': this.streamUnsubscribes.push(command.stream_id); response = { resp: 'stream_unsubscribed', stream_id: command.stream_id }; break;
      case 'get_workspace_info': response = { resp: 'workspace_info', has_workspace: false, capabilities: this.legacyHost ? [] : ['host_stream_v1'] }; break;
      case 'list_recent_workspaces': response = { resp: 'recent_workspaces', workspaces: [], opened_workspaces: [] }; break;
      case 'list_sessions': response = { resp: 'sessions', sessions: [], has_more: false }; break;
      case 'list_assistants': response = { resp: 'assistants', assistants: [] }; break;
      case 'host_invoke': response = { resp: 'host_invoke_result', ok: true, result: {} }; break;
      default: throw new Error(`Unhandled test host command: ${command.cmd}`);
    }
    const nonce = randomBytes(12);
    const encrypted = gcm(key, nonce).encrypt(new TextEncoder().encode(JSON.stringify(response)));
    return { encrypted_data: Buffer.from(encrypted).toString('base64'), nonce: nonce.toString('base64') };
  }

  socket(ws, endpoint) {
    let auth;
    ws.send('0' + JSON.stringify({ sid: 'fixture', upgrades: [], pingInterval: 60000, pingTimeout: 60000, maxPayload: 1000000 }));
    ws.on('message', data => {
      try {
        const frame = data.toString();
        if (frame.startsWith('40')) {
          auth = this.tokens.get(JSON.parse(frame.slice(2)).token);
          if (!auth || auth.endpoint !== endpoint) {
            ws.send('44' + JSON.stringify({ message: 'Unauthorized' })); return;
          }
          ws.send('40' + JSON.stringify({ sid: auth.deviceId }));
          const connection = { ws, auth, endpoint };
          this.sockets.add(connection);
          ws.once('close', () => this.sockets.delete(connection));
          ws.send('42' + JSON.stringify(['auth-ok', { userId: auth.userId, deviceId: auth.deviceId }]));
        } else if (frame.startsWith('42')) {
          assert.ok(auth, 'RPC requires authenticated connection');
          const start = frame.indexOf('[');
          const ack = frame.slice(2, start);
          const [event, request] = JSON.parse(frame.slice(start));
          assert.equal(event, 'rpc-call');
          assert.match(request.method, /:invoke$/);
          const result = this.rpc(endpoint, auth, request.method.slice(0, -7), request.params);
          ws.send(`43${ack}${JSON.stringify([{ ok: true, result }])}`);
        } else if (frame === '41' || frame === '1') {
          ws.close();
        } else {
          assert.equal(frame, '3');
        }
      } catch (error) { this.errors.push(error); ws.close(); }
    });
  }

  async page(context, sourceOrigin, url = invitation(), init) {
    const page = await context.newPage();
    const fixtureId = String(++nextFixtureId);
    realtimeFixtures.set(fixtureId, this);
    page.once('close', () => realtimeFixtures.delete(fixtureId));
    // Keep the real Socket.IO client and WebSocket transport. Only route the
    // simulated Relay's socket to our loopback server, like HTTP interception.
    await page.evaluateOnNewDocument((origin, id, official, lan) => {
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        constructor(url, protocols) {
          const target = new URL(url);
          if (target.pathname.endsWith('/v1/updates/')) {
            const endpoint = target.hostname === 'remote.openbitfun.com' ? official : lan;
            url = `${origin.replace('http:', 'ws:')}/__relay_fixture/${id}?endpoint=${encodeURIComponent(endpoint)}`;
          }
          super(url, protocols);
        }
      };
    }, sourceOrigin, fixtureId, OFFICIAL, LAN);
    await page.setViewport({ width: 1280, height: 850 });
    page.on('pageerror', error => this.errors.push(error));
    await page.setRequestInterception(true);
    page.on('request', request => {
      void (async () => {
        const requested = new URL(request.url());
        if (requested.hostname === 'api.github.com') {
          const id = Number(requested.pathname.split('/').at(-1));
          await request.respond({ status: 200, contentType: 'application/json',
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ id, login: `user-${id}`, avatar_url: '' }) });
          return;
        }
        const endpoint = requested.hostname === 'remote.openbitfun.com' ? OFFICIAL : LAN;
        if (![new URL(LAN).origin, new URL(OFFICIAL).origin].includes(requested.origin)) {
          await request.abort(); return;
        }
        const path = (requested.pathname.startsWith(`${OFFICIAL_PREFIX}/`) || requested.pathname === OFFICIAL_PREFIX
          ? requested.pathname.slice(OFFICIAL_PREFIX.length)
          : requested.pathname) || '/';
        if (path === '/' && requested.searchParams.has('account-store-test')) {
          await request.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Browser storage contract</title>' });
          return;
        }
        if (path.startsWith('/api/') || path.startsWith('/v3/')) {
          await request.respond(await this.api(endpoint, path, request)); return;
        }
        const source = await fetch(`${sourceOrigin}${path}${requested.search}`);
        await request.respond({ status: source.status, contentType: source.headers.get('content-type') || 'text/plain',
          body: Buffer.from(await source.arrayBuffer()) });
      })().catch(async error => {
        this.errors.push(error);
        if (!request.isInterceptResolutionHandled()) await request.abort().catch(() => {});
      });
    });
    // Account scenarios use English action labels independently of the host OS.
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('openbitfun-mobile-language', 'en-US');
    });
    if (init) await page.evaluateOnNewDocument(init);
    await page.goto(url, { waitUntil: 'networkidle0' });
    return page;
  }
}

export async function readAccount(page) {
  return page.evaluate(async () => {
    const { getBrowserAccountStore, releaseBrowserAccount } = await import('/src/services/BrowserAccountStore.ts');
    const { currentRelayUrl } = await import('/src/services/pairingLink.ts');
    const saved = await getBrowserAccountStore(currentRelayUrl()).read();
    const summary = { controllerDeviceId: saved.controllerDeviceId, revision: saved.revision,
      token: saved.session?.token ?? null, userId: saved.session?.userId ?? null };
    releaseBrowserAccount(saved);
    return summary;
  });
}

export async function signIn(page, user = '123') {
  await page.bringToFront();
  await page.waitForSelector('.pairing-page__form button[type="submit"]');
  // OAuth itself is covered by the account contract suite; no real GitHub
  // authorization or user credentials are used by these browser tests.
  await page.evaluate(async user => {
    const { CloudAccountClient } = await import('/src/services/CloudAccountClient.ts');
    CloudAccountClient.prototype.authorize = async () => `fixture-user-${user}`;
  }, user);
  await page.click('.pairing-page__form button[type="submit"]');
}

export async function connected(page, device = 'desktop-a') {
  await page.waitForFunction(async expected => {
    const { useMobileStore } = await import('/src/services/store.ts');
    const state = useMobileStore.getState();
    return state.controlTarget?.deviceId === expected && state.connectionHealth === 'connected';
  }, { timeout: 15_000, polling: 100 }, device);
  assert.equal(await page.$('.pairing-page__form'), null);
}

export async function disconnect(page) {
  await page.bringToFront();
  await page.click('.harmony-sidebar__settings');
  await page.waitForSelector('.harmony-sidebar__settings-disconnect', { visible: true });
  await page.waitForFunction(() => {
    const sheet = document.querySelector('.harmony-sidebar__settings-disconnect')?.closest('[role="dialog"]');
    return sheet && sheet.getBoundingClientRect().bottom <= innerHeight + 1;
  }, { polling: 100 });
  await page.$eval('.harmony-sidebar__settings-disconnect', button => button.scrollIntoView({ block: 'center' }));
  await page.click('.harmony-sidebar__settings-disconnect');
  await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"]')]
    .some(dialog => dialog.textContent.includes('Disconnect this tab')), { polling: 100 });
  await page.evaluate(() => [...document.querySelectorAll('[role="dialog"]')]
    .find(dialog => dialog.textContent.includes('Disconnect this tab'))
    .querySelector('button[data-appearance="danger"]').click());
  await page.waitForSelector('.devices-page__description');
}

export async function signOut(page) {
  await page.bringToFront();
  // Open the device directory from the UI if this tab is controlling a host.
  if (!await page.$('.devices-page') && await page.$('.harmony-sidebar__settings')) {
    await page.click('button[aria-label="Settings"]');
    await page.waitForSelector('button[aria-label="Devices"]', { visible: true });
    await page.$eval('button[aria-label="Devices"]', async button => {
      const sheet = button.closest('[role="dialog"]');
      if (sheet) await Promise.all(sheet.getAnimations().map(animation => animation.finished));
    });
  }
  const button = await page.$('button[aria-label="Devices"]');
  if (button) { await button.click(); await page.waitForSelector('.devices-page'); }
  const clicked = await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find(node => node.textContent.trim() === 'Sign out');
    if (!button) return false;
    button.click(); return true;
  });
  assert.ok(clicked, 'Sign out must be reachable in the device directory');
  await page.waitForSelector('.pairing-page__form');
}
