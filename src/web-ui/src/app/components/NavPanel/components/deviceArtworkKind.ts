import { deviceSystemKeyFromOs } from '../../../../../../shared/device-system/deviceSystemMarks';
import type { DeviceOverviewDevice } from '../deviceInterconnectionOverview';

export type DeviceArtworkKind =
  | 'device'
  | 'server'
  | 'macbook-air'
  | 'windows'
  | 'macos'
  | 'linux'
  | 'harmonyos';

type DeviceArtworkFacts = Pick<DeviceOverviewDevice, 'kind' | 'name' | 'os' | 'hostKind'>;

/**
 * Artwork for the system a device reported. A system we cannot place keeps the
 * neutral artwork instead of claiming a plausible one, so the shared resolver
 * answers only for the systems it knows.
 */
export function getDeviceArtworkKind(device: DeviceArtworkFacts): DeviceArtworkKind {
  // A CLI host has no window to draw, whatever machine it runs on.
  if (device.hostKind === 'cli') return 'server';
  if (device.kind === 'execution-host') return 'server';
  if (device.kind !== 'desktop') return 'device';
  // Device names can identify a model, but the controller's OS cannot identify
  // a remote machine. Unrecognized names deliberately use neutral artwork.
  if (/macbook[\s._-]*air\b/i.test(device.name)) return 'macbook-air';
  return deviceSystemKeyFromOs(device.os) ?? 'device';
}
