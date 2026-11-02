import type { DeviceOverviewDevice } from '../deviceInterconnectionOverview';
import macbookAir from '../assets/macbook-air-hero.png';

import { getDeviceArtworkKind } from './deviceArtworkKind';

export function DeviceArtwork({ device }: { device: DeviceOverviewDevice }) {
  const artwork = getDeviceArtworkKind(device);
  return (
    <div className="openbitfun-device-overview__artwork" data-artwork={artwork}>
      {artwork === 'macbook-air'
        ? <img src={macbookAir} alt="" width={1672} height={941} draggable={false} />
        : <span className="openbitfun-device-overview__artwork-glyph" aria-hidden="true" />}
    </div>
  );
}
