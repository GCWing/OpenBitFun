// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Menu } from '@openbitfun/ui';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import common from '@/locales/en-US/common.json';
import { UpdateMenuItems } from './UpdateMenuItems';
import { selectHasUpdateAttention, useUpdateInstallStore } from './updateInstallStore';
import { writeAppUpdateSnapshot } from './appUpdateStorage';

const mocks = vi.hoisted(() => ({
  check: vi.fn(), current: vi.fn(), pending: vi.fn(), download: vi.fn(), closeMenu: vi.fn(),
  notifications: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('@/infrastructure/api/service-api/SystemAPI', () => ({ systemAPI: {
  checkForUpdates: mocks.check, getLocalAppVersion: mocks.current, getPendingUpdate: mocks.pending,
} }));
vi.mock('./installUpdateWithProgress', () => ({ installUpdateWithProgress: mocks.download }));
vi.mock('@/shared/notification-system/services/NotificationService', () => ({ notificationService: mocks.notifications }));
vi.mock('@/shared/utils/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({
  t: (key: string, args?: Record<string, unknown>) => {
    const value = key.split('.').reduce<unknown>((value, part) => (value as Record<string, unknown>)?.[part], common);
    return String(value ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) => String(args?.[name] ?? ''));
  },
}) }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const state = () => useUpdateInstallStore.getState();
const check = () => container.querySelector<HTMLButtonElement>('[data-testid="nav-check-updates"]')!;
const reminder = () => check()?.querySelector('[data-testid="app-update-indicator"]');
const release = (version = '2.0.0') => ({ updateAvailable: true, currentVersion: '1.0.0', latestVersion: version, releaseNotes: 'Changes', releaseDate: null });

beforeEach(async () => {
  vi.stubEnv('DEV', true);
  vi.stubGlobal('__TAURI__', {});
  mocks.check.mockReset().mockResolvedValue(release());
  mocks.current.mockReset().mockResolvedValue('1.0.0');
  mocks.pending.mockReset().mockResolvedValue(null);
  mocks.download.mockReset();
  mocks.closeMenu.mockReset();
  Object.values(mocks.notifications).forEach(notify => notify.mockReset());
  localStorage.clear();
  useUpdateInstallStore.setState({
    status: 'idle', progress: { downloaded: 0, total: null }, error: null, startedAt: null,
    version: null, downloadVersion: null, promptOpen: false, initialized: true, currentVersion: '1.0.0',
    availableUpdate: null, checkStatus: 'idle', checkError: null, lastCheckedAt: null, lastCheckAttemptAt: null,
    skippedVersion: null, notice: null, noticeRevision: 0, detailsOpen: false, releaseNotesOpen: false,
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Menu><UpdateMenuItems onCloseMenu={mocks.closeMenu} /></Menu>));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('keeps the manual check available in desktop development before discovery', () => {
  expect(check().textContent).toBe(common.update.checkForUpdates);
  expect(check().disabled).toBe(false);
  expect(reminder()).toBeNull();
  expect(mocks.check).not.toHaveBeenCalled();
});

it('does not light a reminder or check the network when opening More in dev 1.0.1 with a stale discovery cache', async () => {
  await act(async () => root.render(<Menu><span /></Menu>));
  mocks.current.mockResolvedValue('1.0.1');
  writeAppUpdateSnapshot({ checkedAt: Date.now(), result: { ...release('1.0.1'), currentVersion: '1.0.1' } });
  useUpdateInstallStore.setState({ initialized: false, currentVersion: null });
  await act(async () => root.render(<Menu><UpdateMenuItems onCloseMenu={mocks.closeMenu} /></Menu>));
  expect(state()).toMatchObject({ initialized: true, currentVersion: '1.0.1', availableUpdate: null, checkStatus: 'idle' });
  expect(check().textContent).toBe(common.update.checkForUpdates);
  expect(check().disabled).toBe(false);
  expect(reminder()).toBeNull();
  expect(mocks.check).not.toHaveBeenCalled();
  expect(mocks.current).toHaveBeenCalledOnce();
});

it('keeps one row, checks once, and uses its blue dot to reopen the download/skip card', async () => {
  let finish!: (result: ReturnType<typeof release>) => void;
  mocks.check.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => check().click());
  expect(check().disabled).toBe(true);
  expect(check().textContent).toContain(common.update.checking);
  await act(async () => check().click());
  expect(mocks.check).toHaveBeenCalledOnce();
  await act(async () => finish(release()));
  expect(check().disabled).toBe(false);
  expect(reminder()).not.toBeNull();
  expect(check().textContent).toBe(common.update.checkForUpdates);
  expect(container.querySelectorAll('[role="menuitem"]')).toHaveLength(1);
  expect(state()).toMatchObject({ notice: 'available', detailsOpen: false, promptOpen: false });
  expect(mocks.closeMenu).toHaveBeenCalledOnce();
  expect(mocks.download).not.toHaveBeenCalled();
  act(() => state().dismissNotice());
  expect(selectHasUpdateAttention(state())).toBe(true);
  await act(async () => check().click());
  expect(state()).toMatchObject({ notice: 'available', detailsOpen: false, promptOpen: false });
  expect(mocks.closeMenu).toHaveBeenCalledTimes(2);
  expect(mocks.check).toHaveBeenCalledOnce();
});

it('uses notifications for manual results and keeps the menu action unchanged', async () => {
  mocks.check.mockResolvedValueOnce({ ...release(), updateAvailable: false, latestVersion: null });
  await act(async () => check().click());
  expect(check().textContent).toBe(common.update.checkForUpdates);
  expect(reminder()).toBeNull();
  expect(mocks.notifications.success).toHaveBeenCalledExactlyOnceWith(common.update.noUpdate, { title: common.update.checkForUpdates });
  mocks.check.mockRejectedValueOnce(new Error('network offline'));
  await act(async () => check().click());
  expect(check().textContent).toBe(common.update.checkForUpdates);
  expect(check().disabled).toBe(false);
  expect(mocks.notifications.error).toHaveBeenCalledExactlyOnceWith(common.update.errors.network, { title: common.update.checkFailed });
  expect(mocks.notifications.info).not.toHaveBeenCalled();
  expect(mocks.closeMenu).toHaveBeenCalledTimes(2);
  expect(state()).toMatchObject({ detailsOpen: false, promptOpen: false, notice: null });
  await act(async () => root.render(<Menu><span /></Menu>));
  await act(async () => root.render(<Menu><UpdateMenuItems onCloseMenu={mocks.closeMenu} /></Menu>));
  expect(check().textContent).toBe(common.update.checkForUpdates);
  expect(mocks.notifications.success).toHaveBeenCalledOnce();
  expect(mocks.notifications.error).toHaveBeenCalledOnce();
});

it.each(['latest', 'error'] as const)('delivers a manual %s result after the menu is closed', async outcome => {
  let finish!: () => void;
  mocks.check.mockImplementationOnce(() => new Promise((resolve, reject) => {
    finish = () => outcome === 'latest'
      ? resolve({ ...release(), updateAvailable: false, latestVersion: null })
      : reject(new Error('network offline'));
  }));
  await act(async () => check().click());
  await act(async () => root.render(<Menu><span /></Menu>));
  await act(async () => finish());
  expect(mocks.notifications[outcome === 'latest' ? 'success' : 'error']).toHaveBeenCalledOnce();
  expect(state()).toMatchObject({ notice: null, detailsOpen: false, promptOpen: false });
  expect(mocks.closeMenu).not.toHaveBeenCalled();
});

it('does not notify for passive state changes or reopening a previously checked menu', async () => {
  await act(async () => state().checkForUpdates());
  mocks.check.mockResolvedValueOnce({ ...release(), updateAvailable: false, latestVersion: null });
  await act(async () => state().checkForUpdates());
  await act(async () => root.render(<Menu><span /></Menu>));
  await act(async () => root.render(<Menu><UpdateMenuItems onCloseMenu={mocks.closeMenu} /></Menu>));
  expect(check().textContent).toBe(common.update.checkForUpdates);
  Object.values(mocks.notifications).forEach(notify => expect(notify).not.toHaveBeenCalled());
});

it('reports an already-downloaded release through a notification without opening installation', async () => {
  act(() => useUpdateInstallStore.setState({ status: 'ready', version: '2.0.0' }));
  await act(async () => check().click());
  expect(check().textContent).toBe(common.update.checkForUpdates);
  expect(reminder()).toBeNull();
  expect(mocks.notifications.info).toHaveBeenCalledExactlyOnceWith(
    common.update.readyVersion.replace('{{version}}', '2.0.0'), { title: common.update.checkForUpdates },
  );
  expect(mocks.notifications.success).not.toHaveBeenCalled();
  expect(mocks.download).not.toHaveBeenCalled();
  expect(state()).toMatchObject({ notice: null, detailsOpen: false, promptOpen: false, version: '2.0.0' });
});

it('preserves a known release if a subsequent manual check fails', async () => {
  await act(async () => check().click());
  act(() => state().dismissNotice());
  mocks.check.mockRejectedValueOnce(new Error('network offline'));
  await act(async () => state().checkForUpdates());
  expect(check().textContent).toBe(common.update.checkForUpdates);
  expect(reminder()).not.toBeNull();
  expect(state().availableUpdate?.latestVersion).toBe('2.0.0');
  expect(selectHasUpdateAttention(state())).toBe(true);
});

it('allows an explicit check to revisit a skipped release without restoring its dots', async () => {
  act(() => state().skipVersion('2.0.0'));
  await act(async () => check().click());
  expect(reminder()).toBeNull();
  expect(container.querySelector('[data-testid="app-update-indicator"]')).toBeNull();
  expect(state()).toMatchObject({ skippedVersion: '2.0.0', notice: 'available', detailsOpen: false });
  expect(selectHasUpdateAttention(state())).toBe(false);
  expect(localStorage.getItem('openbitfun:update:skippedVersion')).toBe('2.0.0');
});

it('leaves the downloaded version to the checkmark but reminds about a newer release', async () => {
  act(() => useUpdateInstallStore.setState({ status: 'ready', version: '2.0.0', availableUpdate: release() }));
  expect(reminder()).toBeNull();
  expect(selectHasUpdateAttention(state())).toBe(false);
  expect(check().disabled).toBe(false);
  expect(check().textContent).toBe(common.update.checkForUpdates);
  expect(container.querySelectorAll('[role="menuitem"]')).toHaveLength(1);
  mocks.check.mockResolvedValueOnce(release('2.1.0'));
  await act(async () => check().click());
  expect(reminder()).not.toBeNull();
  expect(check().textContent).toBe(common.update.checkForUpdates);
  expect(state().version).toBe('2.0.0');
  act(() => useUpdateInstallStore.setState({ status: 'downloading', downloadVersion: '2.1.0' }));
  expect(reminder()).toBeNull();
  expect(check().disabled).toBe(true);
  act(() => useUpdateInstallStore.setState({ status: 'ready', error: 'network offline' }));
  expect(reminder()).not.toBeNull();
  expect(check().textContent).toBe(common.update.checkForUpdates);
  await act(async () => check().click());
  expect(state()).toMatchObject({ notice: 'error', detailsOpen: false, version: '2.0.0' });
});

it('shows a known version on hover and opens the card only on click', async () => {
  vi.useFakeTimers();
  await act(async () => state().checkForUpdates());
  expect(state()).toMatchObject({ notice: null, detailsOpen: false, promptOpen: false });
  expect(reminder()).not.toBeNull();
  expect(check().textContent).toBe(common.update.checkForUpdates);
  expect(container.querySelectorAll('[role="menuitem"]')).toHaveLength(1);
  act(() => check().dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('2.0.0');
  expect(check().textContent).toBe(common.update.checkForUpdates);
  expect(state().notice).toBeNull();
  await act(async () => check().click());
  expect(state()).toMatchObject({ notice: 'available', detailsOpen: false, promptOpen: false });
  expect(mocks.closeMenu).toHaveBeenCalledOnce();
  expect(mocks.check).toHaveBeenCalledOnce();
  expect(mocks.download).not.toHaveBeenCalled();
  act(() => state().skipVersion('2.0.0'));
  expect(reminder()).toBeNull();
  expect(state().notice).toBeNull();
  expect(localStorage.getItem('openbitfun:update:skippedVersion')).toBe('2.0.0');
});

it('delivers an available release through the existing card after the menu is closed during a check', async () => {
  let finish!: (result: ReturnType<typeof release>) => void;
  mocks.check.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => check().click());
  await act(async () => root.render(<Menu><span /></Menu>));
  await act(async () => finish(release()));
  expect(state()).toMatchObject({ notice: 'available', detailsOpen: false, promptOpen: false });
  expect(selectHasUpdateAttention(state())).toBe(true);
  Object.values(mocks.notifications).forEach(notify => expect(notify).not.toHaveBeenCalled());
  expect(mocks.closeMenu).not.toHaveBeenCalled();
});

it('omits desktop update actions on unsupported surfaces', () => {
  Reflect.deleteProperty(window, '__TAURI__');
  act(() => useUpdateInstallStore.setState({ lastCheckedAt: Date.now() }));
  expect(container.querySelector('[data-testid="nav-check-updates"]')).toBeNull();
  expect(container.querySelector('[data-testid="app-update-indicator"]')).toBeNull();
});
