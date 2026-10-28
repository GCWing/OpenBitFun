import type { SessionCatalogQuery } from '@/infrastructure/api/service-api/SessionAPI';
import type { Session } from '@/flow_chat/types/flow-chat';
import { sessionBelongsToWorkspaceNavRow } from '@/flow_chat/utils/sessionOrdering';
import { isUnmaterializedSessionDraft } from '@/flow_chat/utils/sessionDraft';
import { getWorkspaceSessionHierarchy } from './sessionNavHierarchy';
import {
  hasWorkspaceSessionFilters,
  matchesWorkspaceSourceAgent,
  type WorkspaceSessionFilters,
  type WorkspaceSessionOrdering,
  type WorkspaceSessionSourceAgent,
  type WorkspaceSessionShow,
} from '../../workspaceSessionView';

export function countPersistedWorkspaceCatalogSessions(sessions: Iterable<Session>, workspaceId: string | undefined, source: WorkspaceSessionSourceAgent): number {
  return getWorkspaceSessionHierarchy(sessions, workspaceId ? [workspaceId] : []).topLevelSessions
    .filter(session => !isUnmaterializedSessionDraft(session) && session.persistedStatus !== 'archived'
      && matchesWorkspaceSourceAgent(session, source)).length;
}

export function workspaceSessionCatalogTotal(visibleCount: number, catalog: { paged: boolean; total?: number; knownCount?: number }): number {
  return Math.max(visibleCount, catalog.paged
    ? (catalog.total ?? 0) + visibleCount - (catalog.knownCount ?? visibleCount) : 0);
}

/** Select supported views and the ordering changes that restart their reader.
 * Newly hydrated rows alone must not invalidate an in-progress catalog. */
export function workspaceSessionCatalogQuery(
  workspaceId: string | undefined,
  ordering: WorkspaceSessionOrdering,
  show: WorkspaceSessionShow,
  filters: WorkspaceSessionFilters,
  source: string,
  sessions: Iterable<Session>,
  getSortTimestamp: (session: Session) => number,
): SessionCatalogQuery | undefined {
  if (!workspaceId || (ordering !== 'updated' && ordering !== 'created')
    || show !== 'all' || hasWorkspaceSessionFilters(filters)) return;
  const sortTimestamps: Record<string, number> = {};
  if (ordering === 'updated') {
    for (const session of sessions) {
      if (!sessionBelongsToWorkspaceNavRow(session, workspaceId)) continue;
      const timestamp = getSortTimestamp(session);
      if (timestamp !== (session.lastFinishedAt ?? session.createdAt)) {
        sortTimestamps[session.sessionId] = timestamp;
      }
    }
  }
  return { workspaceId, ordering, source,
    ...(Object.keys(sortTimestamps).length ? { sortTimestamps } : {}),
  };
}

/** Bind every observed timestamp before reading a new host catalog. Matching
 * local metadata is not evidence that another host still has that timestamp. */
export function captureWorkspaceSessionCatalogQuery(
  query: SessionCatalogQuery,
  sessions: Iterable<Session>,
  getSortTimestamp: (session: Session) => number,
): SessionCatalogQuery {
  if (query.ordering !== 'updated') return query;
  const sortTimestamps = { ...query.sortTimestamps };
  for (const session of sessions) {
    if (sessionBelongsToWorkspaceNavRow(session, query.workspaceId)) {
      sortTimestamps[session.sessionId] = getSortTimestamp(session);
    }
  }
  return Object.keys(sortTimestamps).length ? { ...query, sortTimestamps } : query;
}

/** Ordering pins change the reader, while the selected view stays the same. */
export function sessionCatalogViewKey(query?: SessionCatalogQuery): string {
  return query ? JSON.stringify([query.workspaceId, query.ordering, query.source]) : '';
}

export function sessionCatalogQueryKey(query?: SessionCatalogQuery): string {
  return query ? JSON.stringify([query.workspaceId, query.ordering, query.source,
    Object.entries(query.sortTimestamps ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  ]) : '';
}
