/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MiniAppMeta } from '@/infrastructure/api/service-api/MiniAppAPI';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';
import { notificationService } from '@/shared/notification-system/services/NotificationService';
import { notificationStore } from '@/shared/notification-system/store/NotificationStore';
import { useMiniAppSystemInstallation } from './useMiniAppSystemInstallation';

const native = vi.hoisted(() => ({ install: vi.fn(), uninstall: vi.fn() }));
vi.mock('@/infrastructure/api/service-api/MiniAppPresentationAPI', () => ({ miniAppPresentationAPI: native }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({
  currentLanguage: 'en-US',
  t: (key: string, params?: Record<string, unknown>) => `${key} ${JSON.stringify(params)}`,
}) }));
vi.mock('@/infrastructure/i18n/core/I18nService', () => ({ i18nService: { t: (key: string) => key } }));
vi.mock('@/shared/notification-system', async () => ({
  useNotification: (await import('@/shared/notification-system/hooks/useNotification')).useNotification,
}));
vi.mock('../utils/miniAppSystemIcon', () => ({ renderMiniAppSystemIcon: () => '<svg />' }));

const app = { id: 'notes', name: 'Notes', description: '', icon: 'book',
  i18n: { locales: { 'en-US': { name: 'My Notes' } } },
} as MiniAppMeta;
let root: Root;
let installation: ReturnType<typeof useMiniAppSystemInstallation>;
function Harness({ supported }: { supported: boolean }) {
  installation = useMiniAppSystemInstallation(supported);
  return null;
}
const render = (supported = true) => act(async () => { root.render(<Harness supported={supported} />); });
const state = () => notificationStore.getState();

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  resetDeviceSurfaceForTest();
  vi.resetAllMocks();
  native.install.mockResolvedValue({ path: '/Applications/Notes.app' });
  native.uninstall.mockResolvedValue(undefined);
  notificationStore.clearActiveNotifications();
  notificationStore.clearHistory();
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
  resetDeviceSurfaceForTest();
  notificationStore.clearActiveNotifications();
  notificationStore.clearHistory();
});

describe('MiniApp system operation notifications', () => {
  it.each(['install', 'update', 'uninstall'] as const)('keeps the %s result in the notification center after its toast closes', async operation => {
    let finish!: (value: { path: string }) => void;
    const action = operation === 'uninstall' ? native.uninstall : native.install;
    action.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    await render();
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = operation === 'uninstall' ? installation.uninstall(app) : installation.install(app, '/project', operation === 'update');
    });
    expect(state().activeNotifications).toHaveLength(1);
    expect(state().activeNotifications[0]).toMatchObject({
      variant: 'progress', progressMode: 'text-only', status: 'active',
      message: expect.stringContaining('My Notes'),
    });
    expect(state().notificationHistory).toHaveLength(0);
    // Closing the initiating view does not abandon an accepted OS operation.
    await act(async () => { root.render(null); });
    await act(async () => { finish({ path: '/Applications/Notes.app' }); await pending; });
    const [result] = state().notificationHistory;
    const key = operation === 'uninstall' ? 'uninstalled' : operation === 'update' ? 'updated' : 'installed';
    expect(state().notificationHistory).toHaveLength(1);
    expect(result).toMatchObject({
      type: 'success', showInCenter: true, read: false,
      message: expect.stringContaining(`presentation.${key}`),
    });
    expect(result.message).toContain('My Notes');
    if (operation !== 'uninstall') expect(result.message).toContain('/Applications/Notes.app');
    expect(state().unreadCount).toBe(1);
    notificationService.dismiss(result.id);
    expect(state().activeNotifications).toHaveLength(0);
    expect(state().notificationHistory[0].message).toBe(result.message);
  });

  it.each(['install', 'update', 'uninstall'] as const)('records a named %s failure and clears its progress', async operation => {
    const action = operation === 'uninstall' ? native.uninstall : native.install;
    action.mockRejectedValueOnce(new Error('Permission denied'));
    await render();
    await act(async () => {
      const result = operation === 'uninstall'
        ? await installation.uninstall(app)
        : await installation.install(app, null, operation === 'update');
      expect(result).toBeUndefined();
    });
    expect(state().activeNotifications).toHaveLength(1);
    expect(state().activeNotifications[0].variant).toBe('toast');
    expect(state().notificationHistory).toHaveLength(1);
    expect(state().notificationHistory[0]).toMatchObject({
      type: 'error', showInCenter: true, message: expect.stringContaining(`presentation.${operation}Failed`),
    });
    expect(state().notificationHistory[0].message).toContain('My Notes');
    expect(state().notificationHistory[0].message).toContain('Permission denied');
  });

  it.each(['success', 'failure'] as const)('clears progress immediately on a surface switch and discards late %s', async outcome => {
    let finish!: (value: { path: string }) => void;
    let fail!: (error: Error) => void;
    native.install.mockReturnValueOnce(new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
    await render();
    let pending!: Promise<unknown>;
    await act(async () => { pending = installation.install(app); });
    expect(state().activeNotifications).toHaveLength(1);
    act(() => { activateSurface('peer'); });
    expect(state().activeNotifications).toHaveLength(0);
    await act(async () => {
      if (outcome === 'success') finish({ path: '/Applications/Notes.app' });
      else fail(new Error('Host unavailable'));
      await pending;
    });
    expect(state().notificationHistory).toHaveLength(0);
    expect(state().unreadCount).toBe(0);
  });

  it('does not begin operations or notifications on unsupported surfaces', async () => {
    await render(false);
    await act(async () => { await installation.install(app); await installation.uninstall(app); });
    expect(native.install).not.toHaveBeenCalled();
    expect(native.uninstall).not.toHaveBeenCalled();
    expect(state().activeNotifications).toHaveLength(0);
    expect(state().notificationHistory).toHaveLength(0);
  });
});
