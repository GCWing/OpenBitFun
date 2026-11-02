import { Monitor } from 'lucide-react';
import type { IconSize } from '@openbitfun/ui';
import type { DeviceOverviewDevice } from '../deviceInterconnectionOverview';
import { getDeviceArtworkKind } from './deviceArtworkKind';
import { DEVICE_MARK_BY_ARTWORK, DEVICE_SYSTEM_MARKS } from './deviceSystemMarks';

type DeviceSystemFacts = Pick<DeviceOverviewDevice, 'kind' | 'name' | 'os' | 'hostKind'>;

const ICON_TOKEN_SIZE: Record<IconSize, string> = {
  '2xs': 'var(--openbitfun-control-icon-size2xs)',
  xs: 'var(--openbitfun-control-icon-size-xs)',
  sm: 'var(--openbitfun-control-icon-size-sm)',
  md: 'var(--openbitfun-control-icon-size-md)',
  lg: 'var(--openbitfun-control-icon-size-lg)',
};

/**
 * The mark a device row shows in front of its name: the system the device
 * reported, the server silhouette for a CLI host, and the neutral monitor this
 * list always drew for a device whose system cannot be placed.
 *
 * An inline path rather than a masked asset file, because a mask whose asset
 * does not resolve paints the element as a solid block instead of falling back
 * to no mark, and the inline form needs no mask, size, or colour rules.
 *
 * Size is a pixel count or an icon-size token, so a caller can put the mark in
 * the same slot as the icons it stands beside.
 *
 * A mark also carries its own optical correction (see `deviceSystemMarks`), and
 * states it with the individual `translate` property so a caller's own
 * `transform` still applies instead of replacing it. It is expressed in `em`
 * against the mark's font size, which is the rendered size here, so one number
 * holds at every slot size.
 */
export function DeviceSystemGlyph({
  device,
  size = 16,
}: {
  device: DeviceSystemFacts;
  size?: number | IconSize;
}) {
  const resolvedSize = typeof size === 'number' ? `${size}px` : ICON_TOKEN_SIZE[size];
  const key = DEVICE_MARK_BY_ARTWORK[getDeviceArtworkKind(device)];
  if (!key) return <Monitor size={resolvedSize} />;
  const mark = DEVICE_SYSTEM_MARKS[key];
  return (
    <svg
      aria-hidden="true"
      data-system={key}
      focusable="false"
      height={resolvedSize}
      viewBox={mark.viewBox}
      width={resolvedSize}
      xmlns="http://www.w3.org/2000/svg"
      style={mark.opticalShift === 0
        ? undefined
        : { fontSize: resolvedSize, translate: `0 ${mark.opticalShift}em` }}
    >
      <path fill="currentColor" d={mark.path} />
    </svg>
  );
}
