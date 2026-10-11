import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import {
  aiExperienceConfigService,
  type AIExperienceSettings,
} from '../services/AIExperienceConfigService';

export interface UseAIExperienceSettingsResult {
  settings: AIExperienceSettings | null;
  isLoading: boolean;
  isRefreshing: boolean;
  error: Error | null;
  reload: () => Promise<void>;
}

export function useAIExperienceSettings(): UseAIExperienceSettingsResult {
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const [snapshot, setSnapshot] = useState(() => ({
    epoch: scope.epoch,
    settings: aiExperienceConfigService.getCachedSettings(),
    error: null as Error | null,
    pending: true,
  }));
  const activeRef = useRef(true);
  const requestIdRef = useRef(0);

  const load = useCallback(async (forceRefresh: boolean) => {
    const requestId = ++requestIdRef.current;
    setSnapshot(current => current.epoch === scope.epoch
      ? { ...current, pending: true, error: null }
      : { epoch: scope.epoch, settings: null, pending: true, error: null });
    try {
      const next = await aiExperienceConfigService.getSettingsAsync({ forceRefresh, requireLoaded: true });
      if (activeRef.current && scope.isCurrent() && requestId === requestIdRef.current) {
        setSnapshot({ epoch: scope.epoch, settings: next, pending: false, error: null });
      }
    } catch (reason) {
      if (activeRef.current && scope.isCurrent() && requestId === requestIdRef.current) {
        setSnapshot(current => ({
          ...current, pending: false,
          error: reason instanceof Error ? reason : new Error(String(reason)),
        }));
      }
    }
  }, [scope]);

  useEffect(() => {
    activeRef.current = true;
    void load(false);
    const removeListener = aiExperienceConfigService.addChangeListener(next => {
      if (!activeRef.current || !scope.isCurrent()) return;
      requestIdRef.current += 1;
      setSnapshot({ epoch: scope.epoch, settings: next, pending: false, error: null });
    });
    return () => {
      activeRef.current = false;
      requestIdRef.current += 1;
      removeListener();
    };
  }, [load, scope]);

  const reload = useCallback(() => load(true), [load]);
  const current = snapshot.epoch === scope.epoch ? snapshot : { settings: null, error: null, pending: true };
  return {
    settings: current.settings,
    error: current.error,
    isLoading: current.pending && current.settings === null,
    isRefreshing: current.pending && current.settings !== null,
    reload,
  };
}
