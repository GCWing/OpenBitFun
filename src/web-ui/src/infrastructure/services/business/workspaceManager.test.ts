import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isSurfaceChangedError } from '@/infrastructure/peer-device/deviceSurface';

const globalStateMocks = vi.hoisted(() => ({
  initializeWorkspaceStartupState: vi.fn(),
  cleanupInvalidWorkspaces: vi.fn(),
  getRecentWorkspaces: vi.fn(),
  getOpenedWorkspaces: vi.fn(),
  getCurrentWorkspace: vi.fn(),
  getPrimaryAssistantWorkspace: vi.fn(),
  updateWorkspaceInfo: vi.fn(),
}));

const listenMock = vi.hoisted(() => vi.fn());

vi.mock('../../../shared/types', () => ({
  WorkspaceKind: {
    Normal: 'normal',
    Assistant: 'assistant',
    Remote: 'remote',
  },
  globalStateAPI: globalStateMocks,
  isRemoteWorkspace: (workspace: { workspaceKind?: string } | null) =>
    workspace?.workspaceKind === 'remote',
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
}));

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@/shared/utils/startupTrace', () => ({
  startupTrace: {
    markPhase: vi.fn(),
  },
}));

function configureGlobalState(): void {
  globalStateMocks.initializeWorkspaceStartupState.mockResolvedValue({
    cleanupRemovedCount: 0,
    recentWorkspaces: [],
    openedWorkspaces: [],
    currentWorkspace: null,
    legacyRemoteWorkspace: null,
  });
  globalStateMocks.cleanupInvalidWorkspaces.mockResolvedValue(0);
  globalStateMocks.getRecentWorkspaces.mockResolvedValue([]);
  globalStateMocks.getOpenedWorkspaces.mockResolvedValue([]);
  globalStateMocks.getCurrentWorkspace.mockResolvedValue(null);
  globalStateMocks.getPrimaryAssistantWorkspace.mockResolvedValue(null);
  globalStateMocks.updateWorkspaceInfo.mockReset();
}

async function getFreshWorkspaceManager() {
  const { manager } = await getFreshWorkspaceHarness();
  return manager;
}

async function getFreshWorkspaceHarness() {
  vi.resetModules();
  const deviceSurface = await import('@/infrastructure/peer-device/deviceSurface');
  deviceSurface.resetDeviceSurfaceForTest();
  const { WorkspaceManager } = await import('./workspaceManager');
  (WorkspaceManager as unknown as { instance: unknown }).instance = null;
  return {
    manager: WorkspaceManager.getInstance(),
    deviceSurface,
  };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('WorkspaceManager startup initialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureGlobalState();
  });

  it('does not block startup workspace state on identity listener registration', async () => {
    listenMock.mockReturnValue(new Promise(() => undefined));
    const manager = await getFreshWorkspaceManager();

    const initializePromise = manager.initialize();
    const initializeResult = await Promise.race([
      initializePromise.then(() => 'initialized'),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 20)),
    ]);

    expect(listenMock).toHaveBeenCalledWith('workspace-identity-changed', expect.any(Function));
    expect(initializeResult).toBe('initialized');
    expect(globalStateMocks.initializeWorkspaceStartupState).toHaveBeenCalledTimes(1);
    expect(globalStateMocks.cleanupInvalidWorkspaces).not.toHaveBeenCalled();
    expect(globalStateMocks.getCurrentWorkspace).not.toHaveBeenCalled();
    expect(globalStateMocks.getRecentWorkspaces).not.toHaveBeenCalled();
    expect(globalStateMocks.getOpenedWorkspaces).not.toHaveBeenCalled();
  });

  it('applies identity updates after delayed listener registration completes', async () => {
    const workspace = {
      id: 'assistant-1',
      name: 'Assistant 1',
      rootPath: 'D:/workspace/assistant-1',
      workspaceKind: 'assistant',
      identity: null,
    };
    globalStateMocks.initializeWorkspaceStartupState.mockResolvedValue({
      cleanupRemovedCount: 0,
      recentWorkspaces: [workspace],
      openedWorkspaces: [workspace],
      currentWorkspace: workspace,
      legacyRemoteWorkspace: null,
    });
    globalStateMocks.getCurrentWorkspace.mockResolvedValue(workspace);
    globalStateMocks.getRecentWorkspaces.mockResolvedValue([workspace]);
    globalStateMocks.getOpenedWorkspaces.mockResolvedValue([workspace]);

    let identityHandler:
      | ((event: {
          payload: {
            workspaceId: string;
            workspacePath: string;
            name: string;
            identity: { name: string };
            changedFields: string[];
          };
        }) => void)
      | null = null;
    let resolveListener: ((unlisten: () => void) => void) | null = null;
    listenMock.mockImplementation((eventName, handler) => {
      if (eventName !== 'workspace-identity-changed') {
        return Promise.resolve(() => undefined);
      }
      identityHandler = handler;
      return new Promise(resolve => {
        resolveListener = resolve;
      });
    });

    const manager = await getFreshWorkspaceManager();
    await manager.initialize();

    expect(manager.getState().currentWorkspace?.name).toBe('Assistant 1');

    resolveListener?.(() => undefined);
    await flushAsyncWork();

    identityHandler?.({
      payload: {
        workspaceId: 'assistant-1',
        workspacePath: 'D:/workspace/assistant-1',
        name: 'Assistant renamed',
        identity: { name: 'Assistant renamed' },
        changedFields: ['name'],
      },
    });

    expect(manager.getState().currentWorkspace?.name).toBe('Assistant renamed');
    identityHandler?.({ payload: {
      workspaceId: 'another-workspace', workspacePath: workspace.rootPath,
      name: 'Wrong workspace', identity: { name: 'Wrong workspace' }, changedFields: ['name'],
    } });
    expect(manager.getState().currentWorkspace?.name).toBe('Assistant renamed');

  });

  it('refreshes workspace identity once the delayed listener is ready after startup', async () => {
    const startupWorkspace = {
      id: 'assistant-1',
      name: 'Assistant 1',
      rootPath: 'D:/workspace/assistant-1',
      workspaceKind: 'assistant',
      identity: null,
    };
    const refreshedWorkspace = {
      ...startupWorkspace,
      name: 'Assistant renamed',
      identity: { name: 'Assistant renamed' },
    };
    globalStateMocks.initializeWorkspaceStartupState.mockResolvedValue({
      cleanupRemovedCount: 0,
      recentWorkspaces: [startupWorkspace],
      openedWorkspaces: [startupWorkspace],
      currentWorkspace: startupWorkspace,
      legacyRemoteWorkspace: null,
    });
    globalStateMocks.getCurrentWorkspace.mockResolvedValue(refreshedWorkspace);
    globalStateMocks.getRecentWorkspaces.mockResolvedValue([refreshedWorkspace]);
    globalStateMocks.getOpenedWorkspaces.mockResolvedValue([refreshedWorkspace]);

    let resolveListener: ((unlisten: () => void) => void) | null = null;
    listenMock.mockImplementation(eventName => eventName === 'workspace-identity-changed'
      ? new Promise<() => void>(resolve => {
        resolveListener = resolve;
      })
      : Promise.resolve(() => undefined));

    const manager = await getFreshWorkspaceManager();
    await manager.initialize();

    expect(manager.getState().currentWorkspace?.name).toBe('Assistant 1');

    resolveListener?.(() => undefined);
    await flushAsyncWork();

    expect(globalStateMocks.getCurrentWorkspace).toHaveBeenCalledTimes(1);
    expect(manager.getState().currentWorkspace?.name).toBe('Assistant renamed');
  });

  it('refreshes workspace identity when an identity event arrives before startup state is committed', async () => {
    const startupWorkspace = {
      id: 'assistant-1',
      name: 'Assistant 1',
      rootPath: 'D:/workspace/assistant-1',
      workspaceKind: 'assistant',
      identity: null,
    };
    const refreshedWorkspace = {
      ...startupWorkspace,
      name: 'Assistant renamed',
      identity: { name: 'Assistant renamed' },
    };
    let resolveStartupState: ((value: {
      cleanupRemovedCount: number;
      recentWorkspaces: typeof startupWorkspace[];
      openedWorkspaces: typeof startupWorkspace[];
      currentWorkspace: typeof startupWorkspace;
      legacyRemoteWorkspace: null;
    }) => void) | null = null;
    globalStateMocks.initializeWorkspaceStartupState.mockReturnValue(new Promise(resolve => {
      resolveStartupState = resolve;
    }));
    globalStateMocks.getCurrentWorkspace.mockResolvedValue(refreshedWorkspace);
    globalStateMocks.getRecentWorkspaces.mockResolvedValue([refreshedWorkspace]);
    globalStateMocks.getOpenedWorkspaces.mockResolvedValue([refreshedWorkspace]);

    let identityHandler:
      | ((event: {
          payload: {
            workspaceId: string;
            workspacePath: string;
            name: string;
            identity: { name: string };
            changedFields: string[];
          };
        }) => void)
      | null = null;
    listenMock.mockImplementation((eventName, handler) => {
      if (eventName === 'workspace-identity-changed') {
        identityHandler = handler;
      }
      return Promise.resolve(() => undefined);
    });

    const manager = await getFreshWorkspaceManager();
    const initializePromise = manager.initialize();
    await flushAsyncWork();

    identityHandler?.({
      payload: {
        workspaceId: 'assistant-1',
        workspacePath: 'D:/workspace/assistant-1',
        name: 'Assistant renamed',
        identity: { name: 'Assistant renamed' },
        changedFields: ['name'],
      },
    });

    resolveStartupState?.({
      cleanupRemovedCount: 0,
      recentWorkspaces: [startupWorkspace],
      openedWorkspaces: [startupWorkspace],
      currentWorkspace: startupWorkspace,
      legacyRemoteWorkspace: null,
    });
    await initializePromise;
    await flushAsyncWork();

    expect(globalStateMocks.getCurrentWorkspace).toHaveBeenCalledTimes(1);
    expect(manager.getState().currentWorkspace?.name).toBe('Assistant renamed');
  });

  it('keeps startup workspace state available when identity listener registration fails', async () => {
    listenMock.mockRejectedValue(new Error('listener unavailable'));
    const manager = await getFreshWorkspaceManager();

    await expect(manager.initialize()).resolves.toBeUndefined();

    expect(globalStateMocks.initializeWorkspaceStartupState).toHaveBeenCalledTimes(1);
    expect(manager.getState().loading).toBe(false);
    expect(manager.getState().error).toBeNull();
  });

  it('keeps startup workspace state available when identity listener registration throws synchronously', async () => {
    listenMock.mockImplementation(() => {
      throw new Error('listener unavailable');
    });
    const manager = await getFreshWorkspaceManager();

    await expect(manager.initialize()).resolves.toBeUndefined();

    expect(globalStateMocks.initializeWorkspaceStartupState).toHaveBeenCalledTimes(1);
    expect(manager.getState().loading).toBe(false);
    expect(manager.getState().error).toBeNull();
  });

  it('fails a Peer-mode rebootstrap instead of leaving workspace loading unresolved', async () => {
    globalStateMocks.initializeWorkspaceStartupState.mockRejectedValue(
      new Error('peer request timed out'),
    );
    listenMock.mockResolvedValue(() => undefined);
    const manager = await getFreshWorkspaceManager();

    await expect(manager.reinitializeForPeerModeSwitch()).rejects.toThrow(
      'peer request timed out',
    );

    expect(manager.getState()).toMatchObject({
      loading: false,
      error: 'peer request timed out',
    });
  });

  it('stores the startup legacy remote workspace snapshot for one reconnect pass', async () => {
    const legacyRemoteWorkspace = {
      connectionId: 'conn-1',
      connectionName: 'Remote',
      remotePath: '/repo',
      sshHost: 'devbox',
    };
    globalStateMocks.initializeWorkspaceStartupState.mockResolvedValue({
      cleanupRemovedCount: 0,
      recentWorkspaces: [],
      openedWorkspaces: [],
      currentWorkspace: null,
      legacyRemoteWorkspace,
    });
    listenMock.mockResolvedValue(() => undefined);
    const manager = await getFreshWorkspaceManager();

    await manager.initialize();

    expect(manager.consumeStartupLegacyRemoteWorkspaceSnapshot()).toEqual({
      available: true,
      workspace: legacyRemoteWorkspace,
    });
    expect(manager.consumeStartupLegacyRemoteWorkspaceSnapshot()).toEqual({
      available: false,
      workspace: null,
    });
  });
});

describe('WorkspaceManager device surface switching', () => {
  const workspaceA = {
    id: 'workspace-a',
    name: 'Device A repo',
    rootPath: '/repo',
    workspaceKind: 'normal',
    identity: null,
  };
  const workspaceB = {
    ...workspaceA,
    id: 'workspace-b',
    name: 'Device B repo',
  };

  function startupSnapshot(workspace: typeof workspaceA) {
    return {
      cleanupRemovedCount: 0,
      recentWorkspaces: [workspace],
      openedWorkspaces: [workspace],
      currentWorkspace: workspace,
      primaryAssistantWorkspaceId: null,
      legacyRemoteWorkspace: null,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    configureGlobalState();
    listenMock.mockResolvedValue(() => undefined);
  });

  it('lets a later switch supersede an in-flight rebootstrap instead of running two', async () => {
    const startupResolvers: Array<(snapshot: ReturnType<typeof startupSnapshot>) => void> = [];
    globalStateMocks.initializeWorkspaceStartupState.mockImplementation(
      () => new Promise(resolve => {
        startupResolvers.push(resolve);
      }),
    );

    const manager = await getFreshWorkspaceManager();

    const first = manager.reinitializeForPeerModeSwitch().then(
      () => null,
      (error: unknown) => error,
    );
    await flushAsyncWork();
    const second = manager.reinitializeForPeerModeSwitch().then(
      () => null,
      (error: unknown) => error,
    );
    await flushAsyncWork();

    expect(startupResolvers).toHaveLength(2);

    // The switch that superseded the first one lands first; the abandoned load
    // then answers late, which is exactly when it used to overwrite state.
    startupResolvers[1](startupSnapshot(workspaceB));
    await flushAsyncWork();
    startupResolvers[0](startupSnapshot(workspaceA));

    expect(isSurfaceChangedError(await first)).toBe(true);
    expect(await second).toBeNull();

    const state = manager.getState();
    expect(state.currentWorkspace?.id).toBe('workspace-b');
    expect(Array.from(state.openedWorkspaces.keys())).toEqual(['workspace-b']);
    expect(state.error).toBeNull();
    expect(state.loading).toBe(false);
  });

  it('makes a concurrent initialize join the in-flight load instead of resolving early', async () => {
    let resolveStartup: ((snapshot: ReturnType<typeof startupSnapshot>) => void) | null = null;
    globalStateMocks.initializeWorkspaceStartupState.mockReturnValue(
      new Promise(resolve => {
        resolveStartup = resolve;
      }),
    );

    const manager = await getFreshWorkspaceManager();

    const first = manager.initialize();
    let joinedSettled = false;
    const joined = manager.initialize().then(() => {
      joinedSettled = true;
    });
    await flushAsyncWork();

    expect(globalStateMocks.initializeWorkspaceStartupState).toHaveBeenCalledTimes(1);
    expect(joinedSettled).toBe(false);

    resolveStartup?.(startupSnapshot(workspaceA));
    await Promise.all([first, joined]);

    expect(joinedSettled).toBe(true);
    expect(manager.getState().currentWorkspace?.id).toBe('workspace-a');
  });

  it('keeps a superseded load from reporting its failure onto the new surface', async () => {
    const startupOutcomes: Array<{
      resolve: (snapshot: ReturnType<typeof startupSnapshot>) => void;
      reject: (error: Error) => void;
    }> = [];
    globalStateMocks.initializeWorkspaceStartupState.mockImplementation(
      () => new Promise((resolve, reject) => {
        startupOutcomes.push({ resolve, reject });
      }),
    );

    const manager = await getFreshWorkspaceManager();

    const first = manager.reinitializeForPeerModeSwitch().then(
      () => null,
      (error: unknown) => error,
    );
    await flushAsyncWork();
    const second = manager.reinitializeForPeerModeSwitch().then(
      () => null,
      (error: unknown) => error,
    );
    await flushAsyncWork();

    startupOutcomes[1].resolve(startupSnapshot(workspaceB));
    await flushAsyncWork();
    startupOutcomes[0].reject(new Error('peer request timed out'));

    expect(isSurfaceChangedError(await first)).toBe(true);
    expect(await second).toBeNull();
    expect(manager.getState().error).toBeNull();
    expect(manager.getState().currentWorkspace?.id).toBe('workspace-b');
  });

  it('selects each device cached workspace state before its refresh completes', async () => {
    globalStateMocks.initializeWorkspaceStartupState
      .mockResolvedValueOnce(startupSnapshot(workspaceA))
      .mockResolvedValueOnce(startupSnapshot(workspaceB));
    const { manager, deviceSurface } = await getFreshWorkspaceHarness();

    await manager.initialize();
    expect(manager.getState().currentWorkspace?.id).toBe('workspace-a');

    deviceSurface.activateSurface('peer-b');
    expect(manager.getState().currentWorkspace).toBeNull();
    await manager.reinitializeForPeerModeSwitch();
    expect(manager.getState().currentWorkspace?.id).toBe('workspace-b');

    deviceSurface.activateSurface(deviceSurface.LOCAL_SURFACE_ID);
    expect(manager.getState().currentWorkspace?.id).toBe('workspace-a');
    deviceSurface.activateSurface('peer-b');
    expect(manager.getState().currentWorkspace?.id).toBe('workspace-b');
  });

  it('keeps a cached surface visible when its refresh fails', async () => {
    globalStateMocks.initializeWorkspaceStartupState.mockResolvedValue(
      startupSnapshot(workspaceA),
    );
    const manager = await getFreshWorkspaceManager();
    await manager.initialize();

    globalStateMocks.initializeWorkspaceStartupState.mockRejectedValue(
      new Error('relay unavailable'),
    );
    await expect(manager.reinitializeForPeerModeSwitch()).rejects.toThrow('relay unavailable');

    expect(manager.getState()).toMatchObject({
      currentWorkspace: workspaceA,
      loading: false,
      error: 'relay unavailable',
    });
  });

  it('keeps local identity events out of a rendered peer with equal workspace ids', async () => {
    const localWorkspace = {
      id: 'shared-workspace-id',
      name: 'Local repo',
      rootPath: '/repo',
      workspaceKind: 'normal',
      identity: null,
    };
    const peerWorkspace = {
      ...localWorkspace,
      name: 'Peer repo',
    };
    globalStateMocks.initializeWorkspaceStartupState
      .mockResolvedValueOnce(startupSnapshot(localWorkspace))
      .mockResolvedValueOnce(startupSnapshot(peerWorkspace));
    let identityHandler: ((event: { payload: {
      workspaceId: string;
      workspacePath: string;
      name: string;
      identity: { name: string };
      changedFields: string[];
    } }) => void) | null = null;
    listenMock.mockImplementation((eventName, handler) => {
      if (eventName === 'workspace-identity-changed') {
        identityHandler = handler;
      }
      return Promise.resolve(() => undefined);
    });
    const { manager, deviceSurface } = await getFreshWorkspaceHarness();

    await manager.initialize();
    deviceSurface.activateSurface('peer-b');
    await manager.reinitializeForPeerModeSwitch();

    identityHandler?.({
      payload: {
        workspaceId: 'shared-workspace-id',
        workspacePath: '/repo',
        name: 'Local repo renamed',
        identity: { name: 'Local repo renamed' },
        changedFields: ['name'],
      },
    });

    expect(manager.getState().currentWorkspace?.name).toBe('Peer repo');
    deviceSurface.activateSurface(deviceSurface.LOCAL_SURFACE_ID);
    expect(manager.getState().currentWorkspace?.name).toBe('Local repo renamed');
  });
});

describe('WorkspaceManager project rename', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureGlobalState();
  });

  it('updates current, opened, and recent workspace records together', async () => {
    const workspace = {
      id: 'project-1',
      name: 'Original project',
      rootPath: 'D:/workspace/project-1',
      workspaceKind: 'normal',
    };
    const renamedWorkspace = {
      ...workspace,
      name: 'Renamed project',
    };
    globalStateMocks.initializeWorkspaceStartupState.mockResolvedValue({
      cleanupRemovedCount: 0,
      recentWorkspaces: [workspace],
      openedWorkspaces: [workspace],
      currentWorkspace: workspace,
      legacyRemoteWorkspace: null,
    });
    globalStateMocks.updateWorkspaceInfo.mockResolvedValue(renamedWorkspace);
    listenMock.mockResolvedValue(() => undefined);

    const manager = await getFreshWorkspaceManager();
    await manager.initialize();

    await expect(manager.renameWorkspace('project-1', '  Renamed project  '))
      .resolves.toEqual(renamedWorkspace);

    expect(globalStateMocks.updateWorkspaceInfo).toHaveBeenCalledWith('project-1', {
      name: 'Renamed project',
    });
    const state = manager.getState();
    expect(state.currentWorkspace?.name).toBe('Renamed project');
    expect(state.openedWorkspaces.get('project-1')?.name).toBe('Renamed project');
    expect(state.recentWorkspaces[0]?.name).toBe('Renamed project');
  });
});

describe('WorkspaceManager host catalog hints', () => {
  const localWorkspace = {
    id: 'workspace-local',
    name: 'Local repo',
    rootPath: '/repo/local',
    workspaceKind: 'normal',
    identity: null,
  };
  const remoteOpenedWorkspace = {
    id: 'workspace-remote-opened',
    name: 'Opened from phone',
    rootPath: '/repo/phone',
    workspaceKind: 'normal',
    identity: null,
  };

  type CatalogHandler = (event: { payload: Record<string, unknown> }) => void;

  function captureCatalogHandler(): { current: () => CatalogHandler | null } {
    let handler: CatalogHandler | null = null;
    listenMock.mockImplementation((eventName, callback) => {
      if (eventName === 'workspace-catalog-changed') {
        handler = callback;
      }
      return Promise.resolve(() => undefined);
    });
    return { current: () => handler };
  }

  function snapshot(workspaces: Array<typeof localWorkspace>, current: typeof localWorkspace | null) {
    return {
      cleanupRemovedCount: 0,
      recentWorkspaces: workspaces,
      openedWorkspaces: workspaces,
      currentWorkspace: current,
      primaryAssistantWorkspaceId: null,
      legacyRemoteWorkspace: null,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    configureGlobalState();
  });

  it('subscribes to host catalog hints during startup', async () => {
    listenMock.mockResolvedValue(() => undefined);
    const manager = await getFreshWorkspaceManager();
    await manager.initialize();

    expect(listenMock).toHaveBeenCalledWith('workspace-catalog-changed', expect.any(Function));
  });

  it('shows a workspace another controller opened without stealing the active slot', async () => {
    globalStateMocks.initializeWorkspaceStartupState.mockResolvedValue(
      snapshot([localWorkspace], localWorkspace),
    );
    const handler = captureCatalogHandler();
    const manager = await getFreshWorkspaceManager();
    await manager.initialize();
    const events: string[] = [];
    manager.addEventListener(event => {
      events.push(event.type);
    });

    // The remote controller selected its workspace, so the host's current
    // workspace moved; this surface keeps what its user is looking at.
    globalStateMocks.getCurrentWorkspace.mockResolvedValue(remoteOpenedWorkspace);
    globalStateMocks.getRecentWorkspaces.mockResolvedValue([remoteOpenedWorkspace, localWorkspace]);
    globalStateMocks.getOpenedWorkspaces.mockResolvedValue([localWorkspace, remoteOpenedWorkspace]);

    handler.current()?.({ payload: { revision: 3 } });
    await flushAsyncWork();

    const state = manager.getState();
    expect(globalStateMocks.getOpenedWorkspaces).toHaveBeenCalledTimes(1);
    expect(Array.from(state.openedWorkspaces.keys())).toEqual([
      'workspace-local',
      'workspace-remote-opened',
    ]);
    expect(state.activeWorkspaceId).toBe('workspace-local');
    expect(state.currentWorkspace?.id).toBe('workspace-local');
    expect(state.recentWorkspaces.map(workspace => workspace.id)).toEqual([
      'workspace-remote-opened',
      'workspace-local',
    ]);
    expect(events).toEqual(['workspace:opened']);
  });

  it('adopts the host current workspace when this surface had no selection', async () => {
    globalStateMocks.initializeWorkspaceStartupState.mockResolvedValue(snapshot([], null));
    const handler = captureCatalogHandler();
    const manager = await getFreshWorkspaceManager();
    await manager.initialize();
    const events: string[] = [];
    manager.addEventListener(event => {
      events.push(event.type);
    });

    globalStateMocks.getCurrentWorkspace.mockResolvedValue(remoteOpenedWorkspace);
    globalStateMocks.getRecentWorkspaces.mockResolvedValue([remoteOpenedWorkspace]);
    globalStateMocks.getOpenedWorkspaces.mockResolvedValue([remoteOpenedWorkspace]);

    handler.current()?.({ payload: { revision: 1 } });
    await flushAsyncWork();

    expect(manager.getState().activeWorkspaceId).toBe('workspace-remote-opened');
    expect(events).toEqual(['workspace:opened', 'workspace:active-changed']);
  });

  it('retires a workspace the host closed and moves the selection with the host', async () => {
    globalStateMocks.initializeWorkspaceStartupState.mockResolvedValue(
      snapshot([localWorkspace, remoteOpenedWorkspace], remoteOpenedWorkspace),
    );
    const handler = captureCatalogHandler();
    const manager = await getFreshWorkspaceManager();
    await manager.initialize();
    const events: string[] = [];
    manager.addEventListener(event => {
      events.push(event.type);
    });

    globalStateMocks.getCurrentWorkspace.mockResolvedValue(localWorkspace);
    globalStateMocks.getRecentWorkspaces.mockResolvedValue([localWorkspace]);
    globalStateMocks.getOpenedWorkspaces.mockResolvedValue([localWorkspace]);

    handler.current()?.({ payload: { revision: 2 } });
    await flushAsyncWork();

    const state = manager.getState();
    expect(Array.from(state.openedWorkspaces.keys())).toEqual(['workspace-local']);
    expect(state.activeWorkspaceId).toBe('workspace-local');
    expect(events).toEqual(['workspace:closed', 'workspace:active-changed']);
  });

  it('coalesces hints that arrive while a re-read is running into one more re-read', async () => {
    globalStateMocks.initializeWorkspaceStartupState.mockResolvedValue(
      snapshot([localWorkspace], localWorkspace),
    );
    const handler = captureCatalogHandler();
    const manager = await getFreshWorkspaceManager();
    await manager.initialize();

    let releaseFirstRead: ((workspaces: Array<typeof localWorkspace>) => void) | null = null;
    globalStateMocks.getOpenedWorkspaces
      .mockImplementationOnce(() => new Promise(resolve => {
        releaseFirstRead = resolve;
      }))
      .mockResolvedValue([localWorkspace, remoteOpenedWorkspace]);
    globalStateMocks.getCurrentWorkspace.mockResolvedValue(localWorkspace);
    globalStateMocks.getRecentWorkspaces.mockResolvedValue([localWorkspace, remoteOpenedWorkspace]);

    handler.current()?.({ payload: { revision: 4 } });
    await flushAsyncWork();
    handler.current()?.({ payload: { revision: 5 } });
    handler.current()?.({ payload: { revision: 6 } });
    await flushAsyncWork();
    expect(globalStateMocks.getOpenedWorkspaces).toHaveBeenCalledTimes(1);

    releaseFirstRead?.([localWorkspace]);
    await flushAsyncWork();
    await flushAsyncWork();

    expect(globalStateMocks.getOpenedWorkspaces).toHaveBeenCalledTimes(2);
    expect(manager.getState().openedWorkspaces.has('workspace-remote-opened')).toBe(true);
  });

  it('re-reads after startup when a hint arrived while the bootstrap snapshot was in flight', async () => {
    let resolveStartup: ((snapshot: ReturnType<typeof snapshot>) => void) | null = null;
    globalStateMocks.initializeWorkspaceStartupState.mockImplementation(
      () => new Promise(resolve => {
        resolveStartup = resolve;
      }),
    );
    const handler = captureCatalogHandler();
    const manager = await getFreshWorkspaceManager();
    const initializePromise = manager.initialize();
    await flushAsyncWork();

    globalStateMocks.getCurrentWorkspace.mockResolvedValue(localWorkspace);
    globalStateMocks.getRecentWorkspaces.mockResolvedValue([localWorkspace, remoteOpenedWorkspace]);
    globalStateMocks.getOpenedWorkspaces.mockResolvedValue([localWorkspace, remoteOpenedWorkspace]);
    handler.current()?.({ payload: { revision: 9 } });
    expect(globalStateMocks.getOpenedWorkspaces).not.toHaveBeenCalled();

    resolveStartup?.(snapshot([localWorkspace], localWorkspace));
    await initializePromise;
    await flushAsyncWork();

    expect(globalStateMocks.getOpenedWorkspaces).toHaveBeenCalledTimes(1);
    expect(manager.getState().openedWorkspaces.has('workspace-remote-opened')).toBe(true);
  });

  it('ignores hints mirrored from a peer device while the local surface is rendered', async () => {
    globalStateMocks.initializeWorkspaceStartupState.mockResolvedValue(
      snapshot([localWorkspace], localWorkspace),
    );
    const handler = captureCatalogHandler();
    const manager = await getFreshWorkspaceManager();
    await manager.initialize();

    handler.current()?.({ payload: { revision: 2, __openbitfunSourceDeviceId: 'device-b' } });
    await flushAsyncWork();

    expect(globalStateMocks.getOpenedWorkspaces).not.toHaveBeenCalled();
    expect(manager.getState().openedWorkspaces.size).toBe(1);
  });
});
