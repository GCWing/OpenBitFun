import { useEffect, useState } from 'react';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('useArchivedSessionMetadata');

/** Load archived records only for a visible navigation view on the selected host. */
export function useArchivedSessionMetadata({
  workspaceIds,
  enabled,
  refreshVersion,
}: {
  workspaceIds: readonly string[];
  enabled: boolean;
  refreshVersion: number;
}) {
  const surface = getActiveSurfaceScope();
  const workspaceIdsKey = JSON.stringify(workspaceIds);
  const scopeKey = surface.key(workspaceIdsKey, surface.epoch, refreshVersion);
  const [state, setState] = useState({ scopeKey: '', loading: false, failed: false });
  const shouldLoad = enabled && workspaceIds.length > 0;

  useEffect(() => {
    if (!shouldLoad) return;
    let cancelled = false;
    setState({ scopeKey, loading: true, failed: false });
    const ids = JSON.parse(workspaceIdsKey) as string[];
    void Promise.allSettled(ids.map(id => flowChatStore.loadArchivedSessionMetadata(id))).then(results => {
      if (cancelled || !surface.isCurrent()) return;
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          log.warn('Failed to load archived session projection', { error: result.reason, workspaceId: ids[index] });
        }
      });
      setState({ scopeKey, loading: false, failed: results.some(result => result.status === 'rejected') });
    });
    return () => { cancelled = true; };
  }, [scopeKey, shouldLoad, surface, workspaceIdsKey]);

  if (!shouldLoad) return { loading: false, failed: false };
  return state.scopeKey === scopeKey ? state : { loading: true, failed: false };
}
