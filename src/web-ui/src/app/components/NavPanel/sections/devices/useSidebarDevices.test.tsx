// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { SIDEBAR_PRESENCE_GAP_GRACE_MS, resetSidebarPresenceGapsForTest, useSidebarDevices } from './useSidebarDevices';
import { useDeviceDirectory } from '@/infrastructure/account/deviceDirectory';
import { useDeviceOrderPreferences } from '@/app/navigation/deviceOrderPreferences';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import type { AccountDeviceInfo } from '@/infrastructure/api/service-api/RemoteConnectAPI';

vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({ api: { listen: () => () => {} } }));
vi.mock('@/infrastructure/peer-device/peerDeviceContextState', () => ({ usePeerDeviceModeOptional: () => null }));

it('uses saved device IDs for sidebar order across remote activation, offline recovery, and renames', () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  useDeviceOrderPreferences.setState({ order: ['peer', 'local-id', 'offline'] });
  const devices = [
    { device_id: 'local-id', device_name: 'Local', online: true },
    { device_id: 'peer', device_name: 'Peer', online: true },
    { device_id: 'offline', device_name: 'Offline', online: false },
  ] as AccountDeviceInfo[];
  useDeviceDirectory.setState({ localId: 'local-id', devices, status: 'ready' });
  activateSurface('local');
  const host = document.createElement('div');
  const root = createRoot(host);
  function Probe() { return <>{useSidebarDevices('This computer').map(slot => <span key={slot.surfaceId} data-id={slot.deviceId} data-rendered={slot.rendered} />)}</>; }
  const order = () => [...host.querySelectorAll('span')].map(node => node.dataset.id);
  try {
    act(() => root.render(<Probe />));
    expect(order()).toEqual(['peer', 'local-id']);
    act(() => activateSurface('peer'));
    expect(order()).toEqual(['peer', 'local-id']);
    expect(host.querySelector('[data-rendered="true"]')?.getAttribute('data-id')).toBe('peer');
    act(() => useDeviceDirectory.setState({ devices: devices.map(device => ({ ...device, online: true, device_alias: 'Renamed' })) }));
    expect(order()).toEqual(['peer', 'local-id', 'offline']);
    act(() => useDeviceOrderPreferences.getState().move('offline', 'peer', 'before', ['peer', 'local-id', 'offline']));
    expect(order()).toEqual(['offline', 'peer', 'local-id']);
  } finally {
    act(() => root.unmount());
    activateSurface('local');
    useDeviceOrderPreferences.setState({ order: [] });
  }
});

it('keeps a section through a short presence gap and marks it reconnecting', () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  resetSidebarPresenceGapsForTest();
  const devices = [
    { device_id: 'local-id', device_name: 'Local', online: true },
    { device_id: 'peer', device_name: 'Peer', online: true },
  ] as AccountDeviceInfo[];
  useDeviceDirectory.setState({ localId: 'local-id', devices, status: 'ready' });
  activateSurface('local');
  const host = document.createElement('div');
  const root = createRoot(host);
  function Probe() {
    return <>{useSidebarDevices('This computer').map(slot => (
      <span key={slot.surfaceId} data-id={slot.deviceId} data-link={slot.linkState ?? ''} />
    ))}</>;
  }
  const peer = () => host.querySelector('[data-id="peer"]');
  try {
    act(() => root.render(<Probe />));
    expect(peer()?.getAttribute('data-link')).toBe('');

    // A routing reconnect reports an empty roster for a moment.
    act(() => useDeviceDirectory.setState({ devices: devices.map(device => ({ ...device, online: device.device_id === 'local-id' })) }));
    expect(peer()?.getAttribute('data-link')).toBe('reconnecting');

    act(() => useDeviceDirectory.setState({ devices }));
    expect(peer()?.getAttribute('data-link')).toBe('');

    // A device that stays away is dropped once the grace period ends.
    act(() => useDeviceDirectory.setState({ devices: devices.map(device => ({ ...device, online: device.device_id === 'local-id' })) }));
    act(() => { vi.advanceTimersByTime(SIDEBAR_PRESENCE_GAP_GRACE_MS + 1); });
    expect(peer()).toBeNull();
  } finally {
    act(() => root.unmount());
    vi.useRealTimers();
    resetSidebarPresenceGapsForTest();
  }
});
