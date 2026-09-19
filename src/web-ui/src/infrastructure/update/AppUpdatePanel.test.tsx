// @vitest-environment jsdom
import React, { act } from 'react';
import { Dialog } from '@openbitfun/ui';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import common from '@/locales/en-US/common.json';
import { AppUpdatePanel } from './AppUpdatePanel';
import { selectHasUpdateAttention, useUpdateInstallStore } from './updateInstallStore';
import type { UpdateDownloadProgressPayload } from './installUpdateWithProgress';

const mocks = vi.hoisted(() => ({ check: vi.fn(), download: vi.fn() }));
vi.mock('@/infrastructure/api/service-api/SystemAPI', () => ({ systemAPI: {
  getLocalAppVersion: async () => '1.0.0',
  getPendingUpdate: async () => null,
  checkForUpdates: mocks.check,
} }));
vi.mock('./installUpdateWithProgress', () => ({ installUpdateWithProgress: mocks.download }));
vi.mock('@/shared/utils/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({
  t: (key: string, args?: Record<string, unknown>) => {
    const value = key.split('.').reduce<unknown>((value, part) => (value as Record<string, unknown>)?.[part], common);
    return String(value ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) => String(args?.[name] ?? ''));
  },
  formatDate: String,
  formatNumber: String,
}) }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const state = () => useUpdateInstallStore.getState();

beforeEach(async () => {
  mocks.download.mockReset();
  mocks.check.mockReset().mockResolvedValue({
    updateAvailable: true, currentVersion: '1.0.0', latestVersion: '2.0.0',
    releaseNotes: 'Release changes', releaseDate: null,
  });
  localStorage.clear();
  useUpdateInstallStore.setState({
    status: 'idle', progress: { downloaded: 0, total: null }, error: null,
    startedAt: null, version: null, promptOpen: false, initialized: false,
    downloadVersion: null, availableUpdate: null, currentVersion: null,
    checkStatus: 'idle', checkError: null, lastCheckedAt: null, lastCheckAttemptAt: null,
    skippedVersion: null, notice: null, noticeRevision: 0, detailsOpen: true, releaseNotesOpen: false,
  });
  await state().initialize();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(
    <Dialog open onOpenChange={() => state().closeDetails()} portalTarget={container} aria-label={common.update.detailsTitle}>
      <AppUpdatePanel />
    </Dialog>,
  ));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

it('shows explicit release details without the general manual-check action', async () => {
  await act(async () => state().checkForUpdates());
  expect(container.textContent).toContain('2.0.0');
  expect(container.textContent).toContain('Release changes');
  expect(state().notice).toBeNull();
  expect(state().promptOpen).toBe(false);
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  const actions = container.querySelector('[data-openbitfun-part="updateActions"]');
  expect(actions?.closest('[data-openbitfun-part="footer"]')).not.toBeNull();
  expect(actions?.closest('[data-openbitfun-part="body"]')).toBeNull();

  expect(Array.from(container.querySelectorAll('button')).some(button => button.textContent === common.update.checkForUpdates)).toBe(false);
  act(() => useUpdateInstallStore.setState({ error: 'network offline', status: 'error', downloadVersion: '2.0.0' }));
  expect(container.textContent).toContain(common.update.errors.network);
  expect(container.textContent).toContain('2.0.0');
  expect(selectHasUpdateAttention(state())).toBe(true);
});

it('enables normal download controls and installation confirmation in explicit release details', async () => {
  let reportProgress!: (progress: UpdateDownloadProgressPayload) => void;
  let finish!: (pending: { version: string }) => void;
  mocks.download.mockImplementationOnce(onProgress => {
    reportProgress = onProgress;
    return new Promise(resolve => { finish = resolve; });
  });
  await act(async () => state().checkForUpdates());
  const download = Array.from(container.querySelectorAll('button'))
    .find(button => button.textContent === common.update.downloadUpdate)!;
  expect(download.disabled).toBe(false);
  await act(async () => download.click());
  act(() => reportProgress({ downloaded: 50, total: 100 }));
  expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('50');
  expect(container.textContent).not.toContain('50%');
  expect(container.textContent).toContain('Release changes');
  await act(async () => finish({ version: '2.0.0' }));
  const install = Array.from(container.querySelectorAll('button'))
    .find(button => button.textContent === common.update.installAndRestart)!;
  expect(install.disabled).toBe(false);
  act(() => install.click());
  expect(state().promptOpen).toBe(true);
  expect(mocks.download).toHaveBeenCalledWith(expect.any(Function), '2.0.0');
});

it('keeps a manual check of a skipped release quiet and offers an explicit restore action', async () => {
  act(() => state().skipVersion('2.0.0'));
  await act(async () => state().checkForUpdates());
  expect(selectHasUpdateAttention(state())).toBe(false);
  expect(state().notice).toBeNull();
  const restore = Array.from(container.querySelectorAll('button'))
    .find(button => button.textContent === common.update.restoreReminder)!;
  expect(restore).toBeDefined();
  act(() => restore.click());
  expect(selectHasUpdateAttention(state())).toBe(true);
  expect(localStorage.getItem('openbitfun:update:skippedVersion')).toBeNull();
  expect(state().notice).toBeNull();
  expect(state().status).toBe('idle');
});

it('keeps release notes directly readable from both details entry points', async () => {
  await act(async () => state().checkForUpdates());
  const notes = container.querySelector('[data-openbitfun-part="notes"]');
  expect(notes?.textContent).toContain('Release changes');
  expect(container.querySelector('details')).toBeNull();
  act(() => state().openReleaseNotes());
  expect(container.querySelector('[data-openbitfun-part="notes"]')).toBe(notes);
  act(() => state().closeDetails());
  expect(state().releaseNotesOpen).toBe(false);
  act(() => state().openDetails());
  expect(container.querySelector('[data-openbitfun-part="notes"]')).toBe(notes);
  expect(notes?.textContent).toContain('Release changes');
});

it('keeps download details on the version being downloaded when discovery advances', async () => {
  await act(async () => state().checkForUpdates());
  act(() => useUpdateInstallStore.setState({
    status: 'downloading', downloadVersion: '1.5.0', progress: { downloaded: 50, total: 100 },
  }));
  expect(container.textContent).toContain('v1.5.0');
  expect(container.textContent).not.toContain('v2.0.0');
  expect(container.textContent).not.toContain('Release changes');
  expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('50');
});
