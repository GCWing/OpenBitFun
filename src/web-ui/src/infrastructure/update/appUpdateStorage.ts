import type { CheckForUpdatesResponse } from '@/infrastructure/api/service-api/SystemAPI';
import { isAppVersion, isNewerAppVersion } from './appUpdateVersion';

// Keep legacy keys readable by older installs. Dismissal never changes the skipped version.
const LAST_DAILY_PROMPT_DATE_KEY = 'openbitfun:update:lastDailyPromptDate';
const LAST_PROMPTED_LATEST_KEY = 'openbitfun:update:lastPromptedLatestVersion';
const SKIPPED_VERSION_KEY = 'openbitfun:update:skippedVersion';
const CHECK_SNAPSHOT_KEY = 'openbitfun:update:checkSnapshot';

export interface AppUpdateSnapshot {
  result: CheckForUpdatesResponse;
  checkedAt: number;
}

export function getSkippedVersion(): string | null {
  try { return localStorage.getItem(SKIPPED_VERSION_KEY); } catch { return null; }
}

export function shouldShowDailyUpdatePrompt(latestVersion: string): boolean {
  if (getSkippedVersion() === latestVersion) return false;
  try {
    return localStorage.getItem(LAST_PROMPTED_LATEST_KEY) !== latestVersion;
  } catch { return true; }
}

/** Record actual presentation, including opening the update details. */
export function recordDailyPromptDismissed(latestVersion: string): void {
  try {
    const date = new Date();
    const localDate = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
    localStorage.setItem(LAST_DAILY_PROMPT_DATE_KEY, localDate);
    localStorage.setItem(LAST_PROMPTED_LATEST_KEY, latestVersion);
  } catch { /* Storage may be unavailable; the in-memory state still works. */ }
}

export function recordSkipThisVersion(latestVersion: string): void {
  try { localStorage.setItem(SKIPPED_VERSION_KEY, latestVersion); } catch { /* Keep the in-memory decision. */ }
  recordDailyPromptDismissed(latestVersion);
}

export function restoreVersionReminder(version: string): void {
  try {
    if (getSkippedVersion() === version) localStorage.removeItem(SKIPPED_VERSION_KEY);
  } catch { /* Keep the in-memory decision. */ }
}

export function readAppUpdateSnapshot(): AppUpdateSnapshot | null {
  try {
    const raw = localStorage.getItem(CHECK_SNAPSHOT_KEY);
    if (!raw) return null;
    const snapshot = JSON.parse(raw) as AppUpdateSnapshot;
    const result = snapshot?.result;
    if (!Number.isFinite(snapshot?.checkedAt) || snapshot.checkedAt <= 0 || snapshot.checkedAt > Date.now() ||
        !result || !isAppVersion(result.currentVersion) ||
        typeof result.updateAvailable !== 'boolean' ||
        (result.updateAvailable && !isNewerAppVersion(result.latestVersion, result.currentVersion)) ||
        (result.releaseNotes != null && typeof result.releaseNotes !== 'string') ||
        (result.releaseDate != null && typeof result.releaseDate !== 'string')) return null;
    return snapshot;
  } catch {
    // An unreadable record is not a reason to remove persisted user data.
    return null;
  }
}

export function writeAppUpdateSnapshot(snapshot: AppUpdateSnapshot): void {
  try { localStorage.setItem(CHECK_SNAPSHOT_KEY, JSON.stringify(snapshot)); } catch { /* Best effort cache. */ }
}
