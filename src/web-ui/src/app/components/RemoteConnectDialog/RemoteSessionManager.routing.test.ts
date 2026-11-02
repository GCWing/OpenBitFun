import { describe, expect, it, vi } from 'vitest';
import { RelayHttpClient } from '../../../../../mobile-web/src/services/RelayHttpClient';
import {
  RemoteControlTargetChangedError,
  RemoteSessionManager,
} from '../../../../../mobile-web/src/services/RemoteSessionManager';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function clientForTest() {
  const client = new RelayHttpClient('https://relay.example.com', { token: 'test', userId: 'user-a', deviceId: 'browser', masterKey: new Uint8Array(32).fill(7) });
  client.setTargetDeviceId('home-device');
  return client;
}

describe('mobile RemoteSessionManager target routing', () => {
  it('uses the authenticated browser device across heartbeat requests and manager recreation', async () => {
    const client = clientForTest();
    const send = vi.spyOn(client, 'sendDeviceRpc').mockResolvedValue({ resp: 'pong' });
    await new RemoteSessionManager(client).ping();
    await new RemoteSessionManager(client).ping();
    const first = send.mock.calls[0][1] as { client: { id: string; name: string } };
    expect(first.client.id).toBe(client.controllerDeviceId);
    expect(first.client.name).toBeTruthy();
    expect(send.mock.calls[1][1]).toEqual(expect.objectContaining({ cmd: 'ping', client: first.client }));
  });

  it('attaches request-proven SSH identity to legacy session rows sharing one path', async () => {
    const client = clientForTest();
    const send = vi.spyOn(client, 'sendDeviceRpc').mockResolvedValue({
      resp: 'sessions',
      sessions: [{ session_id: 'legacy-session', workspace_path: '/projects/herdr' }],
      has_more: false,
    });
    const manager = new RemoteSessionManager(client);
    for (const host of ['a', 'b']) {
      const result = await manager.listSessions('/projects/herdr', 30, 0, '', {
        remoteConnectionId: `ssh-${host}`, remoteSshHost: `host-${host}`,
      });
      expect(send).toHaveBeenLastCalledWith('home-device', expect.objectContaining({
        cmd: 'list_sessions', workspace_path: '/projects/herdr',
        remote_connection_id: `ssh-${host}`, remote_ssh_host: `host-${host}`,
      }), expect.anything());
      expect(result.sessions[0].workspace_identity).toEqual({
        path: '/projects/herdr', remote_connection_id: `ssh-${host}`, remote_ssh_host: `host-${host}`,
      });
    }
  });

  it('invalidates an in-flight command when a new account logs in', async () => {
    const client = clientForTest();
    const workspace = deferred<any>();
    vi.spyOn(client, 'sendDeviceRpc').mockImplementationOnce(() => workspace.promise)
      .mockResolvedValue({ resp: 'workspace_info', has_workspace: true });
    const manager = new RemoteSessionManager(client);
    const stale = manager.getWorkspaceInfo();
    client.setAccountIdentity({ token: 'b', userId: 'user-b', deviceId: 'browser', masterKey: new Uint8Array(32).fill(8) });
    expect(client.targetDeviceId).toBeNull();
    workspace.resolve({ resp: 'workspace_info', has_workspace: true });
    await expect(stale).rejects.toBeInstanceOf(RemoteControlTargetChangedError);
    client.setTargetDeviceId('new-device');
    await expect(manager.getWorkspaceInfo()).resolves.toMatchObject({ has_workspace: true });
  });

  it('invalidates an in-flight device request on account disconnect', async () => {
    const client = clientForTest();
    const workspace = deferred<any>();
    vi.spyOn(client, 'sendDeviceRpc').mockImplementation(() => workspace.promise);
    const manager = new RemoteSessionManager(client);
    const initialEpoch = client.controlTargetEpoch;

    const activeRoomRequest = manager.getWorkspaceInfo();
    client.resetConnectionIdentity();
    expect(client.controlTargetEpoch).toBeGreaterThan(initialEpoch);
    workspace.resolve({ resp: 'workspace_info', has_workspace: true });

    await expect(activeRoomRequest).rejects.toBeInstanceOf(RemoteControlTargetChangedError);
  });

  it('rejects a missing target without sending any command', async () => {
    const client = clientForTest();
    client.setTargetDeviceId(null);
    const request = vi.spyOn(client, 'sendDeviceRpc');
    await expect(new RemoteSessionManager(client).getWorkspaceInfo()).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects a deferred A response after the control target switches to B', async () => {
    const client = clientForTest();
    client.setTargetDeviceId('device-a');
    const responseA = deferred<any>();
    vi.spyOn(client, 'sendDeviceRpc').mockImplementation((deviceId) => {
      if (deviceId === 'device-a') return responseA.promise;
      return Promise.resolve({
        resp: 'workspace_info',
        has_workspace: true,
        project_name: 'Device B',
      });
    });
    const manager = new RemoteSessionManager(client);

    const requestA = manager.getWorkspaceInfo();
    client.setTargetDeviceId('device-b');
    await expect(manager.getWorkspaceInfo()).resolves.toMatchObject({
      project_name: 'Device B',
    });
    responseA.resolve({
      resp: 'workspace_info',
      has_workspace: true,
      project_name: 'Device A',
    });

    await expect(requestA).rejects.toBeInstanceOf(RemoteControlTargetChangedError);
  });

  it('rejects a deferred A error after an A to B to A ABA switch', async () => {
    const client = clientForTest();
    client.setTargetDeviceId('device-a');
    const responseA = deferred<any>();
    vi.spyOn(client, 'sendDeviceRpc').mockImplementation(() => responseA.promise);
    const manager = new RemoteSessionManager(client);
    const firstAEpoch = client.controlTargetEpoch;

    const requestA = manager.getWorkspaceInfo();
    client.setTargetDeviceId('device-b');
    client.setTargetDeviceId('device-a');
    expect(client.controlTargetEpoch).toBeGreaterThan(firstAEpoch);
    responseA.reject(new Error('Device A request failed'));

    await expect(requestA).rejects.toBeInstanceOf(RemoteControlTargetChangedError);
    await expect(requestA).rejects.not.toThrow('Device A request failed');
  });

  it('does not send a later file chunk to B after a download starts on A', async () => {
    const client = clientForTest();
    client.setTargetDeviceId('device-a');
    const remoteRequest = vi.spyOn(client, 'sendDeviceRpc').mockResolvedValue({
      resp: 'file_chunk',
      name: 'from-a.txt',
      chunk_base64: 'QUFB',
      offset: 0,
      chunk_size: 3,
      total_size: 6,
      mime_type: 'text/plain',
    });
    const manager = new RemoteSessionManager(client);

    const download = manager.readFile('/tmp/from-a.txt', 'session-a', () => {
      client.setTargetDeviceId('device-b');
    });

    await expect(download).rejects.toBeInstanceOf(RemoteControlTargetChangedError);
    expect(remoteRequest).toHaveBeenCalledTimes(1);
    expect(remoteRequest).toHaveBeenCalledWith(
      'device-a',
      expect.objectContaining({
        cmd: 'read_file_chunk',
        offset: 0,
      }),
      { retryable: true },
    );
  });

  it('bounds a remote reasoning-setting write independently from long-running commands', async () => {
    const client = clientForTest();
    client.setTargetDeviceId('remote-device');
    const remoteRequest = vi.spyOn(client, 'sendDeviceRpc')
      .mockResolvedValueOnce({
        resp: 'model_catalog',
        catalog: {
          version: 1,
          models: [],
          default_models: {},
          session_model_write_fence_supported: false,
        },
      })
      .mockResolvedValueOnce({
        resp: 'session_model_updated',
        session_id: 'session-a',
        model_id: 'primary',
        reasoning_preset: 'high',
      });
    const manager = new RemoteSessionManager(client);

    await expect(manager.setSessionModelSelection('session-a', 'primary', 'high'))
      .resolves.toEqual({ model_id: 'primary', reasoning_preset: 'high' });
    expect(remoteRequest).toHaveBeenLastCalledWith(
      'remote-device',
      expect.objectContaining({
        cmd: 'set_session_model',
        session_id: 'session-a',
        model_id: 'primary',
        reasoning_preset: 'high',
      }),
      expect.objectContaining({ retryable: false, timeoutMs: 20_000 }),
    );
  });
});


describe('mobile output file transfer integrity', () => {
  const chunk = (offset: number, bytes: string, total = 4) => ({
    resp: 'file_chunk', name: 'preview.png', chunk_base64: btoa(bytes),
    offset, chunk_size: bytes.length, total_size: total, mime_type: 'image/png',
  });

  it('reassembles short padded chunks using bytes and retains the owning session', async () => {
    const client = clientForTest();
    const send = vi.spyOn(client, 'sendDeviceRpc')
      .mockResolvedValueOnce(chunk(0, 'a'))
      .mockResolvedValueOnce(chunk(1, 'bc'))
      .mockResolvedValueOnce(chunk(3, 'd'));
    const file = await new RemoteSessionManager(client).readFile('preview.png', 'origin-session');
    expect(atob(file.contentBase64)).toBe('abcd');
    expect(file.size).toBe(4);
    expect(send.mock.calls.map(call => call[1])).toEqual([0, 1, 3].map(offset => expect.objectContaining({
      cmd: 'read_file_chunk', path: 'preview.png', session_id: 'origin-session', offset,
    })));
  });

  it.each([
    { offset: 3 }, { chunk_size: 2 }, { total_size: 5 },
    { name: 'different.png' }, { chunk_base64: '', chunk_size: 0 }, { revision: 'changed' },
  ])('rejects truncated, inconsistent or reordered chunks: %j', async invalid => {
    const client = clientForTest();
    vi.spyOn(client, 'sendDeviceRpc').mockResolvedValueOnce(chunk(0, 'ab'))
      .mockResolvedValueOnce({ ...chunk(2, 'c'), ...invalid });
    await expect(new RemoteSessionManager(client).readFile('preview.png', 'origin')).rejects.toThrow();
  });

  it('stops oversized inline previews after the first bounded response', async () => {
    const client = clientForTest();
    const send = vi.spyOn(client, 'sendDeviceRpc').mockResolvedValue(chunk(0, 'a', 100));
    await expect(new RemoteSessionManager(client).readFile('preview.png', 'origin', undefined, 8)).rejects.toThrow('too large');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toEqual(expect.objectContaining({ limit: 8 }));
  });
});
