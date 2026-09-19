// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DailyAppUpdateGate } from './DailyAppUpdateGate';
import { useUpdateInstallStore } from './updateInstallStore';

const mocks = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock('@/infrastructure/api/service-api/SystemAPI', () => ({ systemAPI: { checkForUpdates: mocks.check } }));
vi.mock('./installUpdateWithProgress', () => ({ installUpdateWithProgress: vi.fn() }));
vi.mock('./UpdateInstallProgressModal', () => ({ UpdateInstallProgressModal: () => null }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it('synchronizes skips in development without starting discovery or dismissing another version', async () => {
  vi.stubEnv('DEV', true);
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
