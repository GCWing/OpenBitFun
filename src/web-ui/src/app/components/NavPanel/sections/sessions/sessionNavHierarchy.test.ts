import { describe, expect, it } from 'vitest';
import type { Session } from '@/flow_chat/types/flow-chat';
import {
  DEFAULT_WORKSPACE_SESSION_FILTERS,
  matchesWorkspaceSessionView,
  matchesWorkspaceSourceAgent,
  type WorkspaceSessionSourceAgent,
} from '../../workspaceSessionView';
import { getWorkspaceSessionHierarchy } from './sessionNavHierarchy';
import { getSessionDisplayLimit, getSessionExpandToggleState } from './sessionNavExpand';

const session = (sessionId: string, workspaceId: string, extra: Partial<Session> = {}): Session => ({
  sessionId, workspaceId, projectWorkspaceId: 'main', title: sessionId,
  config: {}, createdAt: 1, lastActiveAt: 1, status: 'idle', persistedStatus: 'active',
  sessionKind: 'normal', error: null, dialogTurns: [], ...extra,
} as Session);

const visibleParents = (sessions: Session[], workspaceId: string, source: WorkspaceSessionSourceAgent = 'all') =>
  getWorkspaceSessionHierarchy(sessions, [workspaceId]).topLevelSessions.filter(row =>
    matchesWorkspaceSourceAgent(row, source)
    && matchesWorkspaceSessionView(row, 'all', DEFAULT_WORKSPACE_SESSION_FILTERS, false));

describe('workspace-owned navigation counts', () => {
  it('counts a shared 659-record catalog as 24 native + 432 Codex rows for the main workspace', () => {
    const records = [
      ...Array.from({ length: 23 }, (_, index) => session(`native-${index}`, 'main')),
      session('managed', 'managed-worktree', {
        config: { executionTarget: { kind: 'managedWorktree', rootPath: '/repo/.worktrees/task' } },
      }),
      ...Array.from({ length: 432 }, (_, index) => session(`codex-${index}`, 'main', { importedSource: 'codex' })),
      ...Array.from({ length: 94 }, (_, index) => session(`ui-${index}`, 'ui', { importedSource: 'codex' })),
      ...Array.from({ length: 105 }, (_, index) => session(`cli-${index}`, 'cli', { importedSource: 'codex' })),
      ...Array.from({ length: 3 }, (_, index) => session(`child-${index}`, 'main', {
        sessionKind: 'btw', parentSessionId: 'native-0',
      })),
      session('ui-child', 'ui', { sessionKind: 'review', parentSessionId: 'ui-0' }),
    ];
    expect(records).toHaveLength(659);
    expect(getWorkspaceSessionHierarchy(records, ['main', 'ui', 'cli']).topLevelSessions).toHaveLength(655);
    for (const [source, total, remaining] of [
      ['openbitfun', 24, 19], ['codex', 432, 427], ['all', 456, 451],
    ] as const) {
      const rows = visibleParents(records, 'main', source);
      expect(rows).toHaveLength(total);
      expect(getSessionExpandToggleState(rows.length, 0).collapsedRemainingCount).toBe(remaining);
      expect(getSessionDisplayLimit({ loadedTopLevelCount: rows.length, expandLevel: 0, level2DisplayCount: 200, showAllWithoutLimit: false })).toBe(5);
    }
    expect(visibleParents(records, 'ui')).toHaveLength(94);
    expect(visibleParents(records, 'cli')).toHaveLength(105);
    expect(visibleParents(records, 'managed-worktree')).toHaveLength(0);
  });

  it('tracks creates, deletes and archives from the same filtered rows', () => {
    let records = Array.from({ length: 6 }, (_, index) => session(`row-${index}`, 'main'));
    const remaining = () => getSessionExpandToggleState(visibleParents(records, 'main').length, 0).collapsedRemainingCount;
    expect(remaining()).toBe(1);
    records.push(session('created', 'main'));
    expect(remaining()).toBe(2);
    records = records.filter(row => row.sessionId !== 'row-0');
    expect(remaining()).toBe(1);
    records[0] = { ...records[0], persistedStatus: 'archived' };
    expect(remaining()).toBe(0);
    expect(getSessionExpandToggleState(visibleParents(records, 'main').length, 0).shouldRender).toBe(false);
  });

  it('keeps unresolved children visible and excludes transient and subagent records', () => {
    const records = [
      session('parent', 'main'),
      session('child', 'main', { sessionKind: 'btw', parentSessionId: 'parent' }),
      session('orphan', 'main', { sessionKind: 'btw', parentSessionId: 'unknown' }),
      session('transient', 'main', { isTransient: true }),
      session('agent', 'main', { sessionKind: 'subagent', parentSessionId: 'parent' }),
      session('foreign', 'linked-worktree'),
    ];
    const hierarchy = getWorkspaceSessionHierarchy(records, ['main']);
    expect(hierarchy.topLevelSessions.map(row => row.sessionId)).toEqual(['parent', 'orphan']);
    expect(hierarchy.childrenByParent.get('parent')?.map(row => row.sessionId)).toEqual(['child']);
  });

  it('honors legacy config ownership and POSIX remote IDs without inferring ownership from paths', () => {
    const records = [
      session('legacy', '', { workspaceId: undefined, projectWorkspaceId: undefined, config: { workspaceId: 'ssh-main' } }),
      session('remote-tree', 'ssh-tree', { projectWorkspaceId: 'ssh-main' }),
      session('remote-managed', 'ssh-managed', { projectWorkspaceId: 'ssh-main', config: {
        executionTarget: { kind: 'managedWorktree', rootPath: '/srv/repo/.worktrees/task' },
      } }),
    ];
    expect(visibleParents(records, 'ssh-main').map(row => row.sessionId)).toEqual(['legacy', 'remote-managed']);
    expect(visibleParents(records, 'ssh-tree').map(row => row.sessionId)).toEqual(['remote-tree']);
  });
});
