import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SnapshotAPI } from './SnapshotAPI';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';

const invokeMock = vi.hoisted(() => vi.fn());
const peerCapabilities = vi.hoisted(() => ({ workspaceIdReferencesV1: true }));
const sessionsMock = vi.hoisted(() => new Map<string, any>());
vi.mock('./ApiClient', () => ({ api: { invoke: invokeMock } }));
vi.mock('@/flow_chat/store/FlowChatStore', () => ({
  flowChatStore: { getState: () => ({ sessions: sessionsMock }) },
}));
vi.mock('@/infrastructure/peer-device/PeerConnectionManager', () => ({
  peerConnectionManager: { get: () => ({ getState: () => ({ capabilities: peerCapabilities }) }) },
}));

describe('SnapshotAPI workspace identity', () => {
  let snapshotAPI: SnapshotAPI;
  beforeEach(() => {
    activateSurface('local');
    snapshotAPI = new SnapshotAPI();
    invokeMock.mockReset();
    sessionsMock.clear();
    peerCapabilities.workspaceIdReferencesV1 = true;
  });

  it('deduplicates concurrent reads by workspace ID and allows another read after settlement', async () => {
    const stats = { session_id: 'session-1', total_files: 2 };
    invokeMock.mockResolvedValue(stats);
    const first = snapshotAPI.getSessionStats('session-1', 'opaque-id');
    const second = snapshotAPI.getSessionStats('session-1', 'opaque-id');
    await expect(Promise.all([first, second])).resolves.toEqual([stats, stats]);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('get_session_stats', {
      request: { session_id: 'session-1', workspaceId: 'opaque-id' },
    });
    await snapshotAPI.getSessionStats('session-1', 'opaque-id');
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('does not merge two IDs whose stored roots are identical', async () => {
    sessionsMock.set('a', { workspaceId: 'id-a', workspacePath: '/same/root' });
    sessionsMock.set('b', { workspaceId: 'id-b', workspacePath: '/same/root' });
    invokeMock.mockResolvedValue({});
    await Promise.all([snapshotAPI.getSessionStats('a'), snapshotAPI.getSessionStats('b')]);
    expect(invokeMock.mock.calls.map(([, args]) => args.request.workspaceId)).toEqual(['id-a', 'id-b']);
  });

  it('keeps the session ID binding for remote mutations and offline operation history', async () => {
    sessionsMock.set('remote-session', {
      workspaceId: 'remote-object', workspacePath: '/srv/project',
      remoteConnectionId: 'ssh:old', remoteSshHost: 'old.example',
    });
    invokeMock.mockResolvedValue({});
    await snapshotAPI.rejectFileModifications('remote-session', 'src/main.rs');
    await snapshotAPI.getOperationDiff('remote-session', 'src/main.rs', 'operation-1');
    await snapshotAPI.getOperationSummary('remote-session', 'operation-1');
    for (const [, args] of invokeMock.mock.calls) {
      expect(args.request.workspaceId).toBe('remote-object');
      expect(args.request).not.toHaveProperty('workspacePath');
      expect(args.request).not.toHaveProperty('remoteConnectionId');
      expect(args.request).not.toHaveProperty('remoteSshHost');
    }
  });

  it('does not reinterpret a legacy path-only session before catalog migration', async () => {
    sessionsMock.set('legacy', { workspacePath: '/srv/shared', config: { remoteSshHost: 'host' } });
    await expect(snapshotAPI.getOperationSummary('legacy', 'operation-1')).rejects.toThrow('workspaceId');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('rejects a caller trying to replace a known session owner', async () => {
    sessionsMock.set('session', { workspaceId: 'owner' });
    await expect(snapshotAPI.rejectFileModifications('session', 'file', 'different')).rejects.toThrow('does not match');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('ignores stale SSH metadata on a local session', async () => {
    sessionsMock.set('local', { config: { workspaceId: 'local-object', remoteSshHost: 'stale-host' } });
    invokeMock.mockResolvedValue({});
    await snapshotAPI.getSessionStats('local');
    expect(invokeMock).toHaveBeenCalledWith('get_session_stats', {
      request: { session_id: 'local', workspaceId: 'local-object' },
    });
  });

  it('never reuses a pending response across device surface activations', async () => {
    let resolveFirst!: (value: unknown) => void;
    invokeMock.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }));
    invokeMock.mockResolvedValueOnce({ linesAdded: 2 });
    const first = snapshotAPI.getOperationSummary('same-session', 'operation-1', 'same-id');
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    activateSurface('peer-b');
    const second = snapshotAPI.getOperationSummary('same-session', 'operation-1', 'same-id');
    await expect(second).resolves.toMatchObject({ linesAdded: 2 });
    expect(invokeMock).toHaveBeenCalledTimes(2);
    resolveFirst({ linesAdded: 1 });
    await expect(first).resolves.toMatchObject({ linesAdded: 1 });
  });

  it('does not dispatch after the driving host changes during serialization', async () => {
    const pending = snapshotAPI.getSessionStats('session', 'same-id');
    const rejection = expect(pending).rejects.toThrow();
    activateSurface('peer-c');
    await rejection;
    expect(invokeMock).not.toHaveBeenCalled();
  });
  it('serializes a legacy peer request from the selected ID, including the remote host', async () => {
    peerCapabilities.workspaceIdReferencesV1 = false;
    activateSurface('legacy-peer');
    const records = [
      { id: 'local-id', rootPath: '/same/root', workspaceKind: 'normal' },
      { id: 'remote-id', rootPath: '/same/root', workspaceKind: 'remote', connectionId: 'ssh-id', sshHost: 'host' },
    ];
    invokeMock.mockImplementation(async (command: string) =>
      command === 'get_opened_workspaces' || command === 'get_recent_workspaces' ? records : {});
    await snapshotAPI.getOperationSummary('session', 'operation', 'remote-id');
    expect(invokeMock).toHaveBeenCalledWith('get_operation_summary', {
      request: { sessionId: 'session', operationId: 'operation', workspacePath: '/same/root',
        remoteConnectionId: 'ssh-id', remoteSshHost: 'host' },
    });
  });

});
