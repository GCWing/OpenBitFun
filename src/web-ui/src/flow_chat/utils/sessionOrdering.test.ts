import { describe, expect, it } from 'vitest';
import type { Session } from '../types/flow-chat';
import {
  compareSessionMetadataForDisplay,
  compareSessionsForDisplay,
  compareSessionsForNavStable,
  getSessionMetadataSortTimestamp,
  getSessionSortTimestamp,
  requireSessionOwningWorkspaceId,
  sessionBelongsToWorkspaceNavRow,
  sessionOwningWorkspaceId,
} from './sessionOrdering';

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'session-1',
    title: 'Session Title',
    titleStatus: 'generated',
    dialogTurns: [],
    status: 'idle',
    config: {
      modelName: 'gpt-test',
      agentType: 'Standard',
    },
    createdAt: 1000,
    lastActiveAt: undefined,
    lastFinishedAt: undefined,
    error: null,
    todos: [],
    maxContextTokens: 128128,
    mode: 'Standard',
    workspacePath: '/workspace',
    parentSessionId: undefined,
    sessionKind: 'normal',
    btwThreads: [],
    btwOrigin: undefined,
    ...overrides,
  };
}

describe('sessionOrdering', () => {
  it('uses lastFinishedAt when available', () => {
    const session = createSession({ createdAt: 1234, lastActiveAt: 5678, lastFinishedAt: 9999 });
    expect(getSessionSortTimestamp(session)).toBe(9999);
  });

  it('uses createdAt as fallback', () => {
    const session = createSession({ createdAt: 1234, lastActiveAt: 5678 });
    expect(getSessionSortTimestamp(session)).toBe(1234);
  });

  it('does not move a switched or streaming session above newer display timestamps', () => {
    const sessions = [
      createSession({ sessionId: 'older-new', createdAt: 1000 }),
      createSession({ sessionId: 'completed', createdAt: 500, lastFinishedAt: 3000 }),
      createSession({ sessionId: 'switched-or-streaming', createdAt: 200, lastActiveAt: 5000 }),
      createSession({ sessionId: 'newest-new', createdAt: 2000 }),
    ];

    const orderedIds = [...sessions].sort(compareSessionsForDisplay).map(session => session.sessionId);
    expect(orderedIds).toEqual(['completed', 'newest-new', 'older-new', 'switched-or-streaming']);
  });

  it('falls back to stable ordering when timestamps are equal', () => {
    const sessions = [
      createSession({ sessionId: 'b', createdAt: 1000 }),
      createSession({ sessionId: 'a', createdAt: 1000 }),
    ];

    const orderedIds = [...sessions].sort(compareSessionsForDisplay).map(session => session.sessionId);
    expect(orderedIds).toEqual(['a', 'b']);
  });

  it('nav stable sort ignores lastActiveAt so order does not change on session switch', () => {
    const sessions = [
      createSession({ sessionId: 'first', createdAt: 3000, lastActiveAt: 100 }),
      createSession({ sessionId: 'second', createdAt: 2000, lastActiveAt: 99999 }),
    ];
    const orderedIds = [...sessions].sort(compareSessionsForNavStable).map(s => s.sessionId);
    expect(orderedIds).toEqual(['first', 'second']);
  });

  it('sorts persisted metadata by lastFinishedAt before createdAt without using lastActiveAt', () => {
    const metadata = [
      { sessionId: 'older-new', createdAt: 1000, lastActiveAt: 9000 },
      { sessionId: 'completed', createdAt: 500, lastActiveAt: 600, lastFinishedAt: 3000 },
      { sessionId: 'newest-new', createdAt: 2000, lastActiveAt: 2500 },
    ];

    expect(getSessionMetadataSortTimestamp(metadata[0])).toBe(1000);
    const orderedIds = [...metadata].sort(compareSessionMetadataForDisplay).map(session => session.sessionId);
    expect(orderedIds).toEqual(['completed', 'newest-new', 'older-new']);
  });

  it('falls back to legacy customMetadata lastFinishedAt for persisted metadata sorting', () => {
    expect(getSessionMetadataSortTimestamp({
      sessionId: 'legacy-completed',
      createdAt: 500,
      lastActiveAt: 600,
      customMetadata: { lastFinishedAt: 3000 },
    })).toBe(3000);
  });

  it('keeps same-path workspaces on different hosts separate by ID', () => {
    expect(sessionBelongsToWorkspaceNavRow({ workspaceId: 'host-a-project' }, 'host-a-project')).toBe(true);
    expect(sessionBelongsToWorkspaceNavRow({ workspaceId: 'host-b-project' }, 'host-a-project')).toBe(false);
  });

  it('keeps a session whose execution workspace is not a worktree in its own group', () => {
    const session = {
      workspaceId: 'worktree-cli',
      projectWorkspaceId: 'main-project',
    };
    expect(sessionBelongsToWorkspaceNavRow(session, 'worktree-cli')).toBe(true);
    expect(sessionBelongsToWorkspaceNavRow(session, 'main-project')).toBe(false);
    expect(sessionBelongsToWorkspaceNavRow(session, 'sibling-worktree')).toBe(false);
  });

  it('keeps a worktree-isolated session under the project that owns it', () => {
    const worktreeSession = {
      workspaceId: 'worktree-cli',
      projectWorkspaceId: 'main-project',
      config: {
        executionTarget: {
          kind: 'managedWorktree' as const,
          worktreeId: 'worktree-cli',
          rootPath: '/tmp/worktrees/cli',
        },
      },
    };
    expect(sessionBelongsToWorkspaceNavRow(worktreeSession, 'main-project')).toBe(true);
    expect(sessionBelongsToWorkspaceNavRow(worktreeSession, 'worktree-cli')).toBe(false);
    expect(sessionBelongsToWorkspaceNavRow(worktreeSession, 'sibling-worktree')).toBe(false);
  });

  it('falls back to the execution workspace when a worktree session has no project ID', () => {
    const worktreeSession = {
      workspaceId: 'worktree-only',
      config: {
        executionTarget: {
          kind: 'existingWorktree' as const,
          worktreeId: 'worktree-only',
          rootPath: '/tmp/worktrees/only',
        },
      },
    };
    expect(sessionBelongsToWorkspaceNavRow(worktreeSession, 'worktree-only')).toBe(true);
    expect(sessionBelongsToWorkspaceNavRow(worktreeSession, 'main-project')).toBe(false);
  });

  it('still attributes a legacy record that only carries the project ID', () => {
    const legacySession = { projectWorkspaceId: 'main-project' };
    expect(sessionBelongsToWorkspaceNavRow(legacySession, 'main-project')).toBe(true);
    expect(sessionBelongsToWorkspaceNavRow(legacySession, 'other-project')).toBe(false);
  });

  it('does not guess membership from a missing or stale ID', () => {
    expect(sessionBelongsToWorkspaceNavRow({}, 'known')).toBe(false);
    expect(sessionBelongsToWorkspaceNavRow({ workspaceId: 'stale' }, 'known')).toBe(false);
    expect(sessionBelongsToWorkspaceNavRow({ workspaceId: 'known' }, undefined)).toBe(false);
  });

  it('names one owning workspace ID per session shape', () => {
    expect(sessionOwningWorkspaceId({
      workspaceId: 'worktree-cli', projectWorkspaceId: 'main-project',
      config: {
        executionTarget: { kind: 'managedWorktree', worktreeId: 'worktree-cli', rootPath: '/tmp/tree' },
      },
    })).toBe('main-project');
    expect(sessionOwningWorkspaceId({
      workspaceId: 'worktree-ws', projectWorkspaceId: 'main-project',
      config: { executionTarget: { kind: 'local', rootPath: '/tmp/tree' } },
    })).toBe('worktree-ws');
    expect(sessionOwningWorkspaceId({ config: { projectWorkspaceId: 'main-project' } }))
      .toBe('main-project');
    expect(sessionOwningWorkspaceId({})).toBeUndefined();
  });

  it('addresses session commands through the owning project, not the execution worktree', () => {
    expect(requireSessionOwningWorkspaceId({
      workspaceId: 'worktree-cli', projectWorkspaceId: 'main-project',
      config: {
        executionTarget: { kind: 'managedWorktree', worktreeId: 'worktree-cli', rootPath: '/tmp/tree' },
      },
    })).toBe('main-project');
    expect(requireSessionOwningWorkspaceId({ workspaceId: 'main-project' })).toBe('main-project');
  });

  it('refuses to address session commands when the session carries no workspace identity', () => {
    expect(() => requireSessionOwningWorkspaceId({})).toThrow('Session workspace ID is unavailable');
  });
});
