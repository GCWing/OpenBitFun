// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/infrastructure/i18n', async importOriginal => ({
  ...await importOriginal<typeof import('@/infrastructure/i18n')>(),
  useI18n: () => ({ t: (key: string) => key }),
}));
const catalogSnapshot = vi.hoisted(() => ({ sessions: {} }));
vi.mock('@/infrastructure/peer-device/deviceWorkspaceCatalog', () => ({
  deviceWorkspaceCatalog: {
    getSnapshot: () => catalogSnapshot,
    subscribe: () => () => undefined,
    loadMoreSessions: vi.fn(),
  },
}));
const device = vi.hoisted(() => ({
  runAction: vi.fn(async () => undefined),
  openSession: vi.fn(async () => undefined),
  activate: vi.fn(async () => 'activated'),
}));
vi.mock('./openOnDevice', () => ({
  runDeviceSessionAction: device.runAction,
  openDeviceSession: device.openSession,
  activateDeviceSlot: device.activate,
}));

import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { BackgroundSessionList, type BackgroundActions } from './BackgroundSessionList';
import type { SidebarDeviceSlot } from './useSidebarDevices';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const slot: SidebarDeviceSlot = {
  surfaceId: 'peer-menu', deviceId: 'peer-menu', name: 'Studio', isLocal: false, rendered: false, hostKind: 'desktop', os: null, controllable: true,
};
const record = (sessionId: string, status = 'active') => ({
  sessionId, sessionName: `Chat ${sessionId}`, agentType: 'agentic', modelName: 'm', createdAt: 1, lastActiveAt: 1,
  lastFinishedAt: 1, turnCount: 2, messageCount: 2, toolCallCount: 0, status, tags: [], workspaceId: 'ws',
}) as never;

describe('device catalog session row menu', () => {
  let host: HTMLDivElement;
  let root: Root;
  // Runs the action like the catalog's intent runner does.
  const actions: BackgroundActions & { run: ReturnType<typeof vi.fn> } = {
    pendingKey: null,
    run: vi.fn((_key: string, action: () => Promise<void>) => { void action(); }),
  };
  const row = () => host.querySelector<HTMLElement>('[data-testid="nav-device-session-item"][data-session-id="s-1"]')!;
  const menu = () => document.querySelector<HTMLElement>('[data-testid="nav-device-session-menu"]');
  const openMenu = async () => {
    await act(async () => row().querySelector<HTMLButtonElement>('[data-testid="nav-device-session-menu-btn"]')!.click());
  };

  beforeEach(() => {
    vi.clearAllMocks();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    flowChatStore.seedSurfaceSessions('peer-menu', [{ workspaceId: 'ws', workspacePath: '/w', sessions: [record('s-1')] }]);
    act(() => root.render(<BackgroundSessionList slot={slot} workspaceIds={['ws']} actions={actions}
      workspaceNames={new Map([['ws', 'OpenBitFun']])} />));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    flowChatStore.discardSurfaceState('peer-menu');
  });

  it('exposes the live row more button with menu-button semantics', async () => {
    const actionsCell = row().querySelector('.openbitfun-nav-panel__inline-item-trailing .openbitfun-nav-panel__inline-item-actions');
    const button = actionsCell?.querySelector<HTMLButtonElement>('button.openbitfun-nav-panel__inline-item-action-btn');
    expect(button).not.toBeNull();
    expect(button!.getAttribute('aria-haspopup')).toBe('menu');
    expect(button!.getAttribute('aria-expanded')).toBe('false');
    expect(button!.getAttribute('aria-label')).toContain('actions.more');

    await openMenu();
    expect(button!.getAttribute('aria-expanded')).toBe('true');
    expect(row().classList.contains('is-menu-open')).toBe(true);
    expect(menu()?.classList.contains('openbitfun-nav-panel__inline-item-menu-popover')).toBe(true);
    expect([...menu()!.querySelectorAll('[data-testid]')].map(item => item.getAttribute('data-testid'))).toEqual([
      'nav-device-session-menu-rename',
      'nav-device-session-menu-duplicate',
      'nav-device-session-menu-export-markdown',
      'nav-device-session-menu-open-storage',
      'nav-device-session-menu-archive',
      'nav-device-session-menu-delete',
    ]);
    // Opening the menu is not an intent to open the session.
    expect(device.openSession).not.toHaveBeenCalled();
    expect(actions.run).not.toHaveBeenCalled();
  });

  it('disables storage reveal for another device with its reason', async () => {
    await openMenu();
    const reveal = menu()!.querySelector<HTMLButtonElement>('[data-testid="nav-device-session-menu-open-storage"]')!;
    expect(reveal.disabled).toBe(true);
    expect(reveal.getAttribute('title')).toBe('nav.sessions.storageDirectoryDesktopOnly');
  });

  it.each(['archive', 'delete'] as const)('runs %s on the owning device and closes the menu', async kind => {
    await openMenu();
    await act(async () => menu()!.querySelector<HTMLButtonElement>(`[data-testid="nav-device-session-menu-${kind}"]`)!.click());
    if (kind === 'delete') {
      expect(actions.run).not.toHaveBeenCalled();
      expect(device.runAction).not.toHaveBeenCalled();
      expect(menu()).not.toBeNull();
      await act(async () => menu()!.querySelector<HTMLButtonElement>('[data-testid="nav-device-session-menu-delete-confirm"]')!.click());
    }
    expect(actions.run).toHaveBeenCalledWith(`session-action:s-1:${kind}`, expect.any(Function), 'nav.devices.sessionActionFailed');
    expect(device.runAction).toHaveBeenCalledWith(null, slot, 's-1', { kind }, expect.any(Function));
    expect(device.openSession).not.toHaveBeenCalled();
    expect(menu()).toBeNull();
  });

  it('renames inline, then renders the device to apply the new title', async () => {
    await openMenu();
    await act(async () => menu()!.querySelector<HTMLButtonElement>('[data-testid="nav-device-session-menu-rename"]')!.click());
    const input = row().querySelector<HTMLInputElement>('[data-testid="nav-device-session-rename-input"]')!;
    expect(input).not.toBeNull();
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setValue.call(input, 'New title');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(device.runAction).toHaveBeenCalledWith(null, slot, 's-1', { kind: 'rename', title: 'New title' }, expect.any(Function));
    // Enter in the field is not an Enter on the row.
    expect(device.openSession).not.toHaveBeenCalled();
  });
});
