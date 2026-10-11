// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceKind, WorkspaceType } from '@/shared/types/global-state';
import { notificationService } from '@/shared/notification-system';
import {
  activateSurface,
  getActiveSurfaceId,
  getActiveSurfaceScope,
  isSurfaceChangedError,
} from '@/infrastructure/peer-device/deviceSurface';

import { SSHRemoteProvider } from './SSHRemoteProvider';
import { SSHContext, type ConnectionStatus, type SSHContextValue } from './SSHRemoteContext';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  activateSurface('local');
});

const peerModeFlagMock = vi.hoisted(() => ({ active: false }));

vi.mock('@/infrastructure/peer-device/peerModeFlag', () => ({
  isPeerDeviceModeActive: () => peerModeFlagMock.active,
}));

const workspaceManagerMock = vi.hoisted(() => ({
  getState: vi.fn(),
  addEventListener: vi.fn(),
  consumeStartupLegacyRemoteWorkspaceSnapshot: vi.fn(),
  openRemoteWorkspace: vi.fn(),
  removeRemoteWorkspace: vi.fn(),
}));

const sshApiMock = vi.hoisted(() => ({
  getWorkspaceInfo: vi.fn(),
  listSavedConnections: vi.fn(),
  hasStoredPassword: vi.fn(),
  isConnected: vi.fn(),
  connect: vi.fn(),
  openWorkspace: vi.fn(),
  disconnect: vi.fn(),
  closeWorkspace: vi.fn(),
  removeWorkspace: vi.fn(),
}));

vi.mock('@/infrastructure/services/business/workspaceManager', () => ({
  workspaceManager: workspaceManagerMock,
}));

vi.mock('./sshApi', () => ({
  sshApi: sshApiMock,
}));

vi.mock('@/flow_chat/store/FlowChatStore', () => ({
  flowChatStore: {
    initializeFromDisk: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock('@/infrastructure/api/service-api/ACPClientAPI', () => ({
  ACPClientAPI: {
    probeClientRequirements: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock('@/shared/notification-system', () => ({
  notificationService: {
    warning: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

const confirmWarningMock = vi.hoisted(() => vi.fn());

vi.mock('@/infrastructure/confirm-dialog', () => ({
  confirmWarning: confirmWarningMock,
}));

const translate = vi.hoisted(() => (key: string, params?: Record<string, unknown>) =>
  params ? `${key} ${JSON.stringify(params)}` : key);

vi.mock('@/infrastructure/i18n', () => ({
  useI18n: () => ({ t: translate }),
}));

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('SSHRemoteProvider startup restore', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    workspaceManagerMock.getState.mockReturnValue({
      loading: false,
      openedWorkspaces: new Map(),
      activeWorkspaceId: null,
    });
    workspaceManagerMock.addEventListener.mockReturnValue(() => undefined);
    workspaceManagerMock.consumeStartupLegacyRemoteWorkspaceSnapshot.mockReturnValue({
      available: true,
      workspace: null,
    });
    sshApiMock.getWorkspaceInfo.mockResolvedValue(null);
    sshApiMock.listSavedConnections.mockResolvedValue([]);
    sshApiMock.isConnected.mockResolvedValue(false);
    sshApiMock.connect.mockResolvedValue({ success: false, error: 'connection refused' });
    sshApiMock.openWorkspace.mockResolvedValue(undefined);
    sshApiMock.removeWorkspace.mockResolvedValue(undefined);
    workspaceManagerMock.removeRemoteWorkspace.mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  async function renderProvider(): Promise<void> {
    await act(async () => {
      root.render(
        <SSHRemoteProvider>
          <div />
        </SSHRemoteProvider>
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('skips the legacy remote IPC when the startup snapshot is available', async () => {
    workspaceManagerMock.consumeStartupLegacyRemoteWorkspaceSnapshot.mockReturnValue({
      available: true,
      workspace: null,
    });

    await renderProvider();

    expect(workspaceManagerMock.consumeStartupLegacyRemoteWorkspaceSnapshot).toHaveBeenCalledTimes(1);
    expect(sshApiMock.getWorkspaceInfo).not.toHaveBeenCalled();
  });

  it('falls back to the legacy remote IPC when no startup snapshot is available', async () => {
    workspaceManagerMock.consumeStartupLegacyRemoteWorkspaceSnapshot.mockReturnValue({
      available: false,
      workspace: null,
    });

    await renderProvider();

    expect(sshApiMock.getWorkspaceInfo).toHaveBeenCalledTimes(1);
  });

  it('preserves jump and container targets during startup reconnect', async () => {
    const remoteWorkspace = {
      id: 'ws-container-1',
      name: 'project',
      rootPath: '/workspace/project',
      workspaceType: WorkspaceType.SingleProject,
      workspaceKind: WorkspaceKind.Remote,
      languages: [] as string[],
      openedAt: new Date().toISOString(),
      lastAccessed: new Date().toISOString(),
      tags: [] as string[],
      connectionId: 'conn-container',
      connectionName: 'training-container',
      sshHost: 'train.internal',
    };
    workspaceManagerMock.getState.mockReturnValue({
      loading: false,
      openedWorkspaces: new Map([[remoteWorkspace.id, remoteWorkspace]]),
      activeWorkspaceId: remoteWorkspace.id,
    });
    sshApiMock.listSavedConnections.mockResolvedValue([
      {
        id: 'conn-container',
        name: 'training-container',
        host: 'train.internal',
        port: 22,
        username: 'trainer',
        authType: { type: 'PrivateKey', keyPath: '/tmp/train_key' },
        proxyJump: 'jump1,jump2',
        container: {
          name: 'trainer-dev',
          access: 'docker-exec',
          local: false,
          dockerPath: 'docker',
          shell: '/bin/bash',
          user: 'trainer',
          interactive: true,
        },
      },
    ]);
    sshApiMock.connect.mockResolvedValue({
      success: true,
      connectionId: 'conn-container',
    });

    await renderProvider();

    expect(sshApiMock.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        proxyJump: 'jump1,jump2',
        container: expect.objectContaining({
          name: 'trainer-dev',
          access: 'docker-exec',
        }),
      })
    );
    expect(sshApiMock.openWorkspace).toHaveBeenCalledWith(
      'conn-container',
      '/workspace/project'
    );
  });

  it('reconnects one SSH profile once when several workspaces share it', async () => {
    const firstWorkspace = {
      id: 'ws-shared-1',
      name: 'first',
      rootPath: '/srv/first',
      workspaceType: WorkspaceType.SingleProject,
      workspaceKind: WorkspaceKind.Remote,
      languages: [] as string[],
      openedAt: new Date().toISOString(),
      lastAccessed: new Date().toISOString(),
      tags: [] as string[],
      connectionId: 'conn-shared',
      connectionName: 'shared-box',
      sshHost: 'shared.example.com',
    };
    const secondWorkspace = {
      ...firstWorkspace,
      id: 'ws-shared-2',
      name: 'second',
      rootPath: '/srv/second',
    };
    workspaceManagerMock.getState.mockReturnValue({
      loading: false,
      openedWorkspaces: new Map([
        [firstWorkspace.id, firstWorkspace],
        [secondWorkspace.id, secondWorkspace],
      ]),
      activeWorkspaceId: firstWorkspace.id,
    });
    sshApiMock.listSavedConnections.mockResolvedValue([{
      id: 'conn-shared',
      name: 'shared-box',
      host: 'shared.example.com',
      port: 22,
      username: 'root',
      authType: { type: 'PrivateKey', keyPath: '/tmp/id_rsa' },
    }]);
    sshApiMock.connect.mockResolvedValue({
      success: true,
      connectionId: 'conn-shared',
    });

    await renderProvider();

    expect(sshApiMock.connect).toHaveBeenCalledTimes(1);
    expect(sshApiMock.openWorkspace).toHaveBeenCalledTimes(2);
    expect(sshApiMock.openWorkspace).toHaveBeenCalledWith('conn-shared', '/srv/first');
    expect(sshApiMock.openWorkspace).toHaveBeenCalledWith('conn-shared', '/srv/second');
  });

  it('keeps a disconnected remote workspace after the 180s reconnect budget elapses', async () => {
    vi.useFakeTimers();

    const remoteWorkspace = {
      id: 'ws-remote-1',
      name: 'repos',
      rootPath: '/root/repos',
      workspaceType: WorkspaceType.SingleProject,
      workspaceKind: WorkspaceKind.Remote,
      languages: [] as string[],
      openedAt: new Date().toISOString(),
      lastAccessed: new Date().toISOString(),
      tags: [] as string[],
      connectionId: 'conn-1',
      connectionName: 'dev-box',
      sshHost: 'example.com',
    };

    workspaceManagerMock.getState.mockReturnValue({
      loading: false,
      openedWorkspaces: new Map([[remoteWorkspace.id, remoteWorkspace]]),
      activeWorkspaceId: remoteWorkspace.id,
    });
    sshApiMock.listSavedConnections.mockResolvedValue([
      {
        id: 'conn-1',
        name: 'dev-box',
        host: 'example.com',
        port: 22,
        username: 'root',
        authType: { type: 'PrivateKey', keyPath: '/tmp/id_rsa' },
      },
    ]);

    await renderProvider();

    // Fast connect failures must keep retrying without discarding restore metadata.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(workspaceManagerMock.removeRemoteWorkspace).not.toHaveBeenCalled();
    expect(sshApiMock.removeWorkspace).not.toHaveBeenCalled();
    expect(sshApiMock.connect.mock.calls.length).toBeGreaterThan(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

    expect(workspaceManagerMock.removeRemoteWorkspace).not.toHaveBeenCalled();
    expect(sshApiMock.removeWorkspace).not.toHaveBeenCalled();
    expect(notificationService.error).toHaveBeenCalledWith(
      'Remote workspace could not reconnect within 180 seconds. It remains saved for retry: /root/repos',
      { duration: 8000 }
    );
  });

  it('keeps a password workspace when an upgraded profile has no vault entry', async () => {
    const remoteWorkspace = {
      id: 'ws-password-1',
      name: 'repos',
      rootPath: '/root/repos',
      workspaceType: WorkspaceType.SingleProject,
      workspaceKind: WorkspaceKind.Remote,
      languages: [] as string[],
      openedAt: new Date().toISOString(),
      lastAccessed: new Date().toISOString(),
      tags: [] as string[],
      connectionId: 'conn-password',
      connectionName: 'password-box',
      sshHost: 'example.com',
    };
    workspaceManagerMock.getState.mockReturnValue({
      loading: false,
      openedWorkspaces: new Map([[remoteWorkspace.id, remoteWorkspace]]),
      activeWorkspaceId: remoteWorkspace.id,
    });
    sshApiMock.listSavedConnections.mockResolvedValue([
      {
        id: 'conn-password',
        name: 'password-box',
        host: 'example.com',
        port: 22,
        username: 'root',
        authType: { type: 'Password' },
      },
    ]);
    sshApiMock.hasStoredPassword.mockResolvedValue(false);

    await renderProvider();

    expect(sshApiMock.connect).not.toHaveBeenCalled();
    expect(workspaceManagerMock.removeRemoteWorkspace).not.toHaveBeenCalled();
    expect(sshApiMock.removeWorkspace).not.toHaveBeenCalled();
    expect(notificationService.warning).toHaveBeenCalledWith(
      'Remote workspace was kept. Re-enter its SSH password to reconnect: /root/repos',
      { duration: 8000 }
    );
  });

  it('keeps workspace restore metadata when its saved connection is unavailable', async () => {
    const remoteWorkspace = {
      id: 'ws-orphaned-1',
      name: 'repos',
      rootPath: '/root/repos',
      workspaceType: WorkspaceType.SingleProject,
      workspaceKind: WorkspaceKind.Remote,
      languages: [] as string[],
      openedAt: new Date().toISOString(),
      lastAccessed: new Date().toISOString(),
      tags: [] as string[],
      connectionId: 'legacy-connection',
      connectionName: 'legacy-box',
      sshHost: 'example.com',
    };
    workspaceManagerMock.getState.mockReturnValue({
      loading: false,
      openedWorkspaces: new Map([[remoteWorkspace.id, remoteWorkspace]]),
      activeWorkspaceId: remoteWorkspace.id,
    });
    sshApiMock.listSavedConnections.mockResolvedValue([]);

    await renderProvider();

    expect(sshApiMock.connect).not.toHaveBeenCalled();
    expect(workspaceManagerMock.removeRemoteWorkspace).not.toHaveBeenCalled();
    expect(sshApiMock.removeWorkspace).not.toHaveBeenCalled();
    expect(notificationService.warning).toHaveBeenCalledWith(
      'Remote workspace was kept, but its saved SSH connection is unavailable: /root/repos',
      { duration: 8000 }
    );
  });
});

describe('SSHRemoteProvider workspace connection state', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latestStatuses: Record<string, ConnectionStatus>;
  let statusHistory: Array<Record<string, ConnectionStatus>>;

  function StatusProbe() {
    const ctx = React.useContext(SSHContext);
    latestStatuses = ctx?.workspaceStatuses ?? {};
    statusHistory.push(latestStatuses);
    return null;
  }

  function createRemoteWorkspace() {
    return {
      id: 'ws-remote-1',
      name: 'repos',
      rootPath: '/root/repos',
      workspaceType: WorkspaceType.SingleProject,
      workspaceKind: WorkspaceKind.Remote,
      languages: [] as string[],
      openedAt: new Date().toISOString(),
      lastAccessed: new Date().toISOString(),
      tags: [] as string[],
      connectionId: 'conn-1',
      connectionName: 'dev-box',
      sshHost: 'example.com',
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    peerModeFlagMock.active = false;
    latestStatuses = {};
    statusHistory = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    workspaceManagerMock.getState.mockReturnValue({
      loading: false,
      openedWorkspaces: new Map(),
      activeWorkspaceId: null,
    });
    workspaceManagerMock.addEventListener.mockReturnValue(() => undefined);
    workspaceManagerMock.consumeStartupLegacyRemoteWorkspaceSnapshot.mockReturnValue({
      available: true,
      workspace: null,
    });
    sshApiMock.getWorkspaceInfo.mockResolvedValue(null);
    sshApiMock.listSavedConnections.mockResolvedValue([]);
    sshApiMock.isConnected.mockResolvedValue(false);
    sshApiMock.connect.mockResolvedValue({ success: false, error: 'connection refused' });
    sshApiMock.openWorkspace.mockResolvedValue(undefined);
    sshApiMock.removeWorkspace.mockResolvedValue(undefined);
    workspaceManagerMock.removeRemoteWorkspace.mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    peerModeFlagMock.active = false;
    vi.useRealTimers();
  });

  async function renderProvider(): Promise<void> {
    await act(async () => {
      root.render(
        <SSHRemoteProvider>
          <StatusProbe />
        </SSHRemoteProvider>
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  function emitWorkspaceManagerEvent(event: unknown): void {
    const handlers = workspaceManagerMock.addEventListener.mock.calls.map(call => call[0]);
    act(() => {
      for (const handler of handlers) {
        handler(event);
      }
    });
  }

  it.each([true, false])('keeps an established connection green during a session-switch probe (saved profile: %s)', async (hasSavedProfile) => {
    const workspace = createRemoteWorkspace();
    workspaceManagerMock.getState.mockReturnValue({
      loading: false, openedWorkspaces: new Map([[workspace.id, workspace]]), activeWorkspaceId: workspace.id,
    });
    sshApiMock.listSavedConnections.mockResolvedValue(hasSavedProfile ? [{
      id: 'conn-1', name: 'dev-box', host: 'example.com', port: 22, username: 'dev',
      authType: { type: 'PrivateKey', keyPath: '/tmp/key' },
    }] : []);
    sshApiMock.isConnected.mockResolvedValue(true);
    await renderProvider();
    expect(latestStatuses['conn-1']).toBe('connected');
    statusHistory = [];

    let finishProbe!: (connected: boolean) => void;
    sshApiMock.isConnected.mockImplementationOnce(() => new Promise(resolve => { finishProbe = resolve; }));
    emitWorkspaceManagerEvent({ type: 'workspace:switched', workspace });
    await act(async () => { await Promise.resolve(); });
    expect(finishProbe).toBeTypeOf('function');
    expect(latestStatuses['conn-1']).toBe('connected');
    await act(async () => { finishProbe(true); });

    expect(statusHistory.every(statuses => statuses['conn-1'] === 'connected')).toBe(true);
    expect(sshApiMock.connect).not.toHaveBeenCalled();
  });

  it('shows connecting after a probe confirms a real disconnect and clears it when reconnection finishes', async () => {
    const workspace = createRemoteWorkspace();
    workspaceManagerMock.getState.mockReturnValue({
      loading: false, openedWorkspaces: new Map([[workspace.id, workspace]]), activeWorkspaceId: workspace.id,
    });
    sshApiMock.listSavedConnections.mockResolvedValue([{
      id: 'conn-1', name: 'dev-box', host: 'example.com', port: 22, username: 'dev',
      authType: { type: 'PrivateKey', keyPath: '/tmp/key' },
    }]);
    sshApiMock.isConnected.mockResolvedValue(true);
    await renderProvider();
    expect(latestStatuses['conn-1']).toBe('connected');

    let finishProbe!: (connected: boolean) => void;
    let finishReconnect!: (result: { success: boolean; connectionId: string }) => void;
    sshApiMock.isConnected.mockImplementationOnce(() => new Promise(resolve => { finishProbe = resolve; }));
    sshApiMock.connect.mockImplementationOnce(() => new Promise(resolve => { finishReconnect = resolve; }));
    emitWorkspaceManagerEvent({ type: 'workspace:switched', workspace });
    await act(async () => { await Promise.resolve(); });
    expect(latestStatuses['conn-1']).toBe('connected');
    await act(async () => { finishProbe(false); });
    expect(sshApiMock.connect).toHaveBeenCalledTimes(1);
    expect(latestStatuses['conn-1']).toBe('connecting');
    await act(async () => { finishReconnect({ success: true, connectionId: 'conn-1' }); });
    expect(latestStatuses['conn-1']).toBe('connected');
  });

  it('mirrors peer-owned remote workspaces as connected without starting the reconnect timeout', async () => {
    vi.useFakeTimers();
    peerModeFlagMock.active = true;

    const remoteWorkspace = createRemoteWorkspace();
    workspaceManagerMock.getState.mockReturnValue({
      loading: false,
      openedWorkspaces: new Map([[remoteWorkspace.id, remoteWorkspace]]),
      activeWorkspaceId: remoteWorkspace.id,
    });

    await renderProvider();

    // The peer-mode snapshot must not trigger controller-side reconnect logic.
    expect(sshApiMock.listSavedConnections).not.toHaveBeenCalled();

    emitWorkspaceManagerEvent({ type: 'workspace:opened', workspace: remoteWorkspace });

    expect(latestStatuses['conn-1']).toBe('connected');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200_000);
    });

    expect(workspaceManagerMock.removeRemoteWorkspace).not.toHaveBeenCalled();
    expect(sshApiMock.removeWorkspace).not.toHaveBeenCalled();
    expect(notificationService.error).not.toHaveBeenCalled();
  });

  it('cancels the pending reconnect timeout when peer device mode activates', async () => {
    vi.useFakeTimers();

    const remoteWorkspace = createRemoteWorkspace();
    await renderProvider();

    // No remote workspaces in local state yet, so the workspace event listener
    // owns the 'connecting' transition and its 180s removal timeout.
    emitWorkspaceManagerEvent({ type: 'workspace:opened', workspace: remoteWorkspace });
    expect(latestStatuses['conn-1']).toBe('connecting');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    // Enter Peer Device Mode mid-timeout: the peer now owns SSH lifecycle.
    peerModeFlagMock.active = true;
    act(() => {
      window.dispatchEvent(
        new CustomEvent('peer-mode:changed', { detail: { active: true, deviceId: 'device-b' } })
      );
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200_000);
    });

    expect(workspaceManagerMock.removeRemoteWorkspace).not.toHaveBeenCalled();
    expect(sshApiMock.removeWorkspace).not.toHaveBeenCalled();
    expect(notificationService.error).not.toHaveBeenCalled();
  });

  it('does not remove the workspace when an in-flight reconnect budget ends after entering peer mode', async () => {
    vi.useFakeTimers();

    const remoteWorkspace = createRemoteWorkspace();
    workspaceManagerMock.getState.mockReturnValue({
      loading: false,
      openedWorkspaces: new Map([[remoteWorkspace.id, remoteWorkspace]]),
      activeWorkspaceId: remoteWorkspace.id,
    });
    sshApiMock.listSavedConnections.mockResolvedValue([
      {
        id: 'conn-1',
        name: 'dev-box',
        host: 'example.com',
        port: 22,
        username: 'root',
        authType: { type: 'PrivateKey', keyPath: '/tmp/id_rsa' },
      },
    ]);

    await renderProvider();

    // Local reconnect loop is running with fast-failing connect attempts.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(sshApiMock.connect.mock.calls.length).toBeGreaterThan(1);
    const connectCallsBeforePeerMode = sshApiMock.connect.mock.calls.length;

    peerModeFlagMock.active = true;
    act(() => {
      window.dispatchEvent(
        new CustomEvent('peer-mode:changed', { detail: { active: true, deviceId: 'device-b' } })
      );
    });

    // Budget (180s from reconnect start) ends while peer mode is active.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200_000);
    });

    // No new SSH connects using controller credentials on the peer, no removal,
    // and no spurious failure notification.
    expect(sshApiMock.connect.mock.calls.length).toBe(connectCallsBeforePeerMode);
    expect(workspaceManagerMock.removeRemoteWorkspace).not.toHaveBeenCalled();
    expect(sshApiMock.removeWorkspace).not.toHaveBeenCalled();
    expect(notificationService.error).not.toHaveBeenCalled();
  });
});

function connectionConflictError(owner: string, requested: string): Error {
  return new Error(
    `remote_workspace_connection_conflict: Workspace remote_shared is bound to SSH connection ${owner}; reopening it with connection ${requested} requires confirmation.`
  );
}

describe('SSHRemoteProvider remote workspace connection conflicts', () => {
  let container: HTMLDivElement;
  let root: Root;
  let context: SSHContextValue | null;

  function ContextProbe() {
    context = React.useContext(SSHContext);
    return null;
  }

  const savedConnections = [
    {
      id: 'ssh-root@example.com', name: 'root-profile', host: 'example.com', port: 22,
      username: 'root', authType: { type: 'PrivateKey', keyPath: '/tmp/root_key' },
    },
    {
      id: 'ssh-deploy@example.com', name: 'deploy-profile', host: 'example.com', port: 22,
      username: 'deploy', authType: { type: 'PrivateKey', keyPath: '/tmp/deploy_key' },
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    peerModeFlagMock.active = false;
    context = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    workspaceManagerMock.getState.mockReturnValue({
      loading: false,
      openedWorkspaces: new Map(),
      activeWorkspaceId: null,
    });
    workspaceManagerMock.addEventListener.mockReturnValue(() => undefined);
    workspaceManagerMock.consumeStartupLegacyRemoteWorkspaceSnapshot.mockReturnValue({
      available: true,
      workspace: null,
    });
    sshApiMock.getWorkspaceInfo.mockResolvedValue(null);
    sshApiMock.listSavedConnections.mockResolvedValue(savedConnections);
    sshApiMock.isConnected.mockResolvedValue(true);
    sshApiMock.openWorkspace.mockResolvedValue(undefined);
    sshApiMock.removeWorkspace.mockResolvedValue(undefined);
    workspaceManagerMock.removeRemoteWorkspace.mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  async function renderProvider(): Promise<void> {
    await act(async () => {
      root.render(
        <SSHRemoteProvider>
          <ContextProbe />
        </SSHRemoteProvider>
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function connectDeployProfile(): Promise<void> {
    sshApiMock.connect.mockResolvedValue({
      success: true,
      connectionId: 'ssh-deploy@example.com',
      serverInfo: { homeDir: '/home/deploy' },
    });
    await act(async () => {
      await context!.connect('ssh-deploy@example.com', {
        id: 'ssh-deploy@example.com',
        name: 'deploy-profile',
        host: 'example.com',
        port: 22,
        username: 'deploy',
        auth: { type: 'PrivateKey', keyPath: '/tmp/deploy_key' },
      } as never);
    });
    sshApiMock.openWorkspace.mockClear();
  }

  it('keeps a background-restored record bound to its owner and reports it', async () => {
    workspaceManagerMock.consumeStartupLegacyRemoteWorkspaceSnapshot.mockReturnValue({
      available: true,
      workspace: {
        connectionId: 'ssh-deploy@example.com',
        connectionName: 'deploy-profile',
        remotePath: '/srv/shared',
        sshHost: 'example.com',
      },
    });
    workspaceManagerMock.openRemoteWorkspace.mockRejectedValue(
      connectionConflictError('ssh-root@example.com', 'ssh-deploy@example.com')
    );

    await renderProvider();

    expect(workspaceManagerMock.openRemoteWorkspace).toHaveBeenCalledTimes(1);
    expect(workspaceManagerMock.openRemoteWorkspace.mock.calls[0]).toHaveLength(1);
    expect(confirmWarningMock).not.toHaveBeenCalled();
    expect(notificationService.warning).toHaveBeenCalledWith(
      'ssh.remote.connectionConflictRestoreDeferred {"path":"/srv/shared"}',
      { duration: 8000 }
    );
    expect(workspaceManagerMock.removeRemoteWorkspace).not.toHaveBeenCalled();
    expect(sshApiMock.removeWorkspace).not.toHaveBeenCalled();
    expect(sshApiMock.openWorkspace).not.toHaveBeenCalled();
  });

  it('does not activate a reconnected workspace whose record has another owner', async () => {
    workspaceManagerMock.consumeStartupLegacyRemoteWorkspaceSnapshot.mockReturnValue({
      available: true,
      workspace: {
        connectionId: 'ssh-deploy@example.com',
        connectionName: 'deploy-profile',
        remotePath: '/srv/shared',
        sshHost: 'example.com',
      },
    });
    sshApiMock.isConnected.mockResolvedValue(false);
    sshApiMock.connect.mockResolvedValue({ success: true, connectionId: 'ssh-deploy@example.com' });
    workspaceManagerMock.openRemoteWorkspace.mockRejectedValue(
      connectionConflictError('ssh-root@example.com', 'ssh-deploy@example.com')
    );

    await renderProvider();

    expect(sshApiMock.connect).toHaveBeenCalledTimes(1);
    expect(notificationService.warning).toHaveBeenCalled();
    expect(sshApiMock.openWorkspace).not.toHaveBeenCalled();
    expect(context!.remoteWorkspace).toBeNull();
  });

  it.each([true, false])('checks ownership before activating a restored workspace (connected=%s)', async alreadyConnected => {
    workspaceManagerMock.consumeStartupLegacyRemoteWorkspaceSnapshot.mockReturnValue({
      available: true,
      workspace: {
        connectionId: 'ssh-deploy@example.com',
        connectionName: 'deploy-profile',
        remotePath: '/srv/shared',
        sshHost: 'example.com',
      },
    });
    sshApiMock.isConnected.mockResolvedValue(alreadyConnected);
    sshApiMock.connect.mockResolvedValue({ success: true, connectionId: 'ssh-deploy@example.com' });
    workspaceManagerMock.openRemoteWorkspace.mockResolvedValue({ id: 'remote_shared' });

    await renderProvider();

    expect(workspaceManagerMock.openRemoteWorkspace.mock.invocationCallOrder[0])
      .toBeLessThan(sshApiMock.openWorkspace.mock.invocationCallOrder[0]);
    expect(context!.remoteWorkspace).toMatchObject({ workspaceId: 'remote_shared' });
  });

  it.each(['connection-probe', 'reconnect', 'ownership-check'])('abandons background restore after a device switch during %s', async phase => {
    workspaceManagerMock.consumeStartupLegacyRemoteWorkspaceSnapshot.mockReturnValue({
      available: true,
      workspace: {
        connectionId: 'ssh-deploy@example.com',
        connectionName: 'deploy-profile',
        remotePath: '/srv/shared',
        sshHost: 'example.com',
      },
    });
    let resume!: () => void;
    const paused = new Promise<void>(resolve => { resume = resolve; });
    sshApiMock.isConnected.mockImplementation(async () => {
      if (phase === 'connection-probe') await paused;
      return phase !== 'reconnect';
    });
    sshApiMock.connect.mockImplementation(async () => {
      await paused;
      return { success: true, connectionId: 'ssh-deploy@example.com' };
    });
    workspaceManagerMock.openRemoteWorkspace.mockImplementation(async () => {
      await paused;
      return { id: 'remote_shared' };
    });
    await renderProvider();

    activateSurface('peer-b');
    await act(async () => { resume(); });

    expect(workspaceManagerMock.openRemoteWorkspace).toHaveBeenCalledTimes(phase === 'ownership-check' ? 1 : 0);
    expect(sshApiMock.openWorkspace).not.toHaveBeenCalled();
    expect(notificationService.warning).not.toHaveBeenCalled();
    expect(context!.remoteWorkspace).toBeNull();
  });

  it.each(['peer-b', 'local'])('abandons an old confirmation after switching to %s', async nextSurface => {
    await renderProvider();
    await connectDeployProfile();
    const dispatchedSurfaces: string[] = [];
    workspaceManagerMock.openRemoteWorkspace.mockImplementation(async (_workspace, options) => {
      dispatchedSurfaces.push(getActiveSurfaceId());
      if (!options?.rebindConnection) {
        throw connectionConflictError('ssh-root@example.com', 'ssh-deploy@example.com');
      }
      return { id: 'remote_shared' };
    });
    let confirm!: (value: boolean) => void;
    confirmWarningMock.mockImplementation(() => new Promise<boolean>(resolve => { confirm = resolve; }));
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = context!.openWorkspace('/srv/shared').catch(error => error);
    });
    expect(confirmWarningMock).toHaveBeenCalledTimes(1);

    activateSurface('peer-b');
    if (nextSurface === 'local') activateSurface('local');
    let result: unknown;
    await act(async () => {
      confirm(true);
      result = await pending;
    });

    expect(isSurfaceChangedError(result)).toBe(true);
    expect(dispatchedSurfaces).toEqual(['local']);
    expect(sshApiMock.openWorkspace).not.toHaveBeenCalled();
  });

  it('does not turn a cancelled connection lookup into a new-device confirmation', async () => {
    await renderProvider();
    await connectDeployProfile();
    workspaceManagerMock.openRemoteWorkspace.mockRejectedValue(
      connectionConflictError('ssh-root@example.com', 'ssh-deploy@example.com')
    );
    const scope = getActiveSurfaceScope();
    let rejectLookup!: (reason: unknown) => void;
    sshApiMock.listSavedConnections.mockImplementation(() => new Promise((_resolve, reject) => {
      rejectLookup = reject;
    }));
    confirmWarningMock.mockResolvedValue(true);
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = context!.openWorkspace('/srv/shared').catch(error => error);
    });

    activateSurface('peer-b');
    let result: unknown;
    await act(async () => {
      try { scope.assertCurrent(); } catch (error) { rejectLookup(error); }
      result = await pending;
    });

    expect(isSurfaceChangedError(result)).toBe(true);
    expect(confirmWarningMock).not.toHaveBeenCalled();
    expect(workspaceManagerMock.openRemoteWorkspace).toHaveBeenCalledTimes(1);
    expect(sshApiMock.openWorkspace).not.toHaveBeenCalled();
  });

  it('does not activate an interactive workspace after its device has changed', async () => {
    await renderProvider();
    await connectDeployProfile();
    let finishOpen!: (value: { id: string }) => void;
    workspaceManagerMock.openRemoteWorkspace.mockImplementation(() => new Promise(resolve => { finishOpen = resolve; }));
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = context!.openWorkspace('/srv/shared').catch(error => error);
    });

    activateSurface('peer-b');
    let result: unknown;
    await act(async () => {
      finishOpen({ id: 'remote_shared' });
      result = await pending;
    });

    expect(isSurfaceChangedError(result)).toBe(true);
    expect(sshApiMock.openWorkspace).not.toHaveBeenCalled();
  });

  it('rebinds an interactively selected record only after the user confirms', async () => {
    await renderProvider();
    await connectDeployProfile();
    workspaceManagerMock.openRemoteWorkspace
      .mockRejectedValueOnce(connectionConflictError('ssh-root@example.com', 'ssh-deploy@example.com'))
      .mockResolvedValueOnce({ id: 'remote_shared' });
    confirmWarningMock.mockResolvedValue(true);

    let opened: boolean | undefined;
    await act(async () => {
      opened = await context!.openWorkspace('/srv/shared');
    });

    expect(opened).toBe(true);
    expect(confirmWarningMock).toHaveBeenCalledWith(
      'ssh.remote.connectionConflictTitle',
      'ssh.remote.connectionConflictMessage {"path":"/srv/shared","owner":"root-profile","connection":"deploy-profile"}',
      { confirmText: 'ssh.remote.connectionConflictConfirm' }
    );
    expect(workspaceManagerMock.openRemoteWorkspace).toHaveBeenCalledTimes(2);
    expect(workspaceManagerMock.openRemoteWorkspace.mock.calls[1][1]).toEqual({ rebindConnection: true });
    expect(sshApiMock.openWorkspace).toHaveBeenCalledWith('ssh-deploy@example.com', '/srv/shared');
    expect(context!.remoteWorkspace).toMatchObject({
      workspaceId: 'remote_shared',
      connectionId: 'ssh-deploy@example.com',
      remotePath: '/srv/shared',
    });
  });

  it('leaves no host-side state when the user keeps the existing binding', async () => {
    await renderProvider();
    await connectDeployProfile();
    workspaceManagerMock.openRemoteWorkspace.mockRejectedValue(
      connectionConflictError('ssh-root@example.com', 'ssh-deploy@example.com')
    );
    confirmWarningMock.mockResolvedValue(false);

    let opened: boolean | undefined;
    await act(async () => {
      opened = await context!.openWorkspace('/srv/shared');
    });

    expect(opened).toBe(false);
    expect(workspaceManagerMock.openRemoteWorkspace).toHaveBeenCalledTimes(1);
    expect(sshApiMock.openWorkspace).not.toHaveBeenCalled();
    expect(context!.remoteWorkspace).toBeNull();
    expect(context!.showFileBrowser).toBe(true);
  });

  it('propagates other open failures without asking to rebind', async () => {
    await renderProvider();
    await connectDeployProfile();
    workspaceManagerMock.openRemoteWorkspace.mockRejectedValue(
      new Error('Remote workspace path is not a directory')
    );

    let failure: unknown;
    await act(async () => {
      failure = await context!.openWorkspace('/srv/missing').catch(error => error);
    });

    expect(failure).toBeInstanceOf(Error);
    expect(confirmWarningMock).not.toHaveBeenCalled();
    expect(sshApiMock.openWorkspace).not.toHaveBeenCalled();
  });
});
