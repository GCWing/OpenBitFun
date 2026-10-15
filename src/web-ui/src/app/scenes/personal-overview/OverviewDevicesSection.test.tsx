/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AccountIdentitySnapshot } from '@/infrastructure/account-identity';
import { useDeviceDirectory } from '@/infrastructure/account/deviceDirectory';
import type { AccountDeviceInfo } from '@/infrastructure/api/service-api/RemoteConnectAPI';
import type { PeerModeState } from '@/infrastructure/peer-device/peerDeviceContextState';
import { OverviewDevicesSection } from './OverviewDevicesSection';

const mocks = vi.hoisted(() => ({
  peerMode: { active: false } as PeerModeState,
  refresh: vi.fn(),
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
const identity: AccountIdentitySnapshot = { resolved: true, status: 'signed-in', me: null };
const device = (id: string, extra: Partial<AccountDeviceInfo> = {}): AccountDeviceInfo => ({
  device_id: id, device_name: id, online: true, last_seen_at: null, ...extra,
});
const render = (snapshot = identity) => act(async () => { root.render(<OverviewDevicesSection identity={snapshot} />); });
const row = (id: string) => container.querySelector(`[data-device-id="${id}"]`);

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.peerMode = { active: false };
  mocks.refresh.mockReset().mockResolvedValue(undefined);
  useDeviceDirectory.setState({ devices: [], localId: 'local', status: 'ready' });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useDeviceDirectory.setState(useDeviceDirectory.getInitialState(), true);
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
    .toEqual(['peer', 'local', 'extra', 'online']);
  expect(row('peer')?.textContent).toContain('Build host');
  expect(row('peer')?.textContent).toContain('Linux');
  expect(row('peer')?.textContent).toContain('devices.current');
  expect(row('peer')?.textContent).toContain('devices.incompatible');
  expect(row('local')?.textContent).toContain('devices.thisDevice');
  expect(row('online')?.textContent).not.toContain('devices.incompatible');
  expect(container.textContent).not.toContain('Stale alias');
  expect(container.textContent).toContain('devices.viewAll:5');
  // Surface selection only changes presentation; the controller's directory survives.
  mocks.peerMode = { active: false };
  await render();
  expect(row('local')?.textContent).toContain('devices.current');
  expect(row('peer')?.textContent).not.toContain('devices.current');
  expect(useDeviceDirectory.getState().devices).toHaveLength(5);
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
  await render({ ...identity, status: 'signed-out' });
  expect(container.textContent).toContain('devices.signInHint');
  expect(row('private-device')).toBeNull();
  const opened = vi.fn();
  window.addEventListener('openbitfun:open-remote-connect', opened);
  try {
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="personal-overview-manage-devices"]')!.click(); });
    expect(opened).toHaveBeenCalledOnce();
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ group: 'account' });
  } finally {
    window.removeEventListener('openbitfun:open-remote-connect', opened);
  }
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
