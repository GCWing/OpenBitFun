import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  listSessions: vi.fn(),
  getAvailableShells: vi.fn(),
  createSession: vi.fn(),
  getConfig: vi.fn(),
}));

vi.mock('@/infrastructure/services/business/workspaceManager', () => ({ workspaceManager: { getState: () => ({
  openedWorkspaces: new Map([
    ['workspace-main', { id: 'workspace-main', workspaceKind: 'normal', connectionId: 'dirty-legacy-hint' }],
    ['workspace-remote', { id: 'workspace-remote', workspaceKind: 'remote', connectionId: 'ssh-1' }],
  ]), recentWorkspaces: [],
}) } }));

vi.mock('@/tools/terminal/services/TerminalService', () => ({
  getTerminalService: () => ({
    connect: mocks.connect,
    listSessions: mocks.listSessions,
    getAvailableShells: mocks.getAvailableShells,
    createSession: mocks.createSession,
  }),
}));

vi.mock('@/infrastructure/config/services/ConfigManager', () => ({
  configManager: { getConfig: mocks.getConfig },
}));

import { createManualTerminalSession } from './createManualTerminalSession';

describe('createManualTerminalSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue(undefined);
    mocks.getConfig.mockResolvedValue({ default_shell: 'C:\\Program Files\\Git\\bin\\bash.exe' });
    mocks.getAvailableShells.mockResolvedValue([
      {
        id: 'bash:c:/program files/git/bin/bash.exe',
        shellType: 'Bash',
        name: 'Git Bash',
        path: 'C:\\Program Files\\Git\\bin\\bash.exe',
        available: true,
      },
    ]);
    mocks.listSessions.mockResolvedValue([
      { id: 'manual-1', source: 'manual' },
      { id: 'agent-1', source: 'agent' },
    ]);
    mocks.createSession.mockResolvedValue({ id: 'manual-2', name: 'Shell 2' });
  });

  it('creates the selected Git Bash terminal directly for the active workspace', async () => {
    await expect(createManualTerminalSession({ workspaceId: 'workspace-main',
      workspacePath: '/workspace/project',
    })).resolves.toEqual({ id: 'manual-2', name: 'Shell 2' });

    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.createSession).toHaveBeenCalledWith({
      workspaceId: 'workspace-main',
      workingDirectory: '/workspace/project',
      name: 'Shell 2',
      shellId: 'bash:c:/program files/git/bin/bash.exe',
      shellType: 'Bash',
      source: 'manual',
    });
  });

  it('sends only the workspace ID for remote terminal creation', async () => {
    mocks.getConfig.mockResolvedValue({ default_shell: '' });

    await createManualTerminalSession({ workspaceId: 'workspace-remote' });

    expect(mocks.createSession).toHaveBeenCalledWith({
      workspaceId: 'workspace-remote',
      workingDirectory: undefined,
      name: 'Shell 2',
      source: 'manual',
    });
  });

  it('uses automatic shell selection when no default shell is configured', async () => {
    mocks.getConfig.mockResolvedValue({ default_shell: '' });

    await createManualTerminalSession({ workspaceId: 'workspace-main', workspacePath: '/workspace/project' });

    expect(mocks.getAvailableShells).not.toHaveBeenCalled();
    expect(mocks.createSession).toHaveBeenCalledWith({
      workspaceId: 'workspace-main',
      workingDirectory: '/workspace/project',
      name: 'Shell 2',
      source: 'manual',
    });
  });

  it('falls back to automatic shell selection when the configured path is unavailable', async () => {
    mocks.getConfig.mockResolvedValue({ default_shell: 'C:\\missing\\bash.exe' });

    await createManualTerminalSession({ workspaceId: 'workspace-main', workspacePath: '/workspace/project' });

    expect(mocks.createSession).toHaveBeenCalledWith({
      workspaceId: 'workspace-main',
      workingDirectory: '/workspace/project',
      name: 'Shell 2',
      source: 'manual',
    });
  });
});
