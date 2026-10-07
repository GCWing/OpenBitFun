import { lazyWithRecovery } from '@/shared/utils/lazyWithRecovery';
import { Suspense, useEffect, useRef, useState, type ReactElement } from 'react';
import { useHasModalOverlay } from '@openbitfun/ui';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';
import { createLogger } from '@/shared/utils/logger';
import { scheduleAfterStartupSignal } from '@/shared/utils/startupTaskScheduling';
import { canAutoCheckForAppUpdates, canCheckForAppUpdates } from './tauriEnv';
import { getSkippedVersion, getAppUpdateReminderAt, recordAppUpdatePresented, shouldShowDailyUpdatePrompt } from './appUpdateStorage';
import { UpdateInstallProgressModal } from './UpdateInstallProgressModal';
import { useUpdateInstallStore } from './updateInstallStore';
import { APP_UPDATE_CHECK_INTERVAL, getNextAppUpdateCheckAt } from './appUpdateSchedule';
import { RetainedMountBoundary } from '@/shared/presence';

const AppUpdateDetailsDialog = lazyWithRecovery(() => import('./AppUpdateDetailsDialog'));

const log = createLogger('DailyAppUpdate');

/** One shell-owned scheduler; discovery, notices and installation have separate state. */
export function DailyAppUpdateGate(): ReactElement | null {
  const state = useUpdateInstallStore();
  const modalOpen = useHasModalOverlay();
  const [started, setStarted] = useState(false);
  const startupCheckPending = useRef(true);

  useEffect(() => {
    if (!canCheckForAppUpdates()) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && !event.key.startsWith('openbitfun:update:')) return;
      const skippedVersion = getSkippedVersion();
      const current = useUpdateInstallStore.getState();
      useUpdateInstallStore.setState({
        skippedVersion,
        reminderRevision: current.reminderRevision + 1,
        ...(current.notice === 'available' && current.availableUpdate?.latestVersion && !shouldShowDailyUpdatePrompt(current.availableUpdate.latestVersion)
          ? { notice: null } : {}),
        ...(current.status === 'ready' && current.version && (getAppUpdateReminderAt('ready', current.version) ?? 0) > Date.now()
          ? { promptOpen: false } : {}),
      });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    if (!canAutoCheckForAppUpdates()) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelStartupSchedule = scheduleAfterStartupSignal(() => {
      timer = setTimeout(() => {
        void useUpdateInstallStore.getState().initialize().then(() => {
          if (!cancelled) setStarted(true);
        });
      }, 5000);
    }, {
      signalName: 'openbitfun:interactive-shell-ready',
      fallbackTimeoutMs: 10000,
      frameCount: 1,
      onError: error => log.warn('Failed to schedule update checks after startup', error),
    });
    return () => {
      cancelled = true;
      cancelStartupSchedule();
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!started) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const foreground = () => document.visibilityState !== 'hidden' && document.hasFocus();
    const schedule = (afterAttempt = false) => {
      clearTimeout(timer);
      if (cancelled || !foreground() || navigator.onLine === false) return;
      const current = useUpdateInstallStore.getState();
      if (current.checkStatus === 'checking' || current.status === 'downloading' || current.status === 'installing') return;
      const source = startupCheckPending.current ? 'startup' : 'automatic';
      const delay = startupCheckPending.current ? 0 : Math.max(0, getNextAppUpdateCheckAt(current, source) - Date.now());
      // A disabled/unavailable preference must not create a zero-delay retry loop.
      timer = setTimeout(() => {
        if (cancelled || !foreground() || navigator.onLine === false) return;
        startupCheckPending.current = false;
        void useUpdateInstallStore.getState().checkForUpdates(source).finally(() => schedule(true));
      }, afterAttempt && delay === 0 ? APP_UPDATE_CHECK_INTERVAL : delay);
    };
    // Startup freshness is checked once, even when its cached result is reused.
    if (startupCheckPending.current && foreground() && navigator.onLine !== false) {
      startupCheckPending.current = false;
      void useUpdateInstallStore.getState().checkForUpdates('startup').finally(() => schedule(true));
    } else schedule();
    const onResume = () => schedule();
    const unsubscribe = systemAPI.onAutoUpdateEnabledChange(enabled => {
      if (enabled && foreground() && navigator.onLine !== false) {
        void useUpdateInstallStore.getState().checkForUpdates('automatic', true).finally(() => schedule(true));
      } else if (!enabled && useUpdateInstallStore.getState().notice === 'available') {
        useUpdateInstallStore.setState({ notice: null });
      }
    });
    window.addEventListener('online', onResume);
    window.addEventListener('offline', onResume);
    window.addEventListener('focus', onResume);
    window.addEventListener('blur', onResume);
    document.addEventListener('visibilitychange', onResume);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      unsubscribe();
      window.removeEventListener('online', onResume);
      window.removeEventListener('offline', onResume);
      window.removeEventListener('focus', onResume);
      window.removeEventListener('blur', onResume);
      document.removeEventListener('visibilitychange', onResume);
    };
  }, [started, state.checkStatus, state.lastCheckedAt, state.lastCheckAttemptAt, state.consecutiveCheckFailures, state.status]);

  useEffect(() => {
    if (!canCheckForAppUpdates() || !state.initialized) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const present = () => {
      clearTimeout(timer);
      if (document.visibilityState === 'hidden' || !document.hasFocus()) return;
      const current = useUpdateInstallStore.getState();
      if (current.promptOpen && current.version) recordAppUpdatePresented('ready', current.version);
      if (modalOpen || current.detailsOpen || current.promptOpen || current.status === 'downloading' || current.status === 'installing') return;
      current.presentPendingInstall();
      void useUpdateInstallStore.getState().refreshAvailableReminder();
      const next = useUpdateInstallStore.getState();
      const deadlines = [
        next.version && next.getReminderAt('ready', next.version),
        next.availableUpdate?.latestVersion && next.getReminderAt('available', next.availableUpdate.latestVersion),
      ].filter((at): at is number => typeof at === 'number' && at > Date.now());
      if (deadlines.length) timer = setTimeout(present, Math.min(...deadlines) - Date.now());
    };
    present();
    window.addEventListener('focus', present);
    document.addEventListener('visibilitychange', present);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', present);
      document.removeEventListener('visibilitychange', present);
    };
  }, [modalOpen, state.initialized, state.status, state.version, state.availableUpdate, state.detailsOpen, state.promptOpen, state.reminderRevision]);

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
