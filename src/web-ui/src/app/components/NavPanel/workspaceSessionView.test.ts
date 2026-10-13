// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import type { Session } from '@/flow_chat/types/flow-chat';
import {
  compareWorkspaceNavSessions,
  DEFAULT_WORKSPACE_SESSION_FILTERS,
  deriveWorkspaceSessionEnvironment,
  deriveWorkspaceSessionSource,
  deriveWorkspaceSessionStatus,
  deriveWorkspaceSessionWorktree,
  getNextWorkspaceSessionGrouping,
  matchesWorkspaceSessionView,
  normalizeWorkspaceSessionGrouping,
  normalizeWorkspaceSessionOrdering,
  readManualOrder,
  useWorkspaceSessionViewStore,
  WORKSPACE_SESSION_ORDERING_MODES,
  writeManualOrder,
} from './workspaceSessionView';

const WORKSPACE_SESSION_VIEW_STORAGE_KEY = 'openbitfun.workspace-session-view.v2';

const session = (overrides: Partial<Session>): Session => ({
  sessionId: 'session',
  title: 'Session',
  config: {},
  createdAt: 1,
  lastActiveAt: 1,
  updatedAt: undefined,
  lastFinishedAt: undefined,
  persistedStatus: 'active',
  status: 'idle',
  error: null,
  dialogTurns: [],
  ...overrides,
} as Session);

describe('workspace session view model', () => {
  it('toggles between unified groups and the flat all-session view', () => {
    expect(getNextWorkspaceSessionGrouping('grouped')).toBe('all');
    expect(getNextWorkspaceSessionGrouping('all')).toBe('grouped');
  });

  it('migrates legacy workspace grouping to the unified grouped view', () => {
    expect(normalizeWorkspaceSessionGrouping('workspace')).toBe('grouped');
    expect(normalizeWorkspaceSessionGrouping('grouped')).toBe('grouped');
    expect(normalizeWorkspaceSessionGrouping('all')).toBe('all');
    expect(normalizeWorkspaceSessionGrouping(undefined)).toBe('grouped');
  });

  it('sorts by execution recency, status, creation time, and title', () => {
    const running = session({ sessionId: 'running', title: 'Zulu', createdAt: 10, updatedAt: 40 });
    const newer = session({ sessionId: 'newer', title: 'Alpha', createdAt: 20, updatedAt: 30 });
    const getTitle = (value: Session) => value.title || '';
    const isRunning = (value: Session) => value.sessionId === 'running';
    const getActivityTimestamp = (value: Session) => value.sessionId === 'running' ? 40 : 30;

    expect(compareWorkspaceNavSessions(running, newer, 'updated', getTitle, isRunning, getActivityTimestamp)).toBeLessThan(0);
    expect(compareWorkspaceNavSessions(running, newer, 'status', getTitle, isRunning)).toBeLessThan(0);
    expect(compareWorkspaceNavSessions(running, newer, 'created', getTitle, isRunning)).toBeGreaterThan(0);
    expect(compareWorkspaceNavSessions(running, newer, 'name', getTitle, isRunning)).toBeGreaterThan(0);
  });

  it('does not use mutable timestamps as a fallback or break ties in explicit name and creation order', () => {
    const left = session({ sessionId: 'a', createdAt: 10, lastActiveAt: 100, updatedAt: 100, lastFinishedAt: 100 });
    const right = session({ sessionId: 'b', createdAt: 10 });
    const getTitle = (value: Session) => value.title || '';
    for (const ordering of ['updated', 'created', 'name'] as const) {
      expect(compareWorkspaceNavSessions(left, right, ordering, getTitle)).toBeLessThan(0);
      expect(compareWorkspaceNavSessions(right, left, ordering, getTitle)).toBeGreaterThan(0);
    }
    for (const ordering of ['created', 'name'] as const) {
      expect(compareWorkspaceNavSessions(left, right, ordering, getTitle, () => false,
        value => value.sessionId === 'b' ? 500 : 10)).toBeLessThan(0);
    }
    expect(compareWorkspaceNavSessions(left, session({ sessionId: 'newer', createdAt: 20 }),
      'updated', getTitle)).toBeGreaterThan(0);
  });

  it('derives filter facets from canonical session data', () => {
    const value = session({
      status: 'error',
      remoteConnectionId: 'remote',
      config: {
        agentType: 'acp:codex',
        executionTarget: { kind: 'managedWorktree', rootPath: '/repo/.worktrees/task' },
      },
    });

    expect(deriveWorkspaceSessionStatus(value, false)).toBe('error');
    expect(deriveWorkspaceSessionStatus(value, true)).toBe('running');
    expect(deriveWorkspaceSessionEnvironment(value)).toBe('remote');
    expect(deriveWorkspaceSessionSource(value)).toBe('external');
    expect(deriveWorkspaceSessionWorktree(value)).toBe('worktree');
  });

  it('combines show presets with hidden facet values', () => {
    const unread = session({ hasUnreadCompletion: true });
    const completed = session({ persistedStatus: 'completed', lastFinishedAt: 50 });

    expect(matchesWorkspaceSessionView(unread, 'unread', DEFAULT_WORKSPACE_SESSION_FILTERS, false)).toBe(true);
    expect(matchesWorkspaceSessionView(completed, 'unread', DEFAULT_WORKSPACE_SESSION_FILTERS, false)).toBe(false);
    expect(matchesWorkspaceSessionView(completed, 'all', {
      ...DEFAULT_WORKSPACE_SESSION_FILTERS,
      hiddenStatuses: ['completed'],
    }, false)).toBe(false);
  });
});

describe('workspace session ordering preference', () => {
  afterEach(() => {
    window.localStorage.clear();
    useWorkspaceSessionViewStore.setState({ manualOrder: {} });
  });

  it('accepts the manual mode and normalizes unavailable persisted values', () => {
    expect(WORKSPACE_SESSION_ORDERING_MODES).toEqual(['updated', 'status', 'created', 'name', 'manual']);
    for (const mode of WORKSPACE_SESSION_ORDERING_MODES) {
      expect(normalizeWorkspaceSessionOrdering(mode)).toBe(mode);
    }
    expect(normalizeWorkspaceSessionOrdering('workspace')).toBe('updated');
    expect(normalizeWorkspaceSessionOrdering(undefined)).toBe('updated');
    expect(normalizeWorkspaceSessionOrdering(null)).toBe('updated');
  });

  it('persists the manual drag order per scope next to the other preferences', () => {
    expect(readManualOrder('all')).toEqual([]);

    writeManualOrder('workspace:ws-1', ['s2', 's1']);
    writeManualOrder('all', ['s3']);

    expect(readManualOrder('workspace:ws-1')).toEqual(['s2', 's1']);
    expect(readManualOrder('all')).toEqual(['s3']);
    const persisted = JSON.parse(window.localStorage.getItem(WORKSPACE_SESSION_VIEW_STORAGE_KEY) ?? 'null');
    expect(persisted.state.manualOrder).toEqual({ 'workspace:ws-1': ['s2', 's1'], all: ['s3'] });
  });

  it('drops unusable stored scopes instead of failing to hydrate', () => {
    window.localStorage.setItem(
      WORKSPACE_SESSION_VIEW_STORAGE_KEY,
      JSON.stringify({ state: { manualOrder: { all: ['s1', 4, 's1'], 'workspace:ws-1': 's2' } }, version: 3 }),
    );

    expect(() => useWorkspaceSessionViewStore.persist.rehydrate()).not.toThrow();

    expect(readManualOrder('all')).toEqual(['s1']);
    expect(readManualOrder('workspace:ws-1')).toEqual([]);
    expect(useWorkspaceSessionViewStore.getState().manualOrder).toEqual({ all: ['s1'] });
  });
});
