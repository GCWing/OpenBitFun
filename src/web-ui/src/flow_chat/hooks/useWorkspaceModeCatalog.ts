import { useCallback, useEffect, useRef } from 'react';

import { globalEventBus } from '@/infrastructure/event-bus';
import { createLogger } from '@/shared/utils/logger';
import type { ModeInfo } from '../reducers/modeReducer';

const log = createLogger('WorkspaceModeCatalog');

/**
 * Keep the selector catalog bound to the current workspace and newest refresh.
 * External discovery can make an older request finish after a workspace switch
 * or catalog update, so only the latest request may publish modes.
 */
export function useWorkspaceModeCatalog(
  scope: {
    workspaceId?: string;
  },
  publishModes: (modes: ModeInfo[]) => void,
): () => Promise<void> {
  const { workspaceId } = scope;
  const publishModesRef = useRef(publishModes);
  const mountedRef = useRef(false);
  const requestSequenceRef = useRef(0);
  publishModesRef.current = publishModes;

  const refresh = useCallback(async () => {
    const requestId = ++requestSequenceRef.current;
    try {
      const { agentAPI } = await import('@/infrastructure/api/service-api/AgentAPI');
      const modes = await agentAPI.getAvailableModes({
        workspaceId,
      });
      if (mountedRef.current && requestId === requestSequenceRef.current) {
        publishModesRef.current(modes);
      }
    } catch (error) {
      if (mountedRef.current && requestId === requestSequenceRef.current) {
        log.error('Failed to fetch available modes', { error });
      }
    }
  }, [workspaceId]);

  useEffect(() => {
    mountedRef.current = true;
    // Do not expose the previous workspace's local or external profiles while
    // the new workspace-scoped catalog is still being discovered.
    publishModesRef.current([]);
    void refresh();
    globalEventBus.on('mode:config:updated', refresh);
    globalEventBus.on('custom-agent:updated', refresh);

    return () => {
      mountedRef.current = false;
      requestSequenceRef.current += 1;
      globalEventBus.off('mode:config:updated', refresh);
      globalEventBus.off('custom-agent:updated', refresh);
    };
  }, [refresh]);

  return refresh;
}
