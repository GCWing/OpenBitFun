/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AccountIdentitySnapshot } from '@/infrastructure/account-identity';
import { useDeviceDirectory } from '@/infrastructure/account/deviceDirectory';
import type { AccountDeviceInfo, DeviceInfo } from '@/infrastructure/api/service-api/RemoteConnectAPI';
import type { PeerModeState } from '@/infrastructure/peer-device/peerDeviceContextState';
import { OverviewDevicesSection } from './OverviewDevicesSection';

const mocks = vi.hoisted(() => ({
  peerMode: { active: false } as PeerModeState,
  refresh: vi.fn(),
  getDeviceInfo: vi.fn(),
}));
vi.mock('@/infrastructure/api/service-api/RemoteConnectAPI', async original => ({
  ...await original<typeof import('@/infrastructure/api/service-api/RemoteConnectAPI')>(),
  remoteConnectAPI: { getDeviceInfo: mocks.getDeviceInfo },
}));
vi.mock('@/infrastructure/account/deviceDirectory', async original => ({
  ...await original<typeof import('@/infrastructure/account/deviceDirectory')>(),
  refreshDeviceDirectory: mocks.refresh,
}));
vi.mock('@/infrastructure/peer-device/peerDeviceContextState', () => ({
  usePeerDeviceModeOptional: () => ({ peerMode: mocks.peerMode }),
}));
vi.mock('@/infrastructure/i18n/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: { count?: string }) => options?.count ? `${key}:${options.count}` : key,
    formatNumber: String,
  }),
}));

let root: Root;
let container: HTMLDivElement;
let trackWidth: number;
const resizeListeners = new Set<() => void>();
const identity: AccountIdentitySnapshot = { resolved: true, status: 'signed-in', me: null };
const device = (id: string, extra: Partial<AccountDeviceInfo> = {}): AccountDeviceInfo => ({
  device_id: id, device_name: id, online: true, last_seen_at: null, ...extra,
});
const render = (snapshot = identity) => act(async () => { root.render(<OverviewDevicesSection identity={snapshot} />); });
const row = (id: string) => container.querySelector(`[data-device-id="${id}"]`);
const track = () => container.querySelector<HTMLUListElement>('.personal-overview__device-track')!;
const previousButton = () => container.querySelector<HTMLButtonElement>('[data-testid="personal-overview-previous-devices"]');
const nextButton = () => container.querySelector<HTMLButtonElement>('[data-testid="personal-overview-next-devices"]');
const resize = (width: number) => act(() => { trackWidth = width; resizeListeners.forEach(listener => listener()); });
const scrollToPosition = (left: number) => act(() => {
  track().scrollLeft = left;
  track().dispatchEvent(new Event('scroll'));
});
const mockScrolling = () => {
  const scrollTo = vi.fn((options: ScrollToOptions) => {
    track().scrollLeft = options.left ?? 0;
    track().dispatchEvent(new Event('scroll'));
  });
  track().scrollTo = scrollTo;
  return scrollTo;
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  trackWidth = 632;
  resizeListeners.clear();
  vi.stubGlobal('ResizeObserver', class {
    constructor(private listener: () => void) { resizeListeners.add(listener); }
    observe() {}
    disconnect() { resizeListeners.delete(this.listener); }
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function () {
    return this.classList.contains('personal-overview__device-track') ? trackWidth : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function () {
    if (!this.classList.contains('personal-overview__device-track')) return 0;
    const cardWidth = Math.min(trackWidth, Math.max(220, (trackWidth - 32) / 2.5));
    return this.children.length * cardWidth + Math.max(0, this.children.length - 1) * 16;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function () {
    if (!this.parentElement?.classList.contains('personal-overview__device-track')) return 0;
    const index = Array.from(this.parentElement.children).indexOf(this);
    return index * (Math.min(trackWidth, Math.max(220, (trackWidth - 32) / 2.5)) + 16);
  });
  mocks.peerMode = { active: false };
  mocks.refresh.mockReset().mockResolvedValue(undefined);
  mocks.getDeviceInfo.mockReset().mockResolvedValue({ device_id: 'local', device_name: 'Workstation', mac_address: '' });
  useDeviceDirectory.setState({ devices: [], localId: 'local', status: 'ready' });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useDeviceDirectory.setState(useDeviceDirectory.getInitialState(), true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('keeps the active peer and controller visible, using reported metadata and legacy device payloads', async () => {
  useDeviceDirectory.setState({ devices: [
    device('offline', { online: false }),
    device('online'),
    device('local'),
    device('peer', { device_alias: 'Build host', device_os: 'Linux', device_kind: 'cli', compatible: false }),
    device('extra'),
  ] });
  mocks.peerMode = { active: true, deviceId: 'peer', deviceName: 'Stale alias' };
  await render();
  expect([...container.querySelectorAll('[data-device-id]')].map(element => element.getAttribute('data-device-id')))
    .toEqual(['peer', 'local', 'extra', 'online', 'offline']);
  expect(row('peer')?.textContent).toContain('Build host');
  expect(row('peer')?.textContent).toContain('Linux');
  expect(row('peer')?.textContent).toContain('devices.current');
  expect(row('peer')?.textContent).toContain('devices.incompatible');
  expect(row('local')?.textContent).toContain('devices.thisDevice');
  expect(row('online')?.textContent).not.toContain('devices.incompatible');
  expect(container.textContent).not.toContain('Stale alias');
  expect(container.textContent).not.toContain('devices.viewAll');
  // Surface selection only changes presentation; the controller's directory survives.
  mocks.peerMode = { active: false };
  await render();
  expect(row('local')?.textContent).toContain('devices.current');
  expect(row('peer')?.textContent).not.toContain('devices.current');
  expect(useDeviceDirectory.getState().devices).toHaveLength(5);
});

it('scrolls all five devices by one card and disables the controls at either edge', async () => {
  useDeviceDirectory.setState({ devices: [device('local'), device('a'), device('b'), device('c'), device('d')] });
  await render();
  const scrollTo = mockScrolling();
  expect(track().children).toHaveLength(5);
  expect(previousButton()?.disabled).toBe(true);
  expect(nextButton()?.disabled).toBe(false);
  expect(nextButton()?.getAttribute('aria-controls')).toBe(track().id);

  await act(async () => nextButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
  expect(scrollTo).toHaveBeenLastCalledWith({ left: 256, behavior: 'smooth' });
  expect(previousButton()?.disabled).toBe(false);
  expect(nextButton()?.disabled).toBe(false);

  await act(async () => nextButton()!.click());
  expect(scrollTo).toHaveBeenLastCalledWith({ left: 512, behavior: 'auto' });
  await act(async () => nextButton()!.click());
  expect(scrollTo).toHaveBeenLastCalledWith({ left: 632, behavior: 'auto' });
  expect(nextButton()?.disabled).toBe(true);
  await act(async () => previousButton()!.click());
  expect(scrollTo).toHaveBeenLastCalledWith({ left: 376, behavior: 'auto' });

  scrollToPosition(-5);
  expect(previousButton()?.disabled).toBe(true);
  scrollToPosition(637);
  expect(nextButton()?.disabled).toBe(true);
});

it('uses instant scrolling with reduced motion and returns to the active host on a surface switch', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  useDeviceDirectory.setState({ devices: [device('local'), device('a'), device('b'), device('c'), device('d')] });
  await render();
  const scrollTo = mockScrolling();
  await act(async () => nextButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
  expect(scrollTo).toHaveBeenLastCalledWith({ left: 256, behavior: 'auto' });

  mocks.peerMode = { active: true, deviceId: 'd', deviceName: 'd' };
  await render();
  expect(track().firstElementChild).toBe(row('d'));
  expect(track().scrollLeft).toBe(0);
  expect(previousButton()?.disabled).toBe(true);
});

it('updates overflow for a hidden or resized scene and changing device inventory', async () => {
  trackWidth = 0;
  useDeviceDirectory.setState({ devices: [device('local'), device('a'), device('b'), device('c'), device('d')] });
  await render();
  expect(nextButton()).toBeNull();
  resize(632);
  expect(nextButton()?.disabled).toBe(false);
  scrollToPosition(632);
  resize(1264);
  expect(nextButton()?.disabled).toBe(false);
  await act(async () => useDeviceDirectory.setState({ devices: [device('local'), device('a')] }));
  expect(previousButton()).toBeNull();
  expect(nextButton()).toBeNull();
  scrollToPosition(0);
  resize(300);
  expect(nextButton()?.disabled).toBe(false);
  await act(async () => useDeviceDirectory.setState({ devices: [device('local')] }));
  expect(nextButton()).toBeNull();
});

it.each([true, false])('omits local presence labels when Relay reports online=%s, while keeping peer status', async (online) => {
  useDeviceDirectory.setState({ devices: [device('local', { online }), device('peer', { online: false })] });
  await render();
  expect(row('local')?.textContent).toContain('devices.current');
  expect(row('local')?.textContent).not.toContain('devices.online');
  expect(row('local')?.textContent).not.toContain('devices.offline');
  expect(row('peer')?.textContent).toContain('devices.offline');

  mocks.peerMode = { active: true, deviceId: 'peer', deviceName: 'peer' };
  await render();
  expect(row('local')?.textContent).toContain('devices.thisDevice');
  expect(row('local')?.textContent).not.toContain('devices.online');
  expect(row('local')?.textContent).not.toContain('devices.offline');
  expect(row('peer')?.textContent).toContain('devices.current');
  expect(row('peer')?.textContent).toContain('devices.offline');
  expect(row('peer')?.textContent).not.toContain('devices.online');
  expect(useDeviceDirectory.getState().devices.map(entry => entry.online)).toEqual([online, false]);
});

it('reflects aliases and offline presence updates without inventing an operating system', async () => {
  useDeviceDirectory.setState({ devices: [device('local'), device('peer')] });
  await render();
  await act(async () => {
    useDeviceDirectory.setState({ devices: [device('local'), device('peer', { device_alias: 'Renamed', online: false })] });
  });
  expect(row('peer')?.textContent).toContain('Renamed');
  expect(row('peer')?.textContent).toContain('devices.offline');
  expect(row('peer')?.querySelector('[data-system]')).toBeNull();
});

it('hides account inventory after sign-out and opens the existing device management flow', async () => {
  useDeviceDirectory.setState({ devices: [device('private-device')] });
  mocks.peerMode = { active: true, deviceId: 'private-device', deviceName: 'Private peer' };
  await render({ ...identity, status: 'signed-out' });
  expect(container.textContent).toContain('devices.signInHint');
  expect(row('private-device')).toBeNull();
  expect(row('local')?.textContent).toContain('Workstation');
  expect(row('local')?.textContent).toContain('devices.current');
  expect(row('local')?.textContent).not.toContain('devices.online');
  expect(mocks.getDeviceInfo).toHaveBeenCalledOnce();
  const signIn = container.querySelector<HTMLButtonElement>('[data-testid="personal-overview-sign-in-devices"]')!;
  expect(signIn.closest('li')?.previousElementSibling).toBe(row('local'));
  expect(signIn.querySelector('svg')).toBeNull();
  const opened = vi.fn();
  window.addEventListener('openbitfun:open-remote-connect', opened);
  try {
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="personal-overview-manage-devices"]')!.click(); });
    expect(opened).toHaveBeenCalledOnce();
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ group: 'account' });
    await act(async () => { signIn.click(); });
    expect(opened).toHaveBeenCalledTimes(2);
    expect((opened.mock.calls[1][0] as CustomEvent).detail).toEqual({ group: 'account' });
  } finally {
    window.removeEventListener('openbitfun:open-remote-connect', opened);
  }
});

it('shows this device immediately without a directory and fills in only reported local metadata', async () => {
  let finish!: (device: DeviceInfo) => void;
  mocks.getDeviceInfo.mockImplementation(() => new Promise<DeviceInfo>(resolve => { finish = resolve; }));
  useDeviceDirectory.setState({ devices: [], localId: null, status: 'idle' });
  await render({ ...identity, status: 'signed-out' });
  const placeholder = container.querySelector('[data-testid="personal-overview-local-device"]')!;
  expect(placeholder.textContent).toContain('devices.thisDevice');
  expect(placeholder.textContent).toContain('devices.current');
  expect(placeholder.querySelector('[data-system]')).toBeNull();
  expect(placeholder.hasAttribute('data-device-id')).toBe(false);
  expect(container.textContent).not.toContain('devices.empty');
  await act(async () => { finish({
    device_id: 'controller', device_name: 'My desktop', mac_address: 'private',
    device_os: 'Linux', device_kind: 'desktop', device_model: 'Workstation model',
  }); });
  expect(row('controller')?.textContent).toContain('My desktop');
  expect(row('controller')?.textContent).toContain('Workstation model · Linux');
  expect(container.textContent).not.toContain('private');
});

it('keeps a neutral current-device row if local metadata cannot be read', async () => {
  mocks.getDeviceInfo.mockRejectedValue(new Error('Device metadata unavailable'));
  await render({ ...identity, status: 'signed-out' });
  const local = container.querySelector('[data-testid="personal-overview-local-device"]')!;
  expect(local.textContent).toContain('devices.thisDevice');
  expect(local.textContent).toContain('devices.current');
  expect(local.textContent).not.toContain('devices.offline');
  expect(local.querySelector('[data-system]')).toBeNull();
  expect(container.textContent).toContain('devices.signInHint');
});

it('distinguishes loading, failed and empty reads, preserving stale entries with an explicit retry', async () => {
  useDeviceDirectory.setState({ status: 'loading', localId: null });
  await render();
  expect(container.textContent).toContain('devices.loading');
  expect(container.querySelector('section')?.getAttribute('aria-busy')).toBe('true');
  await act(async () => { useDeviceDirectory.setState({ status: 'failed', devices: [device('saved')] }); });
  expect(container.textContent).toContain('devices.failed');
  expect(container.textContent).not.toContain('devices.empty');
  expect(row('saved')).not.toBeNull();
  await act(async () => {
    [...container.querySelectorAll('button')].find(button => button.textContent === 'retry')!.click();
  });
  expect(mocks.refresh).toHaveBeenCalledOnce();
  await act(async () => { useDeviceDirectory.setState({ status: 'ready', devices: [] }); });
  expect(container.textContent).toContain('devices.empty');
  expect(container.textContent).not.toContain('devices.failed');
});
