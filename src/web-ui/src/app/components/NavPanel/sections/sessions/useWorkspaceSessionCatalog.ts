import { useEffect, useRef, useState } from 'react';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import type { SessionMetadataPage } from '@/infrastructure/api/service-api/SessionAPI';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { createLogger } from '@/shared/utils/logger';
import { loadWorkspaceSessionSourcePages } from './workspaceSessionSourcePages';

const log = createLogger('useWorkspaceSessionCatalog');

/** Metadata totals cover a shared storage root, not necessarily this workspace.
 * Load its lightweight catalog once so every filter counts the actual rows.
 * The caller enables this only after the startup page has finished. */
export function useWorkspaceSessionCatalog({
  workspaceId,
  enabled,
  refreshVersion,
  onPage,
}: {
  workspaceId?: string;
  enabled: boolean;
  refreshVersion: number;
  onPage: (workspaceId: string, page: SessionMetadataPage) => void;
}) {
  const surface = getActiveSurfaceScope();
  const scopeKey = surface.key(workspaceId, surface.epoch, refreshVersion);
  const completedKey = useRef<string | null>(null);
  const [state, setState] = useState({ scopeKey: '', loading: false, failed: false, complete: false });

  useEffect(() => {
    if (!enabled || !workspaceId || completedKey.current === scopeKey) return;
    let cancelled = false;
    const isCurrent = () => !cancelled && surface.isCurrent();
    setState({ scopeKey, loading: true, failed: false, complete: false });
    void loadWorkspaceSessionSourcePages(async cursor => {
      const page = await flowChatStore.loadSessionMetadataPage(
        workspaceId, 200, cursor, 'sessions_nav_catalog',
        { fresh: refreshVersion > 0 },
      );
      if (isCurrent()) onPage(workspaceId, page);
      return page;
    }, isCurrent).then(() => {
      if (!isCurrent()) return;
      completedKey.current = scopeKey;
      setState({ scopeKey, loading: false, failed: false, complete: true });
    }).catch(error => {
      if (!isCurrent()) return;
      log.warn('Failed to load workspace session catalog', { workspaceId, error });
      setState({ scopeKey, loading: false, failed: true, complete: false });
    });
    return () => { cancelled = true; };
  }, [enabled, onPage, refreshVersion, scopeKey, surface, workspaceId]);

  return state.scopeKey === scopeKey
    ? state
    : { scopeKey, loading: enabled && Boolean(workspaceId), failed: false, complete: false };
}
