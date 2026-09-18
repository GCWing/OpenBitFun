import { describe, expect, it } from 'vitest';
import type { RemoteConnectStatus } from '@/infrastructure/api/service-api/RemoteConnectAPI';
import {
  classifyAccountRelayUrl,
  connectionServiceFromRelayUrl,
  formatDeviceDisplayName,
  projectDeviceInterconnectionOverview,
  selectActivityFacts,
  selectAttachedGroups,
  type DeviceInterconnectionOverviewInput,
} from './deviceInterconnectionOverview';

const disconnectedStatus: RemoteConnectStatus = {
  relay_connected: false,
  relay_url: null,
  clients: [],
  active_method: null,
  bot_connected: null,
  bot_verbose_mode: false,
};

const baseInput = (
  overrides: Partial<DeviceInterconnectionOverviewInput> = {},
): DeviceInterconnectionOverviewInput => ({
  localDeviceName: 'This Windows',
  peer: null,
  remoteStatus: disconnectedStatus,
  remoteStatusState: 'ready',
  dispatchJobs: [],
  accountService: null,
  ...overrides,
});

describe('projectDeviceInterconnectionOverview', () => {
  it('presents local work as a complete state without a connection-service row', () => {
    const overview = projectDeviceInterconnectionOverview(baseInput());

    expect(overview.mode).toBe('local');
    expect(overview.devices).toEqual([
      expect.objectContaining({
        name: 'This Windows',
        activities: ['current-use'],
      }),
    ]);
    expect(overview.connectionService).toBeNull();
    expect(overview.topologyUnavailable).toBe(false);
  });

  it('does not turn account service availability into a connected-device state', () => {
    const overview = projectDeviceInterconnectionOverview(baseInput({
      accountService: connectionServiceFromRelayUrl(
        'https://remote.openbitfun.com/relay',
      ),
    }));

    expect(overview.mode).toBe('local');
    expect(overview.connectedDevices).toHaveLength(0);
    expect(overview.connectionService).toBeNull();
  });

  it('shows a paired phone once as a controller and identifies the active service', () => {
    const overview = projectDeviceInterconnectionOverview(baseInput({
      remoteStatus: {
        ...disconnectedStatus,
        relay_connected: true,
        relay_url: 'https://remote.openbitfun.com/v/1.0.2',
        active_method: 'openbitfun_server' as const,
        clients: [{ id: 'mobile-user', name: 'My iPhone' }],
      },
    }));

    expect(overview.mode).toBe('connected');
    expect(overview.devices).toHaveLength(2);
    expect(overview.connectedDevices).toEqual([
      expect.objectContaining({
        name: 'My iPhone',
        activities: ['controlling'],
      }),
    ]);
    expect(overview.connectionService?.kind).toBe('official');
  });

  it('names a paired bot once, as a controller rather than a second connection service', () => {
    const overview = projectDeviceInterconnectionOverview(baseInput({
      remoteStatus: { ...disconnectedStatus, bot_connected: 'Weixin(wxid_9f3a)' },
    }));

    expect(overview.mode).toBe('connected');
    expect(overview.connectedDevices).toEqual([
      expect.objectContaining({
        name: 'Weixin',
        kind: 'message-app',
        activities: ['controlling'],
      }),
    ]);
    expect(overview.connectionService).toBeNull();
  });

  it('reports the relay that carries dispatch work even while a bot is paired', () => {
    const overview = projectDeviceInterconnectionOverview(baseInput({
      accountService: connectionServiceFromRelayUrl('https://relay.example.com'),
      remoteStatus: { ...disconnectedStatus, bot_connected: 'Telegram(7096812005)' },
      dispatchJobs: [
        {
          id: 'job-device',
          state: 'running',
          target: { kind: 'device', id: 'linux-2', name: 'Build Server' },
        },
      ],
    }));

    expect(overview.connectionService?.kind).toBe('self-hosted');
  });

  it('makes the peer the current device and the local desktop its controller', () => {
    const overview = projectDeviceInterconnectionOverview(baseInput({
      peer: { deviceId: 'linux-1', deviceName: 'Linux Workstation' },
      accountService: connectionServiceFromRelayUrl('https://relay.example.com'),
    }));

    expect(overview.primaryDevice).toEqual(expect.objectContaining({
      id: 'device:linux-1',
      name: 'Linux Workstation',
      activities: ['current-use'],
    }));
    expect(overview.connectedDevices).toEqual([
      expect.objectContaining({
        id: 'device:local',
        name: 'This Windows',
        activities: ['controlling'],
      }),
    ]);
    expect(overview.connectionService?.kind).toBe('self-hosted');
  });

  it('shows same-account distributed hosts but excludes ordinary SSH targets', () => {
    const overview = projectDeviceInterconnectionOverview(baseInput({
      accountService: connectionServiceFromRelayUrl('https://relay.example.com'),
      dispatchJobs: [
        {
          id: 'job-device',
          state: 'running',
          target: { kind: 'device', id: 'linux-2', name: 'Build Server' },
        },
        {
          id: 'job-ssh',
          state: 'running',
          target: { kind: 'ssh', id: 'archive', name: 'SSH Archive' },
        },
      ],
    }));

    expect(overview.backgroundTaskCount).toBe(1);
    expect(overview.connectedDevices).toEqual([
      expect.objectContaining({
        id: 'device:linux-2',
        name: 'Build Server',
        kind: 'execution-host',
        activities: ['background-execution'],
        backgroundTaskCount: 1,
      }),
    ]);
    expect(overview.devices.some(device => device.name === 'SSH Archive')).toBe(false);
    expect(overview.connectionService?.kind).toBe('self-hosted');
  });

  it('merges current use and background execution for the same peer device', () => {
    const overview = projectDeviceInterconnectionOverview(baseInput({
      peer: { deviceId: 'linux-1', deviceName: 'Linux Workstation' },
      dispatchJobs: [
        {
          id: 'job-1',
          state: 'running',
          target: { kind: 'device', id: 'linux-1', name: 'Linux Workstation' },
        },
      ],
    }));

    expect(overview.devices.filter(device => device.id === 'device:linux-1')).toHaveLength(1);
    expect(overview.primaryDevice.activities).toEqual([
      'current-use',
      'background-execution',
    ]);
    expect(overview.primaryDevice.backgroundTaskCount).toBe(1);
  });
});

describe('selectActivityFacts', () => {
  const connectedPhone = {
    ...disconnectedStatus,
    relay_connected: true,
        relay_url: 'https://remote.openbitfun.com/v/1.0.2',
        active_method: 'openbitfun_server' as const,
        clients: [{ id: 'mobile-user', name: 'My iPhone' }],
  };

  it('reports nothing beyond the local host when no device is attached', () => {
    expect(selectActivityFacts(projectDeviceInterconnectionOverview(baseInput())))
      .toEqual([{ kind: 'local' }]);
  });

  it('names the single remote party that holds this host', () => {
    const overview = projectDeviceInterconnectionOverview(baseInput({
      remoteStatus: connectedPhone,
    }));

    expect(selectActivityFacts(overview)).toEqual([
      { kind: 'controlled-by', device: 'My iPhone' },
    ]);
  });

  it('counts controllers instead of naming only the first when several hold this host', () => {
    const overview = projectDeviceInterconnectionOverview(baseInput({
      remoteStatus: { ...connectedPhone, bot_connected: 'Weixin (group)' },
    }));

    expect(selectActivityFacts(overview)).toEqual([{ kind: 'controllers', count: 2 }]);
  });

  it('states that this device drives the work when peer mode is active', () => {
    const overview = projectDeviceInterconnectionOverview(baseInput({
      peer: { deviceId: 'linux-1', deviceName: 'Linux Workstation' },
      remoteStatus: connectedPhone,
    }));

    expect(selectActivityFacts(overview)).toEqual([{ kind: 'controlled-from-here' }]);
  });

  it('reports distributed execution when devices only run background work', () => {
    const overview = projectDeviceInterconnectionOverview(baseInput({
      dispatchJobs: [
        {
          id: 'job-device',
          state: 'running',
          target: { kind: 'device', id: 'linux-2', name: 'Build Server' },
        },
      ],
    }));

    expect(selectActivityFacts(overview)).toEqual([
      { kind: 'distributed-execution', count: 1 },
    ]);
  });

  it('keeps control and distributed execution as separate facts when both hold', () => {
    const overview = projectDeviceInterconnectionOverview(baseInput({
      remoteStatus: connectedPhone,
      dispatchJobs: [
        { id: 'a', state: 'running', target: { kind: 'device', id: 'host-1', name: 'Host 1' } },
        { id: 'b', state: 'queued', target: { kind: 'device', id: 'host-2', name: 'Host 2' } },
      ],
    }));

    expect(selectActivityFacts(overview)).toEqual([
      { kind: 'controlled-by', device: 'My iPhone' },
      { kind: 'distributed-execution', count: 2 },
    ]);
  });
});

describe('selectAttachedGroups', () => {
  it('shows nothing while no other device is attached', () => {
    expect(selectAttachedGroups(projectDeviceInterconnectionOverview(baseInput())))
      .toEqual([]);
  });

  it('keeps one group per device kind so the footer width never grows with device count', () => {
    const overview = projectDeviceInterconnectionOverview(baseInput({
      remoteStatus: {
        ...disconnectedStatus,
        relay_connected: true,
        relay_url: 'https://remote.openbitfun.com/v/1.0.2',
        active_method: 'openbitfun_server' as const,
        clients: [{ id: 'mobile-user', name: 'My iPhone' }],
        bot_connected: 'Weixin (family group)',
      },
      dispatchJobs: [
        { id: 'a', state: 'running', target: { kind: 'device', id: 'host-1', name: 'Host 1' } },
        { id: 'b', state: 'queued', target: { kind: 'device', id: 'host-2', name: 'Host 2' } },
        { id: 'c', state: 'running', target: { kind: 'device', id: 'host-3', name: 'Host 3' } },
      ],
    }));

    expect(selectAttachedGroups(overview)).toEqual([
      { kind: 'mobile', count: 1 },
      { kind: 'message-app', count: 1 },
      { kind: 'execution-host', count: 3 },
    ]);
  });

  it('counts the controlling desktop when this device drives a peer', () => {
    const overview = projectDeviceInterconnectionOverview(baseInput({
      peer: { deviceId: 'linux-1', deviceName: 'Linux Workstation' },
    }));

    expect(selectAttachedGroups(overview)).toEqual([{ kind: 'desktop', count: 1 }]);
  });

  it('leaves the current device out of the attached groups', () => {
    const overview = projectDeviceInterconnectionOverview(baseInput({
      peer: { deviceId: 'linux-1', deviceName: 'Linux Workstation' },
      dispatchJobs: [
        {
          id: 'job-1',
          state: 'running',
          target: { kind: 'device', id: 'linux-1', name: 'Linux Workstation' },
        },
      ],
    }));

    expect(overview.primaryDevice.activities).toContain('background-execution');
    expect(selectAttachedGroups(overview)).toEqual([{ kind: 'desktop', count: 1 }]);
  });
});

describe('device display names', () => {
  it('drops the discovery zone suffix that no person uses to name a machine', () => {
    expect(formatDeviceDisplayName('yuyuqingqingdeMacBook-Pro.local')).toBe('yuyuqingqingdeMacBook-Pro');
    expect(formatDeviceDisplayName('build-box.LAN')).toBe('build-box');
    expect(formatDeviceDisplayName('nas.internal.')).toBe('nas');
  });

  it('keeps names that only look like a zone suffix', () => {
    expect(formatDeviceDisplayName('.local')).toBe('.local');
    expect(formatDeviceDisplayName('  My iPhone  ')).toBe('My iPhone');
    expect(formatDeviceDisplayName(null)).toBe('');
  });

  it('normalizes every device name the overview projects', () => {
    const overview = projectDeviceInterconnectionOverview(baseInput({
      localDeviceName: 'Studio-Mac.local',
      remoteStatus: {
        ...disconnectedStatus,
        relay_connected: true,
        relay_url: 'https://remote.openbitfun.com/v/1.0.2',
        active_method: 'openbitfun_server' as const,
        clients: [{ id: 'mobile-user', name: 'Pixel.lan' }],
      },
      dispatchJobs: [
        {
          id: 'job-device',
          state: 'running',
          target: { kind: 'device', id: 'linux-2', name: 'Build-Server.local' },
        },
      ],
    }));

    expect(overview.localDeviceName).toBe('Studio-Mac');
    expect(overview.devices.map(device => device.name)).toEqual([
      'Studio-Mac',
      'Pixel',
      'Build-Server',
    ]);
  });
});

describe('connection service classification', () => {
  it('only classifies the canonical OpenBitFun relay host as official', () => {
    expect(classifyAccountRelayUrl('https://remote.openbitfun.com/relay')).toBe('official-relay');
    expect(classifyAccountRelayUrl('https://relay.example.com')).toBe('self-hosted-relay');
    expect(classifyAccountRelayUrl('not a url')).toBe('unknown');
  });
});
