/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';
import { WorkspaceKind, type WorkspaceInfo } from '@/shared/types';
import type { MiniAppMeta } from '@/infrastructure/api/service-api/MiniAppAPI';
import { useMiniAppStore } from '@/app/scenes/miniapps/miniAppStore';
import { useMiniAppNavigationStore } from '@/app/scenes/miniapps/miniAppNavigationStore';
import { useMiniAppPresentationStore } from '@/app/scenes/miniapps/miniAppPresentationStore';
import MiniAppShortcuts from './MiniAppShortcuts';

const mocks = vi.hoisted(() => ({
  workspace: null as WorkspaceInfo | null,
  local: true, snapshot: vi.fn(), open: vi.fn(), openScene: vi.fn(), error: vi.fn(),
  activeTabId: 'miniapp:notes',
}));
vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({
  useCurrentWorkspace: () => ({ workspace: mocks.workspace, workspacePath: mocks.workspace?.rootPath }),
}));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({
  t: (key: string, params?: { name: string }) => params ? `${key}:${params.name}` : key,
  currentLanguage: 'en-US',
}) }));
vi.mock('@/shared/notification-system', () => ({ useNotification: () => ({ error: mocks.error }) }));
vi.mock('@/app/stores/sceneStore', () => ({ useSceneStore: Object.assign(
  (select: (state: { activeTabId: string }) => unknown) => select(mocks),
  { getState: () => ({ openScene: mocks.openScene }) },
) }));
vi.mock('@/infrastructure/api/service-api/MiniAppPresentationAPI', () => ({
  hasLocalMiniAppPresentation: () => mocks.local,
  miniAppPresentationAPI: { snapshot: mocks.snapshot, open: mocks.open },
}));

const app = (id: string, name: string): MiniAppMeta => ({
  id, name, description: '', icon: 'box', permissions: {}, category: 'utilities', tags: [],
  version: 1, created_at: 1, updated_at: 1,
});
const notes = app('notes', 'Notes');
const timer = app('timer', 'Timer');
const snapshot = (window = false) => ({ protocolVersion: 1, hostEpoch: 'host', revision: 1,
  instances: window ? [{ instanceId: 'notes#1', appId: 'notes', workspacePath: '/original',
    primaryView: { kind: 'window', viewId: 'window' }, pendingView: null, contentCapabilities: [] }] : [],
});
let root: Root;
let host: HTMLDivElement;
const render = () => act(async () => { root.render(<MiniAppShortcuts />); });
const row = (id: string) => host.querySelector<HTMLButtonElement>(`[data-miniapp-id="${id}"]`)!;
const pin = (surface: string, id: string) => useMiniAppNavigationStore.getState().setPinned(surface, id, true);

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  resetDeviceSurfaceForTest();
  vi.clearAllMocks();
  mocks.local = true;
  mocks.activeTabId = 'miniapp:notes';
  mocks.workspace = { id: 'project', rootPath: '/current', workspaceKind: WorkspaceKind.Normal } as WorkspaceInfo;
  mocks.snapshot.mockReset().mockResolvedValue(snapshot());
  mocks.open.mockReset().mockImplementation(async (appId, kind, workspacePath) => ({
    instance: { appId, workspacePath }, view: { kind, viewId: 'tab' },
  }));
  useMiniAppNavigationStore.setState({ pinnedAppIdsBySurface: {} });
  useMiniAppStore.getState().setApps([notes, timer]);
  useMiniAppPresentationStore.setState({ snapshot: null, tabs: {} });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  resetDeviceSurfaceForTest();
});

describe('MiniApp navigation shortcuts', () => {
  it('uses saved order and current localized metadata, highlights the app, and launches through presentation', async () => {
    pin('local', 'timer'); pin('local', 'notes');
    useMiniAppStore.getState().setApps([{ ...notes, i18n: { locales: { 'en-US': { name: 'My Notes' } } } }, timer]);
    await render();
    expect([...host.querySelectorAll('[data-miniapp-id]')].map(item => item.textContent)).toEqual(['Timer', 'My Notes']);
    expect(row('notes').getAttribute('data-openbitfun-state')).toBe('active');
    await act(async () => { row('notes').click(); });
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith('notes', 'tab', '/current', undefined);
    expect(mocks.openScene).toHaveBeenCalledExactlyOnceWith('miniapp:notes');
  });

  it('removes a shortcut without launching or deleting the app', async () => {
    pin('local', 'notes');
    await render();
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="navigation.removeApp:Notes"]')!.click(); });
    expect(row('notes')).toBeNull();
    expect(useMiniAppStore.getState().apps).toContain(notes);
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it('retains preferences when the catalog is empty and updates after a device switch', async () => {
    pin('local', 'notes'); pin('peer', 'notes');
    await render();
    expect(row('notes')).not.toBeNull();
    await act(async () => { activateSurface('peer'); });
    expect(host.querySelector('[data-miniapp-id]')).toBeNull();
    await act(async () => { useMiniAppStore.getState().setApps([]); });
    expect(useMiniAppNavigationStore.getState().pinnedAppIdsBySurface.peer).toEqual(['notes']);
    await act(async () => { useMiniAppStore.getState().setApps([app('notes', 'Peer Notes')]); });
    expect(row('notes').textContent).toBe('Peer Notes');
    mocks.local = false;
    await render();
    await act(async () => { row('notes').click(); });
    expect(mocks.openScene).toHaveBeenCalledExactlyOnceWith('miniapp:notes');
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it('keeps unsupported remote-workspace apps removable without launching them', async () => {
    mocks.workspace!.workspaceKind = WorkspaceKind.Remote;
    useMiniAppStore.getState().setApps([{ ...notes, permissions: { fs: { read: ['{workspace}'] } } }]);
    pin('local', 'notes');
    await render();
    expect(row('notes').disabled).toBe(true);
    await act(async () => { row('notes').click(); });
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.openScene).not.toHaveBeenCalled();
    const remove = host.querySelector<HTMLButtonElement>('[aria-label="navigation.removeApp:Notes"]')!;
    expect(remove.disabled).toBe(false);
    await act(async () => { remove.click(); });
    expect(row('notes')).toBeNull();
  });

  it('asks before moving an existing window into a tab and preserves its workspace', async () => {
    mocks.snapshot.mockResolvedValue(snapshot(true));
    pin('local', 'notes');
    await render();
    await act(async () => { row('notes').click(); });
    expect(mocks.open).not.toHaveBeenCalled();
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('presentation.transferWarning');
    const confirm = [...dialog.querySelectorAll('button')].find(button => button.textContent === 'presentation.openTab')!;
    await act(async () => { confirm.click(); });
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith('notes', 'tab', '/original', undefined);
  });
});
