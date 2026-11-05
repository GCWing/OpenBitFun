// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({ trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('./deviceCatalogTransport', () => ({ invokeOnDevice: vi.fn(), acknowledgeOnDevice: vi.fn(), deviceCatalogLocalTransport: vi.fn() }));
vi.mock('@/infrastructure/api/service-api/RemoteConnectAPI', () => ({ remoteConnectAPI: {} }));

import {
  DEVICE_CATALOG_INVALIDATE_DEBOUNCE_MS,
  DEVICE_CATALOG_POLL_MS,
  DEVICE_CATALOG_RELEASE_GRACE_MS,
  DeviceWorkspaceCatalog,
  type DeviceWorkspaceCatalogIO,
} from './deviceWorkspaceCatalog';
import { routeSurfaceEvent, setActiveSurfaceDeviceId } from './deviceSurfaceRouting';
import { activateSurface, resetDeviceSurfaceForTest, surfaceIdForDevice } from './deviceSurface';
import { beginDeviceOpen, endDeviceOpen } from './deviceOpenIntent';

const workspace = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: id, rootPath: `/home/me/${id}`, workspaceType: 'other', workspaceKind: 'normal',
  languages: [], openedAt: '', lastAccessed: '', tags: [], ...extra,
});

const session = (sessionId: string, extra: Record<string, unknown> = {}) => ({
  sessionId, sessionName: sessionId, agentType: 'agentic', modelName: 'm', createdAt: 1, lastActiveAt: 1,
  turnCount: 1, messageCount: 1, toolCallCount: 0, status: 'active', tags: [], ...extra,
});

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe('DeviceWorkspaceCatalog', () => {
  let invoke: ReturnType<typeof vi.fn>;
  let io: DeviceWorkspaceCatalogIO;
  let catalog: DeviceWorkspaceCatalog;
  let capabilities: Record<string, boolean>;
  let workspaces: unknown[];

  beforeEach(() => {
    vi.useFakeTimers();
    resetDeviceSurfaceForTest();
    capabilities = { workspace_id_references_v1: true };
    workspaces = [workspace('ws-1'), workspace('assistant-1', { workspaceKind: 'assistant' })];
    invoke = vi.fn(async (_device: string | null, command: string) => {
      if (command === 'peer_mode_ping') return { capabilities };
      if (command === 'get_opened_workspaces') return workspaces;
      if (command === 'list_persisted_sessions_page') {
        return {
          sessions: [
            session('s-1'),
            session('child', { relationship: { parentSessionId: 's-1' } }),
            session('sub', { sessionKind: 'subagent' }),
            session('archived', { status: 'archived' }),
          ],
          totalTopLevelCount: 1, loadedTopLevelCount: 1, hasMore: false,
          activities: [{ sessionId: 's-1', execution: 'running', pendingApprovals: 0, pendingQuestions: 0 }],
        };
      }
      throw new Error(`unexpected ${command}`);
    });
    io = {
      invoke: invoke as DeviceWorkspaceCatalogIO['invoke'],
      acknowledge: vi.fn(async () => undefined),
      subscribeCatalog: vi.fn(async () => 'sub-1'),
      unsubscribeCatalog: vi.fn(async () => undefined),
      listen: vi.fn(() => () => undefined),
    };
    catalog = new DeviceWorkspaceCatalog(io);
  });

  afterEach(() => {
    catalog.dispose();
    setActiveSurfaceDeviceId(null);
    resetDeviceSurfaceForTest();
    vi.useRealTimers();
  });

  it('reads nothing until a section retains the device', async () => {
    expect(catalog.getSnapshot('peer-a').status).toBe('idle');
    expect(invoke).not.toHaveBeenCalled();
    const release = catalog.retain('peer-a');
    await flush();
    expect(invoke.mock.calls.map(call => call[1])).toEqual(['peer_mode_ping', 'get_opened_workspaces']);
    expect(invoke.mock.calls.every(call => call[0] === 'peer-a')).toBe(true);
    expect(catalog.getSnapshot('peer-a').workspaces.map(item => item.id)).toEqual(['ws-1', 'assistant-1']);
    expect(io.subscribeCatalog).toHaveBeenCalledWith('peer-a');
    expect(catalog.getSnapshot('peer-a').live).toBe(true);
    release();
  });

  it('reads the workspace directory while negotiating and waits for addressing before reading sessions', async () => {
    let resolvePing!: (value: unknown) => void;
    const ping = new Promise(resolve => { resolvePing = resolve; });
    const normalInvoke = invoke.getMockImplementation()!;
    invoke.mockImplementation((device, command, ...args) => command === 'peer_mode_ping'
      ? ping : normalInvoke(device, command, ...args));
    const release = catalog.retain('peer-a');
    const releaseWorkspace = catalog.retainSessions('peer-a', 'ws-1');
    await flush();
    expect(invoke).toHaveBeenCalledWith('peer-a', 'get_opened_workspaces', { request: {} });
    expect(invoke.mock.calls.some(call => call[1] === 'list_persisted_sessions_page')).toBe(false);
    resolvePing({ capabilities });
    await flush();
    expect(invoke.mock.calls.some(call => call[1] === 'list_persisted_sessions_page')).toBe(true);
    releaseWorkspace();
    release();
  });

  it('loads sessions only for an expanded workspace and keeps top-level rows', async () => {
    catalog.retain('peer-a');
    await flush();
    expect(invoke).not.toHaveBeenCalledWith('peer-a', 'list_persisted_sessions_page', expect.anything());
    catalog.retainSessions('peer-a', 'ws-1');
    await flush();
    expect(invoke).toHaveBeenCalledWith('peer-a', 'list_persisted_sessions_page', {
      request: { workspace_id: 'ws-1', limit: 8 },
    });
    const sessions = catalog.getSessions('peer-a', 'ws-1');
    expect(sessions.sessions.map(item => item.sessionId)).toEqual(['s-1']);
    expect(sessions.activities['s-1']?.execution).toBe('running');
  });

  it('addresses a pre-ID host by its own workspace root', async () => {
    capabilities = {};
    workspaces = [workspace('ws-remote', { workspaceKind: 'remote', connectionId: 'conn-1', sshHost: 'box' })];
    catalog.retain('peer-old');
    await flush();
    catalog.retainSessions('peer-old', 'ws-remote');
    await flush();
    expect(invoke).toHaveBeenCalledWith('peer-old', 'list_persisted_sessions_page', {
      request: { workspace_path: '/home/me/ws-remote', remote_connection_id: 'conn-1', remote_ssh_host: 'box', limit: 8 },
    });
  });

  it('reads this machine through the local transport without a stream', async () => {
    catalog.retain('local');
    await flush();
    expect(invoke.mock.calls.map(call => [call[0], call[1]])).toEqual([[null, 'get_opened_workspaces']]);
    expect(io.subscribeCatalog).not.toHaveBeenCalled();
  });

  it('coalesces a burst of host hints into one debounced read', async () => {
    catalog.retain('peer-a');
    await flush();
    invoke.mockClear();
    for (let i = 0; i < 5; i += 1) {
      routeSurfaceEvent('host-catalog-changed', { sessionsRevision: i, __openbitfunSourceDeviceId: 'peer-a' });
    }
    expect(invoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DEVICE_CATALOG_INVALIDATE_DEBOUNCE_MS);
    await flush();
    expect(invoke.mock.calls.filter(call => call[1] === 'get_opened_workspaces')).toHaveLength(1);
  });

  it('ignores hints from the rendered device and from devices nobody shows', async () => {
    catalog.retain('peer-a');
    await flush();
    activateSurface(surfaceIdForDevice('peer-a'));
    setActiveSurfaceDeviceId('peer-a');
    // An activation refreshes every catalog once; hints after that are the subject.
    await vi.advanceTimersByTimeAsync(DEVICE_CATALOG_INVALIDATE_DEBOUNCE_MS);
    await flush();
    invoke.mockClear();
    routeSurfaceEvent('host-catalog-changed', { __openbitfunSourceDeviceId: 'peer-a' });
    routeSurfaceEvent('host-catalog-changed', { __openbitfunSourceDeviceId: 'peer-b' });
    await vi.advanceTimersByTimeAsync(DEVICE_CATALOG_INVALIDATE_DEBOUNCE_MS * 2);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps the last catalog on failure and recovers on retry', async () => {
    catalog.retain('peer-a');
    await flush();
    invoke.mockImplementation(async () => { throw new Error('host unreachable'); });
    await catalog.retry('peer-a');
    expect(catalog.getSnapshot('peer-a').workspaces).toHaveLength(2);
    expect(catalog.getSnapshot('peer-a').error).toBe('host unreachable');
    invoke.mockImplementation(async (_device: string | null, command: string) => (
      command === 'get_opened_workspaces' ? [workspace('ws-2')] : { capabilities }
    ));
    await catalog.retry('peer-a');
    expect(catalog.getSnapshot('peer-a').error).toBeUndefined();
    expect(catalog.getSnapshot('peer-a').workspaces.map(item => item.id)).toEqual(['ws-2']);
  });

  it('reports an error state when the first read fails', async () => {
    invoke.mockRejectedValue(new Error('offline'));
    catalog.retain('peer-a');
    await flush();
    expect(catalog.getSnapshot('peer-a').status).toBe('error');
  });

  it('stops the host stream only after the release grace period', async () => {
    const release = catalog.retain('peer-a');
    await flush();
    release();
    await vi.advanceTimersByTimeAsync(DEVICE_CATALOG_RELEASE_GRACE_MS - 1);
    expect(io.unsubscribeCatalog).not.toHaveBeenCalled();
    const again = catalog.retain('peer-a');
    await vi.advanceTimersByTimeAsync(DEVICE_CATALOG_RELEASE_GRACE_MS);
    expect(io.unsubscribeCatalog).not.toHaveBeenCalled();
    again();
    await vi.advanceTimersByTimeAsync(DEVICE_CATALOG_RELEASE_GRACE_MS);
    expect(io.unsubscribeCatalog).toHaveBeenCalledWith('sub-1');
  });

  it('falls back to visibility refresh for a host without a catalog stream', async () => {
    io.subscribeCatalog = vi.fn(async () => { throw new Error('host_stream_v1 unsupported'); });
    catalog.retain('peer-a');
    await flush();
    expect(catalog.getSnapshot('peer-a').live).toBe(false);
    invoke.mockClear();
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(DEVICE_CATALOG_INVALIDATE_DEBOUNCE_MS);
    await flush();
    expect(invoke).toHaveBeenCalledWith('peer-a', 'get_opened_workspaces', { request: {} });
    invoke.mockClear();
    await vi.advanceTimersByTimeAsync(DEVICE_CATALOG_POLL_MS + DEVICE_CATALOG_INVALIDATE_DEBOUNCE_MS);
    await flush();
    expect(invoke).toHaveBeenCalledWith('peer-a', 'get_opened_workspaces', { request: {} });
  });

  it('re-reads open sections under a new account', async () => {
    catalog.retain('peer-a');
    await flush();
    invoke.mockClear();
    catalog.reset();
    await flush();
    expect(invoke).toHaveBeenCalledWith('peer-a', 'peer_mode_ping', {});
    expect(invoke).toHaveBeenCalledWith('peer-a', 'get_opened_workspaces', { request: {} });
  });

  it('keeps every workspace current for device status without expanding it', async () => {
    workspaces = [workspace('ws-1'), workspace('ws-2'), workspace('ws-3')];
    const release = catalog.retainActivity('peer-a');
    await flush();
    const sessionReads = invoke.mock.calls.filter(call => call[1] === 'list_persisted_sessions_page');
    expect(sessionReads.map(call => call[2].request.workspace_id).sort()).toEqual(['ws-1', 'ws-2', 'ws-3']);
    expect(catalog.loadedSurfaces()).toEqual(['peer-a']);

    // An expanded row reuses the page the activity refresh keeps current.
    invoke.mockClear();
    catalog.retainSessions('peer-a', 'ws-1');
    await flush();
    expect(invoke).not.toHaveBeenCalled();

    // A host hint refreshes all of them once, after the debounce.
    routeSurfaceEvent('host-catalog-changed', { __openbitfunSourceDeviceId: 'peer-a' });
    await vi.advanceTimersByTimeAsync(DEVICE_CATALOG_INVALIDATE_DEBOUNCE_MS);
    await flush();
    expect(invoke.mock.calls.filter(call => call[1] === 'list_persisted_sessions_page')).toHaveLength(3);
    release();
  });

  it('refreshes only the departed device when a device switch lands', async () => {
    activateSurface(surfaceIdForDevice('peer-a'));
    catalog.retain('peer-a');
    catalog.retain('peer-b');
    catalog.retain('peer-c');
    await flush();
    invoke.mockClear();
    activateSurface(surfaceIdForDevice('peer-b'));
    await vi.advanceTimersByTimeAsync(DEVICE_CATALOG_INVALIDATE_DEBOUNCE_MS);
    await flush();
    expect(invoke).toHaveBeenCalledWith('peer-a', 'get_opened_workspaces', { request: {} });
    expect(invoke.mock.calls.every(call => call[0] === 'peer-a')).toBe(true);
  });

  it('holds refreshes while a cross-device open runs and catches up once after it', async () => {
    catalog.retain('peer-a');
    await flush();
    invoke.mockClear();
    const intent = beginDeviceOpen({ surfaceId: 'peer-b', key: 'session:s' });
    activateSurface(surfaceIdForDevice('peer-b'));
    routeSurfaceEvent('host-catalog-changed', { __openbitfunSourceDeviceId: 'peer-a' });
    await vi.advanceTimersByTimeAsync(DEVICE_CATALOG_INVALIDATE_DEBOUNCE_MS * 4);
    expect(invoke).not.toHaveBeenCalled();
    endDeviceOpen(intent);
    await vi.advanceTimersByTimeAsync(DEVICE_CATALOG_INVALIDATE_DEBOUNCE_MS);
    await flush();
    expect(invoke.mock.calls.filter(call => call[1] === 'get_opened_workspaces')).toHaveLength(1);
  });

  it('refreshes only session pages when the hint says the workspace list is unchanged', async () => {
    catalog.retainActivity('peer-a');
    await flush();
    const hint = (workspacesRevision: number) => routeSurfaceEvent('host-catalog-changed',
      { sessionsRevision: Math.random(), workspacesRevision, __openbitfunSourceDeviceId: 'peer-a' });
    hint(1);
    await vi.advanceTimersByTimeAsync(DEVICE_CATALOG_INVALIDATE_DEBOUNCE_MS);
    await flush();
    invoke.mockClear();
    hint(1);
    await vi.advanceTimersByTimeAsync(DEVICE_CATALOG_INVALIDATE_DEBOUNCE_MS);
    await flush();
    expect(invoke.mock.calls.map(call => call[1])).not.toContain('get_opened_workspaces');
    expect(invoke.mock.calls.map(call => call[1])).toContain('list_persisted_sessions_page');
    invoke.mockClear();
    hint(2);
    await vi.advanceTimersByTimeAsync(DEVICE_CATALOG_INVALIDATE_DEBOUNCE_MS);
    await flush();
    expect(invoke.mock.calls.map(call => call[1])).toContain('get_opened_workspaces');
  });

  it('reads nothing while the window is hidden and catches up once when shown', async () => {
    catalog.retain('peer-a');
    await flush();
    invoke.mockClear();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    for (let i = 0; i < 3; i += 1) routeSurfaceEvent('host-catalog-changed', { __openbitfunSourceDeviceId: 'peer-a' });
    await vi.advanceTimersByTimeAsync(DEVICE_CATALOG_INVALIDATE_DEBOUNCE_MS * 3);
    expect(invoke).not.toHaveBeenCalled();
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(DEVICE_CATALOG_INVALIDATE_DEBOUNCE_MS);
    await flush();
    expect(invoke.mock.calls.filter(call => call[1] === 'get_opened_workspaces')).toHaveLength(1);
    visibility.mockRestore();
  });

  it('does not re-read the device that just became rendered', async () => {
    catalog.retain('peer-a');
    await flush();
    invoke.mockClear();
    activateSurface(surfaceIdForDevice('peer-a'));
    await vi.advanceTimersByTimeAsync(DEVICE_CATALOG_INVALIDATE_DEBOUNCE_MS);
    await flush();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('coalesces the updates of a read into fewer notifications', async () => {
    workspaces = [workspace('ws-1'), workspace('ws-2'), workspace('ws-3')];
    const listener = vi.fn();
    catalog.subscribe(listener);
    catalog.retainActivity('peer-a');
    await flush();
    await flush();
    // Unbatched, a read of three workspaces publishes 9 updates (status, list,
    // and loading/ready per page); updates within one task share a notification.
    expect(listener.mock.calls.length).toBeLessThan(9);
  });

  it('marks a device read on its host, updating rows at once', async () => {
    invoke.mockImplementation(async (_device: string | null, command: string) => {
      if (command === 'peer_mode_ping') return { capabilities };
      if (command === 'get_opened_workspaces') return [workspace('ws-1')];
      return {
        sessions: [session('done', { unreadCompletion: 'completed' }), session('quiet')],
        totalTopLevelCount: 2, loadedTopLevelCount: 2, hasMore: false,
        activities: [{ sessionId: 'done', execution: 'idle', pendingApprovals: 0, pendingQuestions: 0, unreadCompletion: 'completed' }],
      };
    });
    catalog.retainActivity('peer-a');
    await flush();
    const marked = catalog.markAllRead('peer-a');
    // Optimistic: cleared before the host answers.
    expect(catalog.getSessions('peer-a', 'ws-1').activities.done?.unreadCompletion).toBeUndefined();
    expect(await marked).toBe(1);
    expect(io.acknowledge).toHaveBeenCalledOnce();
    expect(io.acknowledge).toHaveBeenCalledWith('peer-a', { workspace_id: 'ws-1' }, expect.objectContaining({ sessionId: 'done' }));
  });

  it('drops the answer of a session read a newer read replaced', async () => {
    catalog.retain('peer-a');
    await flush();
    let releaseSlow: (value: unknown) => void = () => undefined;
    let calls = 0;
    invoke.mockImplementation(async (_device: string | null, command: string) => {
      if (command === 'get_opened_workspaces') return workspaces;
      if (command !== 'list_persisted_sessions_page') return { capabilities };
      calls += 1;
      if (calls === 1) return new Promise(resolve => { releaseSlow = resolve; });
      return { sessions: [session('new'), session('older')], totalTopLevelCount: 2, hasMore: false };
    });
    catalog.retainSessions('peer-a', 'ws-1');
    await flush();
    void catalog.loadMoreSessions('peer-a', 'ws-1');
    await flush();
    releaseSlow({ sessions: [session('stale')], totalTopLevelCount: 1, hasMore: false });
    await flush();
    expect(catalog.getSessions('peer-a', 'ws-1').sessions.map(item => item.sessionId)).toEqual(['new', 'older']);
  });

  it('asks a host that refused a session read how it addresses sessions again', async () => {
    catalog.retain('peer-a');
    await flush();
    const refused = Object.assign(new Error('unknown field workspace_id'), { name: 'DeviceCatalogCommandError' });
    invoke.mockImplementation(async (_device: string | null, command: string) => {
      if (command === 'get_opened_workspaces') return workspaces;
      if (command === 'peer_mode_ping') return { capabilities: {} };
      throw refused;
    });
    catalog.retainSessions('peer-a', 'ws-1');
    await flush();
    invoke.mockClear();
    await catalog.retry('peer-a');
    await flush();
    expect(invoke).toHaveBeenCalledWith('peer-a', 'peer_mode_ping', {});
    expect(invoke).toHaveBeenCalledWith('peer-a', 'list_persisted_sessions_page', {
      request: expect.objectContaining({ workspace_path: '/home/me/ws-1' }),
    });
  });
});
