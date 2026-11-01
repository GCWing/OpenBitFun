// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSessionSceneTabId, type SceneTab, type SceneTabId } from '@/app/components/SceneBar/types';
import { sessionSceneWorkspaceKey } from '@/app/services/sessionSceneTarget';
import { useContentResourceStore } from '@/app/workbench/contentResourceStore';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';

const state = vi.hoisted(() => {
  const assistant = { id: 'assistant', name: 'Assistant', workspaceKind: 'assistant' };
  const project = { id: 'project', name: 'Project', workspaceKind: 'normal' };
  return {
    grouping: 'all',
    collapseAllRequestId: 0,
    activeWorkspaceId: null as string | null,
    workspaces: [assistant, project],
    defaultWorkspaces: [assistant, project],
  };
});
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
  default: ({ workspace, isActive, isSelected, draggable, sessionsCollapsed, onSessionsCollapsedChange }: {
    workspace: { id: string };
    isActive: boolean;
    isSelected: boolean;
    draggable?: boolean;
    sessionsCollapsed?: boolean;
    onSessionsCollapsedChange?: (collapsed: boolean) => void;
  }) => (
    <div
      data-owner-row={workspace.id}
      data-context-active={isActive}
      data-selected={isSelected}
      data-row-draggable={draggable ? 'true' : 'false'}
      data-collapsed={sessionsCollapsed}
    >
      {onSessionsCollapsedChange && (
        <button data-disclosure={workspace.id} onClick={() => onSessionsCollapsedChange(!sessionsCollapsed)}>Toggle</button>
      )}
    </div>
  ),
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
  state.collapseAllRequestId = 0;
  state.activeWorkspaceId = null;
  state.workspaces = [...state.defaultWorkspaces];
  useSceneStore.setState({ activeTabId: null, openTabs: [] });
  useContentResourceStore.setState({ resources: {} });
  activateSurface('local');
});

function renderList() {
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(<WorkspaceListSection variant="all" />));
  return {
    container,
    ownerRows: () => Array.from(container.querySelectorAll('[data-owner-row]'))
      .map(row => row.getAttribute('data-owner-row')),
    unmount: () => act(() => root.unmount()),
  };
}

describe('assistant pinning', () => {
  it('pins the assistant above the project workspaces regardless of the stored order', () => {
    state.grouping = 'grouped';
    // The persisted workspace order lists the project first.
    state.workspaces = [...state.defaultWorkspaces].reverse();

    const list = renderList();
    try {
      expect(list.ownerRows()).toEqual(['assistant', 'project']);
      const pinnedRow = list.container.querySelector('[data-session-group-pinned="true"]');
      expect(pinnedRow?.getAttribute('data-workspace-id')).toBe('assistant');
      expect(pinnedRow?.getAttribute('data-session-group-kind')).toBe('assistant');
      expect(pinnedRow?.querySelector('[data-owner-row="assistant"]')).not.toBeNull();
    } finally {
      list.unmount();
    }
  });

  it('keeps the pinned assistant out of the project drag order', () => {
    state.grouping = 'grouped';
    state.workspaces = [
      { id: 'assistant', name: 'Assistant', workspaceKind: 'assistant' },
      { id: 'first-project', name: 'First', workspaceKind: 'normal' },
      { id: 'second-project', name: 'Second', workspaceKind: 'normal' },
    ];

    const list = renderList();
    try {
      expect(list.ownerRows()).toEqual(['assistant', 'first-project', 'second-project']);
      const draggable = (id: string) => list.container
        .querySelector(`[data-owner-row="${id}"]`)?.getAttribute('data-row-draggable');
      expect(draggable('assistant')).toBe('false');
      expect(draggable('first-project')).toBe('true');
      expect(draggable('second-project')).toBe('true');
    } finally {
      list.unmount();
    }
  });

  it('keeps the pin above the flat session list without rendering project rows', () => {
    state.grouping = 'all';

    const list = renderList();
    try {
      expect(list.ownerRows()).toEqual(['assistant']);
      expect(list.container.querySelector('[data-session-group-pinned="true"]')
        ?.getAttribute('data-workspace-id')).toBe('assistant');
      expect(list.container.querySelector('[data-session-scopes]')?.getAttribute('data-session-scopes'))
        .toBe('project');
    } finally {
      list.unmount();
    }
  });

  it('renders no pin when the assistant is not created or has been hidden', () => {
    state.grouping = 'grouped';
    // A hidden assistant is not an opened workspace, so it must not leave an
    // empty pinned slot behind.
    state.workspaces = state.defaultWorkspaces.filter(workspace => workspace.workspaceKind !== 'assistant');

    const list = renderList();
    try {
      expect(list.ownerRows()).toEqual(['project']);
      expect(list.container.querySelector('[data-session-group-pinned="true"]')).toBeNull();
      expect(list.container.querySelector('[data-testid="nav-workspace-list-empty"]')).toBeNull();
    } finally {
      list.unmount();
    }
  });

  it('leaves the flat session list in place when no assistant is open', () => {
    state.grouping = 'all';
    state.workspaces = state.defaultWorkspaces.filter(workspace => workspace.workspaceKind !== 'assistant');

    const list = renderList();
    try {
      expect(list.ownerRows()).toEqual([]);
      expect(list.container.querySelector('[data-session-group-pinned="true"]')).toBeNull();
      expect(list.container.querySelector('[data-testid="nav-workspace-list-empty"]')).toBeNull();
      expect(list.container.querySelector('[data-session-scopes]')?.getAttribute('data-session-scopes'))
        .toBe('project');
    } finally {
      list.unmount();
    }
  });

  it('keeps the empty state when no session group is open', () => {
    state.grouping = 'grouped';
    state.workspaces = [];

    const list = renderList();
    try {
      expect(list.ownerRows()).toEqual([]);
      expect(list.container.querySelector('[data-testid="nav-workspace-list-empty"]')).not.toBeNull();
    } finally {
      list.unmount();
    }
  });
});

describe('project disclosure across view changes', () => {
  it('retains folded projects and reopened projects after Collapse All', () => {
    state.grouping = 'grouped';
    const container = document.createElement('div');
    const root = createRoot(container);
    const render = () => act(() => root.render(<WorkspaceListSection variant="all" />));
    const toggle = () => act(() => container.querySelector<HTMLButtonElement>('[data-disclosure="project"]')!.click());
    const collapsed = () => container.querySelector('[data-owner-row="project"]')?.getAttribute('data-collapsed');
    try {
      render();
      toggle();
      expect(collapsed()).toBe('true');
      state.grouping = 'all';
      render();
      state.grouping = 'grouped';
      render();
      expect(collapsed()).toBe('true');

      state.collapseAllRequestId = 1;
      render();
      toggle();
      expect(collapsed()).toBe('false');
      state.grouping = 'all';
      render();
      state.grouping = 'grouped';
      render();
      expect(collapsed()).toBe('false');

      state.grouping = 'all';
      state.collapseAllRequestId = 2;
      render();
      state.grouping = 'grouped';
      render();
      expect(collapsed()).toBe('true');
    } finally {
      act(() => root.unmount());
    }
  });

  it('keeps identically named local and peer workspaces independently folded', () => {
    state.grouping = 'grouped';
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      act(() => root.render(<WorkspaceListSection variant="all" />));
      act(() => container.querySelector<HTMLButtonElement>('[data-disclosure="project"]')!.click());
      expect(container.querySelector('[data-owner-row="project"]')?.getAttribute('data-collapsed')).toBe('true');
      act(() => activateSurface('peer:host-b'));
      expect(container.querySelector('[data-owner-row="project"]')?.getAttribute('data-collapsed')).toBe('false');
      act(() => activateSurface('local'));
      expect(container.querySelector('[data-owner-row="project"]')?.getAttribute('data-collapsed')).toBe('true');
    } finally {
      act(() => root.unmount());
    }
  });
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
