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

/** Select supported views. Only a view change restarts their reader: a session
 * that starts running moves ahead of rows whose relative order is unchanged,
 * so the local projection reorders it without discarding the host pages. */
export function workspaceSessionCatalogQuery(
  workspaceId: string | undefined,
  ordering: WorkspaceSessionOrdering,
  show: WorkspaceSessionShow,
  filters: WorkspaceSessionFilters,
  source: string,
): SessionCatalogQuery | undefined {
  if (!workspaceId || (ordering !== 'updated' && ordering !== 'created')
    || show !== 'all' || hasWorkspaceSessionFilters(filters)) return;
  return { workspaceId, ordering, source };
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

export function sessionCatalogQueryKey(query?: SessionCatalogQuery): string {
  return query ? JSON.stringify([query.workspaceId, query.ordering, query.source,
    Object.entries(query.sortTimestamps ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  ]) : '';
}
