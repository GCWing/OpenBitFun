import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ACPClientAPI } from '@/infrastructure/api/service-api/ACPClientAPI';
import { loadWorkspaceAcpMenuClients } from './workspaceAcpMenuClients';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';

vi.mock('@/infrastructure/api/service-api/ACPClientAPI', () => ({
  ACPClientAPI: {
    getClients: vi.fn(),
    probeClientRequirements: vi.fn(),
  },
}));

function client(id: string, enabled: boolean) {
  return {
    id,
    name: id,
    command: id,
    args: [],
    enabled,
    readonly: false,
    permissionMode: 'ask' as const,
    status: 'configured' as const,
    toolName: `acp__${id}__prompt`,
    sessionCount: 0,
  };
}

describe('loadWorkspaceAcpMenuClients', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    activateSurface('local');
  });

  it('does not probe external ACP executables while loading workspace menu clients', async () => {
    vi.mocked(ACPClientAPI.getClients).mockResolvedValue([
      client('opencode', true),
      client('disabled-client', false),
    ]);

    const clients = await loadWorkspaceAcpMenuClients();

    expect(ACPClientAPI.getClients).toHaveBeenCalledTimes(1);
    expect(ACPClientAPI.probeClientRequirements).not.toHaveBeenCalled();
    expect(clients.map(item => item.id)).toEqual(['opencode']);
  });

  it('uses local ACP config for remote workspaces and filters by remote requirements', async () => {
    vi.mocked(ACPClientAPI.getClients).mockResolvedValue([
      client('claude-code', true),
      client('custom-remote-only', true),
      client('disabled-client', false),
    ]);
    vi.mocked(ACPClientAPI.probeClientRequirements).mockResolvedValue([
      {
        id: 'opencode',
        tool: { name: 'opencode', installed: false },
        runnable: false,
        notes: ['opencode is not available on remote PATH'],
      },
      {
        id: 'claude-code',
        tool: { name: 'claude', installed: false },
        adapter: { name: '@agentclientprotocol/claude-agent-acp', installed: true },
        runnable: false,
        notes: ['claude is not available on remote PATH'],
      },
      {
        id: 'custom-remote-only',
        tool: { name: 'custom-acp', installed: true },
        runnable: true,
        notes: [],
      },
      {
        id: 'disabled-client',
        tool: { name: 'disabled-client', installed: true },
        runnable: true,
        notes: [],
      },
    ]);

    const clients = await loadWorkspaceAcpMenuClients({
      remoteWorkspace: true,
      remoteConnectionId: 'ssh-1',
    });

    expect(ACPClientAPI.probeClientRequirements).toHaveBeenCalledWith({
      remoteConnectionId: 'ssh-1',
    });
    expect(clients.map(item => item.id)).toEqual(['custom-remote-only']);
  });

  it('refreshes remote requirements when no cached remote snapshot exists', async () => {
    vi.mocked(ACPClientAPI.getClients).mockResolvedValue([
      client('custom-remote-only', true),
    ]);
    vi.mocked(ACPClientAPI.probeClientRequirements)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'custom-remote-only',
          tool: { name: 'custom-acp', installed: true },
          runnable: true,
          notes: [],
        },
      ]);

    const clients = await loadWorkspaceAcpMenuClients({
      remoteWorkspace: true,
      remoteConnectionId: 'ssh-1',
    });

    expect(ACPClientAPI.probeClientRequirements).toHaveBeenNthCalledWith(1, {
      remoteConnectionId: 'ssh-1',
    });
    expect(ACPClientAPI.probeClientRequirements).toHaveBeenNthCalledWith(2, {
      remoteConnectionId: 'ssh-1',
      force: true,
    });
    expect(clients.map(item => item.id)).toEqual(['custom-remote-only']);
  });

  it('refreshes once when cached remote requirements hide every enabled local ACP client', async () => {
    vi.mocked(ACPClientAPI.getClients).mockResolvedValue([
      client('codex', true),
    ]);
    vi.mocked(ACPClientAPI.probeClientRequirements)
      .mockResolvedValueOnce([
        {
          id: 'codex',
          tool: { name: 'codex', installed: true },
          adapter: { name: '@agentclientprotocol/codex-acp', installed: false },
          runnable: false,
          notes: ['npx is not available on remote PATH'],
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'codex',
          tool: { name: 'codex', installed: true },
          adapter: { name: '@agentclientprotocol/codex-acp', installed: true },
          runnable: true,
          notes: [],
        },
      ]);

    const clients = await loadWorkspaceAcpMenuClients({
      remoteWorkspace: true,
      remoteConnectionId: 'ssh-stale',
    });

    expect(ACPClientAPI.probeClientRequirements).toHaveBeenNthCalledWith(1, {
      remoteConnectionId: 'ssh-stale',
    });
    expect(ACPClientAPI.probeClientRequirements).toHaveBeenNthCalledWith(2, {
      remoteConnectionId: 'ssh-stale',
      force: true,
    });
    expect(clients.map(item => item.id)).toEqual(['codex']);
  });

  it('refreshes negative snapshots again after the same connection ID moves to another device', async () => {
    vi.mocked(ACPClientAPI.getClients).mockResolvedValue([client('codex', true)]);
    vi.mocked(ACPClientAPI.probeClientRequirements).mockResolvedValue([
      { id: 'codex', tool: { name: 'codex', installed: false }, runnable: false, notes: [] },
    ]);
    const options = { remoteWorkspace: true, remoteConnectionId: 'same-id' };
    await loadWorkspaceAcpMenuClients(options);
    await loadWorkspaceAcpMenuClients(options);
    expect(vi.mocked(ACPClientAPI.probeClientRequirements).mock.calls.filter(([options]) => options?.force)).toHaveLength(1);
    activateSurface('peer-b');
    await loadWorkspaceAcpMenuClients(options);
    expect(vi.mocked(ACPClientAPI.probeClientRequirements).mock.calls.filter(([options]) => options?.force)).toHaveLength(2);
  });
});
