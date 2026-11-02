import { Monitor, Smartphone } from 'lucide-react';
import {
  DEVICE_SYSTEM_MARKS,
  deviceSystemKeyFromOs,
  type DeviceSystemKey,
} from '../../../shared/device-system/deviceSystemMarks';

interface DeviceSystemMarkProps {
  /** Kind the device reported: a headless host draws the server silhouette. */
  deviceKind?: string | null;
  /** System the device reported. Absent system keeps a neutral mark. */
  os?: string | null;
  size: number;
}

/**
 * The mark in front of a device name: the system that device reported, the server
 * silhouette for a headless host, and the shape that says what a device is when
 * it reports no system this client can draw.
 *
 * The marks themselves are shared with the desktop shell, so one device is drawn
 * the same way on either surface. Size and colour are the caller's: mobile web
 * sets its own icon scale, and every mark takes the colour of the row it sits in.
 */
export function DeviceSystemMark({ deviceKind, os, size }: DeviceSystemMarkProps) {
  const kind = deviceKind?.trim().toLowerCase();
  // A phone is not a system and a headless host has no window to draw, whatever
  // either of them runs.
  if (kind === 'mobile') {
    return <Smartphone width={size} height={size} stroke="currentColor" aria-hidden="true" />;
  }
  const key: DeviceSystemKey | null = kind === 'cli' ? 'server' : deviceSystemKeyFromOs(os);
  if (!key) {
    return <Monitor width={size} height={size} stroke="currentColor" aria-hidden="true" />;
  }
  const mark = DEVICE_SYSTEM_MARKS[key];
  return (
    <svg
      aria-hidden="true"
      data-system={key}
      focusable="false"
      height={size}
      viewBox={mark.viewBox}
      width={size}
      xmlns="http://www.w3.org/2000/svg"
      style={mark.opticalShift === 0
        ? undefined
        : { fontSize: `${size}px`, translate: `0 ${mark.opticalShift}em` }}
    >
      <path fill="currentColor" d={mark.path} />
    </svg>
  );
}
