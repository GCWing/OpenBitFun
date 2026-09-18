import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SubagentAPI } from './SubagentAPI';
import { CustomAgentAPI } from './CustomAgentAPI';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), idProtocol: true, local: true,
}));
vi.mock('./ApiClient', () => ({ api: { invoke: mocks.invoke } }));
vi.mock('@/infrastructure/event-bus', () => ({ globalEventBus: { emit: vi.fn() } }));
vi.mock('@/infrastructure/peer-device/deviceSurface', () => ({
  getActiveSurfaceScope: () => ({ surfaceId: 'owner-host', assertCurrent: vi.fn() }),
  isLocalSurface: () => mocks.local,
}));
vi.mock('@/infrastructure/peer-device/PeerConnectionManager', () => ({
  peerConnectionManager: { get: () => ({ getState: () => ({
    capabilities: { workspaceIdReferencesV1: mocks.idProtocol },
  }) }) },
}));

const records = [
  { id: 'local-id', rootPath: '/same/path', workspaceKind: 'normal' },
  { id: 'remote-id', rootPath: '/same/path', workspaceKind: 'remote', connectionId: 'saved-ssh' },
];
describe('Agent API workspace identity', () => {
  beforeEach(() => {
    mocks.local = true;
    mocks.idProtocol = true;
    mocks.invoke.mockReset().mockImplementation(async command =>
      command === 'get_opened_workspaces' ? records : []);
  });

  it('sends only the selected ID to current local and peer hosts', async () => {
    for (const local of [true, false]) {
      mocks.local = local;
      await SubagentAPI.listSubagents({ workspaceId: 'remote-id' });
      expect(mocks.invoke).toHaveBeenLastCalledWith('list_subagents', {
        request: { workspaceId: 'remote-id' },
      });
    }
    expect(mocks.invoke).not.toHaveBeenCalledWith('get_opened_workspaces');
  });

  it('projects the ID-selected object only for a negotiated old host', async () => {
    mocks.local = false;
    mocks.idProtocol = false;
    await SubagentAPI.listSubagents({ workspaceId: 'remote-id' });
    expect(mocks.invoke).toHaveBeenLastCalledWith('list_subagents', {
      request: { workspacePath: '/same/path', remoteConnectionId: 'saved-ssh' },
    });
  });

  it('does not mutate another same-path workspace when the selected ID is missing', async () => {
    mocks.local = false;
    mocks.idProtocol = false;
    await expect(CustomAgentAPI.deleteCustomAgent('agent', 'missing-id')).rejects.toThrow('unavailable');
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'delete_custom_agent')).toBe(false);
  });

  it('distinguishes an invalid selected ID from an explicitly global request', async () => {
    await expect(SubagentAPI.listSubagents({ workspaceId: '' })).rejects.toThrow('empty');
    expect(mocks.invoke).not.toHaveBeenCalled();
    await SubagentAPI.listSubagents();
    expect(mocks.invoke).toHaveBeenLastCalledWith('list_subagents', { request: {} });
  });
});
