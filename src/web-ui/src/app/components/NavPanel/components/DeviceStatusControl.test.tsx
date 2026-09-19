// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  projectDeviceInterconnectionOverview,
  type DeviceInterconnectionOverview,
  type DeviceInterconnectionOverviewInput,
} from '../deviceInterconnectionOverview';
import { getDeviceArtworkKind } from './deviceArtworkKind';
import DeviceStatusControl from './DeviceStatusControl';

const state = vi.hoisted(() => ({
  overview: null as DeviceInterconnectionOverview | null,
  refresh: vi.fn().mockResolvedValue(undefined),
  switchToLocal: vi.fn().mockResolvedValue('activated'),
}));

vi.mock('./useDeviceInterconnectionOverview', () => ({
  useDeviceInterconnectionOverview: () => ({
    overview: state.overview,
    refresh: state.refresh,
    accountService: null,
  }),
}));
vi.mock('@/infrastructure/i18n/hooks/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/infrastructure/appearance/runtime/AppearanceOverlayHost', () => ({
  getAppearanceOverlayHost: () => document.body,
}));
vi.mock('@/infrastructure/peer-device/peerDeviceContextState', () => ({
  usePeerDeviceModeOptional: () => ({
    peerMode: { active: state.overview?.peerActive },
    switchToLocal: state.switchToLocal,
  }),
}));
vi.mock('@/shared/notification-system', () => ({
  useNotification: () => ({ success: vi.fn(), warning: vi.fn() }),
}));

function overview(overrides: Partial<DeviceInterconnectionOverviewInput> = {}) {
  return projectDeviceInterconnectionOverview({
    localDeviceName: 'Workstation',
    peer: null,
    remoteStatus: {
      relay_connected: false,
      relay_url: null,
      active_method: null,
      clients: [],
      bot_connected: null,
      bot_verbose_mode: false,
    },
    remoteStatusState: 'ready',
    dispatchJobs: [],
    accountService: null,
    ...overrides,
  });
}

let root: Root;
let container: HTMLDivElement;
const onOpenChange = vi.fn();
const onManageDevices = vi.fn();

function render() {
  act(() => root.render(
    <DeviceStatusControl open onOpenChange={onOpenChange} onManageDevices={onManageDevices} />,
  ));
}

function element(testId: string) {
  const result = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  expect(result).not.toBeNull();
  return result!;
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.overview = overview();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('device status card', () => {
  it('uses centered card anatomy, device artwork and a primary connection action', () => {
    render();
    const card = element('nav-device-status-popover');
    expect(card.dataset.radius).toBe('lg');
    expect(card.dataset.padding).toBe('none');
    expect(card.querySelector('[data-openbitfun-part="header"]')?.getAttribute('data-content-align')).toBe('center');
    expect(card.querySelector('[data-artwork="device"]')).not.toBeNull();
    expect(element('nav-device-status-summary').querySelector('.openbitfun-device-overview__device-name')?.textContent).toBe('Workstation');
    expect(element('nav-device-status-manage').getAttribute('data-openbitfun-variant')).toBe('primary');
    expect(card.querySelector('[data-testid="nav-device-status-connected-devices"]')).toBeNull();
    act(() => element('nav-device-status-manage').click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onManageDevices).toHaveBeenCalledOnce();
  });

  it('only uses model-specific artwork for a matching device, never the controller platform', () => {
    expect(getDeviceArtworkKind({ kind: 'desktop', name: 'MacBook-Air.local' })).toBe('macbook-air');
    expect(getDeviceArtworkKind({ kind: 'desktop', name: 'MacBook Pro' })).toBe('device');
    expect(getDeviceArtworkKind({ kind: 'desktop', name: 'This Windows' })).toBe('device');
    expect(getDeviceArtworkKind({ kind: 'desktop', name: 'Linux desktop' })).toBe('device');
    expect(getDeviceArtworkKind({ kind: 'execution-host', name: 'Build server' })).toBe('server');
    state.overview = overview({ localDeviceName: 'MacBook-Air.local' });
    render();
    const image = element('nav-device-status-summary').querySelector('img');
    expect(image?.getAttribute('src')).toContain('macbook-air.png');
    expect(image?.getAttribute('alt')).toBe('');
    state.overview = overview({
      localDeviceName: 'MacBook-Air.local',
      peer: { deviceId: 'peer-linux', deviceName: 'Build workstation' },
    });
    render();
    expect(element('nav-device-status-summary').querySelector('img')).toBeNull();
    expect(element('nav-device-status-summary').textContent).toContain('Build workstation');
  });

  it('keeps connected controllers visible without the connection service card', () => {
    state.overview = overview({ remoteStatus: {
      relay_connected: true,
      relay_url: 'http://192.168.1.2:9700',
      active_method: 'lan',
      clients: [{ id: 'mobile-user', name: 'My phone' }],
      bot_connected: null,
      bot_verbose_mode: false,
    } });
    render();
    expect(element('nav-device-status-summary').textContent).toContain('Workstation');
    expect(element('nav-device-status-connected-devices').textContent).toContain('My phone');
    expect(document.querySelector('[data-testid="nav-device-connection-service"]')).toBeNull();
  });

  it('keeps detached execution activity visible without changing the primary device', () => {
    state.overview = overview({ dispatchJobs: [{
      id: 'job-1', state: 'running', target: { kind: 'device', id: 'host-1', name: 'Build server' },
    }] });
    render();
    expect(element('nav-device-status-summary').textContent).toContain('Workstation');
    const devices = element('nav-device-status-connected-devices');
    expect(devices.textContent).toContain('Build server');
    expect(devices.textContent).toContain('deviceOverview.executingTasks');
  });

  it('preserves the return-to-local action in peer mode', async () => {
    state.overview = overview({ peer: { deviceId: 'peer-1', deviceName: 'Remote workstation' } });
    render();
    expect(element('nav-device-status-summary').textContent).toContain('Remote workstation');
    await act(async () => element('nav-device-status-return-local').click());
    expect(state.switchToLocal).toHaveBeenCalledWith('manual');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('preserves unavailable-state retry, Escape and backdrop dismissal', () => {
    state.overview = overview({
      peer: { deviceId: 'peer-1', deviceName: 'Remote workstation' },
      remoteStatus: null,
      remoteStatusState: 'unavailable',
    });
    render();
    const retry = document.querySelector<HTMLButtonElement>('.openbitfun-device-overview__notice');
    expect(retry?.textContent).toContain('deviceOverview.statusUnavailable');
    const previousRefreshes = state.refresh.mock.calls.length;
    act(() => retry?.click());
    expect(state.refresh).toHaveBeenCalledTimes(previousRefreshes + 1);
    act(() => retry?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(document.activeElement).toBe(element('nav-footer-device-status'));
    onOpenChange.mockClear();
    act(() => element('nav-device-status-backdrop').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('retains the full device name in the summary and accessible trigger', () => {
    const name = 'Engineering workstation with a very long device name';
    state.overview = overview({ localDeviceName: name });
    render();
    expect(element('nav-device-status-summary').querySelector('.openbitfun-device-overview__device-name')?.textContent).toBe(name);
    expect(element('nav-device-status-summary').querySelector('[title]')?.getAttribute('title')).toBe(name);
    expect(element('nav-footer-device-status').getAttribute('aria-label')).toContain(name);
  });
});
