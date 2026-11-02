import { describe, expect, it } from 'vitest';
import type { Session } from '../types/flow-chat';
import {
  isSessionWorktreeIsolationEnabled,
  isSessionWorktreeBindingLocked,
  sessionWorktreeMaterializationPlan,
  sessionWorktreeBindingSubscriptionKey,
  sessionWorktreeRootPath,
} from './sessionWorktree';

function session(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'session-1',
    dialogTurns: [],
    status: 'active',
    config: {
      executionTarget: {
        kind: 'local',
        rootPath: '/repo',
      },
    },
    createdAt: 0,
    lastActiveAt: 0,
    error: null,
    sessionKind: 'normal',
    ...overrides,
  };
}

describe('session worktree control', () => {
  it('does not treat the selected session status as runtime processing', () => {
    expect(isSessionWorktreeBindingLocked(session({ status: 'active' }), false)).toBe(false);
    expect(isSessionWorktreeBindingLocked(session(), true)).toBe(true);
  });

  it('locks metadata-only history before its dialog turns are hydrated', () => {
    expect(isSessionWorktreeBindingLocked(session({ totalTurnCount: 1 }), false)).toBe(true);
  });

  it('locks catalog-only history before its dialog turns are hydrated', () => {
    expect(isSessionWorktreeBindingLocked(session({
      turnCatalog: {
        schemaVersion: 1,
        sessionId: 'session-1',
        revision: 'catalog-1',
        totalTurnCount: 1,
        complete: false,
        entries: [],
      },
    }), false)).toBe(true);
  });

  it('shows an armed worktree before it has been materialized', () => {
    const armed = session({
      workspacePath: '/repo',
      projectWorkspacePath: '/repo',
      config: {
        projectWorkspacePath: '/repo',
        executionTarget: {
          kind: 'local',
          rootPath: '/repo',
        },
        worktreeIsolationRequested: true,
      },
    });

    expect(isSessionWorktreeIsolationEnabled(armed)).toBe(true);
    expect(sessionWorktreeMaterializationPlan(armed)).toEqual({
      enabled: true,
      projectWorkspacePath: '/repo',
    });
  });

  it('locates the owning project by workspace ID when the session carries one', () => {
    const inWorktree = session({
      workspaceId: 'worktree-ws',
      projectWorkspaceId: 'project-ws',
      workspacePath: '/worktrees/wt-1',
      projectWorkspacePath: '/repo',
      config: {
        workspaceId: 'worktree-ws',
        projectWorkspacePath: '/repo',
        executionTarget: {
          kind: 'local',
          rootPath: '/worktrees/wt-1',
        },
        worktreeIsolationRequested: true,
      },
    });
    expect(sessionWorktreeMaterializationPlan(inWorktree)).toEqual({
      enabled: true,
      projectWorkspaceId: 'project-ws',
      projectWorkspacePath: '/repo',
    });

    const local = session({
      workspaceId: 'workspace-1',
      workspacePath: '/repo',
      projectWorkspacePath: '/repo',
      config: {
        workspaceId: 'workspace-1',
        projectWorkspacePath: '/repo',
        executionTarget: { kind: 'local', rootPath: '/repo' },
        worktreeIsolationRequested: true,
      },
    });
    expect(sessionWorktreeMaterializationPlan(local)).toEqual({
      enabled: true,
      projectWorkspaceId: 'workspace-1',
      projectWorkspacePath: '/repo',
    });
  });

  it('does not materialize when no preference change is pending', () => {
    expect(sessionWorktreeMaterializationPlan(session())).toBeUndefined();
    expect(sessionWorktreeMaterializationPlan(session({
      config: {
        executionTarget: {
          kind: 'local',
          rootPath: '/repo',
        },
        worktreeIsolationRequested: false,
      },
    }))).toBeUndefined();
  });

  it('discards a stale pending change once the session has persisted work', () => {
    expect(sessionWorktreeMaterializationPlan(session({
      totalTurnCount: 1,
      config: {
        executionTarget: {
          kind: 'local',
          rootPath: '/repo',
        },
        worktreeIsolationRequested: true,
      },
    }))).toBeUndefined();
  });

  it('invalidates the composer subscription after hydrate and rebind', () => {
    const initial = sessionWorktreeBindingSubscriptionKey(session());
    const armed = sessionWorktreeBindingSubscriptionKey(session({
      config: {
        executionTarget: {
          kind: 'local',
          rootPath: '/repo',
        },
        worktreeIsolationRequested: true,
      },
    }));
    const hydrated = sessionWorktreeBindingSubscriptionKey(session({ totalTurnCount: 1 }));
    const rebound = sessionWorktreeBindingSubscriptionKey(session({
      workspacePath: '/worktrees/wt-1',
      projectWorkspacePath: '/repo',
      config: {
        projectWorkspacePath: '/repo',
        executionTarget: {
          kind: 'managedWorktree',
          worktreeId: 'wt-1',
          rootPath: '/worktrees/wt-1',
        },
      },
    }));

    expect(armed).not.toBe(initial);
    expect(hydrated).not.toBe(initial);
    expect(rebound).not.toBe(initial);
  });
});

describe('worktree execution root', () => {
  it('reports the worktree directory of an isolated session', () => {
    expect(sessionWorktreeRootPath(session({
      workspaceId: 'worktree-ws',
      projectWorkspaceId: 'project-ws',
      workspacePath: '/worktrees/wt-1',
      config: {
        executionTarget: { kind: 'managedWorktree', worktreeId: 'wt-1', rootPath: '/worktrees/wt-1' },
      },
    }))).toBe('/worktrees/wt-1');
  });

  it('falls back to the execution path for a legacy target without a root', () => {
    const legacy = session({
      workspacePath: '/worktrees/wt-2',
      config: {
        // Persisted targets written before `rootPath` was required.
        executionTarget: { kind: 'existingWorktree', worktreeId: 'wt-2' },
      } as Session['config'],
    });
    expect(sessionWorktreeRootPath(legacy)).toBe('/worktrees/wt-2');
  });

  it('reports nothing when the isolated target carries no usable directory', () => {
    expect(sessionWorktreeRootPath(session({
      workspacePath: '   ',
      config: {
        executionTarget: { kind: 'existingWorktree', worktreeId: 'wt-3', rootPath: '   ' },
      },
    }))).toBeUndefined();
  });

  it('reports nothing for a session that runs in its project root', () => {
    expect(sessionWorktreeRootPath(session({ workspacePath: '/repo' }))).toBeUndefined();
    expect(sessionWorktreeRootPath(session({
      workspacePath: '/repo',
      config: {
        executionTarget: { kind: 'local', rootPath: '/repo' },
        worktreeIsolationRequested: true,
      },
    }))).toBeUndefined();
  });
});
