import type { DeviceArtworkKind } from './deviceArtworkKind';
import type { DeviceSystemKey } from '../../../../../../shared/device-system/deviceSystemMarks';

// The systems a host can report are shared with mobile web so both surfaces
// draw one device the same way. The artwork kinds below are this shell's own.
export { DEVICE_SYSTEM_MARKS, deviceSystemKeyFromOs, type DeviceSystemKey } from '../../../../../../shared/device-system/deviceSystemMarks';

/**
 * Artwork a device resolved to, and the mark that stands for it. A MacBook Air
 * is a Mac at this size, where the photographic artwork is not an option.
 */
export const DEVICE_MARK_BY_ARTWORK: Partial<Record<DeviceArtworkKind, DeviceSystemKey>> = {
  windows: 'windows',
  macos: 'macos',
  'macbook-air': 'macos',
  linux: 'linux',
  harmonyos: 'harmonyos',
  server: 'server',
};
