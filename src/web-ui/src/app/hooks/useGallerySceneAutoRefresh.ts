import { useEffect, useRef } from 'react';
import type { SceneTabId } from '@/app/components/SceneBar/types';
import { useSceneStore } from '@/app/stores/sceneStore';

export interface UseGallerySceneAutoRefreshOptions {
  /** Tab id from SceneBar (e.g. skills, agents, miniapps). */
  sceneId: SceneTabId;
  /** Reload lists; may be async. */
  refetch: () => void | Promise<void>;
  enabled?: boolean;
}

/**
 * Gallery scenes stay mounted while inactive (SceneViewport). Refresh when:
 * 1. User switches back to this tab (inactive → active).
 * 2. The window regains visibility while this tab is active (e.g. external edits).
 *
 * Initial load remains the responsibility of each feature hook (workspacePath,
 * search query, etc.); this hook only covers re-entry and focus.
 */
export function useGallerySceneAutoRefresh({
  sceneId,
  refetch,
  enabled = true,
}: UseGallerySceneAutoRefreshOptions): void {
  const isActive = useSceneStore(state => state.activeTabId === sceneId);
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  /** null = not yet synced (skip first tick to avoid duplicating hook mount loads). */
  const wasActiveRef = useRef<boolean | null>(null);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    if (wasActiveRef.current === null) {
      wasActiveRef.current = isActive;
      return;
    }
    if (isActive && !wasActiveRef.current) {
      void Promise.resolve(refetchRef.current());
    }
    wasActiveRef.current = isActive;
  }, [enabled, isActive]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') {
        return;
      }
      if (!isActive) {
        return;
      }
      void Promise.resolve(refetchRef.current());
    };

    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [enabled, isActive]);
}
