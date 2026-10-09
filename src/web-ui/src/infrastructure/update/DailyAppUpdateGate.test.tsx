// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Dialog } from '@openbitfun/ui';
import { DailyAppUpdateGate } from './DailyAppUpdateGate';
import { useUpdateInstallStore } from './updateInstallStore';
import { writeAppUpdateSnapshot } from './appUpdateStorage';

const mocks = vi.hoisted(() => ({ check: vi.fn(), foreground: true }));
vi.mock('@/infrastructure/api/service-api/SystemAPI', () => ({ systemAPI: {
  checkForUpdates: mocks.check, getLocalAppVersion: async () => '1.0.0', getPendingUpdate: async () => null,
  getAutoUpdateEnabled: async () => true, onAutoUpdateEnabledChange: () => () => {},
} }));
vi.mock('@/shared/utils/startupTaskScheduling', () => ({ scheduleAfterStartupSignal: (start: () => void) => { start(); return () => {}; } }));
vi.mock('./installUpdateWithProgress', () => ({ installUpdateWithProgress: vi.fn() }));
vi.mock('./UpdateInstallProgressModal', () => ({ UpdateInstallProgressModal: () => null }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('DEV', false);
  vi.stubGlobal('__TAURI__', {});
  mocks.foreground = true;
  vi.spyOn(document, 'hasFocus').mockImplementation(() => mocks.foreground);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  mocks.check.mockReset().mockResolvedValue({ updateAvailable: false, currentVersion: '1.0.0', latestVersion: null, releaseNotes: null, releaseDate: null });
  useUpdateInstallStore.setState(useUpdateInstallStore.getInitialState());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('synchronizes skips in development without starting discovery or dismissing another version', async () => {
  vi.stubEnv('DEV', true);
  mocks.foreground = false;
  vi.stubGlobal('__TAURI__', {});
  localStorage.clear();
  useUpdateInstallStore.setState({
    ...useUpdateInstallStore.getInitialState(), initialized: true, currentVersion: '1.0.0',
    status: 'ready', version: '1.5.0', notice: 'available', availableUpdate: {
      updateAvailable: true, currentVersion: '1.0.0', latestVersion: '2.0.0',
      releaseNotes: null, releaseDate: null,
    },
  });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<DailyAppUpdateGate />));
    act(() => {
      localStorage.setItem('openbitfun:update:skippedVersion', '1.5.0');
      window.dispatchEvent(new StorageEvent('storage', { key: 'openbitfun:update:skippedVersion' }));
    });
    expect(useUpdateInstallStore.getState()).toMatchObject({ skippedVersion: '1.5.0', notice: 'available' });
    act(() => {
      localStorage.setItem('openbitfun:update:skippedVersion', '2.0.0');
      window.dispatchEvent(new StorageEvent('storage', { key: 'openbitfun:update:skippedVersion' }));
    });
    expect(useUpdateInstallStore.getState()).toMatchObject({ skippedVersion: '2.0.0', notice: null, version: '1.5.0' });
    expect(mocks.check).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});

it('checks startup after five seconds, then uses a six-hour deadline across focus changes', async () => {
  writeAppUpdateSnapshot({ result: await mocks.check(), checkedAt: Date.now() - 3 * 60 * 60 * 1000 });
  mocks.check.mockClear();
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<DailyAppUpdateGate />));
    await act(async () => vi.advanceTimersByTimeAsync(4999));
    expect(mocks.check).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(mocks.check).toHaveBeenCalledOnce();
    mocks.foreground = false;
    act(() => window.dispatchEvent(new Event('blur')));
    await act(async () => vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000));
    expect(mocks.check).toHaveBeenCalledOnce();
    mocks.foreground = true;
    act(() => window.dispatchEvent(new Event('focus')));
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(mocks.check).toHaveBeenCalledTimes(2);
    act(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); });
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(mocks.check).toHaveBeenCalledTimes(2);
  } finally { await act(async () => root.unmount()); }
});

it('holds a ready installation behind background and modal barriers, then presents it without installing', async () => {
  vi.stubEnv('DEV', true);
  mocks.foreground = false;
  const root = createRoot(document.createElement('div'));
  useUpdateInstallStore.setState({ initialized: true, currentVersion: '1.0.0', status: 'ready', version: '2.0.0' });
  try {
    await act(async () => root.render(<><Dialog open aria-label="Another dialog">Busy</Dialog><DailyAppUpdateGate /></>));
    expect(useUpdateInstallStore.getState().promptOpen).toBe(false);
    mocks.foreground = true;
    act(() => window.dispatchEvent(new Event('focus')));
    expect(useUpdateInstallStore.getState().promptOpen).toBe(false);
    await act(async () => root.render(<DailyAppUpdateGate />));
    expect(useUpdateInstallStore.getState().promptOpen).toBe(true);
    act(() => useUpdateInstallStore.getState().deferInstall());
    expect(useUpdateInstallStore.getState().promptOpen).toBe(false);
    act(() => window.dispatchEvent(new Event('focus')));
    expect(useUpdateInstallStore.getState().promptOpen).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000));
    expect(useUpdateInstallStore.getState().promptOpen).toBe(true);
  } finally { await act(async () => root.unmount()); }
});

it('retries a failed check once after thirty minutes, then waits six hours', async () => {
  mocks.check.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('still offline'));
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<DailyAppUpdateGate />));
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(mocks.check).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(30 * 60 * 1000));
    expect(mocks.check).toHaveBeenCalledTimes(2);
    act(() => window.dispatchEvent(new Event('online')));
    await act(async () => vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000));
    expect(mocks.check).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(60 * 60 * 1000));
    expect(mocks.check).toHaveBeenCalledTimes(3);
    expect(useUpdateInstallStore.getState().consecutiveCheckFailures).toBe(0);
  } finally { await act(async () => root.unmount()); }
});

it('consumes startup freshness once when a hidden launch first gains focus', async () => {
  mocks.foreground = false;
  writeAppUpdateSnapshot({ result: await mocks.check(), checkedAt: Date.now() - 60 * 60 * 1000 });
  mocks.check.mockClear();
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<DailyAppUpdateGate />));
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    mocks.foreground = true;
    act(() => window.dispatchEvent(new Event('focus')));
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(mocks.check).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000));
    expect(mocks.check).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000));
    expect(mocks.check).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); }
});
