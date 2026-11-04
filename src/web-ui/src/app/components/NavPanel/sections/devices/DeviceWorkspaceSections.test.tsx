// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const slots = vi.hoisted(() => ({ value: [] as unknown[] }));
const live = vi.hoisted(() => ({ loading: false }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('./useSidebarDevices', async importOriginal => ({
  ...await importOriginal<typeof import('./useSidebarDevices')>(),
  useSidebarDevices: () => slots.value,
}));
vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({ useWorkspaceContext: () => ({ loading: live.loading }) }));
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

  it('keeps device sections in a fixed order whichever device is rendered', () => {
    slots.value = [slot('local', true), slot('peer-b', false)];
    render();
    const order = () => [...host.querySelectorAll('[data-testid="nav-device-section"]')].map(node => node.getAttribute('data-device-surface'));
    expect(order()).toEqual(['local', 'peer-b']);
    slots.value = [slot('local', false), slot('peer-b', true)];
    render();
    expect(order()).toEqual(['local', 'peer-b']);
  });
});
