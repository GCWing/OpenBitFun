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
  switchToDevice: vi.fn().mockResolvedValue('activated'),
  identity: { status: 'signed-out', me: null } as { status: string; me: unknown },
  getDeviceInfo: vi.fn(),
  accountListDevices: vi.fn(),
  renderedPeerHostKind: null as 'desktop' | 'cli' | null,
  attachedHostKinds: {} as Record<string, 'desktop' | 'cli'>,
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
    peerMode: { active: state.overview?.peerActive, deviceId: 'peer-1' },
    attachments: Object.entries(state.attachedHostKinds).map(([deviceId, hostKind]) => ({
      deviceId,
      deviceName: deviceId,
      health: 'connected',
      capabilities: { hostKind },
    })),
    currentPeerCapabilities: state.renderedPeerHostKind
      ? { hostKind: state.renderedPeerHostKind }
      : null,
    switchToLocal: state.switchToLocal,
    switchToDevice: state.switchToDevice,
  }),
}));
vi.mock('@/infrastructure/account-identity', () => ({
  useAccountIdentity: () => state.identity,
}));
vi.mock('@/infrastructure/api/service-api/RemoteConnectAPI', async importOriginal => ({
  ...await importOriginal<typeof import('@/infrastructure/api/service-api/RemoteConnectAPI')>(),
  remoteConnectAPI: {
    getDeviceInfo: state.getDeviceInfo,
    accountListDevices: state.accountListDevices,
  },
}));
vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({
  api: { listen: () => () => {} },
}));
const notifications = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn() }));
vi.mock('@/shared/notification-system', () => ({
  useNotification: () => notifications,
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
  state.identity = { status: 'signed-out', me: null };
  state.renderedPeerHostKind = null;
  state.attachedHostKinds = {};
  state.getDeviceInfo.mockReset();
  state.accountListDevices.mockReset();
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

  it('selects artwork from the system each device reported and keeps device.svg otherwise', () => {
    const name = 'Workstation';
    expect(getDeviceArtworkKind({ kind: 'desktop', name, os: 'Windows' })).toBe('windows');
    expect(getDeviceArtworkKind({ kind: 'desktop', name, os: 'macOS' })).toBe('macos');
    expect(getDeviceArtworkKind({ kind: 'desktop', name, os: 'Linux' })).toBe('linux');
    expect(getDeviceArtworkKind({ kind: 'desktop', name, os: 'HarmonyOS' })).toBe('harmonyos');
    // Relay payloads are not an enum, so spacing, case and older spellings hold.
    expect(getDeviceArtworkKind({ kind: 'desktop', name, os: ' harmonyos ' })).toBe('harmonyos');
    expect(getDeviceArtworkKind({ kind: 'desktop', name, os: 'Darwin' })).toBe('macos');
    expect(getDeviceArtworkKind({ kind: 'desktop', name, os: 'Windows 11 Pro' })).toBe('windows');
    // An unplaceable system never borrows another one's mark.
    expect(getDeviceArtworkKind({ kind: 'desktop', name, os: 'FreeBSD' })).toBe('device');
    expect(getDeviceArtworkKind({ kind: 'desktop', name, os: null })).toBe('device');
    // A named model stays the more specific answer than the system it runs.
    expect(getDeviceArtworkKind({ kind: 'desktop', name: 'MacBook-Air.local', os: 'Linux' }))
      .toBe('macbook-air');
    // A phone is not a desktop we can draw by system.
    expect(getDeviceArtworkKind({ kind: 'mobile', name: 'Phone', os: 'Linux' })).toBe('device');

    state.overview = overview({ localDeviceName: 'Workstation', localDeviceOs: 'Windows' });
    render();
    expect(document.querySelector('[data-artwork="windows"]')).not.toBeNull();
    expect(document.querySelector('[data-artwork="device"]')).toBeNull();
  });

  it('draws a CLI host as a server from the kind it reported', () => {
    state.overview = overview({
      localDeviceName: 'Workstation',
      localDeviceOs: 'Windows',
      localDeviceKind: 'cli',
    });
    render();
    // A headless host has no laptop to draw, whatever system it runs.
    expect(document.querySelector('[data-artwork="server"]')).not.toBeNull();
    expect(document.querySelector('[data-artwork="windows"]')).toBeNull();

    state.overview = overview({
      localDeviceName: 'Workstation',
      localDeviceOs: 'Windows',
      localDeviceKind: 'desktop',
    });
    render();
    expect(document.querySelector('[data-artwork="windows"]')).not.toBeNull();
  });

  it('lets a live control link correct a reported kind that has gone stale', () => {
    state.overview = overview({
      localDeviceName: 'Workstation',
      localDeviceOs: 'Windows',
      peer: { deviceId: 'peer-1', deviceName: 'Headless host' },
      peerDeviceKind: 'desktop',
    });
    render();
    // Neither the kind nor a system has arrived for this peer yet.
    expect(element('nav-device-status-summary').querySelector('[data-artwork="device"]')).not.toBeNull();

    state.renderedPeerHostKind = 'cli';
    render();
    expect(element('nav-device-status-summary').querySelector('[data-artwork="server"]')).not.toBeNull();
    expect(document.querySelector('[data-artwork="device"]')).toBeNull();
  });

  it('draws an attached CLI peer as a server while browsing the device list', async () => {
    state.identity = { status: 'signed-in', me: { user: { accountId: 'acct', githubId: 42 } } };
    state.getDeviceInfo.mockResolvedValue({ device_id: 'local', device_name: 'This computer', device_os: 'Windows' });
    state.accountListDevices.mockResolvedValue([
      { device_id: 'local', device_name: 'This computer', device_os: 'Windows', device_kind: 'desktop', online: true },
      { device_id: 'peer', device_name: 'Headless host', device_os: 'Linux', device_kind: 'cli', online: true },
    ]);
    await act(async () => {
      root.render(<DeviceStatusControl open onOpenChange={onOpenChange} onManageDevices={onManageDevices} />);
    });

    const next = document.querySelector<HTMLButtonElement>('[aria-label="deviceOverview.nextDevice"]');
    expect(next).not.toBeNull();
    await act(async () => { next!.click(); });

    // The system it reported is real, but a CLI host has no laptop to draw.
    expect(document.querySelector('[data-artwork="server"]')).not.toBeNull();
    expect(document.querySelector('[data-artwork="linux"]')).toBeNull();
  });

  it('names this machine instead of a bare in-use state, and keeps the action row either way', () => {
    state.overview = overview({ localDeviceName: 'This computer' });
    render();
    const summary = element('nav-device-status-summary');
    expect(summary.textContent).toContain('deviceOverview.currentLocalDevice');
    expect(summary.textContent).not.toContain('deviceOverview.currentUse');
    // This machine has no connect action, but its card renders the same button a
    // peer's card renders, so both cards stay exactly one control tall.
    const localActionRow = summary.querySelector('.openbitfun-device-overview__connect-action');
    expect(localActionRow).not.toBeNull();
    const localActionButton = localActionRow!.querySelector('button');
    expect(localActionButton).not.toBeNull();
    expect(localActionButton!.disabled).toBe(true);
    expect(localActionButton!.getAttribute('aria-hidden')).toBe('true');
    expect(localActionButton!.className).toContain('openbitfun-device-overview__connect-reserved');

    // A peer in use keeps the generic wording: it is not a local device.
    state.overview = overview({
      localDeviceName: 'This computer',
      peer: { deviceId: 'peer-1', deviceName: 'Remote workstation' },
    });
    render();
    expect(summary.textContent).toContain('deviceOverview.currentUse');
    expect(summary.textContent).not.toContain('deviceOverview.currentLocalDevice');
    expect(summary.querySelector('.openbitfun-device-overview__connect-action')).not.toBeNull();
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
    expect(element('nav-device-status-summary').querySelector('.openbitfun-device-overview__device-name')?.getAttribute('data-overflow-text')).toBe(name);
    expect(element('nav-footer-device-status').getAttribute('aria-label')).toContain(name);
  });

  it('draws this machine as the attached desktop, by the system it reported', () => {
    const footer = () => element('nav-footer-device-status');
    const attachedDesktop = () => footer()
      .querySelector('[data-openbitfun-device-kind="desktop"]');

    // A peer in use names itself in the trigger and lands in the carousel; this
    // machine is the attached desktop, and it reads as the Mac it is.
    state.overview = overview({
      localDeviceName: 'Workstation',
      localDeviceOs: 'macOS',
      peer: { deviceId: 'peer-1', deviceName: 'Windows box' },
      peerDeviceOs: 'Windows',
    });
    render();
    expect(footer().textContent).toContain('Windows box');
    expect(attachedDesktop()?.querySelector('svg[data-system="macos"]')).not.toBeNull();
    // The peer's own system never stands in for this machine's.
    expect(attachedDesktop()?.querySelector('svg[data-system="windows"]')).toBeNull();

    // A headless client draws the server silhouette wherever it runs.
    state.overview = overview({
      localDeviceName: 'Workstation',
      localDeviceOs: 'Linux',
      localDeviceKind: 'cli',
      peer: { deviceId: 'peer-1', deviceName: 'Windows box' },
    });
    render();
    expect(attachedDesktop()?.querySelector('svg[data-system="server"]')).not.toBeNull();

    // A phone stays a phone: only the desktop group is this machine.
    state.overview = overview({
      localDeviceName: 'Workstation',
      localDeviceOs: 'macOS',
      peer: { deviceId: 'peer-1', deviceName: 'Windows box' },
      remoteStatus: {
        relay_connected: true,
        relay_url: 'http://192.168.1.2:9700',
        active_method: 'lan',
        clients: [{ id: 'mobile-user', name: 'My phone' }],
        bot_connected: null,
        bot_verbose_mode: false,
      },
    });
    render();
    expect(footer().querySelector('[data-openbitfun-device-kind="mobile"] [data-system]')).toBeNull();

    // A system this client cannot place keeps the neutral mark it always drew.
    state.overview = overview({
      localDeviceName: 'Workstation',
      localDeviceOs: 'FreeBSD',
      peer: { deviceId: 'peer-1', deviceName: 'Windows box' },
    });
    render();
    expect(attachedDesktop()?.querySelector('[data-system]')).toBeNull();
    expect(attachedDesktop()?.querySelector('svg')).not.toBeNull();
  });

  it('draws a group of headless hosts with the mark the list draws for them', () => {
    const footer = () => element('nav-footer-device-status');
    const headlessGroup = () => footer()
      .querySelector('[data-openbitfun-device-kind="execution-host"]');

    // A dispatch job running on another host is what puts that group in the
    // footer, and the group names a class rather than one device: it has no row
    // to read a system from.
    state.overview = overview({
      localDeviceName: 'Workstation',
      localDeviceOs: 'macOS',
      dispatchJobs: [{
        id: 'job-1',
        state: 'running',
        target: { kind: 'device', id: 'peer-2', name: 'Build host' },
      }],
    });
    render();

    const drawnPath = (scope: Element | null | undefined) => (
      scope?.querySelector('svg[data-system="server"] path')?.getAttribute('d')
    );
    const listRow = element('nav-device-status-connected-devices')
      .querySelector('[data-openbitfun-device-kind="execution-host"]');
    // One drawing, whatever slot it lands in: the group is not a second glyph.
    expect(drawnPath(headlessGroup())).not.toBeNull();
    expect(drawnPath(headlessGroup())).toBe(drawnPath(listRow));
  });

  it('marks a device name with the system that device runs', () => {
    state.overview = overview({
      localDeviceName: 'Workstation',
      localDeviceOs: 'macOS',
      peer: { deviceId: 'peer-1', deviceName: 'lwb_server' },
      peerDeviceKind: 'cli',
      remoteStatus: {
        relay_connected: true,
        relay_url: 'http://192.168.1.2:9700',
        active_method: 'lan',
        clients: [{ id: 'mobile-user', name: 'My phone' }],
        bot_connected: 'weixin',
        bot_verbose_mode: false,
      },
    });
    render();

    // A host row answers with the system it runs; a phone and a chat app keep
    // saying what they are, because neither is a system this client can draw.
    const rows = element('nav-device-status-connected-devices');
    const row = (text: string) => Array.from(
      rows.querySelectorAll('.openbitfun-device-overview__device-row'),
    ).find(candidate => candidate.textContent?.includes(text))!;
    expect(row('Workstation').querySelector('svg[data-system="macos"]')).not.toBeNull();
    expect(row('My phone').querySelector('[data-system]')).toBeNull();
    expect(row('My phone').querySelector('svg')).not.toBeNull();
    expect(row('remoteConnect.weixin').querySelector('[data-system]')).toBeNull();
    expect(row('remoteConnect.weixin').querySelector('svg')).not.toBeNull();

    // The trigger names one device and states its system, whichever end of the
    // connection that device sits on: the peer here, this machine below.
    const trigger = () => element('nav-footer-device-status');
    const triggerMark = () => trigger().querySelector('svg');
    expect(trigger().textContent).toContain('lwb_server');
    expect(triggerMark()?.getAttribute('data-system')).toBe('server');

    state.overview = overview({ localDeviceName: 'Workstation', localDeviceOs: 'macOS' });
    render();
    expect(trigger().textContent).toContain('Workstation');
    expect(trigger().querySelector('svg[data-system="macos"]')).not.toBeNull();

    // A system this client cannot place keeps the neutral mark, never a guess.
    state.overview = overview({ localDeviceName: 'Workstation', localDeviceOs: 'FreeBSD' });
    render();
    expect(trigger().querySelector('[data-system]')).toBeNull();
    expect(triggerMark()).not.toBeNull();
  });

  it('keeps an incompatible peer in the switch list but never connects to it', async () => {
    state.identity = { status: 'signed-in', me: { user: { accountId: 'acct', githubId: 42 } } };
    state.getDeviceInfo.mockResolvedValue({ device_id: 'local', device_name: 'This computer' });
    state.accountListDevices.mockResolvedValue([
      { device_id: 'local', device_name: 'This computer', online: true },
      { device_id: 'peer', device_name: 'Old build', online: true, compatible: false, device_client_version: '0.9.0' },
    ]);
    await act(async () => {
      root.render(<DeviceStatusControl open onOpenChange={onOpenChange} onManageDevices={onManageDevices} />);
    });

    const next = document.querySelector<HTMLButtonElement>('[aria-label="deviceOverview.nextDevice"]');
    expect(next).not.toBeNull();
    await act(async () => { next!.click(); });

    // The peer stays visible in the carousel with its reason instead of a connect action.
    // The peer keeps the one control slot the other states use, disabled and
    // relabelled, so its card is the same height as a connectable peer's.
    const notice = document.querySelector('[data-testid="nav-device-status-incompatible"]');
    expect(notice).not.toBeNull();
    expect(notice?.tagName).toBe('BUTTON');
    expect((notice as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelectorAll('.openbitfun-device-overview__connect-action button')).toHaveLength(1);
    expect(notice?.textContent).toContain('deviceOverview.deviceClientIncompatibleWithVersion');
    expect(document.querySelector('.openbitfun-device-overview__device-name')?.textContent).toBeDefined();
    expect(Array.from(document.querySelectorAll('button')).some(
      button => button.textContent === 'deviceOverview.connectDevice',
    )).toBe(false);
    expect(state.switchToDevice).not.toHaveBeenCalled();
  });
});
