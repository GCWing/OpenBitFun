// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const slots = vi.hoisted(() => ({ value: [] as unknown[] }));
const live = vi.hoisted(() => ({ loading: false, opened: [] as unknown[] }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('./useSidebarDevices', async importOriginal => ({
  ...await importOriginal<typeof import('./useSidebarDevices')>(),
  useSidebarDevices: () => slots.value,
}));
vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({ useWorkspaceContext: () => ({ loading: live.loading, openedWorkspacesList: live.opened }) }));
vi.mock('../workspaces/WorkspaceListSection', () => ({ default: () => <div data-testid="live-list" /> }));
vi.mock('./DeviceCatalogSection', () => ({
  default: ({ slot }: { slot: { surfaceId: string } }) => <div data-testid="background-list" data-surface={slot.surfaceId} />,
}));
vi.mock('@/infrastructure/peer-device/deviceWorkspaceCatalog', () => ({
  deviceWorkspaceCatalog: {
    getSnapshot: () => ({ status: 'ready', workspaces: [{ id: 'w' }], sessions: {} }),
    subscribe: () => () => undefined,
    retainActivity: () => () => undefined,
  },
}));
vi.mock('@/flow_chat/services/backgroundSurfaceSeeding', () => ({ installBackgroundSurfaceSeeding: () => () => undefined }));

import { beginDeviceOpen, endDeviceOpen } from '@/infrastructure/peer-device/deviceOpenIntent';
import DeviceWorkspaceSections from './DeviceWorkspaceSections';
import { useDeviceVisibilityPreferences } from '@/app/navigation/deviceVisibilityPreferences';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const slot = (surfaceId: string, rendered: boolean) => ({
  surfaceId, deviceId: surfaceId, name: surfaceId, isLocal: surfaceId === 'local', rendered, hostKind: 'desktop', controllable: true,
});

describe('DeviceWorkspaceSections hand-over', () => {
  let host: HTMLDivElement;
  let root: Root;
  const render = () => act(() => root.render(<DeviceWorkspaceSections />));
  const body = (surfaceId: string) => host.querySelector(`[data-device-surface="${surfaceId}"] .openbitfun-nav-panel__device-body > *`)?.getAttribute('data-testid');

  beforeEach(() => {
    useDeviceVisibilityPreferences.setState({ hidden: {} });
    activateSurface('local');
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    live.loading = false;
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it('keeps every device on its background rows until the open settles, then hands over once', () => {
    const intent = beginDeviceOpen({ surfaceId: 'peer-b', key: 'session:s', sessionId: 's' });
    slots.value = [slot('local', false), slot('peer-b', true)];
    render();
    expect(body('local')).toBe('background-list');
    expect(body('peer-b')).toBe('background-list');
    act(() => endDeviceOpen(intent));
    expect(body('peer-b')).toBe('live-list');
    expect(body('local')).toBe('background-list');
  });

  it('waits for the rendered device to finish loading before showing its live rows', () => {
    live.loading = true;
    slots.value = [slot('local', true), slot('peer-b', false)];
    render();
    expect(body('local')).toBe('background-list');
    live.loading = false;
    render();
    expect(body('local')).toBe('live-list');
  });

  it('keeps the live rows while a workspace is activated in them', () => {
    live.loading = true;
    live.opened = [{ id: 'ws' }];
    slots.value = [slot('local', true), slot('peer-b', false)];
    render();
    expect(body('local')).toBe('live-list');
    live.loading = false;
    live.opened = [];
  });

  it('keeps device sections in a fixed order whichever device is rendered', () => {
    slots.value = [slot('local', true), slot('peer-b', false)];
    render();
    const order = () => [...host.querySelectorAll('[data-testid="nav-device-section"]')].map(node => node.getAttribute('data-device-surface'));
    expect(order()).toEqual(['local', 'peer-b']);
    slots.value = [slot('local', false), slot('peer-b', true)];
    render();
    expect(order()).toEqual(['local', 'peer-b']);
  });

  it('hides the rendered peer without drawing its live list under the remaining local device', () => {
    slots.value = [slot('local', false), slot('peer-b', true)];
    render();
    act(() => useDeviceVisibilityPreferences.getState().setVisible('peer-b', false));
    expect(body('peer-b')).toBeUndefined();
    expect(body('local')).toBe('background-list');
    expect(host.querySelector('[data-testid="live-list"]')).toBeNull();
    act(() => useDeviceVisibilityPreferences.getState().setVisible('peer-b', true));
    expect(body('peer-b')).toBe('live-list');
  });

  it('shows only a remaining peer catalog when the local device is hidden', () => {
    slots.value = [slot('local', true), slot('peer-b', false)];
    render();
    act(() => useDeviceVisibilityPreferences.getState().setVisible('local', false));
    expect(body('local')).toBeUndefined();
    expect(body('peer-b')).toBe('background-list');
    expect(host.querySelector('[data-testid="live-list"]')).toBeNull();
  });

  it('keeps all devices hidden across surface activation until explicitly shown', () => {
    slots.value = [slot('local', true), slot('peer-b', false)];
    render();
    act(() => {
      useDeviceVisibilityPreferences.getState().setVisible('local', false);
      useDeviceVisibilityPreferences.getState().setVisible('peer-b', false);
    });
    expect(host.textContent).toBe('');
    expect(host.children).toHaveLength(0);
    slots.value = [slot('local', false), slot('peer-b', true)];
    act(() => activateSurface('peer-b'));
    render();
    expect(host.children).toHaveLength(0);
    act(() => useDeviceVisibilityPreferences.getState().setVisible('peer-b', true));
    expect(body('peer-b')).toBe('live-list');
  });

  it('does not reveal a hidden single local device through the plain-list fallback', () => {
    slots.value = [slot('local', true)];
    render();
    expect(host.querySelector('[data-testid="live-list"]')).not.toBeNull();
    act(() => useDeviceVisibilityPreferences.getState().setVisible('local', false));
    expect(host.children).toHaveLength(0);
  });
});
