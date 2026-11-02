import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkspaceStartupStateSnapshot } from '@/infrastructure/api/service-api/GlobalAPI';
import { createGlobalStateAPI, WorkspaceKind, WorkspaceType } from './global-state';

const globalApiMocks = vi.hoisted(() => ({
  initializeWorkspaceStartupState: vi.fn(),
}));

vi.mock('@/infrastructure/api', () => ({
  globalAPI: globalApiMocks,
  workspaceAPI: {},
}));

vi.mock('../utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

type BootstrapGlobals = typeof globalThis & {
  __OPENBITFUN_BOOTSTRAP_WORKSPACE_STARTUP_STATE__?: unknown;
};

const bootstrapGlobals = globalThis as BootstrapGlobals;

function createWorkspaceSnapshot(): WorkspaceStartupStateSnapshot {
  const workspace = {
    id: 'workspace-1',
    name: 'Workspace 1',
    rootPath: 'D:/workspace/project',
    workspaceType: 'singleProject',
    workspaceKind: 'normal',
    languages: ['TypeScript'],
    openedAt: '2026-06-18T00:00:00.000Z',
    lastAccessed: '2026-06-18T00:00:00.000Z',
    tags: [],
    relatedPaths: [{ path: 'D:/workspace/project/docs', description: null }],
  };

  return {
    cleanupRemovedCount: 1,
    currentWorkspace: workspace,
    recentWorkspaces: [workspace],
    openedWorkspaces: [workspace],
    legacyRemoteWorkspace: {
      connectionId: 'conn-1',
      connectionName: 'Remote',
      remotePath: '/repo',
      sshHost: 'devbox',
    },
  };
}

describe('createGlobalStateAPI workspace startup bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete bootstrapGlobals.__OPENBITFUN_BOOTSTRAP_WORKSPACE_STARTUP_STATE__;
  });

  it('maps the complete assistant catalog without marking closed assistants opened', async () => {
    const snapshot = createWorkspaceSnapshot();
    snapshot.assistantWorkspaces = [{
      ...snapshot.openedWorkspaces[0], id: 'closed-assistant', workspaceKind: 'assistant',
      identity: { name: 'Mira', emoji: null },
    }];
    bootstrapGlobals.__OPENBITFUN_BOOTSTRAP_WORKSPACE_STARTUP_STATE__ = snapshot;
    const state = await createGlobalStateAPI().initializeWorkspaceStartupState();
    expect(state.assistantWorkspaces?.[0].workspaceKind).toBe(WorkspaceKind.Assistant);
    expect(state.assistantWorkspaces?.[0].identity).toMatchObject({ name: 'Mira', emoji: undefined });
    expect(state.openedWorkspaces.map(workspace => workspace.id)).toEqual(['workspace-1']);
  });

  it('accepts old snapshots without the optional assistant catalog', async () => {
    bootstrapGlobals.__OPENBITFUN_BOOTSTRAP_WORKSPACE_STARTUP_STATE__ = createWorkspaceSnapshot();
    const state = await createGlobalStateAPI().initializeWorkspaceStartupState();
    expect(state.assistantWorkspaces).toBeUndefined();
    expect(state.openedWorkspaces).toHaveLength(1);
  });

  it('uses the injected startup workspace snapshot once without a startup IPC', async () => {
    bootstrapGlobals.__OPENBITFUN_BOOTSTRAP_WORKSPACE_STARTUP_STATE__ = createWorkspaceSnapshot();
    globalApiMocks.initializeWorkspaceStartupState.mockResolvedValue({
      cleanupRemovedCount: 0,
      currentWorkspace: null,
      recentWorkspaces: [],
      openedWorkspaces: [],
      legacyRemoteWorkspace: null,
    });

    const api = createGlobalStateAPI();
    const state = await api.initializeWorkspaceStartupState();

    expect(globalApiMocks.initializeWorkspaceStartupState).not.toHaveBeenCalled();
    expect(state.cleanupRemovedCount).toBe(1);
    expect(state.currentWorkspace?.workspaceType).toBe(WorkspaceType.SingleProject);
    expect(state.currentWorkspace?.workspaceKind).toBe(WorkspaceKind.Normal);
    expect(state.currentWorkspace?.sshHost).toBe('localhost');
    expect(state.currentWorkspace?.relatedPaths).toEqual([
      { path: 'D:/workspace/project/docs', description: undefined },
    ]);
    expect(state.legacyRemoteWorkspace).toEqual({
      connectionId: 'conn-1',
      connectionName: 'Remote',
      remotePath: '/repo',
      sshHost: 'devbox',
    });
    expect(
      Object.prototype.hasOwnProperty.call(
        bootstrapGlobals,
        '__OPENBITFUN_BOOTSTRAP_WORKSPACE_STARTUP_STATE__'
      )
    ).toBe(false);

    await api.initializeWorkspaceStartupState();
    expect(globalApiMocks.initializeWorkspaceStartupState).toHaveBeenCalledTimes(1);
  });

  it('keeps MiniApp-owned workspaces out of the recent list', async () => {
    const snapshot = createWorkspaceSnapshot();
    const miniAppWorkspace = {
      ...snapshot.recentWorkspaces[0],
      id: 'workspace-miniapp',
      name: 'deck-1785130332234-eilik4',
      rootPath:
        '/Users/me/Library/Application Support/openbitfun/data/miniapps/builtin-ppt-live/decks/deck-1785130332234-eilik4',
    };
    snapshot.recentWorkspaces = [...snapshot.recentWorkspaces, miniAppWorkspace];
    bootstrapGlobals.__OPENBITFUN_BOOTSTRAP_WORKSPACE_STARTUP_STATE__ = snapshot;

    const api = createGlobalStateAPI();
    const state = await api.initializeWorkspaceStartupState();

    expect(state.recentWorkspaces.map(workspace => workspace.id)).toEqual(['workspace-1']);
  });

  it('falls back to the startup command when the bootstrap snapshot is invalid', async () => {
    bootstrapGlobals.__OPENBITFUN_BOOTSTRAP_WORKSPACE_STARTUP_STATE__ = { recentWorkspaces: [] };
    globalApiMocks.initializeWorkspaceStartupState.mockResolvedValue(createWorkspaceSnapshot());

    const api = createGlobalStateAPI();
    const state = await api.initializeWorkspaceStartupState();

    expect(globalApiMocks.initializeWorkspaceStartupState).toHaveBeenCalledTimes(1);
    expect(state.currentWorkspace?.id).toBe('workspace-1');
    expect(
      Object.prototype.hasOwnProperty.call(
        bootstrapGlobals,
        '__OPENBITFUN_BOOTSTRAP_WORKSPACE_STARTUP_STATE__'
      )
    ).toBe(false);
  });
});
