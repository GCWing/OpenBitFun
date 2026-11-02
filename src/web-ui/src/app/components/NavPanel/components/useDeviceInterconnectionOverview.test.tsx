// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDeviceDirectory } from '@/infrastructure/account/deviceDirectory';
import {
  useDeviceInterconnectionOverview,
} from './useDeviceInterconnectionOverview';
import type { DeviceInterconnectionOverview } from '../deviceInterconnectionOverview';

const state = vi.hoisted(() => ({
  deviceName: 'Workstation' as string | null,
  peer: null as { deviceId: string; deviceName: string } | null,
}));

vi.mock('@/infrastructure/account/useAccountLoginState', () => ({
  useAccountLoginState: () => ({ loggedIn: true, deviceName: state.deviceName }),
}));
vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({
  api: { listen: () => () => {} },
}));
vi.mock('@/infrastructure/api/service-api/RemoteConnectAPI', async importOriginal => ({
  ...await importOriginal<typeof import('@/infrastructure/api/service-api/RemoteConnectAPI')>(),
  remoteConnectAPI: {
    // Identity only: this command states no system and no kind for any client.
    getDeviceInfo: async () => ({
      device_id: 'local', device_name: 'Workstation', mac_address: '',
    }),
    accountGetCredentialHint: async () => ({ relay_url: null }),
  },
}));
vi.mock('@/infrastructure/remote-connect/remoteConnectStatus', () => ({
  remoteConnectStatusSource: { refresh: async () => undefined },
  useRemoteConnectStatus: () => ({
    status: {
      relay_connected: false,
      relay_url: null,
      active_method: null,
      clients: [],
      bot_connected: null,
      bot_verbose_mode: false,
    },
    state: 'ready',
  }),
}));
vi.mock('@/infrastructure/peer-device/peerDeviceContextState', () => ({
  usePeerDeviceModeOptional: () => (state.peer
    ? { peerMode: { active: true, ...state.peer }, attachments: [] }
    : undefined),
}));
vi.mock('@/features/dispatch/dispatchJobStore', () => ({
  useDispatchJobStore: (selector: (value: { jobs: Record<string, never> }) => unknown) => selector({ jobs: {} }),
}));

let root: Root;
let container: HTMLDivElement;
let rendered: DeviceInterconnectionOverview | null = null;

function Probe() {
  const { overview } = useDeviceInterconnectionOverview('Fallback device');
  rendered = overview;
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.deviceName = 'Workstation';
  state.peer = null;
  rendered = null;
  useDeviceDirectory.setState({ devices: [], localId: null });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useDeviceDirectory.setState({ devices: [], localId: null });
});

async function render() {
  await act(async () => { root.render(<Probe />); });
  // The hook reads through one refresh pass before it can project anything.
  await act(async () => { await Promise.resolve(); });
  return rendered!;
}

const directoryRow = (overrides: Record<string, unknown>) => ({
  device_id: 'local', device_name: 'Workstation', online: true, ...overrides,
});

describe('device interconnection overview inputs', () => {
  it('takes this machine\'s system and kind from the account directory row', async () => {
    // The device info call answers with identity only, so a system can only come
    // from the row this client reported to the Relay — the same row the device
    // list draws, never the browser's own platform.
    useDeviceDirectory.setState({
      devices: [directoryRow({ device_os: 'macOS 15.7.3', device_kind: 'desktop' })] as never,
      localId: 'local',
    });

    const overview = await render();
    expect(overview.primaryDevice.local).toBe(true);
    expect(overview.primaryDevice.os).toBe('macOS 15.7.3');
    expect(overview.primaryDevice.hostKind).toBe('desktop');
  });

  it('keeps this machine\'s own facts while a peer is the device in use', async () => {
    useDeviceDirectory.setState({
      devices: [directoryRow({
        device_os: 'macOS 15.7.3', device_kind: 'cli', device_alias: 'lwb_macbook',
      })] as never,
      localId: 'local',
    });
    state.peer = { deviceId: 'peer-1', deviceName: 'Windows box' };

    const overview = await render();
    expect(overview.primaryDevice.name).toBe('Windows box');
    const mac = overview.devices.find(device => device.local);
    expect(mac?.os).toBe('macOS 15.7.3');
    expect(mac?.hostKind).toBe('cli');
  });

  it('states no system at all when no directory row has arrived', async () => {
    // An unloaded directory is not evidence of a system, and the browser's own
    // platform is not this machine's: the neutral mark is the honest answer
    // rather than a plausible guess.
    const overview = await render();
    expect(overview.primaryDevice.os).toBeNull();
    expect(overview.primaryDevice.hostKind).toBeNull();
  });
});
