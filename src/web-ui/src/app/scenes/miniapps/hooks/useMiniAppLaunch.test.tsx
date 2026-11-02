/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';
import { WorkspaceKind, type WorkspaceInfo } from '@/shared/types';
import type { MiniAppInstanceSnapshot, MiniAppViewKind } from '@/infrastructure/api/service-api/MiniAppPresentationAPI';
import { useMiniAppPresentationStore } from '../miniAppPresentationStore';
import { useMiniAppLaunch } from './useMiniAppLaunch';

const mocks = vi.hoisted(() => ({
  workspace: null as WorkspaceInfo | null,
  local: true, snapshot: vi.fn(), open: vi.fn(), openScene: vi.fn(), error: vi.fn(),
}));
vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({
  useCurrentWorkspace: () => ({ workspace: mocks.workspace, workspacePath: mocks.workspace?.rootPath }),
}));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/shared/notification-system', () => ({ useNotification: () => ({ error: mocks.error }) }));
vi.mock('@/app/stores/sceneStore', () => ({ useSceneStore: { getState: () => ({ openScene: mocks.openScene }) } }));
vi.mock('@/infrastructure/api/service-api/MiniAppPresentationAPI', () => ({
  hasLocalMiniAppPresentation: () => mocks.local,
  miniAppPresentationAPI: { snapshot: mocks.snapshot, open: mocks.open },
}));

const snapshot = (kind?: MiniAppViewKind, path: string | null = '/pinned'): MiniAppInstanceSnapshot => ({
  protocolVersion: 1, hostEpoch: 'host', revision: 1,
  instances: kind ? [{ instanceId: 'instance', appId: 'notes', workspacePath: path,
    primaryView: { kind, viewId: 'original' }, pendingView: null, contentCapabilities: [] }] : [],
});
let root: Root;
let container: HTMLDivElement;
let launch: ReturnType<typeof useMiniAppLaunch>;
function Harness() { launch = useMiniAppLaunch(); return null; }
const render = () => act(async () => { root.render(<Harness />); });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  resetDeviceSurfaceForTest();
  vi.clearAllMocks();
  mocks.local = true;
  mocks.workspace = { id: 'local', rootPath: '/current', workspaceKind: WorkspaceKind.Normal } as WorkspaceInfo;
  mocks.snapshot.mockReset().mockResolvedValue(snapshot());
  mocks.open.mockReset().mockImplementation(async (appId: string, kind: MiniAppViewKind, workspacePath: string | null) => ({
    instance: { instanceId: 'instance', appId, workspacePath, primaryView: null,
      pendingView: { kind, viewId: 'destination' }, contentCapabilities: [] },
    view: { kind, viewId: 'destination' },
  }));
  useMiniAppPresentationStore.setState({ snapshot: null, tabs: {} });
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  resetDeviceSurfaceForTest();
});

describe('MiniApp catalog launch choices', () => {
  it.each(['tab', 'window'] as const)('opens a fresh %s directly without a transfer dialog', async kind => {
    await render();
    await act(async () => { await launch.openApp('notes', kind); });
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith('notes', kind, '/current', undefined);
    expect(launch.transfer).toBeNull();
    if (kind === 'tab') {
      expect(mocks.openScene).toHaveBeenCalledExactlyOnceWith('miniapp:notes');
      expect(useMiniAppPresentationStore.getState().tabs.notes.view.kind).toBe('tab');
    } else {
      expect(mocks.openScene).not.toHaveBeenCalled();
      expect(useMiniAppPresentationStore.getState().tabs).toEqual({});
    }
  });

  it.each(['tab', 'window'] as const)('focuses the existing %s without reopening in the current workspace', async kind => {
    mocks.snapshot.mockResolvedValue(snapshot(kind, null));
    await render();
    await act(async () => { await launch.openApp('notes', kind); });
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith('notes', kind, null, undefined);
    expect(launch.transfer).toBeNull();
  });

  it.each(['tab', 'window'] as const)('confirms a transfer to %s and preserves the source until the destination is ready', async kind => {
    mocks.snapshot.mockResolvedValue(snapshot(kind === 'tab' ? 'window' : 'tab'));
    await render();
    await act(async () => { await launch.openApp('notes', kind); });
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.openScene).not.toHaveBeenCalled();
    expect(launch.transfer?.kind).toBe(kind);
    await act(async () => { await launch.confirmTransfer(); });
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith('notes', kind, '/pinned', undefined);
    expect(launch.transfer).toBeNull();
  });

  it('cancels a transfer without creating a destination', async () => {
    mocks.snapshot.mockResolvedValue(snapshot('window'));
    await render();
    await act(async () => { await launch.openApp('notes', 'tab'); });
    act(() => launch.cancelTransfer());
    await act(async () => { await launch.confirmTransfer(); });
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it.each([false, true])('sends the catalog glyph for native launch, including confirmed transfers: %s', async transfer => {
    mocks.snapshot.mockResolvedValue(snapshot(transfer ? 'tab' : undefined));
    await render();
    await act(async () => { await launch.openApp('notes', 'window', 'Presentation'); });
    if (transfer) await act(async () => { await launch.confirmTransfer(); });
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith('notes', 'window', transfer ? '/pinned' : '/current', expect.stringContaining('<svg'));
    expect(mocks.open.mock.calls[0][3]).toContain('stroke="white"');
  });

  it.each(['remote-workspace', 'peer-or-browser'] as const)('gates native launch on %s without local fallback', async surface => {
    if (surface === 'remote-workspace') mocks.workspace!.workspaceKind = WorkspaceKind.Remote;
    else mocks.local = false;
    await render();
    expect(launch.supported).toBe(false);
    await act(async () => { await launch.openApp('notes', 'window'); });
    expect(mocks.error).toHaveBeenCalledWith('presentation.unsupported');
    expect(mocks.openScene).not.toHaveBeenCalled();
    await act(async () => { await launch.openApp('notes', 'tab'); });
    expect(mocks.openScene).toHaveBeenCalledExactlyOnceWith('miniapp:notes');
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it('coalesces duplicate clicks and allows retry after a launch failure', async () => {
    mocks.open.mockRejectedValueOnce(new Error('Host unavailable'));
    await render();
    await act(async () => { await Promise.all([launch.openApp('notes'), launch.openApp('notes')]); });
    expect(mocks.open).toHaveBeenCalledTimes(1);
    expect(mocks.openScene).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith('presentation.openFailed');
    expect(launch.busyAppIds).toEqual([]);
    await act(async () => { await launch.openApp('notes'); });
    expect(mocks.openScene).toHaveBeenCalledExactlyOnceWith('miniapp:notes');
  });

  it.each(['snapshot', 'open'] as const)('discards a late %s response after switching device surfaces', async stage => {
    let finish!: (value: unknown) => void;
    mocks[stage].mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    await render();
    let pending!: Promise<void>;
    await act(async () => { pending = launch.openApp('notes'); });
    await act(async () => {
      activateSurface('peer');
      finish(stage === 'snapshot' ? snapshot() : {});
      await pending;
    });
    expect(mocks.openScene).not.toHaveBeenCalled();
    expect(useMiniAppPresentationStore.getState().tabs).toEqual({});
    if (stage === 'snapshot') expect(mocks.open).not.toHaveBeenCalled();
  });
});
