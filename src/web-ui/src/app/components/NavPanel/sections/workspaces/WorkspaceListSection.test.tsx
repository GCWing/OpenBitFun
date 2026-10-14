// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ grouping: 'all', workspaces: [
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
  }),
}));
vi.mock('../../workspaceSessionView', () => ({
  useWorkspaceSessionViewStore: (selector: (value: typeof state) => unknown) => selector(state),
}));
vi.mock('./WorkspaceItem', () => ({
  default: ({ workspace }: { workspace: { id: string } }) => <div data-owner-row={workspace.id} />,
}));
vi.mock('../sessions/SessionsSection', () => ({
  default: ({ workspaceScopes }: { workspaceScopes: { workspaceId: string }[] }) => (
    <div data-session-scopes={workspaceScopes.map(scope => scope.workspaceId).join(',')} />
  ),
}));

import WorkspaceListSection from './WorkspaceListSection';

afterEach(() => { state.grouping = 'all'; });

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
