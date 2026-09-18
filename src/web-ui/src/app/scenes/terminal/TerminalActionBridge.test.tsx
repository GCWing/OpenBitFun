// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceContext, type WorkspaceContextValue } from '@/infrastructure/contexts/WorkspaceContext';
import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import type { WorkspaceInfo } from '@/shared/types';
import { useNavSceneStore } from '@/app/stores/navSceneStore';
import { TerminalActionBridge } from './TerminalActionBridge';

const terminal = vi.hoisted(() => ({ create: vi.fn(), open: vi.fn() }));
vi.mock('@/shared/services/createManualTerminalSession', () => ({ createManualTerminalSession: terminal.create }));
vi.mock('@/shared/services/openShellSessionTarget', () => ({ openShellSessionTarget: terminal.open }));

describe('terminal creation from workspace resources', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); useNavSceneStore.getState().closeNavScene(); });

  it.each(['unchanged', 'resource-navigation', 'active-workspace'] as const)(
    'creates in the browsed SSH workspace while another workspace is active (change: %s)', async change => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const active = { id: 'a', rootPath: 'D:/active', name: 'A', workspaceKind: 'project' } as WorkspaceInfo;
    const browsed = { id: 'b', rootPath: '/repo', name: 'B', workspaceKind: 'remote', connectionId: 'ssh-b' } as WorkspaceInfo;
    const state = { ...workspaceManager.getState(), currentWorkspace: active,
      activeWorkspaceId: active.id, openedWorkspaces: new Map([[active.id, active], [browsed.id, browsed]]) };
    vi.spyOn(workspaceManager, 'getState').mockReturnValue(state);
    const activate = vi.spyOn(workspaceManager, 'setActiveWorkspace');
    const scope = { surfaceId: 'local', workspaceId: browsed.id, workspacePath: browsed.rootPath, remoteConnectionId: browsed.connectionId };
    let complete!: (session: { id: string; name: string }) => void;
    terminal.create.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const container = document.createElement('div');
    const root = createRoot(container);
    useNavSceneStore.getState().openWorkspaceResources(browsed.id);
    try {
      await act(async () => root.render(
        <WorkspaceContext.Provider value={{ ...state, activeWorkspace: active, workspacePath: active.rootPath } as WorkspaceContextValue}>
          <TerminalActionBridge />
        </WorkspaceContext.Provider>,
      ));
      await act(async () => {
        window.dispatchEvent(new CustomEvent('terminal-create-requested', { detail: {
          workingDirectory: '/repo/src', workspacePath: '/repo', surfaceId: 'local', resourceScope: scope,
        } }));
      });
      // The terminal is owned by the browsed workspace ID; the cwd is only the IO operand.
      expect(terminal.create).toHaveBeenCalledExactlyOnceWith({ workspaceId: browsed.id, workspacePath: '/repo/src' });
      if (change === 'resource-navigation') useNavSceneStore.getState().openWorkspaceResources(active.id);
      if (change === 'active-workspace') {
        const other = { ...active, id: 'c', rootPath: 'D:/other' };
        await act(async () => root.render(
          <WorkspaceContext.Provider value={{ ...state, currentWorkspace: other, activeWorkspace: other, workspacePath: other.rootPath } as WorkspaceContextValue}>
            <TerminalActionBridge />
          </WorkspaceContext.Provider>,
        ));
      }
      await act(async () => { complete({ id: 'terminal-b', name: 'Shell B' }); });
      if (change === 'resource-navigation') expect(terminal.open).not.toHaveBeenCalled();
      else expect(terminal.open).toHaveBeenCalledExactlyOnceWith({ sessionId: 'terminal-b', sessionName: 'Shell B', scope });
      expect(activate).not.toHaveBeenCalled();
      expect(state.currentWorkspace).toBe(active);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
