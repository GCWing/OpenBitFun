import type { CheckForUpdatesResponse } from '@/infrastructure/api/service-api/SystemAPI';
import { isAppVersion, isNewerAppVersion } from './appUpdateVersion';

// Keep legacy keys readable by older installs. Dismissal never changes the skipped version.
const LAST_DAILY_PROMPT_DATE_KEY = 'openbitfun:update:lastDailyPromptDate';
const LAST_PROMPTED_LATEST_KEY = 'openbitfun:update:lastPromptedLatestVersion';
const SKIPPED_VERSION_KEY = 'openbitfun:update:skippedVersion';
const CHECK_SNAPSHOT_KEY = 'openbitfun:update:checkSnapshot';
const REMINDERS_KEY = 'openbitfun:update:reminders';
export const APP_UPDATE_REMINDER_INTERVAL = 24 * 60 * 60 * 1000;
export type AppUpdateReminderStage = 'available' | 'ready';
interface ReminderRecord { version: string; presentedAt?: number; deferredAt?: number }

function readReminders(): Partial<Record<AppUpdateReminderStage, ReminderRecord>> | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(REMINDERS_KEY) ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

/** A future timestamp from a clock correction must not lock out reminders. */
function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= Date.now();
}

export function getAppUpdateReminderAt(stage: AppUpdateReminderStage, version: string): number | null {
  if (stage === 'available' && getSkippedVersion() === version) return null;
  const record = readReminders()?.[stage];
  if (record) {
    return record.version === version && validTimestamp(record.deferredAt)
      ? record.deferredAt + APP_UPDATE_REMINDER_INTERVAL : 0;
  }
  // Old clients only recorded a local calendar date. Honor that day, never a permanent dismissal.
  if (stage === 'available') {
    try {
      const date = localStorage.getItem(LAST_DAILY_PROMPT_DATE_KEY);
      if (localStorage.getItem(LAST_PROMPTED_LATEST_KEY) === version && date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
        const timestamp = new Date(`${date}T00:00:00`).getTime();
        if (validTimestamp(timestamp)) return timestamp + APP_UPDATE_REMINDER_INTERVAL;
      }
    } catch { /* The in-memory reminder remains usable. */ }
  }
  return 0;
}

function writeReminder(stage: AppUpdateReminderStage, version: string, deferred: boolean): void {
  try {
    const records = readReminders();
    if (!records) return;
    const previous = records[stage]?.version === version ? records[stage] : undefined;
    // A storage event in another window must not start a presentation-write loop.
    if (!deferred && validTimestamp(previous?.presentedAt)) return;
    records[stage] = { ...previous, version, [deferred ? 'deferredAt' : 'presentedAt']: Date.now() };
    localStorage.setItem(REMINDERS_KEY, JSON.stringify(records));
  } catch { /* Best effort persistence; never remove an unreadable record. */ }
}

export function recordAppUpdatePresented(stage: AppUpdateReminderStage, version: string): void {
  writeReminder(stage, version, false);
}

export function deferAppUpdateReminder(stage: AppUpdateReminderStage, version: string): void {
  writeReminder(stage, version, true);
}

export interface AppUpdateSnapshot {
  result: CheckForUpdatesResponse;
  checkedAt: number;
}

export function getSkippedVersion(): string | null {
  try { return localStorage.getItem(SKIPPED_VERSION_KEY); } catch { return null; }
}

export function shouldShowDailyUpdatePrompt(latestVersion: string): boolean {
  const due = getAppUpdateReminderAt('available', latestVersion);
  return due !== null && due <= Date.now();
}

/** Explicit dismissal starts the cooldown; presentation alone does not. */
export function recordDailyPromptDismissed(latestVersion: string): void {
  deferAppUpdateReminder('available', latestVersion);
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
