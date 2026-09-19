import { create } from 'zustand';
import { createLogger } from '@/shared/utils/logger';
import { systemAPI, type CheckForUpdatesResponse } from '@/infrastructure/api/service-api/SystemAPI';
import { installUpdateWithProgress, type UpdateDownloadProgressPayload } from './installUpdateWithProgress';
import { isUpdateVersionChangedError } from './updateErrorMessage';
import { isNewerAppVersion, normalizeAppUpdateResult } from './appUpdateVersion';
import { canAutoCheckForAppUpdates } from './tauriEnv';
import {
  getSkippedVersion, readAppUpdateSnapshot, recordDailyPromptDismissed,
  recordSkipThisVersion, restoreVersionReminder, shouldShowDailyUpdatePrompt,
  writeAppUpdateSnapshot,
} from './appUpdateStorage';

const log = createLogger('UpdateInstallStore');
export const APP_UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000;
const CHECK_RETRY_INTERVAL = 5 * 60 * 1000;

export type UpdateInstallStatus = 'idle' | 'downloading' | 'ready' | 'installing' | 'error';
export type UpdateNotice = 'available' | 'downloading' | 'error';
export interface UpdateInstallState {
  status: UpdateInstallStatus;
  progress: UpdateDownloadProgressPayload;
  error: string | null;
  startedAt: number | null;
  /** The host's persisted package, which can survive a failed replacement download. */
  version: string | null;
  downloadVersion: string | null;
  promptOpen: boolean;
  initialized: boolean;
  currentVersion: string | null;
  availableUpdate: CheckForUpdatesResponse | null;
  checkStatus: 'idle' | 'checking' | 'latest' | 'available' | 'error';
  checkError: string | null;
  lastCheckedAt: number | null;
  lastCheckAttemptAt: number | null;
  skippedVersion: string | null;
  notice: UpdateNotice | null;
  noticeRevision: number;
  detailsOpen: boolean;
  releaseNotesOpen: boolean;
  initialize: () => Promise<void>;
  checkForUpdates: (source?: 'manual' | 'automatic', force?: boolean) => Promise<void>;
  startInstall: (replacePending?: boolean, expectedVersion?: string) => Promise<void>;
  requestInstall: () => void;
  confirmInstall: () => Promise<void>;
  deferInstall: () => void;
  clearError: () => void;
  dismissNotice: () => void;
  showNotice: () => void;
  markNoticePresented: () => void;
  skipVersion: (version: string) => void;
  restoreReminder: (version: string) => void;
  openDetails: () => void;
  openReleaseNotes: () => void;
  closeDetails: () => void;
}

const initialProgress: UpdateDownloadProgressPayload = { downloaded: 0, total: null };
let initialization: Promise<void> | null = null;
let checking: Promise<void> | null = null;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const isBusy = (state: UpdateInstallState) => state.status === 'downloading' || state.status === 'installing';
const isRecent = (timestamp: number | null, interval: number) => {
  const elapsed = timestamp === null ? -1 : Date.now() - timestamp;
  return elapsed >= 0 && elapsed < interval;
};
const shouldDeferAutomaticCheck = (state: UpdateInstallState) =>
  isRecent(state.lastCheckedAt, APP_UPDATE_CHECK_INTERVAL) || isRecent(state.lastCheckAttemptAt, CHECK_RETRY_INTERVAL);

/** More owns undownloaded versions; the separate progress control owns prepared packages. */
export function selectHasUpdateAttention(state: UpdateInstallState): boolean {
  const target = state.downloadVersion && state.error ? state.downloadVersion : state.availableUpdate?.latestVersion;
  return Boolean(isNewerAppVersion(target, state.currentVersion ?? state.availableUpdate?.currentVersion)
    && target !== state.skippedVersion && target !== state.version
    && !(state.status === 'downloading' && target === state.downloadVersion));
}

export const useUpdateInstallStore = create<UpdateInstallState>((set, get) => ({
  status: 'idle', progress: initialProgress, error: null, startedAt: null,
  version: null, downloadVersion: null, promptOpen: false, initialized: false,
  currentVersion: null, availableUpdate: null, checkStatus: 'idle', checkError: null,
  lastCheckedAt: null, lastCheckAttemptAt: null, skippedVersion: getSkippedVersion(),
  notice: null, noticeRevision: 0, detailsOpen: false, releaseNotesOpen: false,

  initialize: async () => {
    if (get().initialized) return;
    if (initialization) return initialization;
    initialization = (async () => {
      const [current, pending] = await Promise.allSettled([
        systemAPI.getLocalAppVersion(), systemAPI.getPendingUpdate(),
      ]);
      if (current.status === 'fulfilled') {
        // Development starts without discovery; only a manual check can establish availability.
        const snapshot = canAutoCheckForAppUpdates() ? readAppUpdateSnapshot() : null;
        // Cached discovery belongs to the installed application, not a workspace or peer.
        const validSnapshot = snapshot?.result.currentVersion === current.value ? snapshot : null;
        set({ currentVersion: current.value, skippedVersion: getSkippedVersion(),
          availableUpdate: validSnapshot?.result.updateAvailable ? validSnapshot.result : null,
          lastCheckedAt: validSnapshot?.checkedAt ?? null,
          checkStatus: validSnapshot ? (validSnapshot.result.updateAvailable ? 'available' : 'latest') : 'idle',
        });
      } else {
        log.warn('Failed to read the controller application version', current.reason);
      }
      if (pending.status === 'fulfilled') {
        if (pending.value) set({ status: 'ready', version: pending.value.version });
      } else {
        log.error('Failed to restore pending update', pending.reason);
        set({ status: 'error', error: errorText(pending.reason) });
      }
      set({ initialized: true });
    })();
    try { await initialization; } finally { initialization = null; }
  },

  checkForUpdates: async (source = 'manual', force = false) => {
    if (source === 'automatic' && !canAutoCheckForAppUpdates()) return;
    await get().initialize();
    if (checking) return checking;
    if (isBusy(get())) return;
    if (source === 'automatic') {
      if (!force && shouldDeferAutomaticCheck(get())) return;
      const checkedBeforePreference = get().lastCheckedAt;
      try {
        if (!await systemAPI.getAutoUpdateEnabled()) return;
      } catch (error) {
        log.warn('Automatic update checks paused because the preference is unavailable', error);
        return;
      }
      // A pending preference read must not swallow a manual check or start a duplicate one.
      if (checking) return checking;
      if (isBusy(get()) || get().lastCheckedAt !== checkedBeforePreference) return;
      if (!force && shouldDeferAutomaticCheck(get())) return;
    }
    const check = (async () => {
      set({ checkStatus: 'checking', checkError: null, lastCheckAttemptAt: Date.now() });
      try {
        const response = await systemAPI.checkForUpdates();
        const result = normalizeAppUpdateResult(response, get().currentVersion ?? response.currentVersion);
        const available = result.updateAvailable;
        const checkedAt = Date.now();
        const previous = get();
        const obsoleteDownloadFailure = !isBusy(previous) && previous.error && previous.downloadVersion
          && (isUpdateVersionChangedError(previous.error) || previous.downloadVersion !== result.latestVersion);
        writeAppUpdateSnapshot({ result, checkedAt });
        set({ availableUpdate: available ? result : null, currentVersion: result.currentVersion,
          checkStatus: available ? 'available' : 'latest', lastCheckedAt: checkedAt,
          ...(obsoleteDownloadFailure ? { error: null, status: previous.version ? 'ready' : 'idle', downloadVersion: null } : {}),
          ...(previous.notice === 'available' || (obsoleteDownloadFailure && previous.notice === 'error') ? { notice: null } : {}),
        });
        if (available && result.latestVersion) {
          if (get().detailsOpen) recordDailyPromptDismissed(result.latestVersion);
          else if (source === 'automatic' && get().status !== 'downloading' && get().status !== 'installing' &&
              result.latestVersion !== get().version && result.latestVersion !== get().skippedVersion &&
              shouldShowDailyUpdatePrompt(result.latestVersion) && await systemAPI.getAutoUpdateEnabled()) {
            // The user may open details, skip, or download while the preference read is pending.
            const current = get();
            if (!current.detailsOpen && !current.promptOpen && current.status !== 'downloading' && current.status !== 'installing' &&
                current.version !== result.latestVersion && current.availableUpdate?.latestVersion === result.latestVersion &&
                current.skippedVersion !== result.latestVersion && shouldShowDailyUpdatePrompt(result.latestVersion)) {
              set(state => ({ notice: 'available', noticeRevision: state.noticeRevision + 1 }));
            }
          }
        }
      } catch (error) {
        log.warn('Update check failed', error);
        set({ checkStatus: 'error', checkError: errorText(error) });
      }
    })();
    checking = check;
    try { await check; } finally { if (checking === check) checking = null; }
  },

  // Prepare a signed package only. No download outcome can authorize installation.
  startInstall: async (replacePending = false, expectedVersion) => {
    await get().initialize();
    if (['downloading', 'installing'].includes(get().status)) return;
    if (get().status === 'ready' && !replacePending) return;
    if (expectedVersion && get().currentVersion && !isNewerAppVersion(expectedVersion, get().currentVersion)) return;
    if (!get().currentVersion || (!get().availableUpdate?.latestVersion && !get().version)) await get().checkForUpdates();
    const target = expectedVersion ?? get().availableUpdate?.latestVersion ?? get().version;
    if (!isNewerAppVersion(target, get().currentVersion) || !target || isBusy(get()) || (get().status === 'ready' && !replacePending)) return;
    get().restoreReminder(target);
    recordDailyPromptDismissed(target);
    set(state => ({ status: 'downloading', downloadVersion: target, progress: initialProgress,
      error: null, startedAt: Date.now(), promptOpen: false,
      notice: state.detailsOpen ? null : 'downloading', noticeRevision: state.noticeRevision + 1,
    }));
    try {
      const pending = await installUpdateWithProgress(progress => set({ progress }), target);
      set(state => ({ status: 'ready', version: pending.version, downloadVersion: null,
        promptOpen: false, notice: null, noticeRevision: state.noticeRevision + 1,
      }));
    } catch (error) {
      log.error('Update download failed', error);
      set(state => ({ status: state.version ? 'ready' : 'error', error: errorText(error),
        notice: state.detailsOpen ? null : 'error', noticeRevision: state.noticeRevision + 1,
      }));
    }
  },

  requestInstall: () => {
    const { status, version, downloadVersion } = get();
    if (status !== 'ready' || !version) return;
    get().restoreReminder(version);
    set({ promptOpen: true, detailsOpen: false, releaseNotesOpen: false, notice: null,
      ...(downloadVersion ? { error: null, downloadVersion: null } : {}),
    });
  },
  confirmInstall: async () => {
    const { status, version, promptOpen } = get();
    if (status !== 'ready' || !version || !promptOpen) return;
    set({ status: 'installing', error: null });
    try {
      await systemAPI.installPendingUpdate(version);
    } catch (error) {
      log.error('Update installation failed', error);
      set({ status: 'ready', error: errorText(error) });
    }
  },
  deferInstall: () => {
    if (get().status === 'ready') set({ promptOpen: false });
  },
  clearError: () => set({ status: get().version ? 'ready' : 'idle', error: null, promptOpen: false }),
  dismissNotice: () => set({ notice: null }),
  showNotice: () => {
    const state = get();
    if (state.status === 'installing' || state.promptOpen) return;
    const notice = state.status === 'downloading' ? 'downloading'
      : state.error && state.downloadVersion ? 'error'
        : state.availableUpdate?.latestVersion && state.availableUpdate.latestVersion !== state.version ? 'available' : null;
    if (notice) set({ notice, noticeRevision: state.noticeRevision + 1, detailsOpen: false, releaseNotesOpen: false });
  },
  markNoticePresented: () => {
    const version = get().availableUpdate?.latestVersion;
    if (get().notice === 'available' && version) recordDailyPromptDismissed(version);
  },
  skipVersion: version => {
    recordSkipThisVersion(version);
    set({ skippedVersion: version, notice: null });
  },
  restoreReminder: version => {
    restoreVersionReminder(version);
    if (get().skippedVersion === version) set({ skippedVersion: null });
  },
  openDetails: () => {
    const version = get().availableUpdate?.latestVersion;
    if (version) recordDailyPromptDismissed(version);
    set({ detailsOpen: true, releaseNotesOpen: false, notice: null });
  },
  openReleaseNotes: () => {
    const version = get().availableUpdate?.latestVersion;
    if (version) recordDailyPromptDismissed(version);
    set({ detailsOpen: true, releaseNotesOpen: true, notice: null });
  },
  closeDetails: () => set({ detailsOpen: false, releaseNotesOpen: false }),
}));
