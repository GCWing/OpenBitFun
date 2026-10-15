import { Button, Card, Icon, OverflowText, StatusPill } from '@openbitfun/ui';
import { MonitorSmartphone } from 'lucide-react';
import type { AccountIdentitySnapshot } from '@/infrastructure/account-identity';
import { isDeviceControllable, refreshDeviceDirectory, useDeviceDirectory } from '@/infrastructure/account/deviceDirectory';
import { deviceDisplayName, deviceMetadataLabel } from '@/infrastructure/api/service-api/RemoteConnectAPI';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { DeviceSystemGlyph } from '@/app/components/NavPanel/components/DeviceSystemGlyph';
import { reportedHostKind } from '@/app/components/NavPanel/deviceInterconnectionOverview';

const PREVIEW_DEVICE_COUNT = 4;

function openDeviceManagement() {
  window.dispatchEvent(new CustomEvent('openbitfun:open-remote-connect', { detail: { group: 'account' } }));
}

export function OverviewDevicesSection({ identity }: { identity: AccountIdentitySnapshot }) {
  const { t, formatNumber } = useI18n('scenes/personal-overview');
  const directory = useDeviceDirectory();
  const peer = usePeerDeviceModeOptional();
  const signedIn = identity.status === 'signed-in';
  const loading = !identity.resolved || identity.status === 'loading' || (signedIn && directory.status === 'loading');
  const activeDeviceId = peer?.peerMode.active ? peer.peerMode.deviceId : directory.localId;
  // Account inventory stays on the controller even while a peer surface is selected.
  // Show the active host first so it remains visible in a short home-page preview.
  const devices = signedIn ? [...directory.devices].sort((a, b) => (
    Number(b.device_id === activeDeviceId) - Number(a.device_id === activeDeviceId)
    || Number(b.device_id === directory.localId) - Number(a.device_id === directory.localId)
    || Number(b.online) - Number(a.online)
    || deviceDisplayName(a).localeCompare(deviceDisplayName(b))
  )) : [];

  return (
    <section className="personal-overview__section" aria-labelledby="overview-devices-title" aria-busy={loading} data-openbitfun-scene="personal-overview" data-openbitfun-part="devices">
      <div className="personal-overview__section-header">
        <h2 id="overview-devices-title" className="personal-overview__section-title">{t('devices.title')}</h2>
        <Button className="personal-overview__section-action" variant="text" size="sm" leadingIcon={<Icon glyph={MonitorSmartphone} size="sm" />} onClick={openDeviceManagement} data-testid="personal-overview-manage-devices">
          {t('devices.manage')}
        </Button>
      </div>
      <div className="personal-overview__catalog">
        {devices.length > 0 && (
          <ul className="personal-overview__device-grid">
            {devices.slice(0, PREVIEW_DEVICE_COUNT).map(device => {
              const name = deviceDisplayName(device);
              const isLocal = device.device_id === directory.localId;
              const isCurrent = device.device_id === activeDeviceId;
              const metadata = deviceMetadataLabel(device);
              const kind = device.device_kind?.trim().toLowerCase();
              return (
                <li className="personal-overview__catalog-cell" key={device.device_id} data-device-id={device.device_id}>
                  <Card className="personal-overview__device" appearance="subtle" radius="lg">
                    <span className="personal-overview__device-icon" aria-hidden="true">
                      <DeviceSystemGlyph device={{ kind: kind === 'mobile' || kind === 'watch' ? 'mobile' : 'desktop', name, os: device.device_os, hostKind: reportedHostKind(device.device_kind) }} size="lg" />
                    </span>
                    <div className="personal-overview__catalog-copy" data-overflow-trigger>
                      <OverflowText className="personal-overview__catalog-item-name">{name}</OverflowText>
                      {metadata && <OverflowText className="personal-overview__catalog-item-description">{metadata}</OverflowText>}
                      <div className="personal-overview__device-status">
                        {!isLocal && <StatusPill tone={device.online ? 'success' : 'neutral'}>{t(device.online ? 'devices.online' : 'devices.offline')}</StatusPill>}
                        {isCurrent && <StatusPill tone="info">{t('devices.current')}</StatusPill>}
                        {isLocal && !isCurrent && <StatusPill tone="neutral">{t('devices.thisDevice')}</StatusPill>}
                        {!isLocal && !isDeviceControllable(device) && <StatusPill tone="warning">{t('devices.incompatible')}</StatusPill>}
                      </div>
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
        {loading ? (
          <p className="personal-overview__catalog-empty" role="status">{t('devices.loading')}</p>
        ) : !signedIn ? (
          <p className="personal-overview__catalog-empty personal-overview__device-sign-in">{t('devices.signInHint')}</p>
        ) : directory.status === 'failed' || directory.status === 'idle' ? (
          <div className="personal-overview__catalog-status" role="status">
            <span>{t('devices.failed')}</span>
            <Button variant="secondary" size="sm" onClick={() => void refreshDeviceDirectory()}>{t('retry')}</Button>
          </div>
        ) : devices.length === 0 ? (
          <p className="personal-overview__catalog-empty">{t('devices.empty')}</p>
        ) : null}
        {devices.length > PREVIEW_DEVICE_COUNT && (
          <div className="personal-overview__section-actions">
            <Button variant="text" size="sm" onClick={openDeviceManagement}>
              {t('devices.viewAll', { count: formatNumber(devices.length) })}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
