// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';
import { applyDeviceOrder, sortAccountDevices, useDeviceOrderPreferences as preferences } from './deviceOrderPreferences';
import type { AccountDeviceInfo } from '@/infrastructure/api/service-api/RemoteConnectAPI';

const storageKey = 'openbitfun.device-order.v1';
beforeEach(() => { localStorage.clear(); preferences.setState({ order: [] }); });

it.each([undefined, {}, { order: null }, { order: 'local' }, { hidden: { local: true } }])(
  'loads absent or legacy preferences without requiring a migration: %j', async state => {
    const saved = JSON.stringify({ state, version: 0 });
    localStorage.setItem(storageKey, saved);
    await preferences.persist.rehydrate();
    expect(preferences.getState().order).toEqual([]);
    expect(localStorage.getItem(storageKey)).toBe(saved);
  },
);

it('round-trips order while preserving absent devices and ignoring invalid stored IDs', async () => {
  localStorage.setItem(storageKey, JSON.stringify({ state: { order: ['offline', 'peer', 7, '', 'peer', 'local'] }, version: 0 }));
  await preferences.persist.rehydrate();
  expect(preferences.getState().order).toEqual(['offline', 'peer', 'local']);
  const visible = applyDeviceOrder(['local', 'peer'], preferences.getState().order, id => id);
  expect(visible).toEqual(['peer', 'local']);
  preferences.getState().move('local', 'peer', 'before', visible);
  const saved = localStorage.getItem(storageKey)!;
  preferences.setState({ order: [] });
  localStorage.setItem(storageKey, saved);
  await preferences.persist.rehydrate();
  expect(preferences.getState().order).toEqual(['offline', 'local', 'peer']);
  expect(applyDeviceOrder(['new', 'offline', 'peer', 'local'], preferences.getState().order, id => id))
    .toEqual(['offline', 'local', 'peer', 'new']);
});

it('keeps identity-based order through renames, presence changes, and invalid drops', () => {
  preferences.getState().move('peer', 'local', 'before', ['local', 'peer', 'offline']);
  const order = preferences.getState().order;
  preferences.getState().move('unknown', 'peer', 'before', ['local', 'peer']);
  preferences.getState().move('peer', 'peer', 'after', ['local', 'peer']);
  expect(preferences.getState().order).toBe(order);
  const devices = [
    { device_id: 'local', device_name: 'Z', online: true },
    { device_id: 'peer', device_name: 'Renamed', online: false },
    { device_id: 'offline', device_name: 'A', online: true },
  ] as AccountDeviceInfo[];
  expect(sortAccountDevices(devices, 'local', order).map(device => device.device_id)).toEqual(['peer', 'local', 'offline']);
});
