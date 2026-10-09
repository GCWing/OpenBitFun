// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readAppUpdateSnapshot, recordDailyPromptDismissed, shouldShowDailyUpdatePrompt,
  recordAppUpdatePresented, deferAppUpdateReminder, getAppUpdateReminderAt, APP_UPDATE_REMINDER_INTERVAL,
} from './appUpdateStorage';

beforeEach(() => localStorage.clear());
afterEach(() => vi.useRealTimers());

it('reads legacy prompt records without permanently suppressing the version', () => {
  localStorage.setItem('openbitfun:update:lastDailyPromptDate', '2020-01-01');
  localStorage.setItem('openbitfun:update:lastPromptedLatestVersion', '2.0.0');
  expect(shouldShowDailyUpdatePrompt('2.0.0')).toBe(true);
  expect(shouldShowDailyUpdatePrompt('2.1.0')).toBe(true);
  recordDailyPromptDismissed('2.1.0');
  expect(shouldShowDailyUpdatePrompt('2.1.0')).toBe(false);
  expect(localStorage.getItem('openbitfun:update:skippedVersion')).toBeNull();
});

it('starts a rolling 24-hour cooldown on dismissal, independently for each stage and version', () => {
  vi.useFakeTimers();
  recordAppUpdatePresented('available', '2.0.0');
  expect(shouldShowDailyUpdatePrompt('2.0.0')).toBe(true);
  recordDailyPromptDismissed('2.0.0');
  const now = Date.now();
  expect(getAppUpdateReminderAt('available', '2.0.0')).toBe(now + APP_UPDATE_REMINDER_INTERVAL);
  expect(getAppUpdateReminderAt('ready', '2.0.0')).toBe(0);
  expect(shouldShowDailyUpdatePrompt('2.1.0')).toBe(true);
  deferAppUpdateReminder('ready', '2.0.0');
  expect(getAppUpdateReminderAt('ready', '2.0.0')).toBe(now + APP_UPDATE_REMINDER_INTERVAL);
  vi.advanceTimersByTime(APP_UPDATE_REMINDER_INTERVAL - 1);
  expect(shouldShowDailyUpdatePrompt('2.0.0')).toBe(false);
  vi.advanceTimersByTime(1);
  expect(shouldShowDailyUpdatePrompt('2.0.0')).toBe(true);
});

it('keeps legacy same-day deferrals, skip decisions, additive fields and unreadable reminder data', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-01T10:00:00'));
  localStorage.setItem('openbitfun:update:lastDailyPromptDate', '2026-10-01');
  localStorage.setItem('openbitfun:update:lastPromptedLatestVersion', '2.0.0');
  expect(shouldShowDailyUpdatePrompt('2.0.0')).toBe(false);
  localStorage.setItem('openbitfun:update:reminders', JSON.stringify({ future: true, ready: { version: '2.0.0', deferredAt: Date.now(), future: true } }));
  recordAppUpdatePresented('ready', '2.0.0');
  expect(JSON.parse(localStorage.getItem('openbitfun:update:reminders')!).ready.future).toBe(true);
  localStorage.setItem('openbitfun:update:reminders', '{invalid');
  recordDailyPromptDismissed('2.0.0');
  expect(localStorage.getItem('openbitfun:update:reminders')).toBe('{invalid');
  localStorage.setItem('openbitfun:update:skippedVersion', '2.0.0');
  vi.advanceTimersByTime(APP_UPDATE_REMINDER_INTERVAL * 2);
  expect(shouldShowDailyUpdatePrompt('2.0.0')).toBe(false);
});

it('records presentation once so cross-window storage synchronization converges', () => {
  vi.useFakeTimers();
  recordAppUpdatePresented('ready', '2.0.0');
  const first = localStorage.getItem('openbitfun:update:reminders');
  vi.advanceTimersByTime(1000);
  recordAppUpdatePresented('ready', '2.0.0');
  expect(localStorage.getItem('openbitfun:update:reminders')).toBe(first);
  recordAppUpdatePresented('ready', '2.1.0');
  expect(localStorage.getItem('openbitfun:update:reminders')).not.toBe(first);
});

it('preserves malformed records and accepts additive fields in valid snapshots', () => {
  const key = 'openbitfun:update:checkSnapshot';
  localStorage.setItem(key, '{invalid');
  expect(readAppUpdateSnapshot()).toBeNull();
  expect(localStorage.getItem(key)).toBe('{invalid');
  localStorage.setItem(key, JSON.stringify({ checkedAt: 1, future: true, result: {
    updateAvailable: true, currentVersion: '1.0.0', latestVersion: '2.0.0', releaseNotes: null, releaseDate: null,
  } }));
  expect(readAppUpdateSnapshot()?.result.latestVersion).toBe('2.0.0');
});

it.each(['1.0.0', '1.0.1', '1.0.1-rc.1', '1.0.1+build', 'invalid'])('ignores a cached non-upgrade to %s without deleting the record', latestVersion => {
  const key = 'openbitfun:update:checkSnapshot';
  const record = JSON.stringify({ checkedAt: Date.now(), result: {
    updateAvailable: true, currentVersion: '1.0.1', latestVersion, releaseNotes: null, releaseDate: null,
  } });
  localStorage.setItem(key, record);
  expect(readAppUpdateSnapshot()).toBeNull();
  expect(localStorage.getItem(key)).toBe(record);
});

it('ignores future check timestamps so a changed system clock cannot suppress discovery', () => {
  localStorage.setItem('openbitfun:update:checkSnapshot', JSON.stringify({ checkedAt: Date.now() + 86400000, result: {
    updateAvailable: false, currentVersion: '1.0.1', latestVersion: null, releaseNotes: null, releaseDate: null,
  } }));
  expect(readAppUpdateSnapshot()).toBeNull();
});
