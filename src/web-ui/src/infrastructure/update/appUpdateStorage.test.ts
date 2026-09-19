// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';
import { readAppUpdateSnapshot, recordDailyPromptDismissed, shouldShowDailyUpdatePrompt } from './appUpdateStorage';

beforeEach(() => localStorage.clear());

it('reads legacy prompt records and does not repeat a version on another day', () => {
  localStorage.setItem('openbitfun:update:lastDailyPromptDate', '2020-01-01');
  localStorage.setItem('openbitfun:update:lastPromptedLatestVersion', '2.0.0');
  expect(shouldShowDailyUpdatePrompt('2.0.0')).toBe(false);
  expect(shouldShowDailyUpdatePrompt('2.1.0')).toBe(true);
  recordDailyPromptDismissed('2.1.0');
  expect(shouldShowDailyUpdatePrompt('2.1.0')).toBe(false);
  expect(localStorage.getItem('openbitfun:update:skippedVersion')).toBeNull();
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
