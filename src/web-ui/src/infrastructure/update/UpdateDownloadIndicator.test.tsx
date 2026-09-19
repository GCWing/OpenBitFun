// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import common from '@/locales/en-US/common.json';
import { UpdateDownloadIndicator } from './UpdateDownloadIndicator';
import { UpdateNotificationCard } from './UpdateNotificationCard';
import { UpdateIndicator } from './UpdateIndicator';
import { useUpdateInstallStore } from './updateInstallStore';
import { getUpdateDownloadFraction } from './updateDownloadProgress';
import type { UpdateDownloadProgressPayload } from './installUpdateWithProgress';

const mocks = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock('./tauriEnv', () => ({ canCheckForAppUpdates: () => true }));
vi.mock('@/infrastructure/api/service-api/SystemAPI', () => ({ systemAPI: {} }));
vi.mock('./installUpdateWithProgress', () => ({ installUpdateWithProgress: mocks.download }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({
  t: (key: string, args?: Record<string, unknown>) => {
    const value = key.split('.').reduce<unknown>((value, part) => (value as Record<string, unknown>)?.[part], common);
    return String(value ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) => String(args?.[name] ?? ''));
  }, formatNumber: String,
}) }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const state = () => useUpdateInstallStore.getState();
const control = () => container.querySelector('[data-testid="nav-update-download"]');
const progress = () => control()?.querySelector('[role="progressbar"]');

beforeEach(async () => {
  vi.useFakeTimers();
  mocks.download.mockReset();
  localStorage.clear();
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  useUpdateInstallStore.setState({
    availableUpdate: { updateAvailable: true, currentVersion: '1.0.0', latestVersion: '2.0.0', releaseNotes: 'A smoother workspace.', releaseDate: null },
    skippedVersion: null, detailsOpen: false, releaseNotesOpen: false, status: 'idle', version: null, downloadVersion: null,
    progress: { downloaded: 0, total: null }, currentVersion: '1.0.0',
    notice: 'available', noticeRevision: 0, error: null, promptOpen: false, initialized: true,
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<>
    <UpdateNotificationCard /><UpdateDownloadIndicator />
    <div data-testid="more-dot"><UpdateIndicator /></div>
    <div data-testid="menu-dot"><UpdateIndicator /></div>
  </>));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.getElementById('openbitfun-appearance-overlay-host')?.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

it('hands reminder attention to bottom-up progress and reopens the progress card on activation', () => {
  expect(control()).toBeNull();
  act(() => useUpdateInstallStore.setState({ status: 'downloading', downloadVersion: '2.0.0', progress: { downloaded: 25, total: 100 } }));
  expect(progress()?.getAttribute('aria-valuenow')).toBe('25');
  expect(control()?.querySelector<HTMLElement>('[data-openbitfun-part="downloadFill"]')?.style.transform).toBe('translateY(75%)');
  expect(container.querySelectorAll('[data-testid="app-update-indicator"]')).toHaveLength(0);
  act(() => container.querySelector<HTMLButtonElement>('[data-testid="nav-update-download-button"]')!.click());
  expect(state()).toMatchObject({ detailsOpen: false, notice: 'downloading' });
  expect(state().status).toBe('downloading');
  expect(control()).not.toBeNull();
});

it('hands the shallow wave to real progress without a spinner or fabricated percentage', () => {
  act(() => useUpdateInstallStore.setState({ status: 'downloading', downloadVersion: '2.0.0', progress: { downloaded: 1024, total: null } }));
  const fill = control()?.querySelector<HTMLElement>('[data-openbitfun-part="downloadFill"]');
  expect(progress()?.hasAttribute('aria-valuenow')).toBe(false);
  expect(control()?.querySelector('[data-openbitfun-component="spinner"]')).toBeNull();
  expect(fill?.getAttribute('data-openbitfun-state')).toBe('indeterminate');
  expect(fill?.style.transform).toBe('');
  expect(state().progress).toEqual({ downloaded: 1024, total: null });
  act(() => useUpdateInstallStore.setState({ progress: { downloaded: 1024, total: 4096 } }));
  expect(progress()?.getAttribute('aria-valuenow')).toBe('25');
  expect(control()?.querySelector('[data-openbitfun-part="downloadFill"]')).toBe(fill);
  expect(fill?.hasAttribute('data-openbitfun-state')).toBe(false);
  expect(fill?.style.transform).toBe('translateY(75%)');
  expect(control()?.querySelector('[data-openbitfun-component="spinner"]')).toBeNull();
});

it('hands a download to navigation and opens installation confirmation from the completed checkmark', async () => {
  let reportProgress!: (progress: UpdateDownloadProgressPayload) => void;
  let finish!: (pending: { version: string }) => void;
  mocks.download.mockImplementationOnce(onProgress => {
    reportProgress = onProgress;
    return new Promise(resolve => { finish = resolve; });
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(160, 680, 28, 28));
  const download = Array.from(container.querySelectorAll('button')).find(button => button.textContent === common.update.downloadUpdate)!;
  await act(async () => download.click());
  expect(container.querySelector('[data-testid="app-update-notice"]')).toBeNull();
  expect(state().status).toBe('downloading');
  expect(mocks.download).toHaveBeenCalledWith(expect.any(Function), '2.0.0');
  act(() => reportProgress({ downloaded: 50, total: 100 }));
  expect(progress()?.getAttribute('aria-valuenow')).toBe('50');
  await act(async () => finish({ version: '2.0.0' }));
  expect(control()?.getAttribute('data-download-status')).toBe('ready');
  expect(container.querySelector('[data-testid="app-update-notice"]')).toBeNull();
  expect(control()?.querySelector('[data-openbitfun-part="downloadFill"]')).toBeNull();
  expect(control()?.querySelector('.openbitfun-update-download__complete')).not.toBeNull();
  expect(state().promptOpen).toBe(false);
  const completed = container.querySelector<HTMLButtonElement>('[data-testid="nav-update-download-button"]')!;
  expect(completed.getAttribute('aria-label')).toBe(common.update.installAndRestart);
  act(() => completed.click());
  expect(state()).toMatchObject({ promptOpen: true, detailsOpen: false, status: 'ready', version: '2.0.0', notice: null });
  act(() => state().deferInstall());
  expect(state().promptOpen).toBe(false);
  expect(control()?.getAttribute('data-download-status')).toBe('ready');
  act(() => state().skipVersion('2.0.0'));
  expect(control()?.getAttribute('data-download-status')).toBe('ready');
  expect(container.querySelectorAll('[data-testid="app-update-indicator"]')).toHaveLength(0);
});

it('keeps an older downloaded package installable while More reminds about the failed replacement', () => {
  act(() => useUpdateInstallStore.setState({
    status: 'ready', version: '1.5.0', downloadVersion: '2.0.0', error: 'network offline',
  }));
  expect(control()?.getAttribute('data-download-status')).toBe('ready');
  expect(container.querySelectorAll('[data-testid="app-update-indicator"]')).toHaveLength(2);
  expect(progress()).toBeNull();
  act(() => container.querySelector<HTMLButtonElement>('[data-testid="nav-update-download-button"]')!.click());
  expect(state()).toMatchObject({ promptOpen: true, version: '1.5.0', detailsOpen: false });
});

it('returns failed downloads without a prepared package to the menu reminder', () => {
  act(() => useUpdateInstallStore.setState({
    status: 'error', downloadVersion: '2.0.0', error: 'network offline',
  }));
  expect(control()).toBeNull();
  expect(container.querySelectorAll('[data-testid="app-update-indicator"]')).toHaveLength(2);
});

it('clamps real byte counts and handles invalid totals without a fabricated percentage', () => {
  expect(getUpdateDownloadFraction({ downloaded: -1, total: 100 })).toBe(0);
  expect(getUpdateDownloadFraction({ downloaded: 150, total: 100 })).toBe(1);
  expect(getUpdateDownloadFraction({ downloaded: 10, total: 0 })).toBeNull();
  expect(getUpdateDownloadFraction({ downloaded: 10, total: Number.NaN })).toBeNull();
});
