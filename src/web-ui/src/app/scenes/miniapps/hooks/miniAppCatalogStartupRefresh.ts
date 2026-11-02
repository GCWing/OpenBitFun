import {
  backgroundTaskScheduler,
  type BackgroundTaskHandle,
  type BackgroundTaskScheduler,
} from '@/shared/utils/backgroundTaskScheduler';

export interface MiniAppCatalogStartupRefreshDependencies {
  scheduler?: Pick<BackgroundTaskScheduler, 'schedule'>;
  refreshApps: () => Promise<void>;
  refreshRunningWorkers: () => Promise<void>;
  inFlightKey?: string;
}

export function scheduleMiniAppCatalogStartupRefresh(
  dependencies: MiniAppCatalogStartupRefreshDependencies
): BackgroundTaskHandle<void> {
  const scheduler = dependencies.scheduler ?? backgroundTaskScheduler;

  return scheduler.schedule(async signal => {
    if (signal.aborted) {
      return;
    }
    await dependencies.refreshApps();
    if (signal.aborted) {
      return;
    }
    await dependencies.refreshRunningWorkers();
  }, {
    idle: true,
    priority: 'low',
    inFlightKey: dependencies.inFlightKey ?? 'miniapp:startup-catalog-refresh',
  });
}
