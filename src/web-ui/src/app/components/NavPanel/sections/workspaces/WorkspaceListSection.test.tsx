// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSessionSceneTabId, type SceneTab, type SceneTabId } from '@/app/components/SceneBar/types';
import { sessionSceneWorkspaceKey } from '@/app/services/sessionSceneTarget';
import { useContentResourceStore } from '@/app/workbench/contentResourceStore';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';

const state = vi.hoisted(() => ({ grouping: 'all', activeWorkspaceId: null as string | null, workspaces: [
  { id: 'assistant', name: 'Assistant', workspaceKind: 'assistant' },
  { id: 'project', name: 'Project', workspaceKind: 'normal' },
] }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/shared/notification-system', () => ({ notificationService: { error: vi.fn() } }));
vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({
  useWorkspaceContext: () => ({
    openedWorkspacesList: state.workspaces,
    normalWorkspacesList: state.workspaces.filter(workspace => workspace.workspaceKind === 'normal'),
    assistantWorkspacesList: state.workspaces.filter(workspace => workspace.workspaceKind === 'assistant'),
    activeWorkspaceId: state.activeWorkspaceId,
  }),
}));
vi.mock('@/app/stores/sceneStore', async () => {
  const { create } = await import('zustand');
  return { useSceneStore: create(() => ({ activeTabId: null as SceneTabId | null, openTabs: [] as SceneTab[] })) };
});
vi.mock('../../workspaceSessionView', () => ({
  useWorkspaceSessionViewStore: (selector: (value: typeof state) => unknown) => selector(state),
}));
vi.mock('./WorkspaceItem', () => ({
  default: ({ workspace, isActive, isSelected }: {
    workspace: { id: string };
    isActive: boolean;
    isSelected: boolean;
  }) => <div data-owner-row={workspace.id} data-context-active={isActive} data-selected={isSelected} />,
}));
vi.mock('../sessions/SessionsSection', () => ({
  default: ({ workspaceScopes }: { workspaceScopes: { workspaceId: string }[] }) => (
    <div data-session-scopes={workspaceScopes.map(scope => scope.workspaceId).join(',')} />
  ),
}));

import WorkspaceListSection from './WorkspaceListSection';
import { useSceneStore } from '@/app/stores/sceneStore';

function sessionTab(workspaceId: string, surfaceId = 'local'): SceneTab {
  const session = { surfaceId, workspaceKey: sessionSceneWorkspaceKey(workspaceId), sessionId: `chat-${workspaceId}` };
  return { id: getSessionSceneTabId(session), session, lastUsed: 1 };
}

afterEach(() => {
  state.grouping = 'all';
  state.activeWorkspaceId = null;
  useSceneStore.setState({ activeTabId: null, openTabs: [] });
  useContentResourceStore.setState({ resources: {} });
  activateSurface('local');
});

describe('assistant navigation across grouping modes', () => {
  it.each(['all', 'grouped'])('keeps the assistant entry and excludes its sessions from the %s list', grouping => {
    state.grouping = grouping;
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      act(() => root.render(<WorkspaceListSection variant="all" />));
      expect(container.querySelector('[data-owner-row="assistant"]')).not.toBeNull();
      if (grouping === 'all') {
        expect(container.querySelector('[data-session-scopes]')?.getAttribute('data-session-scopes')).toBe('project');
        expect(container.querySelector('[data-owner-row="project"]')).toBeNull();
      } else {
        expect(container.querySelector('[data-owner-row="project"]')).not.toBeNull();
        expect(container.querySelector('[data-session-scopes]')).toBeNull();
      }
    } finally {
      act(() => root.unmount());
    }
  });
});

describe('workspace navigation selection', () => {
  it.each(['project', 'assistant'])('clears the %s highlight on the tabless surface while retaining its workspace context', workspaceId => {
    state.grouping = 'grouped';
    state.activeWorkspaceId = workspaceId;
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      act(() => root.render(<WorkspaceListSection variant="all" />));
      const row = container.querySelector(`[data-owner-row="${workspaceId}"]`)!;
      const group = row.closest('[data-openbitfun-part="item"]')!;

      // A restored workspace alone must not select a row on startup.
      expect(row.getAttribute('data-context-active')).toBe('true');
      expect(container.querySelector('[data-selected="true"]')).toBeNull();
      expect(group.hasAttribute('data-openbitfun-state')).toBe(false);

      const tab = sessionTab(workspaceId);
      act(() => useSceneStore.setState({ activeTabId: tab.id, openTabs: [tab] }));
      expect(row.getAttribute('data-selected')).toBe('true');
      expect(group.getAttribute('data-openbitfun-state')).toBe('selected');
      expect(container.querySelectorAll('[data-selected="true"]')).toHaveLength(1);

      act(() => useSceneStore.setState({ activeTabId: null, openTabs: [] }));
      expect(container.querySelector('[data-selected="true"]')).toBeNull();
      expect(group.hasAttribute('data-openbitfun-state')).toBe(false);
      expect(row.getAttribute('data-context-active')).toBe('true');
      expect(state.activeWorkspaceId).toBe(workspaceId);
    } finally {
      act(() => root.unmount());
    }
  });

  it.each(['project', 'assistant'])('clears the %s selection on Home and restores it when returning to its session', workspaceId => {
    state.grouping = 'grouped';
    state.activeWorkspaceId = workspaceId;
    const tab = sessionTab(workspaceId);
    const home: SceneTab = { id: 'personal-overview', lastUsed: 2 };
    useSceneStore.setState({ activeTabId: tab.id, openTabs: [tab, home] });
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      act(() => root.render(<WorkspaceListSection variant="all" />));
      const row = container.querySelector(`[data-owner-row="${workspaceId}"]`)!;
      expect(row.getAttribute('data-selected')).toBe('true');

      // The session remains open in the background while Home is visible.
      act(() => useSceneStore.setState({ activeTabId: home.id }));
      expect(container.querySelector('[data-selected="true"]')).toBeNull();
      expect(container.querySelector('[data-openbitfun-state="selected"]')).toBeNull();
      expect(row.getAttribute('data-context-active')).toBe('true');

      act(() => useSceneStore.setState({ activeTabId: tab.id }));
      expect(row.getAttribute('data-selected')).toBe('true');
    } finally {
      act(() => root.unmount());
    }
  });

  it('selects the displayed file owner instead of the retained runtime workspace', () => {
    state.grouping = 'grouped';
    state.activeWorkspaceId = 'assistant';
    const contentId = useContentResourceStore.getState().open(
      { type: 'code-editor', title: 'file.ts', data: { filePath: '/project/file.ts' } },
      { surfaceId: 'local', workspaceId: 'project', workspacePath: '/project' },
    );
    const tab: SceneTab = { id: `content:${contentId}`, contentId, lastUsed: 1 };
    useSceneStore.setState({ activeTabId: tab.id, openTabs: [tab] });
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      act(() => root.render(<WorkspaceListSection variant="all" />));
      expect(container.querySelector('[data-selected="true"]')?.getAttribute('data-owner-row')).toBe('project');
      expect(container.querySelector('[data-context-active="true"]')?.getAttribute('data-owner-row')).toBe('assistant');

      act(() => useContentResourceStore.getState().remove(contentId));
      expect(container.querySelector('[data-selected="true"]')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it('does not carry session selection across device surfaces with identical workspace IDs', () => {
    state.grouping = 'grouped';
    state.activeWorkspaceId = 'project';
    const localTab = sessionTab('project');
    useSceneStore.setState({ activeTabId: localTab.id, openTabs: [localTab] });
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      act(() => root.render(<WorkspaceListSection variant="all" />));
      expect(container.querySelector('[data-selected="true"]')).not.toBeNull();

      act(() => { activateSurface('peer:host-b'); });
      expect(container.querySelector('[data-selected="true"]')).toBeNull();

      const peerTab = sessionTab('project', 'peer:host-b');
      act(() => useSceneStore.setState({ activeTabId: peerTab.id, openTabs: [peerTab] }));
      expect(container.querySelector('[data-selected="true"]')?.getAttribute('data-owner-row')).toBe('project');
    } finally {
      act(() => root.unmount());
    }
  });
});
