import { describe, expect, it } from 'vitest';
import type { Session } from '@/flow_chat/types/flow-chat';
import { DEFAULT_WORKSPACE_SESSION_FILTERS, DEFAULT_WORKSPACE_SESSION_VIEW } from '../../workspaceSessionView';
import { captureWorkspaceSessionCatalogQuery, countPersistedWorkspaceCatalogSessions, workspaceSessionCatalogQuery, workspaceSessionCatalogTotal, sessionCatalogQueryKey } from './workspaceSessionCatalogQuery';

const session = (id: string, overrides: Partial<Session> = {}): Session => ({
  sessionId: id, workspaceId: 'main', createdAt: 10, lastFinishedAt: 20, config: {}, ...overrides,
} as Session);
const recency = (value: Session) => value.lastFinishedAt ?? value.createdAt;

describe('workspace catalog query selection', () => {
  it('pins an already-observed timestamp even while it still matches local metadata', () => {
    const observed = session('observed', { lastFinishedAt: 10 });
    const viewQuery = workspaceSessionCatalogQuery('main', 'updated', 'all',
      DEFAULT_WORKSPACE_SESSION_FILTERS, 'all');
    const query = captureWorkspaceSessionCatalogQuery(viewQuery!, [observed], recency);
    // The host can have finished another turn since this local record loaded.
    // Its new timestamp must not choose a different page than the frozen view.
    expect(query?.sortTimestamps).toEqual({ observed: 10 });
    expect(viewQuery?.sortTimestamps).toBeUndefined();

    const hydrated = session('newly-loaded', { lastFinishedAt: 9 });
    expect(captureWorkspaceSessionCatalogQuery(query, [observed, hydrated], recency).sortTimestamps)
      .toEqual({ observed: 10, 'newly-loaded': 9 });
  });

  it('keeps scoped totals while reflecting local creates, drafts and removals before refresh', () => {
    const baseline = { paged: true, total: 655, knownCount: 5 };
    expect(workspaceSessionCatalogTotal(5, baseline)).toBe(655);
    expect(workspaceSessionCatalogTotal(6, baseline)).toBe(656);
    expect(workspaceSessionCatalogTotal(4, baseline)).toBe(654);
    expect(workspaceSessionCatalogTotal(10, { ...baseline, knownCount: 10 })).toBe(655);
    expect(workspaceSessionCatalogTotal(6, { paged: false, total: 655 })).toBe(6);
  });
  it('counts persisted parents separately from local drafts, children and other workspaces', () => {
    const rows = [session('native'), session('codex', { importedSource: 'codex' }),
      session('draft', { draft: { workspaceId: 'main', phase: 'editing', turnId: 'future-turn' } }),
      session('review', { parentSessionId: 'native', sessionKind: 'review' }),
      session('archived', { persistedStatus: 'archived' }), session('other', { workspaceId: 'other' })];
    expect(countPersistedWorkspaceCatalogSessions(rows, 'main', 'all')).toBe(2);
    expect(countPersistedWorkspaceCatalogSessions(rows, 'main', 'codex')).toBe(1);
    expect(countPersistedWorkspaceCatalogSessions(rows.filter(value => value.sessionId !== 'codex'), 'main', 'all')).toBe(1);
  });
  it('uses bounded paging for the default view and every source selector', () => {
    for (const source of ['all', 'openbitfun', 'codex', 'zcode']) {
      expect(workspaceSessionCatalogQuery('main', DEFAULT_WORKSPACE_SESSION_VIEW.ordering, 'all',
        DEFAULT_WORKSPACE_SESSION_FILTERS, source)).toEqual({ workspaceId: 'main', ordering: 'updated', source });
    }
  });

  it('retains the complete legacy projection for name, status, unread, attention and every richer filter', () => {
    for (const ordering of ['name', 'status'] as const) {
      expect(workspaceSessionCatalogQuery('main', ordering, 'all', DEFAULT_WORKSPACE_SESSION_FILTERS, 'all')).toBeUndefined();
    }
    for (const show of ['unread', 'attention', 'archived'] as const) {
      expect(workspaceSessionCatalogQuery('main', 'updated', show, DEFAULT_WORKSPACE_SESSION_FILTERS, 'codex')).toBeUndefined();
    }
    const filters = [
      { hiddenStatuses: ['running'] }, { hiddenEnvironments: ['remote'] },
      { hiddenSources: ['external'] }, { hiddenWorktrees: ['worktree'] }, { hideArchived: false },
    ] as const;
    for (const filter of filters) {
      expect(workspaceSessionCatalogQuery('main', 'updated', 'all',
        { ...DEFAULT_WORKSPACE_SESSION_FILTERS, ...filter } as typeof DEFAULT_WORKSPACE_SESSION_FILTERS,
        'all')).toBeUndefined();
    }
  });

  it('does not restart the view when a session starts running', () => {
    // The running row moves ahead of rows whose relative order is unchanged,
    // so the host pages already read for this view remain valid.
    expect(sessionCatalogQueryKey(workspaceSessionCatalogQuery('main', 'updated', 'all',
      DEFAULT_WORKSPACE_SESSION_FILTERS, 'all'))).toBe(sessionCatalogQueryKey({
      workspaceId: 'main', ordering: 'updated', source: 'all',
    }));
  });

  it('pins run ordering only within the owning workspace, including isolated worktrees', () => {
    const sessions = [session('historical'), session('running'), session('peer', { workspaceId: 'other' }),
      session('isolated', { workspaceId: 'worktree', projectWorkspaceId: 'main', config: { executionTarget: {
        kind: 'managedWorktree', rootPath: '/project/.worktrees/one',
      } } }), session('linked', { workspaceId: 'worktree', projectWorkspaceId: 'main' })];
    const getTimestamp = (value: Session) => value.sessionId === 'historical' ? recency(value) : 100;
    const query = workspaceSessionCatalogQuery('main', 'updated', 'all', DEFAULT_WORKSPACE_SESSION_FILTERS, 'all');
    expect(captureWorkspaceSessionCatalogQuery(query!, sessions, getTimestamp).sortTimestamps)
      .toEqual({ historical: 20, running: 100, isolated: 100 });
    const created = workspaceSessionCatalogQuery('main', 'created', 'all', DEFAULT_WORKSPACE_SESSION_FILTERS, 'all');
    expect(captureWorkspaceSessionCatalogQuery(created!, sessions, getTimestamp).sortTimestamps).toBeUndefined();
    expect(sessionCatalogQueryKey({ ...query!, sortTimestamps: { running: 100, isolated: 100 } }))
      .toBe(sessionCatalogQueryKey({ ...query!, sortTimestamps: { isolated: 100, running: 100 } }));
  });
});
