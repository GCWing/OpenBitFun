import { lazy, Suspense, useEffect, type ReactElement } from 'react';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';
import { createLogger } from '@/shared/utils/logger';
import { scheduleAfterStartupSignal } from '@/shared/utils/startupTaskScheduling';
import { canAutoCheckForAppUpdates, canCheckForAppUpdates } from './tauriEnv';
import { getSkippedVersion } from './appUpdateStorage';
import { UpdateInstallProgressModal } from './UpdateInstallProgressModal';
import { APP_UPDATE_CHECK_INTERVAL, useUpdateInstallStore } from './updateInstallStore';
import { RetainedMountBoundary } from '@/shared/presence';

const AppUpdateDetailsDialog = lazy(() => import('./AppUpdateDetailsDialog'));

const log = createLogger('DailyAppUpdate');

/** One shell-owned scheduler; discovery, notices and installation have separate state. */
export function DailyAppUpdateGate(): ReactElement | null {
  const state = useUpdateInstallStore();

  useEffect(() => {
    if (!canCheckForAppUpdates()) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== 'openbitfun:update:skippedVersion' && event.key !== null) return;
      const skippedVersion = getSkippedVersion();
      const current = useUpdateInstallStore.getState();
      useUpdateInstallStore.setState({
        skippedVersion,
        ...(current.notice === 'available' && skippedVersion === current.availableUpdate?.latestVersion
          ? { notice: null } : {}),
      });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    if (!canAutoCheckForAppUpdates()) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let interval: ReturnType<typeof setInterval> | undefined;
    let started = false;
    const check = (force = false) => {
      if (!cancelled && started && document.visibilityState !== 'hidden' && navigator.onLine !== false) {
        void useUpdateInstallStore.getState().checkForUpdates('automatic', force);
      }
    };
    const cancelStartupSchedule = scheduleAfterStartupSignal(() => {
      timer = setTimeout(() => {
        started = true;
        void useUpdateInstallStore.getState().initialize().then(() => check());
        interval = setInterval(() => check(), APP_UPDATE_CHECK_INTERVAL);
      }, 900);
    }, {
      signalName: 'openbitfun:interactive-shell-ready',
      fallbackTimeoutMs: 10000,
      frameCount: 1,
      onError: error => log.warn('Failed to schedule update checks after startup', error),
    });
    const onResume = () => check();
    const unsubscribe = systemAPI.onAutoUpdateEnabledChange(enabled => {
      if (enabled) check(true);
      else if (useUpdateInstallStore.getState().notice === 'available') {
        useUpdateInstallStore.getState().dismissNotice();
      }
    });
    window.addEventListener('online', onResume);
    document.addEventListener('visibilitychange', onResume);
    return () => {
      cancelled = true;
      cancelStartupSchedule();
      clearTimeout(timer);
      clearInterval(interval);
      unsubscribe();
      window.removeEventListener('online', onResume);
      document.removeEventListener('visibilitychange', onResume);
    };
  }, []);

  if (!canCheckForAppUpdates()) return null;

  return (
    <>
      <RetainedMountBoundary present={state.detailsOpen}>
        <Suspense fallback={null}><AppUpdateDetailsDialog /></Suspense>
      </RetainedMountBoundary>
      <UpdateInstallProgressModal
        isOpen={state.promptOpen}
        error={state.error}
        installed={state.status === 'ready' || state.status === 'installing'}
        installing={state.status === 'installing'}
        version={state.version}
        progress={state.progress}
        onCloseInstalled={state.deferInstall}
        onRestart={() => void state.confirmInstall()}
        onDownloadAgain={() => void state.startInstall(true, state.version ?? undefined)}
      />
    </>
  );
}
