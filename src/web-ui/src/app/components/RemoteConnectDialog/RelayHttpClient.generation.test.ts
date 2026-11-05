import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { AccountRealtime } from '../../../../../shared/relay-transport/AccountRealtime';
import { AccountIdentityChangedError, RelayHttpClient, deviceDisplayName } from '../../../../../mobile-web/src/services/RelayHttpClient';
import { deriveDeviceMessageKey, encrypt, toB64, generateKeyPair } from '../../../../../mobile-web/src/services/E2EEncryption';

const identity = (userId = 'user-a') => ({ token: `token-${userId}`, userId, deviceId: 'browser', masterKey: new Uint8Array(32).fill(userId === 'user-a' ? 7 : 8) });
const peerPublicKey = (await generateKeyPair()).publicKey;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { vi.stubGlobal('window', globalThis); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe.each(['https://remote.openbitfun.com/v/1.0.2', 'http://192.168.1.9:9700'])('account device routing on %s', (relayUrl) => {
  it('answers a superseded directory read with the newest completion and publishes authoritative names', async () => {
    const client = new RelayHttpClient(relayUrl, identity());
    const old = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(Response.json([
      { device_id: 'desktop', device_name: 'technical', device_alias: 'Current alias', online: true },
    ])));
    const changed = vi.fn(); client.onDeviceDirectorySnapshot(changed);
    const superseded = client.listDevices();
    const newest = await client.listDevices();
    old.resolve(Response.json([{ device_id: 'desktop', device_name: 'old', online: true }]));
    // Several surfaces read the directory at once, so a read that another read
    // superseded still answers: failing its caller would leave that surface on an
    // empty device list, and answering with its own older payload would regress
    // the newest directory. The newest completion wins for everyone.
    expect(await superseded).toEqual(newest);
    expect(client.resolveDeviceName('desktop', 'saved name')).toBe('Current alias');
    expect(changed).toHaveBeenCalledOnce();
    client.setAccountIdentity(identity('user-b'));
    expect(client.resolveDeviceName('desktop')).toBe('desktop');
    client.resetConnectionIdentity();
  });
  it('preserves additive metadata and gates alias mutations on Relay capabilities', async () => {
    const client = new RelayHttpClient(relayUrl, identity());
    const device = { device_id: 'desktop', device_name: 'technical', device_alias: 'Work', device_model: 'Model', device_os: 'Linux', device_os_version: '1', online: false, future: true };
    const fetch = vi.fn().mockResolvedValueOnce(Response.json([device]))
      .mockResolvedValueOnce(Response.json({ protocol_version: 1 }))
      .mockResolvedValueOnce(Response.json({ capabilities: ['device_alias_v1'] }))
      .mockResolvedValueOnce(Response.json({}));
    vi.stubGlobal('fetch', fetch);
    expect(await client.listDevices()).toEqual([device]);
    expect(deviceDisplayName(device)).toBe('Work');
    expect(deviceDisplayName({ ...device, device_alias: null })).toBe('technical');
    await expect(client.updateDeviceAlias('desktop', 'Work')).rejects.toThrow('unsupported');
    expect(fetch).toHaveBeenCalledTimes(2);
    const changed = vi.fn(); client.onDeviceDirectoryChanged(changed);
    await client.updateDeviceAlias('desktop', null);
    expect(fetch.mock.calls[3][1]).toMatchObject({ method: 'PATCH', body: '{"device_alias":null}', headers: { Authorization: 'Bearer token-user-a' } });
    expect(changed).toHaveBeenCalledOnce();
    client.resetConnectionIdentity();
  });
  it.each([404, 405])('reports unsupported PATCH HTTP %s without fake success', async status => {
    const client = new RelayHttpClient(relayUrl, identity());
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ capabilities: ['device_alias_v1'] }))
      .mockResolvedValueOnce(Response.json({}, { status })));
    const changed = vi.fn(); client.onDeviceDirectoryChanged(changed);
    await expect(client.updateDeviceAlias('desktop', 'Work')).rejects.toThrow('unsupported');
    expect(changed).not.toHaveBeenCalled();
    client.resetConnectionIdentity();
  });
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
    vi.spyOn(AccountRealtime.prototype, 'ready').mockResolvedValue();
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
    const ready = vi.spyOn(AccountRealtime.prototype, 'ready').mockResolvedValue();
    const client = new RelayHttpClient(relayUrl, identity()); client.setTargetDeviceId('desktop');
    const result = client.sendDeviceRpc('desktop', { cmd: 'cancel_task' });
    client.setTargetDeviceId('another');
    pending.resolve(Response.json({ device_id: 'desktop', public_key: toB64(peerPublicKey) }));
    await expect(result).rejects.toBeInstanceOf(AccountIdentityChangedError);
    expect(ready).not.toHaveBeenCalled();
    client.resetConnectionIdentity();
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
