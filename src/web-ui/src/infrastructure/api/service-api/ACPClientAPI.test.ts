import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('./ApiClient', () => ({
  api: {
    invoke: invokeMock,
  },
}));

async function importApi() {
  vi.resetModules();
  return (await import('./ACPClientAPI')).default;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('ACPClientAPI client list startup cache', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    vi.useRealTimers();
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  });

  it.each(['clients', 'requirements'])('never reuses cached %s from another device', async (kind) => {
    const ACPClientAPI = await importApi();
    const { activateSurface } = await import('@/infrastructure/peer-device/deviceSurface');
    const read = () => kind === 'clients' ? ACPClientAPI.getClients()
      : ACPClientAPI.probeClientRequirements({ remoteConnectionId: 'same-connection-id' });
    invokeMock.mockResolvedValueOnce([{ id: 'first-device' }]).mockResolvedValueOnce([{ id: 'second-device' }]);
    expect(await read()).toEqual([{ id: 'first-device' }]);
    activateSurface('peer-b');
    expect(await read()).toEqual([{ id: 'second-device' }]);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('keeps a new activation request when a previous request settles late', async () => {
    const ACPClientAPI = await importApi();
    const { activateSurface, isSurfaceChangedError } = await import('@/infrastructure/peer-device/deviceSurface');
    const oldRequest = createDeferred<[]>();
    const currentRequest = createDeferred<[]>();
    invokeMock.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(currentRequest.promise);
    const old = ACPClientAPI.getClients();
    const rejection = expect(old).rejects.toSatisfy(isSurfaceChangedError);
    activateSurface('peer-b');
    activateSurface('local');
    const current = ACPClientAPI.getClients();
    oldRequest.resolve([]);
    await rejection;
    const duplicate = ACPClientAPI.getClients();
    expect(invokeMock).toHaveBeenCalledTimes(2);
    currentRequest.resolve([]);
    await expect(Promise.all([current, duplicate])).resolves.toEqual([[], []]);
  });

  it('never saves an ACP config read from a previous device to the current device', async () => {
    const ACPClientAPI = await importApi();
    const { activateSurface, isSurfaceChangedError } = await import('@/infrastructure/peer-device/deviceSurface');
    const deferred = createDeferred<string>();
    invokeMock.mockReturnValueOnce(deferred.promise);
    const pending = ACPClientAPI.updateClientSubagentConfig({ clientId: 'codex', enabled: true });
    const rejection = expect(pending).rejects.toSatisfy(isSurfaceChangedError);
    activateSurface('peer-b');
    deferred.resolve(JSON.stringify({ acpClients: { codex: { command: 'codex' } } }));
    await rejection;
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(window.dispatchEvent).not.toHaveBeenCalled();
  });

  it('does not publish an ACP change after its originating device is deactivated', async () => {
    const ACPClientAPI = await importApi();
    const { activateSurface, isSurfaceChangedError } = await import('@/infrastructure/peer-device/deviceSurface');
    const deferred = createDeferred<void>();
    invokeMock.mockReturnValueOnce(deferred.promise);
    const pending = ACPClientAPI.stopClient({ clientId: 'codex' });
    const rejection = expect(pending).rejects.toSatisfy(isSurfaceChangedError);
    activateSurface('peer-b');
    deferred.resolve();
    await rejection;
    expect(window.dispatchEvent).not.toHaveBeenCalled();
  });

  it('coalesces concurrent forced probes but allows a later explicit refresh', async () => {
    const ACPClientAPI = await importApi();
    const pending = createDeferred<[]>();
    invokeMock.mockReturnValueOnce(pending.promise).mockResolvedValue([]);
    const options = { remoteConnectionId: 'ssh-a', force: true };
    const first = ACPClientAPI.probeClientRequirements(options);
    const second = ACPClientAPI.probeClientRequirements(options);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    pending.resolve([]);
    await Promise.all([first, second]);
    await ACPClientAPI.probeClientRequirements(options);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('does not let a snapshot read swallow or overwrite a forced probe', async () => {
    const ACPClientAPI = await importApi();
    const snapshot = createDeferred<Array<{ id: string }>>();
    invokeMock.mockReturnValueOnce(snapshot.promise).mockResolvedValueOnce([{ id: 'fresh' }]);
    const old = ACPClientAPI.probeClientRequirements({ remoteConnectionId: 'ssh-a' });
    await ACPClientAPI.probeClientRequirements({ remoteConnectionId: 'ssh-a', force: true });
    snapshot.resolve([{ id: 'stale' }]);
    await old;
    expect(await ACPClientAPI.probeClientRequirements({ remoteConnectionId: 'ssh-a' })).toEqual([{ id: 'fresh' }]);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it.each(['connection', 'config'])('retires in-flight probes when the %s is replaced', async (changed) => {
    const ACPClientAPI = await importApi();
    const previousConnection = createDeferred<Array<{ id: string }>>();
    invokeMock.mockReturnValueOnce(previousConnection.promise);
    const options = { remoteConnectionId: 'ssh-a', force: true };
    const old = ACPClientAPI.probeClientRequirements(options);
    if (changed === 'connection') {
      ACPClientAPI.invalidateRemoteRequirementProbeCache('ssh-a');
    } else {
      invokeMock.mockResolvedValueOnce(undefined);
      await ACPClientAPI.saveJsonConfig('{"acpClients":{}}');
      expect(vi.mocked(window.dispatchEvent).mock.calls.some(([event]) =>
        event.type === 'openbitfun:acp-requirements-invalidated')).toBe(true);
    }
    invokeMock.mockResolvedValueOnce([{ id: 'new-connection' }]);
    await ACPClientAPI.probeClientRequirements(options);
    previousConnection.resolve([{ id: 'old-connection' }]);
    await old;
    expect(await ACPClientAPI.probeClientRequirements({ remoteConnectionId: 'ssh-a' })).toEqual([{ id: 'new-connection' }]);
    expect(invokeMock).toHaveBeenCalledTimes(changed === 'connection' ? 2 : 3);
  });

  it('deduplicates concurrent client list requests', async () => {
    const ACPClientAPI = await importApi();
    const clients = [
      {
        id: 'claude',
        name: 'Claude',
        command: 'claude',
        args: [],
        enabled: true,
        readonly: false,
        permissionMode: 'ask',
        status: 'configured',
        toolName: 'claude',
        sessionCount: 0,
      },
    ];
    const deferred = createDeferred<typeof clients>();
    invokeMock.mockReturnValueOnce(deferred.promise);

    const first = ACPClientAPI.getClients();
    const second = ACPClientAPI.getClients();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('get_acp_clients');

    deferred.resolve(clients);
    await expect(Promise.all([first, second])).resolves.toEqual([clients, clients]);
  });

  it('serves a recently resolved client list from memory until clients change', async () => {
    const ACPClientAPI = await importApi();
    invokeMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([
        {
          id: 'codex',
          name: 'Codex',
          command: 'codex',
          args: [],
          enabled: true,
          readonly: false,
          permissionMode: 'ask',
          status: 'configured',
          toolName: 'codex',
          sessionCount: 0,
        },
      ]);

    await expect(ACPClientAPI.getClients()).resolves.toEqual([]);
    await expect(ACPClientAPI.getClients()).resolves.toEqual([]);
    expect(invokeMock).toHaveBeenCalledTimes(1);

    await ACPClientAPI.initializeClients();
    await ACPClientAPI.getClients();
    expect(invokeMock).toHaveBeenCalledTimes(3);
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'initialize_acp_clients');
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'get_acp_clients');
  });

  it('patches one client subagent profile without discarding the ACP registry', async () => {
    const ACPClientAPI = await importApi();
    invokeMock
      .mockResolvedValueOnce(JSON.stringify({
        acpClients: {
          codex: {
            name: 'Codex',
            command: 'codex',
            enabled: true,
          },
          opencode: {
            name: 'OpenCode',
            command: 'opencode',
            enabled: true,
          },
        },
      }))
      .mockResolvedValueOnce(undefined);

    await ACPClientAPI.updateClientSubagentConfig({
      clientId: 'codex',
      enabled: true,
      description: '  Implements complex code changes  ',
      bestFor: ' Cross-file refactors ',
    });

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'load_acp_json_config');
    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      'save_acp_json_config',
      expect.objectContaining({ jsonConfig: expect.any(String) })
    );
    const saved = JSON.parse(invokeMock.mock.calls[1][1].jsonConfig);
    expect(saved.acpClients.codex.subagent).toEqual({
      enabled: true,
      description: 'Implements complex code changes',
      bestFor: 'Cross-file refactors',
    });
    expect(saved.acpClients.opencode.command).toBe('opencode');
  });
});
