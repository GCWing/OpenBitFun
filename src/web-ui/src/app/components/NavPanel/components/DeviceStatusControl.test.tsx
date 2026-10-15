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
  disconnectDevice: vi.fn().mockResolvedValue(undefined),
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
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => key === 'deviceOverview.deviceCount'
      ? `${params?.formattedCount} devices`
      : key,
    formatNumber: (number: number) => String(number),
  }),
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
      health: 'ready',
      capabilities: { hostKind },
    })),
    currentPeerCapabilities: state.renderedPeerHostKind
      ? { hostKind: state.renderedPeerHostKind }
      : null,
    switchToLocal: state.switchToLocal,
    disconnectDevice: state.disconnectDevice,
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

function render(open = true) {
  act(() => root.render(
    <DeviceStatusControl open={open} onOpenChange={onOpenChange} onManageDevices={onManageDevices} />,
  ));
}

function element(testId: string) {
  const result = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  expect(result).not.toBeNull();
  return result!;
}

function installPreviewAnimations() {
  const card = element('nav-device-status-popover');
  card.style.setProperty('--openbitfun-motion-duration-instant', '80ms');
  card.style.setProperty('--openbitfun-motion-duration-fast', '140ms');
  card.style.setProperty('--openbitfun-motion-easing-standard', 'cubic-bezier(0.23, 1, 0.32, 1)');
  card.style.setProperty('--openbitfun-motion-distance-sm', '4px');
  const records: {
    element: HTMLElement;
    keyframes: Keyframe[];
    options: KeyframeAnimationOptions;
    finish: () => void;
    cancel: ReturnType<typeof vi.fn>;
  }[] = [];
  for (const selector of ['device-scene', 'device-heading', 'device-actions', 'pagination-index']) {
    const node = card.querySelector<HTMLElement>(`.openbitfun-device-overview__${selector}`)!;
    if (!node) continue;
    node.animate = vi.fn((frames, options) => {
      let finish!: () => void;
      let reject!: (error: Error) => void;
      const finished = new Promise<void>((resolve, rejectPromise) => {
        finish = resolve;
        reject = rejectPromise;
      });
      const cancel = vi.fn(() => reject(new Error('Animation cancelled')));
      records.push({ element: node, keyframes: frames as Keyframe[], options: options as KeyframeAnimationOptions, finish, cancel });
      return { finished, cancel } as unknown as Animation;
    });
  }
  return {
    records,
    finishPhase: async () => {
      const phase = records.slice(-4);
      await act(async () => { phase.forEach(animation => animation.finish()); });
    },
  };
}

function installMotionPreference(initial = false) {
  const listeners = new Set<() => void>();
  const preference = {
    matches: initial,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  vi.stubGlobal('matchMedia', vi.fn((query: string) => query === preference.media
    ? preference : { ...preference, matches: false }));
  return (matches: boolean) => {
    preference.matches = matches;
    act(() => listeners.forEach(listener => listener()));
  };
}

async function renderBrowseableDevices() {
  state.overview = overview({ peer: { deviceId: 'peer-1', deviceName: 'Current host' } });
  state.identity = { status: 'signed-in', me: { user: { accountId: 'acct' } } };
  state.getDeviceInfo.mockResolvedValue({ device_id: 'local', device_name: 'This computer' });
  state.accountListDevices.mockResolvedValue([
    { device_id: 'local', device_name: 'This computer', online: true },
    { device_id: 'peer-1', device_name: 'Current host', online: true },
    { device_id: 'peer-2', device_name: 'Another host', device_os: 'Linux', online: true },
    { device_id: 'peer-3', device_name: 'Third host', device_kind: 'cli', online: true },
  ]);
  await act(async () => { render(); });
  return {
    next: document.querySelector<HTMLButtonElement>('[aria-label="deviceOverview.nextDevice"]')!,
    previous: document.querySelector<HTMLButtonElement>('[aria-label="deviceOverview.previousDevice"]')!,
  };
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
  vi.unstubAllGlobals();
});

describe('device status card', () => {
  it('shows the device management icon in the header without an account display', () => {
    render();
    const card = element('nav-device-status-popover');
    expect(card.dataset.radius).toBe('lg');
    expect(card.dataset.padding).toBe('none');
    const header = card.querySelector('[data-openbitfun-part="header"]');
    expect(header?.getAttribute('data-content-align')).toBe('start');
    expect(card.querySelector('[data-testid="nav-device-status-account"]')).toBeNull();
    expect(card.querySelector('[data-artwork="device"]')).not.toBeNull();
    const deviceName = element('nav-device-status-name');
    expect(deviceName.textContent).toBe('Workstation');
    expect(header?.contains(deviceName)).toBe(false);
    const details = deviceName.closest('.openbitfun-device-overview__device-details');
    expect(details?.previousElementSibling?.classList.contains('openbitfun-device-overview__carousel-viewport')).toBe(true);
    expect(details?.nextElementSibling?.classList.contains('openbitfun-device-overview__device-actions')).toBe(true);
    expect(deviceName.closest('.openbitfun-device-overview__device-heading')?.previousElementSibling)
      .toBeNull();
    expect(header?.contains(element('nav-device-status-manage'))).toBe(true);
    expect(element('nav-device-status-manage').dataset.openbitfunVariant).toBe('quiet');
    expect(element('nav-device-status-manage').dataset.size).toBe('sm');
    expect(element('nav-device-status-manage').getAttribute('aria-label')).toBe('deviceOverview.devicesAndConnections');
    expect(element('nav-device-status-manage').querySelector('.lucide-monitor-smartphone')).not.toBeNull();
    expect(card.querySelector('[data-testid="nav-device-status-pagination"]')).toBeNull();
    expect(element('nav-device-status-local').textContent).toBe('deviceOverview.localDevice');
    expect(element('nav-device-status-local').dataset.openbitfunComponent).toBe('status-pill');
    expect(element('nav-device-status-local').dataset.tone).toBe('neutral');
    expect(element('nav-device-status-local').closest('.openbitfun-device-overview__device-actions')).not.toBeNull();
    expect(card.querySelector('.openbitfun-device-overview__carousel-controls')).toBeNull();
    expect(card.querySelector('[data-openbitfun-part="footer"]')).toBeNull();
    expect(card.querySelector('[data-testid="nav-device-status-connected-devices"]')).toBeNull();
    act(() => element('nav-device-status-manage').click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onManageDevices).toHaveBeenCalledOnce();
  });

  it('only uses model-specific artwork for a matching device, never the controller platform', () => {
    expect(getDeviceArtworkKind({ kind: 'desktop', name: 'MacBook-Air.local' })).toBe('macbook-air');
    expect(getDeviceArtworkKind({ kind: 'desktop', name: 'GCWingdeMacBook-Air' })).toBe('macbook-air');
    expect(getDeviceArtworkKind({ kind: 'desktop', name: 'MacBook Pro' })).toBe('device');
    expect(getDeviceArtworkKind({ kind: 'desktop', name: 'This Windows' })).toBe('device');
    expect(getDeviceArtworkKind({ kind: 'desktop', name: 'Linux desktop' })).toBe('device');
    expect(getDeviceArtworkKind({ kind: 'execution-host', name: 'Build server' })).toBe('server');
    state.overview = overview({ localDeviceName: 'MacBook-Air.local' });
    render();
    const image = element('nav-device-status-summary').querySelector('img');
    expect(image?.getAttribute('src')).toContain('macbook-air-hero.png');
    expect(image?.getAttribute('alt')).toBe('');
    state.overview = overview({
      localDeviceName: 'MacBook-Air.local',
      peer: { deviceId: 'peer-linux', deviceName: 'Build workstation' },
    });
    render();
    expect(element('nav-device-status-summary').querySelector('img')).toBeNull();
    expect(element('nav-device-status-name').textContent).toBe('Build workstation');
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

  it('opens on the current peer without sliding when the directory arrives, including after browsing and reopening', async () => {
    state.overview = overview({ peer: { deviceId: 'peer-1', deviceName: 'Current host' } });
    state.identity = { status: 'signed-in', me: { user: { accountId: 'acct' } } };
    state.getDeviceInfo.mockResolvedValue({ device_id: 'local', device_name: 'This computer' });
    const devices = [
      { device_id: 'local', device_name: 'This computer', online: true },
      { device_id: 'peer-1', device_name: 'Current host', online: true },
      { device_id: 'peer-2', device_name: 'Another host', online: true },
    ];
    let resolveDirectory!: (value: typeof devices) => void;
    state.accountListDevices.mockImplementation(() => new Promise<typeof devices>(resolve => {
      resolveDirectory = resolve;
    }));

    for (let opening = 0; opening < 2; opening += 1) {
      await act(async () => {
        root.render(<DeviceStatusControl open onOpenChange={onOpenChange} onManageDevices={onManageDevices} />);
      });
      const summary = element('nav-device-status-summary');
      const initialScene = summary.querySelector<HTMLElement>('.openbitfun-device-overview__device-scene')!;
      const motion = installPreviewAnimations();
      expect(initialScene.style.transform).toBe('');
      expect(element('nav-device-status-name').textContent).toBe('Current host');

      await act(async () => { resolveDirectory(devices); });
      const loadedScene = summary.querySelector<HTMLElement>('.openbitfun-device-overview__device-scene')!;
      expect(loadedScene).toBe(initialScene);
      expect(motion.records).toHaveLength(0);
      expect(element('nav-device-status-name').textContent).toBe('Current host');

      const browsingMotion = installPreviewAnimations();
      act(() => document.querySelector<HTMLButtonElement>('[aria-label="deviceOverview.nextDevice"]')!.click());
      await browsingMotion.finishPhase();
      await browsingMotion.finishPhase();
      expect(summary.querySelectorAll('.openbitfun-device-overview__device-scene')).toHaveLength(1);
      expect(summary.querySelector('.openbitfun-device-overview__device-scene')).toBe(loadedScene);
      expect(element('nav-device-status-name').textContent).toBe('Another host');
      expect(summary.querySelector('.openbitfun-device-overview__usage-badge')).toBeNull();

      act(() => root.render(<DeviceStatusControl open={false} onOpenChange={onOpenChange} onManageDevices={onManageDevices} />));
      expect(document.querySelector('[data-testid="nav-device-status-summary"]')).toBeNull();
    }
    expect(state.switchToDevice).not.toHaveBeenCalled();
  });

  it('hides pagination and navigation after loading a single local device', async () => {
    state.identity = { status: 'signed-in', me: { user: { accountId: 'acct' } } };
    state.getDeviceInfo.mockResolvedValue({ device_id: 'local', device_name: 'This computer' });
    state.accountListDevices.mockResolvedValue([{ device_id: 'local', device_name: 'This computer', online: true }]);
    await act(async () => { render(); });
    expect(document.querySelector('[data-testid="nav-device-status-pagination"]')).toBeNull();
    expect(document.querySelector('.openbitfun-device-overview__carousel-controls')).toBeNull();
    expect(element('nav-device-status-local')).toBeDefined();
  });

  it('hands off artwork, name, pagination and actions together without invoking the old device', async () => {
    const { next } = await renderBrowseableDevices();
    const motion = installPreviewAnimations();
    const total = element('nav-device-status-total');
    act(() => next.click());
    expect(element('nav-device-status-name').textContent).toBe('Current host');
    expect(element('nav-device-status-pagination').textContent).toBe('2 / 4');
    expect((element('nav-device-status-disconnect') as HTMLButtonElement).disabled).toBe(true);
    act(() => { element('nav-device-status-disconnect').click(); element('nav-device-usage-status').click(); });
    expect(state.disconnectDevice).not.toHaveBeenCalled();
    expect(motion.records).toHaveLength(4);
    expect(motion.records.every(animation => !animation.element.contains(total))).toBe(true);
    expect(motion.records[0].options.duration).toBe(80);
    expect(motion.records[0].keyframes[1].transform).toBe('translateX(calc(4px * -1))');

    await motion.finishPhase();
    expect(element('nav-device-status-name').textContent).toBe('Another host');
    expect(element('nav-device-status-pagination').textContent).toBe('3 / 4');
    expect(element('nav-device-status-total')).toBe(total);
    expect(total.textContent).toBe('4');
    expect(document.querySelector('[data-artwork="linux"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="nav-device-usage-status"]')).toBeNull();
    expect(motion.records).toHaveLength(8);
    expect(motion.records[4].options.duration).toBe(140);
    expect(motion.records[4].keyframes[0].transform).toBe('translateX(calc(4px * 2))');
    expect((element('nav-device-status-connect') as HTMLButtonElement).disabled).toBe(true);
    act(() => element('nav-device-status-connect').click());
    expect(state.switchToDevice).not.toHaveBeenCalled();
    await motion.finishPhase();
    expect((element('nav-device-status-connect') as HTMLButtonElement).disabled).toBe(false);
    await act(async () => element('nav-device-status-connect').click());
    expect(state.switchToDevice).toHaveBeenCalledWith('peer-2', 'Another host');
  });

  it('coalesces rapid clicks and interrupts an entrance from its current frame', async () => {
    const { next, previous } = await renderBrowseableDevices();
    const motion = installPreviewAnimations();
    act(() => { next.click(); next.click(); });
    expect(motion.records).toHaveLength(4);
    await motion.finishPhase();
    expect(element('nav-device-status-name').textContent).toBe('Third host');
    expect(element('nav-device-status-pagination').textContent).toBe('4 / 4');
    expect(document.querySelector('[data-artwork="server"]')).not.toBeNull();

    const interrupted = motion.records.slice(-4);
    const scene = motion.records[0].element;
    scene.style.opacity = '0.35';
    scene.style.transform = 'translateX(2px)';
    act(() => previous.click());
    expect(interrupted.every(animation => animation.cancel.mock.calls.length === 1)).toBe(true);
    expect(motion.records[8].keyframes[0]).toEqual({ opacity: '0.35', transform: 'translateX(2px)' });
    scene.style.removeProperty('opacity');
    scene.style.removeProperty('transform');
    await act(async () => { interrupted.forEach(animation => animation.finish()); });
    expect(element('nav-device-status-name').textContent).toBe('Third host');
    await motion.finishPhase();
    expect(element('nav-device-status-name').textContent).toBe('Another host');
    await motion.finishPhase();
    expect((element('nav-device-status-connect') as HTMLButtonElement).disabled).toBe(false);
    expect(state.switchToDevice).not.toHaveBeenCalled();
  });

  it('settles directly when reduced motion is preferred or enabled during a transition', async () => {
    const setReduced = installMotionPreference(true);
    const { next } = await renderBrowseableDevices();
    const motion = installPreviewAnimations();
    act(() => next.click());
    expect(motion.records).toHaveLength(0);
    expect(element('nav-device-status-name').textContent).toBe('Another host');
    setReduced(false);
    act(() => next.click());
    expect(motion.records).toHaveLength(4);
    setReduced(true);
    expect(element('nav-device-status-name').textContent).toBe('Third host');
    expect((element('nav-device-status-connect') as HTMLButtonElement).disabled).toBe(false);
    expect(motion.records.every(animation => animation.cancel.mock.calls.length === 1)).toBe(true);
    await motion.finishPhase();
    expect(element('nav-device-status-name').textContent).toBe('Third host');
  });

  it('cancels pending navigation when the card closes so it reopens on the current device', async () => {
    const { next } = await renderBrowseableDevices();
    const motion = installPreviewAnimations();
    act(() => next.click());
    render(false);
    expect(motion.records.every(animation => animation.cancel.mock.calls.length === 1)).toBe(true);
    await motion.finishPhase();
    await act(async () => { render(); });
    expect(element('nav-device-status-name').textContent).toBe('Current host');
    expect(element('nav-device-status-pagination').textContent).toBe('2 / 4');
    expect((element('nav-device-status-disconnect') as HTMLButtonElement).disabled).toBe(false);
    expect(state.switchToDevice).not.toHaveBeenCalled();
  });

  it('draws an attached CLI peer as a server while browsing the device list', async () => {
    state.overview = overview({ peer: { deviceId: 'peer-1', deviceName: 'Current host' } });
    state.identity = { status: 'signed-in', me: { email: 'user@example.com', user: { accountId: 'acct', githubId: 42, login: 'user' } } };
    state.getDeviceInfo.mockResolvedValue({ device_id: 'local', device_name: 'This computer', device_os: 'Windows' });
    state.accountListDevices.mockResolvedValue([
      { device_id: 'local', device_name: 'This computer', device_os: 'Windows', device_kind: 'desktop', online: true },
      { device_id: 'peer-1', device_name: 'Current host', online: true },
      { device_id: 'peer-2', device_name: 'Headless host', device_os: 'Linux', device_kind: 'cli', online: true },
    ]);
    await act(async () => {
      root.render(<DeviceStatusControl open onOpenChange={onOpenChange} onManageDevices={onManageDevices} />);
    });
    expect(element('nav-device-status-popover').textContent).not.toContain('user@example.com');
    expect(element('nav-device-status-pagination').textContent).toBe('2 / 3');
    expect(element('nav-device-status-name').closest('.openbitfun-device-overview__device-heading')?.previousElementSibling)
      .toBe(element('nav-device-status-pagination'));
    expect(element('nav-device-status-pagination').parentElement)
      .toBe(element('nav-device-status-name').closest('.openbitfun-device-overview__device-details'));
    expect(document.querySelector('[data-testid="nav-device-status-local"]')).toBeNull();
    expect(element('nav-device-status-manage').dataset.openbitfunComponent).toBe('icon-button');

    const next = document.querySelector<HTMLButtonElement>('[aria-label="deviceOverview.nextDevice"]');
    expect(next).not.toBeNull();
    const details = element('nav-device-status-name').closest('.openbitfun-device-overview__device-details');
    expect(details?.querySelector('.openbitfun-device-overview__carousel-controls')).toBe(next?.parentElement);
    expect(details?.querySelector('[aria-label="deviceOverview.previousDevice"]')).not.toBeNull();
    await act(async () => { next!.click(); });

    // The system it reported is real, but a CLI host has no laptop to draw.
    expect(document.querySelector('[data-artwork="server"]')).not.toBeNull();
    expect(document.querySelector('[data-artwork="linux"]')).toBeNull();
    expect(element('nav-device-status-pagination').textContent).toBe('3 / 3');
    expect(document.querySelector('.openbitfun-device-overview__usage-badge')).toBeNull();
    expect(state.switchToDevice).not.toHaveBeenCalled();
    expect(element('nav-device-status-connect').closest('.openbitfun-device-overview__device-status')).not.toBeNull();
    expect(element('nav-device-status-connect').closest('.openbitfun-device-overview__device-actions')).not.toBeNull();
    expect(element('nav-device-status-connect').dataset.openbitfunComponent).toBe('button');
    expect(element('nav-device-status-connect').dataset.openbitfunVariant).toBe('primary');
    expect(element('nav-device-status-connect').textContent).toBe('deviceOverview.connectAndUse');
    state.attachedHostKinds = { 'peer-2': 'cli' };
    render();
    expect(element('nav-device-status-connect').textContent).toBe('deviceOverview.switchUse');
    expect(element('nav-device-status-popover').querySelector('[data-openbitfun-part="footer"]')).toBeNull();
    expect(document.querySelector('[data-testid="nav-device-status-disconnect"]')).toBeNull();
    await act(async () => { element('nav-device-status-connect').click(); });
    expect(state.switchToDevice).toHaveBeenCalledWith('peer-2', 'Headless host');

    const previous = document.querySelector<HTMLButtonElement>('[aria-label="deviceOverview.previousDevice"]')!;
    await act(async () => { previous.click(); });
    expect(element('nav-device-status-disconnect').closest('[data-control-state="active"]')).not.toBeNull();
    await act(async () => { previous.click(); });
    expect(element('nav-device-status-return-local').textContent).toBe('deviceOverview.returnLocalAction');
    await act(async () => { element('nav-device-status-return-local').click(); });
    expect(state.switchToLocal).toHaveBeenCalledWith('manual');
    expect(state.disconnectDevice).not.toHaveBeenCalled();
  });

  it('marks only the current remote name with an in-use pill and keeps the artwork clear', () => {
    state.overview = overview({ localDeviceName: 'This computer' });
    render();
    const summary = element('nav-device-status-summary');
    const header = element('nav-device-status-popover').querySelector('[data-openbitfun-part="header"]');
    expect(summary.querySelector('[data-control-state="local"]')?.getAttribute('aria-label')).toContain('deviceOverview.currentLocalDevice');
    expect(header?.querySelector('.openbitfun-device-overview__device-status')).toBeNull();
    expect(summary.querySelector('.openbitfun-device-overview__usage-badge')).toBeNull();
    expect(summary.querySelector('[data-openbitfun-component="status-pill"]')).toBe(element('nav-device-status-local'));
    expect(summary.querySelector('.openbitfun-device-overview__connection-control')).toBeNull();

    // The active peer carries its status after the name, and keeps its bottom disconnect action.
    state.overview = overview({
      localDeviceName: 'This computer',
      peer: { deviceId: 'peer-1', deviceName: 'Remote workstation' },
    });
    render();
    expect(summary.querySelector('[data-control-state="active"]')?.getAttribute('aria-label')).toContain('deviceOverview.currentUse · deviceOverview.controlling');
    expect(summary.textContent).toContain('deviceOverview.inUse');
    const usageControl = element('nav-device-usage-status');
    expect(usageControl.tagName).toBe('SPAN');
    expect(usageControl.dataset.openbitfunComponent).toBe('status-pill');
    expect(usageControl.dataset.tone).toBe('success');
    expect(usageControl.dataset.shape).toBe('pill');
    expect(usageControl.closest('.openbitfun-device-overview__device-heading')).not.toBeNull();
    expect(element('nav-device-status-name').nextElementSibling).toBe(usageControl);
    expect(summary.querySelector('[data-testid="nav-device-usage-status"]')).toBe(usageControl);
    expect(usageControl.textContent).toBe('deviceOverview.inUse');
    expect(usageControl.getAttribute('role')).not.toBe('button');
    expect(usageControl.getAttribute('tabindex')).toBeNull();
    expect(usageControl.querySelector('svg')).toBeNull();
    expect(usageControl.getAttribute('title')).toBeNull();
    act(() => usageControl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(usageControl.textContent).toBe('deviceOverview.inUse');
    expect(usageControl.querySelector('svg')).toBeNull();
    expect(usageControl.querySelector('.lucide-unplug')).toBeNull();
    act(() => usageControl.focus());
    act(() => usageControl.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: container })));
    expect(usageControl.textContent).toBe('deviceOverview.inUse');
    act(() => element('nav-device-status-manage').focus());
    expect(usageControl.textContent).toBe('deviceOverview.inUse');
    expect(usageControl.closest('[aria-hidden="true"]')).toBeNull();
    expect(summary.querySelector('.openbitfun-device-overview__device-heading .openbitfun-device-overview__usage-badge')).toBe(usageControl);
    expect(header?.contains(element('nav-device-status-disconnect'))).toBe(false);
    expect(summary.contains(element('nav-device-status-disconnect'))).toBe(true);
    expect(element('nav-device-status-disconnect').closest('.openbitfun-device-overview__device-actions')).not.toBeNull();
    expect(element('nav-device-status-disconnect').closest('.openbitfun-device-overview__device-status')).not.toBeNull();
    expect(element('nav-device-status-disconnect').textContent).toBe('deviceOverview.disconnectAction');
    expect(element('nav-device-status-disconnect').dataset.openbitfunComponent).toBe('button');
    expect(element('nav-device-status-disconnect').dataset.openbitfunVariant).toBe('primary');
    expect(summary.querySelector('.openbitfun-device-overview__connection-control')).toBeNull();
    expect(summary.querySelector('[data-openbitfun-component="status-pill"]')).toBe(usageControl);
    expect(document.querySelector('[data-testid="nav-device-status-connected-devices"]')).toBeNull();
    expect(element('nav-device-status-disconnect').closest('[data-control-state="active"]')).not.toBeNull();
    expect(element('nav-device-status-popover').querySelector('[data-openbitfun-part="footer"]')).toBeNull();
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
    expect(element('nav-device-status-name').textContent).toBe('Workstation');
    expect(element('nav-device-status-connected-devices').textContent).toContain('My phone');
    expect(document.querySelector('[data-testid="nav-device-connection-service"]')).toBeNull();
  });

  it('keeps detached execution activity visible without changing the primary device', () => {
    state.overview = overview({ dispatchJobs: [{
      id: 'job-1', state: 'running', target: { kind: 'device', id: 'host-1', name: 'Build server' },
    }] });
    render();
    expect(element('nav-device-status-name').textContent).toBe('Workstation');
    const devices = element('nav-device-status-connected-devices');
    expect(devices.textContent).toContain('Build server');
    expect(devices.querySelector('[data-openbitfun-device-kind="execution-host"]')?.getAttribute('aria-label')).toContain('deviceOverview.executingTasks');
    expect(devices.querySelector('.openbitfun-device-overview__task-count')?.textContent).toBe('1');
  });

  it('keeps the current peer disconnectable even when presence omits it', async () => {
    state.overview = overview({ peer: { deviceId: 'peer-1', deviceName: 'Remote workstation' } });
    state.identity = { status: 'signed-in', me: { user: { accountId: 'acct', githubId: 42, login: 'user' } } };
    state.getDeviceInfo.mockResolvedValue({ device_id: 'local', device_name: 'This computer' });
    state.accountListDevices.mockResolvedValue([
      { device_id: 'local', device_name: 'This computer', online: true },
    ]);
    await act(async () => { render(); });
    expect(element('nav-device-status-name').textContent).toBe('Remote workstation');
    let finishDisconnect!: () => void;
    state.disconnectDevice.mockImplementationOnce(() => new Promise<void>(resolve => { finishDisconnect = resolve; }));
    act(() => element('nav-device-status-disconnect').click());
    expect(element('nav-device-status-disconnect').textContent).toBe('deviceOverview.disconnectingAction');
    expect((element('nav-device-status-disconnect') as HTMLButtonElement).disabled).toBe(true);
    act(() => element('nav-device-status-disconnect').click());
    expect(state.disconnectDevice).toHaveBeenCalledTimes(1);
    await act(async () => { finishDisconnect(); });
    expect(element('nav-device-status-disconnect').textContent).toBe('deviceOverview.disconnectAction');
    expect(state.disconnectDevice).toHaveBeenCalledWith('peer-1', 'manual');
    expect(state.switchToLocal).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(element('nav-device-status-popover'));
  });

  it('keeps the in-use badge informational while the bottom button disconnects', async () => {
    state.overview = overview({ peer: { deviceId: 'peer-1', deviceName: 'Remote workstation' } });
    render();
    let finishDisconnect!: () => void;
    state.disconnectDevice.mockImplementationOnce(() => new Promise<void>(resolve => { finishDisconnect = resolve; }));
    const usageControl = element('nav-device-usage-status');
    act(() => usageControl.click());
    expect(state.disconnectDevice).not.toHaveBeenCalled();
    expect(usageControl.textContent).toBe('deviceOverview.inUse');
    act(() => element('nav-device-status-disconnect').click());
    expect(state.disconnectDevice).toHaveBeenCalledWith('peer-1', 'manual');
    expect(usageControl.textContent).toBe('deviceOverview.inUse');
    expect((element('nav-device-status-disconnect') as HTMLButtonElement).disabled).toBe(true);
    expect((element('nav-footer-cancel-remote') as HTMLButtonElement).disabled).toBe(true);
    act(() => { usageControl.click(); element('nav-footer-cancel-remote').click(); });
    expect(state.disconnectDevice).toHaveBeenCalledTimes(1);
    await act(async () => {
      state.overview = overview();
      render();
      finishDisconnect();
    });
    expect(document.querySelector('[data-testid="nav-device-usage-status"]')).toBeNull();
    expect(document.activeElement).toBe(element('nav-device-status-popover'));
    expect(state.switchToLocal).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('preserves unavailable-state retry, Escape and backdrop dismissal', () => {
    state.overview = overview({
      peer: { deviceId: 'peer-1', deviceName: 'Remote workstation' },
      remoteStatus: null,
      remoteStatusState: 'unavailable',
    });
    render();
    const retry = document.querySelector<HTMLButtonElement>('.openbitfun-device-overview__notice');
    expect(retry?.getAttribute('aria-label')).toContain('deviceOverview.statusUnavailable');
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
    expect(element('nav-device-status-name').textContent).toBe(name);
    expect(element('nav-device-status-name').getAttribute('data-overflow-text')).toBe('');
    expect(element('nav-footer-device-status').getAttribute('aria-label')).toContain(name);
  });

  it('shows one remote-control action after the device name without repeating the local device mark', () => {
    state.overview = overview({ localDeviceOs: 'macOS' });
    render();
    expect(document.querySelector('[data-testid="nav-footer-cancel-remote"]')).toBeNull();

    state.overview = overview({
      localDeviceOs: 'macOS',
      peer: { deviceId: 'peer-1', deviceName: 'Remote Mac' },
      peerDeviceOs: 'macOS',
    });
    render();
    const trigger = element('nav-footer-device-status');
    const control = element('nav-footer-cancel-remote');
    expect(trigger.textContent).toBe('Remote Mac');
    expect(trigger.nextElementSibling).toBe(control);
    expect(control.tagName).toBe('BUTTON');
    expect(control.dataset.openbitfunComponent).toBe('button');
    expect(control.getAttribute('aria-label')).toBe('Remote Mac · deviceOverview.cancelRemoteControl');
    expect(control.querySelector('.lucide-link')).not.toBeNull();
    expect(control.textContent).toBe('deviceOverview.cancelRemoteControl');
    expect(trigger.parentElement?.querySelectorAll('svg[data-system="macos"]')).toHaveLength(1);
    expect(trigger.querySelector('button')).toBeNull();
    expect(trigger.parentElement?.querySelector('.openbitfun-nav-panel__footer-device-status-attached')).toBeNull();

    state.overview = overview({ localDeviceOs: 'macOS' });
    render();
    expect(document.querySelector('[data-testid="nav-footer-cancel-remote"]')).toBeNull();
  });

  it('keeps background hosts in the expanded card without adding footer device icons', () => {
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

    const listRow = element('nav-device-status-connected-devices')
      .querySelector('[data-openbitfun-device-kind="execution-host"]');
    expect(listRow?.querySelector('svg[data-system="server"]')).not.toBeNull();
    expect(listRow?.textContent).toContain('Build host');
    expect(element('nav-footer-device-status').querySelectorAll('svg')).toHaveLength(1);
    expect(document.querySelector('[data-testid="nav-footer-cancel-remote"]')).toBeNull();
  });

  it('cancels the current peer directly from the footer without opening the card and restores focus', async () => {
    state.overview = overview({ peer: { deviceId: 'peer-1', deviceName: 'Remote Mac' } });
    let finishDisconnect!: () => void;
    state.disconnectDevice.mockImplementationOnce(() => new Promise<void>(resolve => { finishDisconnect = resolve; }));
    const renderClosed = () => root.render(
      <DeviceStatusControl open={false} onOpenChange={onOpenChange} onManageDevices={onManageDevices} />,
    );
    act(renderClosed);
    const control = element('nav-footer-cancel-remote') as HTMLButtonElement;
    act(() => { control.focus(); control.click(); });
    expect(state.disconnectDevice).toHaveBeenCalledWith('peer-1', 'manual');
    expect(control.disabled).toBe(true);
    expect(control.getAttribute('aria-busy')).toBe('true');
    act(() => control.click());
    expect(state.disconnectDevice).toHaveBeenCalledTimes(1);
    expect(state.switchToLocal).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="nav-device-status-popover"]')).toBeNull();

    await act(async () => {
      state.overview = overview();
      renderClosed();
      finishDisconnect();
    });
    expect(document.querySelector('[data-testid="nav-footer-cancel-remote"]')).toBeNull();
    expect(document.activeElement).toBe(element('nav-footer-device-status'));
  });

  it('keeps the footer remote-control action available after a failed cancellation', async () => {
    state.overview = overview({ peer: { deviceId: 'peer-1', deviceName: 'Remote Mac' } });
    state.disconnectDevice.mockRejectedValueOnce(new Error('Disconnect failed'));
    render();
    await act(async () => { element('nav-footer-cancel-remote').click(); });
    expect(notifications.warning).toHaveBeenCalledWith('Disconnect failed');
    expect((element('nav-footer-cancel-remote') as HTMLButtonElement).disabled).toBe(false);
    expect(element('nav-footer-cancel-remote').getAttribute('aria-busy')).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
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

    // Additional controllers remain in the card with their own device marks.
    const rows = element('nav-device-status-connected-devices');
    const row = (text: string) => Array.from(
      rows.querySelectorAll('.openbitfun-device-overview__device-row'),
    ).find(candidate => candidate.textContent?.includes(text))!;
    expect(row('Workstation')).toBeUndefined();
    expect(element('nav-footer-cancel-remote').querySelector('.lucide-link')).not.toBeNull();
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
    state.identity = { status: 'signed-in', me: { user: { accountId: 'acct', githubId: 42, login: 'user' } } };
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

    // The unavailable connection is disabled and explains the version in its tooltip.
    const notice = document.querySelector('[data-testid="nav-device-status-incompatible"]');
    expect(notice).not.toBeNull();
    expect(notice?.tagName).toBe('BUTTON');
    expect((notice as HTMLButtonElement).disabled).toBe(true);
    expect(notice?.closest('[data-control-state="incompatible"]')).not.toBeNull();
    expect(notice?.getAttribute('title')).toContain('deviceOverview.deviceClientIncompatibleWithVersion');
    expect(notice?.textContent).toBe('deviceOverview.unavailableAction');
    expect(document.querySelector('.openbitfun-device-overview__device-name')?.textContent).toBeDefined();
    expect(Array.from(document.querySelectorAll('button')).some(
      button => button.textContent === 'deviceOverview.connectDevice',
    )).toBe(false);
    expect(state.switchToDevice).not.toHaveBeenCalled();
  });
});
