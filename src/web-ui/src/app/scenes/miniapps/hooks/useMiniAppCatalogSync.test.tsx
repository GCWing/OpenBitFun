/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';
import type { MiniAppMeta } from '@/infrastructure/api/service-api/MiniAppAPI';
import { useMiniAppStore } from '../miniAppStore';
import { useMiniAppNavigationStore } from '../miniAppNavigationStore';
import { useMiniAppCatalogSync } from './useMiniAppCatalogSync';

const mocks = vi.hoisted(() => ({
  listMiniApps: vi.fn(), workerListRunning: vi.fn(),
  listeners: new Map<string, (payload: { id: string }) => void>(),
}));
vi.mock('@/infrastructure/api/service-api/MiniAppAPI', () => ({ miniAppAPI: mocks }));
vi.mock('../utils/loadInstalledMarketOrigins', () => ({ loadInstalledMarketOrigins: async () => ({}) }));
vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({ api: {
  listen: (event: string, handler: (payload: { id: string }) => void) => {
    mocks.listeners.set(event, handler);
    return () => mocks.listeners.delete(event);
  },
} }));
vi.mock('@/shared/utils/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn() }) }));

const localApp = { id: 'notes', name: 'Local Notes' } as MiniAppMeta;
const peerApp = { id: 'notes', name: 'Peer Notes' } as MiniAppMeta;
let root: Root;
function Harness() { useMiniAppCatalogSync(); return null; }

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  resetDeviceSurfaceForTest();
  vi.clearAllMocks();
  mocks.listeners.clear();
  mocks.listMiniApps.mockReset().mockResolvedValue([localApp]);
  mocks.workerListRunning.mockReset().mockResolvedValue([]);
  useMiniAppStore.setState({ apps: [], catalogSurfaceId: null, loading: false, runningWorkerIds: [] });
  useMiniAppNavigationStore.setState({ pinnedAppIdsBySurface: { local: ['notes'], peer: ['notes'] } });
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
  resetDeviceSurfaceForTest();
});

describe('MiniApp shortcut catalog ownership', () => {
  it('reloads on device activation and discards a late response from the previous device', async () => {
    let finish!: (apps: MiniAppMeta[]) => void;
    mocks.listMiniApps.mockReturnValueOnce(new Promise<MiniAppMeta[]>(resolve => { finish = resolve; }));
    await act(async () => { root.render(<Harness />); });
    mocks.listMiniApps.mockResolvedValue([peerApp]);
    await act(async () => { activateSurface('peer'); });
    expect(useMiniAppStore.getState()).toMatchObject({ apps: [peerApp], catalogSurfaceId: 'peer', loading: false });
    await act(async () => { finish([localApp]); });
    expect(useMiniAppStore.getState()).toMatchObject({ apps: [peerApp], catalogSurfaceId: 'peer' });
  });

  it('preserves pins on failed discovery and removes only an explicitly deleted app on its device', async () => {
    mocks.listMiniApps.mockRejectedValueOnce(new Error('Host offline'));
    await act(async () => { root.render(<Harness />); });
    expect(useMiniAppStore.getState().loading).toBe(false);
    expect(useMiniAppNavigationStore.getState().pinnedAppIdsBySurface).toEqual({ local: ['notes'], peer: ['notes'] });
    await act(async () => { mocks.listeners.get('miniapp-deleted')!({ id: 'notes' }); });
    expect(useMiniAppNavigationStore.getState().pinnedAppIdsBySurface).toEqual({ local: [], peer: ['notes'] });
  });
});
