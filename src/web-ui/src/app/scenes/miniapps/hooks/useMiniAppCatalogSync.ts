/**
 * useMiniAppCatalogSync — keeps Mini App catalog and runtime state in sync.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { api } from '@/infrastructure/api/service-api/ApiClient';
import { miniAppAPI } from '@/infrastructure/api/service-api/MiniAppAPI';
import { BackgroundTaskCancelledError } from '@/shared/utils/backgroundTaskScheduler';
import { createLogger } from '@/shared/utils/logger';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { useMiniAppStore } from '../miniAppStore';
import { useMiniAppNavigationStore } from '../miniAppNavigationStore';
import { loadInstalledMarketOrigins } from '../utils/loadInstalledMarketOrigins';
import { scheduleMiniAppCatalogStartupRefresh } from './miniAppCatalogStartupRefresh';

const log = createLogger('useMiniAppCatalogSync');

export interface UseMiniAppCatalogSyncOptions {
  enabled?: boolean;
  initialLoad?: 'immediate' | 'idle' | 'manual';
}

export function useMiniAppCatalogSync(options: UseMiniAppCatalogSyncOptions = {}) {
  const { enabled = true, initialLoad = 'immediate' } = options;
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope);
  const setApps = useMiniAppStore((state) => state.setApps);
  const setLoading = useMiniAppStore((state) => state.setLoading);
  const setMarketOrigins = useMiniAppStore((state) => state.setMarketOrigins);
  const setRunningWorkerIds = useMiniAppStore((state) => state.setRunningWorkerIds);
  const markWorkerRunning = useMiniAppStore((state) => state.markWorkerRunning);
  const markWorkerStopped = useMiniAppStore((state) => state.markWorkerStopped);

  const refreshApps = useCallback(async () => {
    if (!scope.isCurrent()) return;
    setLoading(true);
    try {
      const [apps, origins] = await Promise.all([
        miniAppAPI.listMiniApps(),
        loadInstalledMarketOrigins(),
      ]);
      if (!scope.isCurrent()) return;
      setApps(apps);
      setMarketOrigins(origins);
    } catch (error) {
      if (scope.isCurrent()) log.error('Failed to load miniapps', error);
    } finally {
      if (scope.isCurrent()) setLoading(false);
    }
  }, [scope, setApps, setLoading, setMarketOrigins]);

  const refreshRunningWorkers = useCallback(async () => {
    if (!scope.isCurrent()) return;
    try {
      const running = await miniAppAPI.workerListRunning();
      if (!scope.isCurrent()) return;
      setRunningWorkerIds(running);
    } catch (error) {
      if (scope.isCurrent()) log.error('Failed to load running miniapp workers', error);
    }
  }, [scope, setRunningWorkerIds]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const startupRefreshHandle = initialLoad === 'idle'
      ? scheduleMiniAppCatalogStartupRefresh({
          refreshApps,
          refreshRunningWorkers,
          inFlightKey: scope.key('miniapp:startup-catalog-refresh', scope.epoch),
        })
      : null;

    if (initialLoad === 'immediate') {
      void refreshApps();
      void refreshRunningWorkers();
    }

    startupRefreshHandle?.promise.catch(error => {
      if (!(error instanceof BackgroundTaskCancelledError)) {
        log.warn('Initial miniapp catalog refresh task failed', error);
      }
    });

    const unlistenCreated = api.listen('miniapp-created', () => {
      void refreshApps();
    });
    const unlistenUpdated = api.listen('miniapp-updated', () => {
      void refreshApps();
    });
    const unlistenDeleted = api.listen<{ id?: string }>('miniapp-deleted', (payload) => {
      if (!scope.isCurrent()) return;
      if (payload?.id) {
        useMiniAppNavigationStore.getState().setPinned(scope.surfaceId, payload.id, false);
        markWorkerStopped(payload.id);
      }
      void refreshApps();
    });
    const unlistenRestarted = api.listen<{ id?: string }>('miniapp-worker-restarted', (payload) => {
      if (scope.isCurrent() && payload?.id) {
        markWorkerRunning(payload.id);
      }
    });
    const unlistenStopped = api.listen<{ id?: string }>('miniapp-worker-stopped', (payload) => {
      if (scope.isCurrent() && payload?.id) {
        markWorkerStopped(payload.id);
      }
    });

    return () => {
      startupRefreshHandle?.cancel();
      unlistenCreated();
      unlistenUpdated();
      unlistenDeleted();
      unlistenRestarted();
      unlistenStopped();
    };
  }, [enabled, initialLoad, scope, markWorkerRunning, markWorkerStopped, refreshApps, refreshRunningWorkers]);

  return {
    refreshApps,
    refreshRunningWorkers,
  };
}
