import { describe, expect, it } from 'vitest';
import type { SceneTabId } from '../SceneBar/types';
import { sessionSceneWorkspaceKey } from '@/app/services/sessionSceneTarget';
import {
  WorkspaceKind,
  WorkspaceType,
  type WorkspaceInfo,
} from '@/shared/types';
import {
  isWorkspaceBackedSessionGroupActive,
  isWorkspaceBackedSessionGroupSelected,
  projectWorkspaceBackedSessionGroups,
} from './sessionNavigationProjection';

const createWorkspace = (
  id: string,
  workspaceKind: WorkspaceKind,
  overrides: Partial<WorkspaceInfo> = {},
): WorkspaceInfo => ({
  id,
  name: id,
  rootPath: `/owners/${id}`,
  workspaceType: WorkspaceType.SingleProject,
  workspaceKind,
  languages: [],
  openedAt: '2026-08-16T00:00:00.000Z',
  lastAccessed: '2026-08-16T00:00:00.000Z',
  tags: [],
  ...overrides,
});

describe('isWorkspaceBackedSessionGroupSelected', () => {
  const workspace = createWorkspace('project', WorkspaceKind.Normal);
  const context = { surfaceId: 'local', activeWorkspaceId: workspace.id, contentScope: undefined };

  it.each<SceneTabId>([
    'personal-overview', 'settings', 'profile', 'agents', 'skills', 'assistant',
    'todos', 'miniapps', 'miniapp:sample', 'browser', 'pages', 'insights',
    'ecosystem-compatibility', 'shell', 'terminal',
  ])('does not select the retained workspace on the global %s page', id => {
    expect(isWorkspaceBackedSessionGroupSelected(workspace, {
      ...context, activeTab: { id, lastUsed: 1 },
    })).toBe(false);
  });

  it('requires an owning session reference rather than the runtime workspace', () => {
    expect(isWorkspaceBackedSessionGroupSelected(workspace, {
      ...context, activeTab: { id: 'session:missing', lastUsed: 1 },
    })).toBe(false);
    const session = { surfaceId: 'local', workspaceKey: sessionSceneWorkspaceKey(workspace.id), sessionId: 'chat' };
    expect(isWorkspaceBackedSessionGroupSelected(workspace, {
      ...context, activeWorkspaceId: 'another-project',
      activeTab: { id: 'session:project', session, lastUsed: 1 },
    })).toBe(true);
    expect(isWorkspaceBackedSessionGroupSelected(workspace, {
      ...context,
      activeTab: { id: 'session:unresolved', session: {
        ...session, workspaceKey: JSON.stringify(['unresolved-workspace', 'chat']),
      }, lastUsed: 1 },
    })).toBe(false);
  });

  it('uses content workspace identity without guessing from paths or other devices', () => {
    const first = createWorkspace('remote-first', WorkspaceKind.Remote, {
      rootPath: '/workspace', connectionId: 'ssh-first',
    });
    const second = createWorkspace('remote-second', WorkspaceKind.Remote, {
      rootPath: '/workspace', connectionId: 'ssh-second',
    });
    const selection = {
      ...context,
      activeTab: { id: 'content:file' as const, contentId: 'file', lastUsed: 1 },
      contentScope: { surfaceId: 'local', workspaceId: first.id, workspacePath: '/workspace' },
    };
    expect(isWorkspaceBackedSessionGroupSelected(first, selection)).toBe(true);
    expect(isWorkspaceBackedSessionGroupSelected(second, selection)).toBe(false);
    expect(isWorkspaceBackedSessionGroupSelected(first, { ...selection, surfaceId: 'peer:host-b' })).toBe(false);
    expect(isWorkspaceBackedSessionGroupSelected(first, {
      ...selection, contentScope: { surfaceId: 'local', workspacePath: '/workspace' },
    })).toBe(false);
  });

  it('keeps Git selection tied to the workspace it renders', () => {
    const activeTab = { id: 'git' as const, lastUsed: 1 };
    expect(isWorkspaceBackedSessionGroupSelected(workspace, { ...context, activeTab })).toBe(true);
    expect(isWorkspaceBackedSessionGroupSelected(workspace, {
      ...context, activeTab, activeWorkspaceId: 'another-project',
    })).toBe(false);
  });
});

describe('projectWorkspaceBackedSessionGroups', () => {
  const project = createWorkspace('local-project', WorkspaceKind.Normal);
  const assistant = createWorkspace('personal-assistant', WorkspaceKind.Assistant);
  const remoteProject = createWorkspace('remote-project', WorkspaceKind.Remote, {
    connectionId: 'ssh-1',
    sshHost: 'example-host',
  });

  it('projects projects and assistants as peer groups in canonical open order', () => {
    const groups = projectWorkspaceBackedSessionGroups(
      [project, assistant, remoteProject],
      'all',
    );

    expect(groups.map(group => ({
      groupId: group.groupId,
      kind: group.kind,
      ownerId: group.workspace.id,
    }))).toEqual([
      { groupId: 'workspace:local-project', kind: 'project', ownerId: 'local-project' },
      { groupId: 'workspace:personal-assistant', kind: 'assistant', ownerId: 'personal-assistant' },
      { groupId: 'workspace:remote-project', kind: 'project', ownerId: 'remote-project' },
    ]);
  });

  it('treats runtime location as project metadata rather than a separate group kind', () => {
    const groups = projectWorkspaceBackedSessionGroups(
      [project, assistant, remoteProject],
      'projects',
    );

    expect(groups.map(group => [group.workspace.id, group.kind])).toEqual([
      ['local-project', 'project'],
      ['remote-project', 'project'],
    ]);
    expect(projectWorkspaceBackedSessionGroups(
      [project, assistant, remoteProject],
      'assistants',
    ).map(group => group.workspace.id)).toEqual(['personal-assistant']);
  });

  it('keeps the canonical project and linked worktrees as separate groups in open order', () => {
    const canonicalProject = createWorkspace('canonical-project', WorkspaceKind.Normal, {
      rootPath: '/repo',
    });
    const firstWorktree = createWorkspace('first-worktree', WorkspaceKind.Normal, {
      rootPath: '/repo/.worktrees/first',
      worktree: {
        path: '/repo/.worktrees/first',
        mainRepoPath: '/repo',
        branch: 'first',
        isMain: false,
      },
    });
    const secondWorktree = createWorkspace('second-worktree', WorkspaceKind.Normal, {
      rootPath: '/repo/.worktrees/second',
      worktree: {
        path: '/repo/.worktrees/second',
        mainRepoPath: '/repo',
        branch: 'second',
        isMain: false,
      },
    });

    const openedWorkspaces = [canonicalProject, firstWorktree, secondWorktree];
    const expectedIds = ['canonical-project', 'first-worktree', 'second-worktree'];

    expect(projectWorkspaceBackedSessionGroups(
      openedWorkspaces,
      'all',
    ).map(group => group.workspace.id)).toEqual(expectedIds);
    expect(projectWorkspaceBackedSessionGroups(
      openedWorkspaces,
      'projects',
    ).map(group => group.workspace.id)).toEqual(expectedIds);
  });
});

describe('isWorkspaceBackedSessionGroupActive', () => {
  it('distinguishes identical paths opened through different remote connections', () => {
    const firstRemote = createWorkspace('remote-first', WorkspaceKind.Remote, {
      rootPath: '/workspace',
      connectionId: 'ssh-first',
      sshHost: 'host-a.example',
    });
    const secondRemote = createWorkspace('remote-second', WorkspaceKind.Remote, {
      rootPath: '/workspace',
      connectionId: 'ssh-second',
      sshHost: 'host-b.example',
    });

    expect(isWorkspaceBackedSessionGroupActive(firstRemote, firstRemote)).toBe(true);
    expect(isWorkspaceBackedSessionGroupActive(secondRemote, firstRemote)).toBe(false);
  });

  it('does not select another local workspace with the same path', () => {
    const first = createWorkspace('local-first', WorkspaceKind.Normal, { rootPath: '/same' });
    const second = createWorkspace('local-second', WorkspaceKind.Normal, { rootPath: '/same' });
    expect(isWorkspaceBackedSessionGroupActive(first, second)).toBe(false);
  });

  it('marks only the selected worktree workspace as active', () => {
    const canonicalProject = createWorkspace('canonical-project', WorkspaceKind.Normal, {
      rootPath: '/repo',
    });
    const selectedWorktree = createWorkspace('selected-worktree', WorkspaceKind.Normal, {
      rootPath: '/repo/.worktrees/selected',
      worktree: {
        path: '/repo/.worktrees/selected',
        mainRepoPath: '/repo',
        branch: 'selected',
        isMain: false,
      },
    });
    const siblingWorktree = createWorkspace('sibling-worktree', WorkspaceKind.Normal, {
      rootPath: '/repo/.worktrees/sibling',
      worktree: {
        path: '/repo/.worktrees/sibling',
        mainRepoPath: '/repo',
        branch: 'sibling',
        isMain: false,
      },
    });

    expect(isWorkspaceBackedSessionGroupActive(selectedWorktree, selectedWorktree)).toBe(true);
    expect(isWorkspaceBackedSessionGroupActive(canonicalProject, selectedWorktree)).toBe(false);
    expect(isWorkspaceBackedSessionGroupActive(siblingWorktree, selectedWorktree)).toBe(false);
  });
});
