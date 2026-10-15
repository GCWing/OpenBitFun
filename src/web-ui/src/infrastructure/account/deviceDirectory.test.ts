/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import {
  startDeviceDirectory, refreshDeviceDirectory, resolveDeviceName, useDeviceDirectory,
  isDeviceControllable, deviceClientVersion,
} from './deviceDirectory';
const mocks = vi.hoisted(() => ({ list: vi.fn(), local: vi.fn(), events: new Map<string, () => void>() }));
vi.mock('@/infrastructure/api/service-api/RemoteConnectAPI', async original => ({
  ...await original<typeof import('@/infrastructure/api/service-api/RemoteConnectAPI')>(),
  remoteConnectAPI: { accountListDevices: mocks.list, getDeviceInfo: mocks.local },
}));
vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({ api: { listen: (name: string, listener: () => void) => { mocks.events.set(name, listener); return () => mocks.events.delete(name); } } }));
let stop = () => {};
afterEach(() => { stop(); vi.resetAllMocks(); });
const device = (alias: string | null) => ({ device_id: 'peer', device_name: 'technical', device_alias: alias, online: true, last_seen_at: null });
it('resolves active, local and persisted dispatch labels by ID; presence triggers GET, never overwrites metadata', async () => {
  mocks.local.mockResolvedValue({ device_id: 'peer' });
  mocks.list.mockResolvedValue([device('Alias')]);
  stop = startDeviceDirectory(); await refreshDeviceDirectory();
  expect(resolveDeviceName('peer', 'stale saved name')).toBe('Alias');
  expect(useDeviceDirectory.getState().localId).toBe('peer');
  expect(useDeviceDirectory.getState().status).toBe('ready');
  mocks.list.mockResolvedValue([device('Renamed')]);
  mocks.events.get('account://device-presence')!(); await refreshDeviceDirectory();
  expect(resolveDeviceName('peer', 'technical')).toBe('Renamed');
  mocks.list.mockResolvedValue([device(null)]); await refreshDeviceDirectory();
  expect(resolveDeviceName('peer')).toBe('technical');
});
it('fences late old-account GET and preserves aliases on failed reads', async () => {
  mocks.local.mockResolvedValue({ device_id: 'peer' });
  let finish!: (value: unknown) => void;
  mocks.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  stop = startDeviceDirectory(); await Promise.resolve(); stop();
  mocks.list.mockResolvedValue([device('New account')]);
  stop = startDeviceDirectory(); await refreshDeviceDirectory();
  finish([device('Old account')]); await Promise.resolve();
  expect(resolveDeviceName('peer')).toBe('New account');
  expect(useDeviceDirectory.getState().status).toBe('ready');
  mocks.list.mockRejectedValue(new Error('offline')); await refreshDeviceDirectory();
  expect(resolveDeviceName('peer')).toBe('New account');
  expect(useDeviceDirectory.getState().status).toBe('failed');
  mocks.list.mockResolvedValue([device('Recovered')]); await refreshDeviceDirectory();
  expect(useDeviceDirectory.getState().status).toBe('ready');
  expect(resolveDeviceName('peer')).toBe('Recovered');
});

it('exposes initial loading and failed reads, and ignores late failures after account replacement', async () => {
  mocks.local.mockResolvedValue({ device_id: 'peer' });
  let rejectOld!: (error: Error) => void;
  mocks.list.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
  stop = startDeviceDirectory();
  expect(useDeviceDirectory.getState().status).toBe('loading');
  await Promise.resolve(); stop();
  expect(useDeviceDirectory.getState().status).toBe('idle');
  mocks.list.mockResolvedValue([]);
  stop = startDeviceDirectory(); await refreshDeviceDirectory();
  rejectOld(new Error('Old account offline')); await Promise.resolve(); await Promise.resolve();
  expect(useDeviceDirectory.getState()).toMatchObject({ devices: [], status: 'ready' });
  stop();
  mocks.list.mockRejectedValue(new Error('Unavailable'));
  stop = startDeviceDirectory(); await refreshDeviceDirectory();
  expect(useDeviceDirectory.getState()).toMatchObject({ devices: [], localId: null, status: 'failed' });
});

it('treats only a confirmed incompatible flag as uncontrollable', () => {
  // A missing flag (older Relay or older payload) must never block control.
  expect(isDeviceControllable({})).toBe(true);
  expect(isDeviceControllable({ compatible: undefined })).toBe(true);
  expect(isDeviceControllable({ compatible: true })).toBe(true);
  expect(isDeviceControllable({ compatible: false })).toBe(false);
});

it('exposes a peer client version only when the Relay reported a non-empty one', () => {
  // The host projection emits `device_client_version`; the Relay's own
  // `client_version` spelling is read too.
  expect(deviceClientVersion({ device_client_version: '1.2.3' })).toBe('1.2.3');
  expect(deviceClientVersion({ client_version: '1.2.3' })).toBe('1.2.3');
  expect(deviceClientVersion({ device_client_version: '  1.2.3  ' })).toBe('1.2.3');
  expect(deviceClientVersion({ device_client_version: '1.2.3', client_version: '0.9.0' })).toBe('1.2.3');
  expect(deviceClientVersion({ device_client_version: null, client_version: '0.9.0' })).toBe('0.9.0');
  expect(deviceClientVersion({ device_client_version: null })).toBe(null);
  expect(deviceClientVersion({ device_client_version: '   ' })).toBe(null);
  expect(deviceClientVersion({})).toBe(null);
});
