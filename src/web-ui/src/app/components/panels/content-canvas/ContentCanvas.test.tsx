// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appManager } from '@/app/services/AppManager';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { useModernFlowChatStore } from '@/flow_chat/store/modernFlowChatStore';
import { flowChatManager } from '@/flow_chat/services/FlowChatManager';
import { buildBtwSessionPanelContent } from '@/flow_chat/services/btwSessionPane';
import type { Session } from '@/flow_chat/types/flow-chat';
import { ContentCanvas } from './ContentCanvas';
import { clearAgentCanvasForPeerSwitch, switchAgentCanvasScope, useAgentCanvasStore } from './stores';

const workspace = vi.hoisted(() => ({
  id: 'workspace', rootPath: '/workspace', workspaceKind: 'normal' as const,
}));

vi.mock('@/infrastructure/services/business/workspaceManager', () => ({
  workspaceManager: { getState: () => ({
    currentWorkspace: workspace,
    activeWorkspaceId: workspace.id,
    openedWorkspaces: new Map([[workspace.id, workspace]]),
  }) },
}));
vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({
  useCurrentWorkspace: () => ({ workspace }),
}));
vi.mock('@/flow_chat/services/FlowChatManager', () => ({
  flowChatManager: { switchChatSession: vi.fn() },
}));

// Exercise the real canvas effect, stores and session activation without mounting
// editors or shortcut handlers. These are state regressions, not visual checks.
vi.mock('./editor-area', () => ({ EditorArea: () => null }));
vi.mock('./anchor-zone', () => ({ AnchorZone: () => null }));
vi.mock('./mission-control', () => ({ MissionControl: () => null }));
vi.mock('./empty-state', () => ({ EmptyState: () => null }));
vi.mock('./hooks', () => ({
  useTabLifecycle: () => ({}),
  useKeyboardShortcuts: () => undefined,
}));

function session(sessionId: string): Session {
  return {
    sessionId, title: sessionId, status: 'idle', config: {}, dialogTurns: [],
    createdAt: 1, lastActiveAt: 1, error: null,
    workspaceId: workspace.id, workspacePath: workspace.rootPath, sessionKind: 'normal',
  };
}

function addBtwTab(parentSessionId: string, workspaceId = workspace.id): string {
  const canvas = useAgentCanvasStore.getState();
  canvas.addTab(buildBtwSessionPanelContent(`child-${parentSessionId}`, parentSessionId, {
    workspaceId, workspacePath: workspace.rootPath,
  }), 'active');
  return useAgentCanvasStore.getState().primaryGroup.activeTabId!;
}

describe('ContentCanvas session selection', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    clearAgentCanvasForPeerSwitch();
    switchAgentCanvasScope('session-a');
    flowChatStore.setState(state => ({
      ...state,
      sessions: new Map(['parent-a', 'parent-b'].map(id => [id, session(id)])),
      activeSessionId: 'parent-a',
    }));
    useModernFlowChatStore.getState().clear();
    vi.mocked(flowChatManager.switchChatSession).mockReset();
    vi.mocked(flowChatManager.switchChatSession).mockImplementation(async sessionId => {
      flowChatStore.setState(state => ({ ...state, activeSessionId: sessionId }));
    });
    appManager.updateLayout({ leftPanelActiveTab: 'files', leftPanelCollapsed: true });
    container = document.createElement('div');
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    clearAgentCanvasForPeerSwitch();
    flowChatStore.setState(state => ({ ...state, sessions: new Map(), activeSessionId: null }));
    useModernFlowChatStore.getState().clear();
    container.remove();
  });

  it.each([
    { parentSessionId: 'parent-a', collapsed: true },
    { parentSessionId: 'parent-b', collapsed: true },
    { parentSessionId: 'parent-a', collapsed: false },
  ])('preserves navigation when selecting $parentSessionId with collapsed=$collapsed', async ({ parentSessionId, collapsed }) => {
    const btwTabId = addBtwTab(parentSessionId);
    useAgentCanvasStore.getState().addTab({
      type: 'code-editor', title: 'file.ts', data: { filePath: '/workspace/file.ts' },
    }, 'active');
    const fileTabId = useAgentCanvasStore.getState().primaryGroup.activeTabId!;
    appManager.updateLayout({ leftPanelCollapsed: collapsed });
    const initialLayout = appManager.getState().layout;
    await act(async () => root.render(<ContentCanvas workspacePath={workspace.rootPath} />));

    await act(async () => useAgentCanvasStore.getState().switchToTab(btwTabId, 'primary'));

    expect(flowChatStore.getState().activeSessionId).toBe(parentSessionId);
    expect(useModernFlowChatStore.getState().activeSession?.sessionId).toBe(parentSessionId);
    expect(appManager.getState().layout).toEqual(initialLayout);

    // Returning through a regular file tab must not reset navigation either.
    await act(async () => useAgentCanvasStore.getState().switchToTab(fileTabId, 'primary'));
    await act(async () => useAgentCanvasStore.getState().switchToTab(btwTabId, 'primary'));
    expect(appManager.getState().layout).toEqual(initialLayout);
  });

  it('does not activate a restored tab when the canvas scope changes', async () => {
    addBtwTab('parent-b');
    switchAgentCanvasScope('session-b');
    await act(async () => root.render(<ContentCanvas workspacePath={workspace.rootPath} />));

    await act(async () => switchAgentCanvasScope('session-a'));

    expect(flowChatManager.switchChatSession).not.toHaveBeenCalled();
    expect(flowChatStore.getState().activeSessionId).toBe('parent-a');
    expect(appManager.getState().layout.leftPanelCollapsed).toBe(true);
  });

  it('does not activate a tab belonging to another workspace', async () => {
    await act(async () => root.render(<ContentCanvas workspacePath={workspace.rootPath} />));

    await act(async () => { addBtwTab('parent-b', 'other-workspace'); });

    expect(flowChatManager.switchChatSession).not.toHaveBeenCalled();
    expect(flowChatStore.getState().activeSessionId).toBe('parent-a');
    expect(appManager.getState().layout.leftPanelCollapsed).toBe(true);
  });
});
