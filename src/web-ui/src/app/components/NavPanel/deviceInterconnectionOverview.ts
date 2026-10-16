import type { RemoteConnectStatus } from '@/infrastructure/api/service-api/RemoteConnectAPI';
import { selectRemoteNetworkConnection } from '@/infrastructure/remote-connect/remoteConnectionState';

export type DeviceOverviewMode = 'local' | 'connected';
export type DeviceOverviewDeviceKind =
  | 'desktop'
  | 'mobile'
  | 'execution-host'
  | 'message-app';
export type DeviceOverviewActivity =
  | 'current-use'
  | 'controlling'
  | 'background-execution';
/**
 * Host kind a device reports, from the account directory (`device_kind`) or
 * from a live peer control link (`host_type`). Controllers report `mobile` or
 * `watch` and are not hosts; anything unrecognized or missing stays `null`
 * rather than being guessed, so the caller can fall back to weaker evidence.
 */
export type DeviceOverviewHostKind = 'desktop' | 'cli';

const HOST_KINDS: Record<string, DeviceOverviewHostKind> = {
  desktop: 'desktop',
  cli: 'cli',
};

export function reportedHostKind(kind: string | null | undefined): DeviceOverviewHostKind | null {
  return HOST_KINDS[kind?.trim().toLowerCase() ?? ''] ?? null;
}
/**
 * A connection service answers "which relay or network carries this link", a
 * fact no device row can state. A message app is not one of those: it is the
 * controller itself, already listed as a device, so reporting it here would only
 * repeat that row's icon and name.
 */
export type DeviceOverviewConnectionServiceKind =
  | 'official'
  | 'self-hosted'
  | 'local-network'
  | 'public-tunnel'
  | 'device-service';

export interface DeviceOverviewDevice {
  id: string;
  name: string;
  kind: DeviceOverviewDeviceKind;
  local: boolean;
  activities: DeviceOverviewActivity[];
  backgroundTaskCount: number;
  /**
   * System the device itself reported to the Relay. Absent for devices that
   * never reported metadata; the controller's own platform never stands in for
   * it, so an unknown system keeps the neutral artwork.
   */
  os?: string | null;
  /**
   * Whether this device is a headless host. Read from the kind the device
   * reported, or from its control link when that link says something newer.
   */
  hostKind?: DeviceOverviewHostKind | null;
}

export interface DeviceOverviewConnectionService {
  kind: DeviceOverviewConnectionServiceKind;
  url: string | null;
  host: string | null;
}

export interface DeviceInterconnectionOverview {
  mode: DeviceOverviewMode;
  localDeviceName: string;
  currentWorkDeviceName: string;
  primaryDevice: DeviceOverviewDevice;
  connectedDevices: DeviceOverviewDevice[];
  devices: DeviceOverviewDevice[];
  connectionService: DeviceOverviewConnectionService | null;
  controllerCount: number;
  backgroundTaskCount: number;
  peerActive: boolean;
  topologyUnavailable: boolean;
}

/**
 * What the device status has to state, as facts rather than phrases, so the
 * selection stays testable and the surface owns only the wording.
 */
export type DeviceOverviewActivityFact =
  | { kind: 'local' }
  | { kind: 'controlled-from-here' }
  | { kind: 'controlled-by'; device: string }
  | { kind: 'controllers'; count: number }
  | { kind: 'distributed-execution'; count: number };

/**
 * Control and distributed execution are separate facts that can hold at the
 * same time. Collapsing them into a single phrase would silently drop whichever
 * one lost, and these sentences are now the only place the detail is spelled
 * out, so they have to be complete.
 */
export function selectActivityFacts(
  overview: DeviceInterconnectionOverview,
): DeviceOverviewActivityFact[] {
  if (overview.mode === 'local') return [{ kind: 'local' }];

  const facts: DeviceOverviewActivityFact[] = [];
  if (overview.peerActive) {
    facts.push({ kind: 'controlled-from-here' });
  } else {
    // Every remote party holding this host counts. Naming only the first one
    // would claim a single controller while several are attached.
    const controllers = overview.devices.filter(device => (
      !device.local && device.activities.includes('controlling')
    ));
    if (controllers.length === 1) {
      facts.push({ kind: 'controlled-by', device: controllers[0].name });
    } else if (controllers.length > 1) {
      facts.push({ kind: 'controllers', count: controllers.length });
    }
  }

  const executingDeviceCount = overview.connectedDevices.filter(device => (
    device.activities.includes('background-execution')
  )).length;
  if (executingDeviceCount > 0) {
    facts.push({ kind: 'distributed-execution', count: executingDeviceCount });
  }

  return facts;
}

export interface DeviceOverviewAttachedGroup {
  kind: DeviceOverviewDeviceKind;
  count: number;
}

const ATTACHED_GROUP_ORDER: DeviceOverviewDeviceKind[] = [
  'desktop',
  'mobile',
  'message-app',
  'execution-host',
];

/**
 * Attached devices collapsed to one group per device kind. The footer trigger
 * lives in fixed navigation chrome, so it has to stay the same size whether one
 * phone or twenty hosts are attached: the number belongs inside a group, never
 * in the layout, and the names belong in the overview a click away.
 */
export function selectAttachedGroups(
  overview: DeviceInterconnectionOverview,
): DeviceOverviewAttachedGroup[] {
  const counts = new Map<DeviceOverviewDeviceKind, number>();
  for (const device of overview.connectedDevices) {
    const attached = device.activities.includes('controlling')
      || device.activities.includes('background-execution');
    if (!attached) continue;
    counts.set(device.kind, (counts.get(device.kind) ?? 0) + 1);
  }
  return ATTACHED_GROUP_ORDER
    .filter(kind => counts.has(kind))
    .map(kind => ({ kind, count: counts.get(kind) as number }));
}

export interface DeviceOverviewDispatchJob {
  id: string;
  state: 'submitting' | 'submission_unknown' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  target:
    | { kind: 'local' }
    | { kind: 'ssh'; id: string; name: string }
    | { kind: 'device'; id: string; name: string };
}

export interface DeviceInterconnectionOverviewInput {
  localDeviceName: string;
  fallbackMobileDeviceName?: string;
  /** System reported by this machine's own device info, never the browser's. */
  localDeviceOs?: string | null;
  /** Kind this machine's own device info reported to the Relay. */
  localDeviceKind?: string | null;
  peer: { deviceId: string; deviceName: string } | null;
  /** System the rendered peer last reported to the Relay. */
  peerDeviceOs?: string | null;
  /** Kind the rendered peer last reported to the Relay. */
  peerDeviceKind?: string | null;
  remoteStatus: RemoteConnectStatus | null;
  remoteStatusState: 'loading' | 'ready' | 'unavailable';
  dispatchJobs: DeviceOverviewDispatchJob[];
  accountService: DeviceOverviewConnectionService | null;
}

const ACTIVE_DISPATCH_STATES = new Set<DeviceOverviewDispatchJob['state']>([
  'submitting',
  'submission_unknown',
  'queued',
  'running',
]);

const OFFICIAL_RELAY_HOST = 'remote.openbitfun.com';

// Device names reach us as discovery host names, so macOS reports
// `<name>.local` and LAN hosts add their own zone. That suffix identifies a
// network zone, not a machine, and it spends the scarce width the footer has
// for the part a person actually recognizes.
const NETWORK_ZONE_SUFFIXES = ['.local', '.lan', '.home', '.internal'];

export function formatDeviceDisplayName(rawName: string | null | undefined): string {
  const trimmed = rawName?.trim() ?? '';
  const withoutRoot = trimmed.replace(/\.+$/, '');
  const lowered = withoutRoot.toLowerCase();
  const suffix = NETWORK_ZONE_SUFFIXES.find(candidate => (
    lowered.endsWith(candidate) && withoutRoot.length > candidate.length
  ));
  return (suffix ? withoutRoot.slice(0, -suffix.length) : withoutRoot) || trimmed;
}

export function connectionServiceFromRelayUrl(
  relayUrl: string | null | undefined,
): DeviceOverviewConnectionService | null {
  const value = relayUrl?.trim();
  if (!value) return null;

  try {
    const parsed = new URL(value);
    const host = parsed.host.toLowerCase();
    return {
      kind: parsed.hostname.toLowerCase() === OFFICIAL_RELAY_HOST
        ? 'official'
        : 'self-hosted',
      url: value,
      host,
    };
  } catch {
    return null;
  }
}

export function classifyAccountRelayUrl(
  relayUrl: string | null | undefined,
): 'official-relay' | 'self-hosted-relay' | 'unknown' {
  const service = connectionServiceFromRelayUrl(relayUrl);
  if (!service) return 'unknown';
  return service.kind === 'official' ? 'official-relay' : 'self-hosted-relay';
}

function messageApplicationName(botConnected: string): string | undefined {
  const name = botConnected.split('(', 1)[0]?.trim();
  return name || undefined;
}

function addActivity(
  device: DeviceOverviewDevice,
  activity: DeviceOverviewActivity,
): void {
  if (!device.activities.includes(activity)) {
    device.activities.push(activity);
  }
}

function addOrMergeDevice(
  devices: DeviceOverviewDevice[],
  device: DeviceOverviewDevice,
): DeviceOverviewDevice {
  const existing = devices.find(item => item.id === device.id);
  if (!existing) {
    devices.push(device);
    return device;
  }

  for (const activity of device.activities) {
    addActivity(existing, activity);
  }
  existing.backgroundTaskCount += device.backgroundTaskCount;
  if (device.kind === 'execution-host' && existing.kind === 'desktop') {
    existing.kind = 'execution-host';
  }
  return existing;
}

export function projectDeviceInterconnectionOverview(
  input: DeviceInterconnectionOverviewInput,
): DeviceInterconnectionOverview {
  const localDeviceName = formatDeviceDisplayName(input.localDeviceName);
  const currentWorkDeviceName = formatDeviceDisplayName(input.peer?.deviceName) || localDeviceName;
  const devices: DeviceOverviewDevice[] = [];

  const primaryDevice = addOrMergeDevice(devices, {
    id: input.peer ? `device:${input.peer.deviceId}` : 'device:local',
    name: currentWorkDeviceName,
    kind: 'desktop',
    local: input.peer === null,
    activities: ['current-use'],
    backgroundTaskCount: 0,
    os: (input.peer ? input.peerDeviceOs : input.localDeviceOs) ?? null,
    hostKind: reportedHostKind(
      input.peer ? input.peerDeviceKind : input.localDeviceKind,
    ),
  });

  if (input.peer) {
    addOrMergeDevice(devices, {
      id: 'device:local',
      name: localDeviceName,
      kind: 'desktop',
      local: true,
      activities: ['controlling'],
      backgroundTaskCount: 0,
      os: input.localDeviceOs ?? null,
      hostKind: reportedHostKind(input.localDeviceKind),
    });
  }

  let connectionService = input.peer ? input.accountService : null;

  const networks = input.remoteStatus?.connections !== undefined
    ? input.remoteStatus.connections.map(route => selectRemoteNetworkConnection(input.remoteStatus, null, route.method))
    : [selectRemoteNetworkConnection(input.remoteStatus)];
  for (const network of networks.filter(connection => connection.connected)) {
    for (const client of network.clients) {
      addOrMergeDevice(devices, {
        id: `mobile:${client.id}`,
        name: formatDeviceDisplayName(client.name) || input.fallbackMobileDeviceName || 'Mobile device',
        kind: 'mobile', local: false, activities: ['controlling'], backgroundTaskCount: 0,
      });
    }
    connectionService ??= connectionServiceFromRelayUrl(network.relayUrl);
  }

  // A paired bot contributes a controller and nothing else. It does not claim
  // the connection service, so a link that also carries dispatch or peer traffic
  // can still report the relay that actually carries it.
  if (input.remoteStatus?.bot_connected) {
    const applicationName = messageApplicationName(input.remoteStatus.bot_connected);
    addOrMergeDevice(devices, {
      id: `message-app:${applicationName ?? 'connected'}`,
      name: applicationName ?? 'Message app',
      kind: 'message-app',
      local: false,
      activities: ['controlling'],
      backgroundTaskCount: 0,
    });
  }

  let backgroundTaskCount = 0;
  for (const job of input.dispatchJobs) {
    // SSH is a remote-workspace / transport concern, not a OpenBitFun device.
    // Only a same-account OpenBitFun host belongs in this overview.
    if (!ACTIVE_DISPATCH_STATES.has(job.state) || job.target.kind !== 'device') {
      continue;
    }

    backgroundTaskCount += 1;
    const device = addOrMergeDevice(devices, {
      id: `device:${job.target.id}`,
      name: formatDeviceDisplayName(job.target.name) || job.target.name,
      kind: 'execution-host',
      local: false,
      activities: ['background-execution'],
      backgroundTaskCount: 1,
    });
    addActivity(device, 'background-execution');
    connectionService ??= input.accountService;
  }

  const connectedDevices = devices.filter(device => device.id !== primaryDevice.id);
  const controllerCount = devices.filter(device => (
    device.activities.includes('controlling')
  )).length;
  const mode: DeviceOverviewMode = connectedDevices.length > 0 || input.peer !== null
    ? 'connected'
    : 'local';

  return {
    mode,
    localDeviceName,
    currentWorkDeviceName,
    primaryDevice,
    connectedDevices,
    devices,
    connectionService: mode === 'connected' ? connectionService : null,
    controllerCount,
    backgroundTaskCount,
    peerActive: input.peer !== null,
    topologyUnavailable: input.remoteStatusState === 'unavailable',
  };
}
