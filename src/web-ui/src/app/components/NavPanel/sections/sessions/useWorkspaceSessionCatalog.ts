import { useEffect, useRef, useState } from 'react';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import type { SessionCatalogQuery, SessionMetadataPage } from '@/infrastructure/api/service-api/SessionAPI';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { createLogger } from '@/shared/utils/logger';
import { loadWorkspaceSessionSourcePages } from './workspaceSessionSourcePages';
import { sessionCatalogQueryKey } from './workspaceSessionCatalogQuery';

const log = createLogger('useWorkspaceSessionCatalog');
const PAGE_SIZE = 200;
interface CatalogState {
  scopeKey: string;
  loading: boolean;
  failed: boolean;
  complete: boolean;
  paged: boolean;
  total?: number;
  knownCount?: number;
  loaded: number;
  nextCursor?: string;
  hasMore: boolean;
  revision?: string;
  requestQuery?: SessionCatalogQuery;
}
const initialState = (scopeKey: string): CatalogState => ({
  scopeKey, loading: false, failed: false, complete: false,
  paged: false, loaded: 0, hasMore: true,
});

/** Query-capable hosts return exact workspace totals and only the requested
 * rows. Legacy hosts and richer client-side views retain complete traversal. */
export function useWorkspaceSessionCatalog({
  workspaceId, enabled, refreshVersion, onPage, query, targetCount = 5, firstPage, getKnownCount, captureQuery,
}: {
  workspaceId?: string;
  enabled: boolean;
  refreshVersion: number;
  onPage: (workspaceId: string, page: SessionMetadataPage) => void;
  query?: SessionCatalogQuery;
  targetCount?: number;
  firstPage?: SessionMetadataPage;
  getKnownCount?: () => number;
  captureQuery?: (query: SessionCatalogQuery) => SessionCatalogQuery;
}) {
  const surface = getActiveSurfaceScope();
  const queryKey = sessionCatalogQueryKey(query);
  const scopeKey = surface.key(workspaceId, surface.epoch, refreshVersion, queryKey);
  const progress = useRef(initialState(''));
  const queryRef = useRef(query);
  queryRef.current = query;
  const [state, setState] = useState(initialState(''));

  useEffect(() => {
    if (!enabled || !workspaceId) return;
    let current = progress.current.scopeKey === scopeKey
      ? progress.current : initialState(scopeKey);
    if (progress.current.scopeKey !== scopeKey && refreshVersion === 0 && firstPage?.catalogQuery
      && sessionCatalogQueryKey(firstPage.catalogQuery) === queryKey) {
      current = { ...current, complete: true, paged: true, total: firstPage.totalTopLevelCount,
        knownCount: getKnownCount?.(), loaded: firstPage.loadedTopLevelCount,
        nextCursor: firstPage.nextCursor, hasMore: firstPage.hasMore, revision: firstPage.catalogRevision,
        requestQuery: firstPage.catalogQuery };
    }
    if (current.complete && (!current.paged || !current.hasMore || current.loaded >= targetCount)) {
      if (progress.current !== current) { progress.current = current; setState({ ...current }); }
      return;
    }
    let cancelled = false;
    const isCurrent = () => !cancelled && surface.isCurrent();
    const publish = (updates: Partial<CatalogState>) => {
      if (!isCurrent()) return;
      Object.assign(current, updates);
      progress.current = current;
      setState({ ...current });
    };
    let requestQuery = current.requestQuery ?? queryRef.current;
    publish({ loading: true, failed: false, complete: false, requestQuery });
    void (async () => {
      if (requestQuery) {
        const visited = new Set<string>();
        if (current.nextCursor) visited.add(current.nextCursor);
        while (isCurrent() && current.hasMore && current.loaded < targetCount) {
          const page = await flowChatStore.loadSessionMetadataPage(
            workspaceId, Math.min(PAGE_SIZE, targetCount - current.loaded), current.nextCursor,
            'sessions_nav_catalog', { fresh: refreshVersion > 0, query: requestQuery },
          );
          if (!isCurrent()) return;
          onPage(workspaceId, page);
          if (!page.catalogQuery || sessionCatalogQueryKey(page.catalogQuery) !== sessionCatalogQueryKey(requestQuery)) break;
          const restarted = page.catalogReset || (current.revision !== undefined
            && page.catalogRevision !== undefined && current.revision !== page.catalogRevision);
          if (restarted) visited.clear();
          if (restarted && captureQuery) {
            // Rows hydrated during this catalog were not in its initial query.
            // If the host changes, bind their observed order before restarting.
            const refreshedQuery = captureQuery(requestQuery);
            if (sessionCatalogQueryKey(refreshedQuery) !== sessionCatalogQueryKey(requestQuery)) {
              requestQuery = refreshedQuery;
              publish({ loaded: 0, nextCursor: undefined, hasMore: true, revision: undefined, requestQuery });
              continue;
            }
          }
          if (page.hasMore && (!page.nextCursor || visited.has(page.nextCursor))) {
            throw new Error('Session metadata pagination did not advance');
          }
          if (page.nextCursor) visited.add(page.nextCursor);
          publish({ paged: true, total: page.totalTopLevelCount,
            knownCount: getKnownCount?.(),
            loaded: (restarted ? 0 : current.loaded) + page.loadedTopLevelCount,
            nextCursor: page.nextCursor, hasMore: page.hasMore, revision: page.catalogRevision });
        }
        if (!isCurrent()) return;
        if (current.paged && (!current.hasMore || current.loaded >= targetCount)) {
          publish({ complete: true, loading: false });
          return;
        }
      }
      await loadWorkspaceSessionSourcePages(async cursor => {
        const page = await flowChatStore.loadSessionMetadataPage(
          workspaceId, PAGE_SIZE, cursor, 'sessions_nav_catalog', { fresh: refreshVersion > 0 },
        );
        if (isCurrent()) onPage(workspaceId, page);
        return page;
      }, isCurrent);
      publish({ complete: true, loading: false, paged: false, total: undefined });
    })().catch(error => {
      if (!isCurrent()) return;
      log.warn('Failed to load workspace session catalog', { workspaceId, error });
      publish({ loading: false, failed: true, complete: false });
    });
    return () => { cancelled = true; };
  }, [captureQuery, enabled, firstPage, getKnownCount, onPage, queryKey, refreshVersion, scopeKey, surface, targetCount, workspaceId]);

  return state.scopeKey === scopeKey
    ? state
    : { ...initialState(scopeKey), loading: enabled && Boolean(workspaceId) };
}
