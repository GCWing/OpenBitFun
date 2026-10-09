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
  writeAppUpdateSnapshot, recordAppUpdatePresented, deferAppUpdateReminder, getAppUpdateReminderAt,
  APP_UPDATE_REMINDER_INTERVAL, type AppUpdateReminderStage,
} from './appUpdateStorage';
import { getNextAppUpdateCheckAt, type AppUpdateCheckSource } from './appUpdateSchedule';
export { APP_UPDATE_CHECK_INTERVAL } from './appUpdateSchedule';

const log = createLogger('UpdateInstallStore');

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
  consecutiveCheckFailures: number;
  reminderRevision: number;
  reminderDeferrals: Partial<Record<AppUpdateReminderStage, { version: string; at: number }>>;
  skippedVersion: string | null;
  notice: UpdateNotice | null;
  noticeRevision: number;
  detailsOpen: boolean;
  releaseNotesOpen: boolean;
  initialize: () => Promise<void>;
  checkForUpdates: (source?: AppUpdateCheckSource, force?: boolean) => Promise<void>;
  refreshAvailableReminder: () => Promise<void>;
  presentPendingInstall: () => void;
  getReminderAt: (stage: AppUpdateReminderStage, version: string) => number | null;
  deferReminder: (stage: AppUpdateReminderStage, version: string) => void;
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
const shouldDeferAutomaticCheck = (state: UpdateInstallState, source: AppUpdateCheckSource) =>
  getNextAppUpdateCheckAt(state, source) > Date.now();

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
  consecutiveCheckFailures: 0, reminderRevision: 0, reminderDeferrals: {},
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
    const automatic = source !== 'manual';
    if (automatic && !canAutoCheckForAppUpdates()) return;
    await get().initialize();
    if (checking) return checking;
    if (isBusy(get())) return;
    if (automatic) {
      if (!force && shouldDeferAutomaticCheck(get(), source)) {
        await get().refreshAvailableReminder();
        return;
      }
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
      if (!force && shouldDeferAutomaticCheck(get(), source)) return;
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
          consecutiveCheckFailures: 0,
          ...(obsoleteDownloadFailure ? { error: null, status: previous.version ? 'ready' : 'idle', downloadVersion: null } : {}),
          ...(previous.notice === 'available' || (obsoleteDownloadFailure && previous.notice === 'error') ? { notice: null } : {}),
        });
        if (available && result.latestVersion) {
          if (get().detailsOpen) recordAppUpdatePresented('available', result.latestVersion);
          else if (automatic) await get().refreshAvailableReminder();
        }
      } catch (error) {
        log.warn('Update check failed', error);
        set(state => ({ checkStatus: 'error', checkError: errorText(error),
          consecutiveCheckFailures: state.consecutiveCheckFailures + 1 }));
      }
    })();
    checking = check;
    try { await check; } finally { if (checking === check) checking = null; }
  },

  refreshAvailableReminder: async () => {
    if (!canAutoCheckForAppUpdates()) return;
    const eligible = () => {
      const state = get();
      const target = state.availableUpdate?.latestVersion;
      return state.initialized && !state.detailsOpen && !state.promptOpen && !isBusy(state) && !state.notice &&
        target && target !== state.version && target !== state.skippedVersion &&
        shouldShowDailyUpdatePrompt(target) && (state.getReminderAt('available', target) ?? Infinity) <= Date.now()
        ? target : null;
    };
    const target = eligible();
    if (!target) return;
    try {
      if (await systemAPI.getAutoUpdateEnabled() && eligible() === target) {
        set(state => ({ notice: 'available', noticeRevision: state.noticeRevision + 1 }));
      }
    } catch (error) {
      log.warn('Update reminders paused because the preference is unavailable', error);
    }
  },

  // The shell calls this only when foreground presentation is available.
  presentPendingInstall: () => {
    const state = get();
    if (state.status !== 'ready' || !state.version || state.error || state.downloadVersion || state.promptOpen || state.detailsOpen) return;
    const due = state.getReminderAt('ready', state.version);
    if (due !== null && due <= Date.now()) {
      set({ promptOpen: true, notice: null });
    }
  },

  getReminderAt: (stage, version) => {
    const stored = getAppUpdateReminderAt(stage, version);
    if (stored === null) return null;
    const deferred = get().reminderDeferrals[stage];
    return deferred?.version === version && deferred.at <= Date.now()
      ? Math.max(stored, deferred.at + APP_UPDATE_REMINDER_INTERVAL) : stored;
  },
  deferReminder: (stage, version) => {
    if (stage === 'available') recordDailyPromptDismissed(version);
    else deferAppUpdateReminder(stage, version);
    // Keep the user's decision for this run even when WebView storage is unavailable.
    set(state => ({ reminderDeferrals: { ...state.reminderDeferrals, [stage]: { version, at: Date.now() } },
      reminderRevision: state.reminderRevision + 1 }));
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
    if (get().status === 'ready' && get().version) {
      get().deferReminder('ready', get().version!);
      set({ promptOpen: false });
    }
  },
  clearError: () => set({ status: get().version ? 'ready' : 'idle', error: null, promptOpen: false }),
  dismissNotice: () => {
    const state = get();
    if (state.notice === 'available' && state.availableUpdate?.latestVersion) {
      state.deferReminder('available', state.availableUpdate.latestVersion);
    }
    set({ notice: null });
  },
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
    if (get().notice === 'available' && version) recordAppUpdatePresented('available', version);
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
    if (version) recordAppUpdatePresented('available', version);
    set({ detailsOpen: true, releaseNotesOpen: false, notice: null });
  },
  openReleaseNotes: () => {
    const version = get().availableUpdate?.latestVersion;
    if (version) recordAppUpdatePresented('available', version);
    set({ detailsOpen: true, releaseNotesOpen: true, notice: null });
  },
  closeDetails: () => {
    const state = get();
    if (state.availableUpdate?.latestVersion) state.deferReminder('available', state.availableUpdate.latestVersion);
    if (state.status === 'ready' && state.version) state.deferReminder('ready', state.version);
    set({ detailsOpen: false, releaseNotesOpen: false });
  },
}));
