import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { AccountRealtime } from '../../../../../shared/relay-transport/AccountRealtime';
import { AccountIdentityChangedError, RelayHttpClient } from '../../../../../mobile-web/src/services/RelayHttpClient';
import { deriveDeviceMessageKey, encrypt, toB64, generateKeyPair } from '../../../../../mobile-web/src/services/E2EEncryption';

const identity = (userId = 'user-a') => ({ token: `token-${userId}`, userId, deviceId: 'browser', masterKey: new Uint8Array(32).fill(userId === 'user-a' ? 7 : 8) });
const peerPublicKey = (await generateKeyPair()).publicKey;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { vi.stubGlobal('window', globalThis); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe.each(['https://remote.openbitfun.com/v/1.0.2', 'http://192.168.1.9:9700'])('account device routing on %s', (relayUrl) => {
  it('rejects an unauthenticated constructor and sends nothing after logout', async () => {
    expect(() => new RelayHttpClient(relayUrl, { ...identity(), token: '' })).toThrow();
    const client = new RelayHttpClient(relayUrl, identity());
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    client.resetConnectionIdentity();
    await expect(client.listDevices()).rejects.toThrow('Sign in');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('invalidates target state and notifies observers on account replacement', () => {
    const client = new RelayHttpClient(relayUrl, identity());
    client.setTargetDeviceId('desktop');
    const epoch = client.controlTargetEpoch;
    const listener = vi.fn(); client.onAccountOwnerChange(listener, { emitCurrent: true });
    client.setAccountIdentity(identity('user-b'));
    expect(client.targetDeviceId).toBeNull();
    expect(client.controlTargetEpoch).toBeGreaterThan(epoch);
    expect(listener.mock.calls.map(([event]) => event.userId)).toEqual(['user-a', 'user-b']);
    client.resetConnectionIdentity();
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'unavailable', userId: null }));
  });
  it.each([200, 401])('discards the old directory response (%s) without clearing a replacement account', async (status) => {
    const pending = deferred<Response>(); vi.stubGlobal('fetch', vi.fn(() => pending.promise));
    const client = new RelayHttpClient(relayUrl, identity());
    const result = client.listDevices();
    client.setAccountIdentity(identity('user-b'));
    pending.resolve(Response.json([], { status }));
    await expect(result).rejects.toBeInstanceOf(AccountIdentityChangedError);
    expect(client.accountUserId).toBe('user-b');
  });
  it.each(['Unauthorized tool provider', 'Upstream returned HTTP 401'])('never replays an authenticated mutation error: %s', async (message) => {
    const client = new RelayHttpClient(relayUrl, identity());
    const key = deriveDeviceMessageKey(identity().masterKey, peerPublicKey);
    const encrypted = await encrypt(key, JSON.stringify({ resp: 'error', message }));
    const fetch = vi.fn(async (url: string) => url.endsWith('/key')
      ? Response.json({ device_id: 'desktop', public_key: toB64(peerPublicKey) })
      : Response.json({ encrypted_data: encrypted.data, nonce: encrypted.nonce }));
    vi.stubGlobal('fetch', fetch);
    const rpc = vi.spyOn(AccountRealtime.prototype, 'call').mockResolvedValue({ encrypted_data: encrypted.data, nonce: encrypted.nonce });
    await expect(client.sendDeviceRpc('desktop', { cmd: 'cancel_task' })).rejects.toThrow(message);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(client.accountUserId).toBe('user-a');
    client.resetConnectionIdentity();
    expect(fetch.mock.calls[0][0]).toBe(`${relayUrl}/api/devices/desktop/key`);
  });
  it('does not post a command after the target changes during key lookup', async () => {
    const pending = deferred<Response>(); const fetch = vi.fn(() => pending.promise); vi.stubGlobal('fetch', fetch);
    const client = new RelayHttpClient(relayUrl, identity()); client.setTargetDeviceId('desktop');
    const result = client.sendDeviceRpc('desktop', { cmd: 'cancel_task' });
    client.setTargetDeviceId('another');
    pending.resolve(Response.json({ device_id: 'desktop', public_key: toB64(peerPublicKey) }));
    await expect(result).rejects.toBeInstanceOf(AccountIdentityChangedError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('stops transient directory retries when the account changes during backoff', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => Response.json({}, { status: 503 })); vi.stubGlobal('fetch', fetch);
    const client = new RelayHttpClient(relayUrl, identity());
    const result = client.listDevices();
    const checked = expect(result).rejects.toBeInstanceOf(AccountIdentityChangedError);
    await vi.advanceTimersByTimeAsync(1);
    client.setAccountIdentity(identity('user-b'));
    await vi.advanceTimersByTimeAsync(300);
    await checked;
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
