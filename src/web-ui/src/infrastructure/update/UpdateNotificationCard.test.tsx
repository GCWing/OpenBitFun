// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import common from '@/locales/en-US/common.json';
import { UpdateNotificationCard } from './UpdateNotificationCard';
import { UpdateIndicator } from './UpdateIndicator';
import { useUpdateInstallStore } from './updateInstallStore';
import type { UpdateDownloadProgressPayload } from './installUpdateWithProgress';

const mocks = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock('./tauriEnv', () => ({ canCheckForAppUpdates: () => true }));
vi.mock('@/infrastructure/api/service-api/SystemAPI', () => ({ systemAPI: {} }));
vi.mock('./installUpdateWithProgress', () => ({ installUpdateWithProgress: mocks.download }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({
  t: (key: string, args?: Record<string, unknown>) => {
    const value = key.split('.').reduce<unknown>((value, part) => (value as Record<string, unknown>)?.[part], common);
    return String(value ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) => String(args?.[name] ?? ''));
  },
  formatNumber: String,
}) }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const state = () => useUpdateInstallStore.getState();
const card = () => container.querySelector('[data-testid="app-update-notice"]');
const dots = () => container.querySelectorAll('[data-testid="app-update-indicator"]');
const tick = (ms: number) => act(() => vi.advanceTimersByTime(ms));

beforeEach(async () => {
  vi.useFakeTimers();
  mocks.download.mockReset();
  localStorage.clear();
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  useUpdateInstallStore.setState({
    availableUpdate: { updateAvailable: true, currentVersion: '1.0.0', latestVersion: '2.0.0', releaseNotes: null, releaseDate: null },
    skippedVersion: null, detailsOpen: false, releaseNotesOpen: false, status: 'idle', version: null, downloadVersion: null,
    progress: { downloaded: 0, total: null }, currentVersion: '1.0.0',
    notice: 'available', noticeRevision: 0, error: null, promptOpen: false, initialized: true,
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<><UpdateNotificationCard /><UpdateIndicator /><UpdateIndicator /></>));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('stays visible without a countdown until explicitly closed, preserving attention', () => {
  expect(document.activeElement).toBe(document.body);
  tick(60000);
  act(() => document.body.click());
  expect(card()).not.toBeNull();
  expect(card()?.querySelector('[data-openbitfun-part="noticeCountdown"]')).toBeNull();
  const close = card()!.querySelector<HTMLButtonElement>(`button[aria-label="${common.actions.close}"]`)!;
  act(() => close.click());
  expect(card()).toBeNull();
  expect(dots()).toHaveLength(2);
  expect(state().skippedVersion).toBeNull();
});

it('dismisses on Escape from the card without skipping the release', () => {
  act(() => {
    const title = card()!.querySelector<HTMLButtonElement>('[data-testid="app-update-release-notes"]')!;
    title.focus();
    title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  expect(card()).toBeNull();
  expect(dots()).toHaveLength(2);
  expect(state().skippedVersion).toBeNull();
});

it('keeps the notice through keyboard focus and background/foreground changes', () => {
  const button = card()!.querySelector<HTMLButtonElement>('button')!;
  act(() => button.focus());
  tick(30000);
  expect(card()).not.toBeNull();
  act(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    button.blur();
  });
  tick(30000);
  expect(card()).not.toBeNull();
  act(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  tick(60000);
  expect(card()).not.toBeNull();
});

it('clears both indicators only when the version is explicitly skipped', () => {
  const skip = Array.from(card()!.querySelectorAll('button')).find(button => button.textContent === common.update.skipVersion)!;
  expect(skip.getAttribute('data-openbitfun-component')).toBe('button');
  expect(skip.getAttribute('data-openbitfun-variant')).toBe('outline');
  act(() => skip.click());
  expect(card()).toBeNull();
  expect(dots()).toHaveLength(0);
  expect(localStorage.getItem('openbitfun:update:skippedVersion')).toBe('2.0.0');
});

it('opens release notes from the version title while keeping both indicators', () => {
  const details = card()!.querySelector<HTMLButtonElement>('[data-testid="app-update-release-notes"]')!;
  expect(details.textContent).toContain('OpenBitFun v2.0.0');
  expect(details.getAttribute('aria-haspopup')).toBe('dialog');
  act(() => details.click());
  expect(state().detailsOpen).toBe(true);
  expect(state().releaseNotesOpen).toBe(true);
  expect(card()).toBeNull();
  expect(dots()).toHaveLength(2);
});

it('shows the published introduction as plain text and keeps it while downloading', () => {
  const releaseNotes = '# Version 2.0.0\n\nFaster **file navigation** and a smoother [workspace](https://example.com).\n\n## Fixes\n\nMore reliable connections.';
  act(() => useUpdateInstallStore.setState({ availableUpdate: { ...state().availableUpdate!, releaseNotes } }));
  const introduction = card()!.querySelector('[data-testid="app-update-introduction"]');
  expect(introduction?.textContent).toBe('Faster file navigation and a smoother workspace.');
  expect(introduction?.querySelector('a')).toBeNull();
  expect(state().availableUpdate?.releaseNotes).toBe(releaseNotes);
  act(() => useUpdateInstallStore.setState({ notice: 'downloading', status: 'downloading', downloadVersion: '2.0.0' }));
  expect(card()!.querySelector('[data-testid="app-update-introduction"]')).toBe(introduction);
  expect(introduction?.textContent).toBe('Faster file navigation and a smoother workspace.');
});

it.each([null, '', '# Version 2.0.0\n\n![Badge](https://example.com/badge.svg)'])('uses decorative artwork without placeholder copy when a release has no summary: %s', releaseNotes => {
  act(() => useUpdateInstallStore.setState({ availableUpdate: { ...state().availableUpdate!, releaseNotes } }));
  const artwork = card()!.querySelector('[data-testid="app-update-release-artwork"]');
  expect(artwork?.getAttribute('aria-hidden')).toBe('true');
  expect(artwork?.textContent).toBe('');
  expect(card()!.querySelector('[data-testid="app-update-introduction"]')).toBeNull();
  expect(state().availableUpdate?.releaseNotes).toBe(releaseNotes);
  const buttons = Array.from(card()!.querySelectorAll('button'));
  expect(buttons.find(button => button.textContent === common.update.downloadUpdate)?.disabled).toBe(false);
  expect(buttons.find(button => button.textContent === common.update.skipVersion)?.disabled).toBe(false);
  act(() => useUpdateInstallStore.setState({ notice: 'downloading', status: 'downloading', downloadVersion: '2.0.0' }));
  expect(card()!.querySelector('[data-testid="app-update-release-artwork"]')).toBe(artwork);
});

it('does not describe an older download target with a newer release introduction', () => {
  act(() => useUpdateInstallStore.setState({
    availableUpdate: { ...state().availableUpdate!, releaseNotes: 'New features in version 2.0.0.' },
    notice: 'downloading', status: 'downloading', downloadVersion: '1.5.0',
  }));
  expect(card()!.querySelector('[data-testid="app-update-introduction"]')).toBeNull();
  expect(card()?.textContent).toContain('OpenBitFun v1.5.0');
});

it('keeps download progress and failures visible until the user closes them', () => {
  const originalCard = card();
  act(() => useUpdateInstallStore.setState({ notice: 'downloading', noticeRevision: 1, status: 'downloading', downloadVersion: '2.0.0' }));
  tick(30000);
  expect(card()).not.toBeNull();
  act(() => useUpdateInstallStore.setState({ notice: 'error', noticeRevision: 2, status: 'error', error: 'network offline' }));
  tick(30000);
  expect(card()?.textContent).toContain(common.update.errors.network);
  expect(card()).toBe(originalCard);
  expect(card()?.querySelector('[data-testid="app-update-release-notes"]')?.textContent).toContain('2.0.0');
  const close = card()!.querySelector<HTMLButtonElement>(`button[aria-label="${common.actions.close}"]`)!;
  act(() => close.click());
  expect(card()).toBeNull();
  expect(dots()).toHaveLength(2);
});

it('keeps download controls enabled without redundant copy', () => {
  expect(card()?.textContent).not.toContain(common.update.backgroundDownloadHint);
  expect(card()?.querySelector('[data-openbitfun-part="subtitle"]')).toBeNull();
  const buttons = Array.from(card()!.querySelectorAll('button'));
  expect(buttons.find(button => button.textContent === common.update.downloadUpdate)?.disabled).toBe(false);
});

it.each([false, true])('finishes without a completion card whether progress was dismissed (%s)', async dismissed => {
  let reportProgress!: (progress: UpdateDownloadProgressPayload) => void;
  let finish!: (pending: { version: string }) => void;
  mocks.download.mockImplementationOnce(onProgress => {
    reportProgress = onProgress;
    return new Promise(resolve => { finish = resolve; });
  });
  const originalCard = card();
  const download = Array.from(card()!.querySelectorAll('button'))
    .find(button => button.textContent === common.update.downloadUpdate)!;
  await act(async () => download.click());
  expect(mocks.download).toHaveBeenCalledWith(expect.any(Function), '2.0.0');
  act(() => reportProgress({ downloaded: 50, total: 100 }));
  expect(card()).toBe(originalCard);
  expect(card()?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('50');
  if (dismissed) {
    const close = card()!.querySelector<HTMLButtonElement>(`button[aria-label="${common.actions.close}"]`)!;
    act(() => close.click());
    expect(card()).toBeNull();
  }
  expect(state().status).toBe('downloading');
  await act(async () => finish({ version: '2.0.0' }));
  expect(state()).toMatchObject({ status: 'ready', version: '2.0.0', promptOpen: false, notice: null });
  expect(card()).toBeNull();
  tick(60000);
  expect(card()).toBeNull();
});
