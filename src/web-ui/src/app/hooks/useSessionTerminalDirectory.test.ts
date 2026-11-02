// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import type { Session } from '@/flow_chat/types/flow-chat';
import {
  activeSessionTerminalDirectory,
  resolveSessionTerminalDirectory,
  useSessionTerminalDirectory,
} from './useSessionTerminalDirectory';

const PROJECT = { id: 'project-ws', rootPath: '/repo' };
const WORKTREE = { id: 'worktree-ws', rootPath: '/worktrees/wt-1' };

function session(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'session-1',
    workspaceId: PROJECT.id,
    workspacePath: PROJECT.rootPath,
    dialogTurns: [],
    status: 'active',
    createdAt: 0,
    lastActiveAt: 0,
    error: null,
    sessionKind: 'normal',
    config: { executionTarget: { kind: 'local', rootPath: PROJECT.rootPath } },
    ...overrides,
  };
}

/** The backend rebinds an isolated session to the worktree workspace record. */
function worktreeSession(): Session {
  return session({
    workspaceId: WORKTREE.id,
    projectWorkspaceId: PROJECT.id,
    workspacePath: WORKTREE.rootPath,
    config: {
      projectWorkspacePath: PROJECT.rootPath,
      executionTarget: {
        kind: 'managedWorktree',
        worktreeId: 'wt-1',
        rootPath: WORKTREE.rootPath,
      },
    },
  });
}

function publish(active: Session | undefined, sessions: Session[] = []): void {
  flowChatStore.setState(state => ({
    ...state,
    sessions: new Map((active ? [active, ...sessions] : sessions).map(item => [item.sessionId, item])),
    activeSessionId: active?.sessionId ?? null,
  }));
}

describe('session terminal directory', () => {
  const initial = flowChatStore.getState();
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    publish(undefined);
  });
  afterEach(() => { flowChatStore.setState(() => initial); });

  it('starts a terminal in the worktree of the selected session', () => {
    expect(resolveSessionTerminalDirectory(worktreeSession(), PROJECT.id)).toBe(WORKTREE.rootPath);
  });

  it('keeps the project root for a session that is not worktree-isolated', () => {
    expect(resolveSessionTerminalDirectory(session(), PROJECT.id)).toBeUndefined();
  });

  it('never follows a worktree into another project scope', () => {
    expect(resolveSessionTerminalDirectory(worktreeSession(), 'other-ws')).toBeUndefined();
    expect(resolveSessionTerminalDirectory(undefined, PROJECT.id)).toBeUndefined();
    expect(resolveSessionTerminalDirectory(worktreeSession(), undefined)).toBeUndefined();
  });

  it('reads the active session at call time', () => {
    publish(worktreeSession());
    expect(activeSessionTerminalDirectory(PROJECT.id)).toBe(WORKTREE.rootPath);
    expect(activeSessionTerminalDirectory(WORKTREE.id)).toBeUndefined();
    publish(session());
    expect(activeSessionTerminalDirectory(PROJECT.id)).toBeUndefined();
  });

  it('tracks the selected session for a workspace scope', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const seen: Array<string | undefined> = [];
    const Probe = ({ workspaceId }: { workspaceId: string }) => {
      seen.push(useSessionTerminalDirectory(workspaceId));
      return null;
    };
    try {
      await act(async () => root.render(createElement(Probe, { workspaceId: PROJECT.id })));
      expect(seen.at(-1)).toBeUndefined();
      await act(async () => publish(worktreeSession()));
      expect(seen.at(-1)).toBe(WORKTREE.rootPath);
      await act(async () => publish(session()));
      expect(seen.at(-1)).toBeUndefined();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
