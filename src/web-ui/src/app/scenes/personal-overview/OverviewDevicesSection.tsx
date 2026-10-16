import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Button, Card, Icon, IconButton, OverflowText, StatusPill } from '@openbitfun/ui';
import { ChevronLeft, ChevronRight, MonitorSmartphone } from 'lucide-react';
import type { AccountIdentitySnapshot } from '@/infrastructure/account-identity';
import { isDeviceControllable, refreshDeviceDirectory, useDeviceDirectory } from '@/infrastructure/account/deviceDirectory';
import { deviceDisplayName, deviceMetadataLabel, remoteConnectAPI, type DeviceInfo } from '@/infrastructure/api/service-api/RemoteConnectAPI';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { DeviceSystemGlyph } from '@/app/components/NavPanel/components/DeviceSystemGlyph';
import { reportedHostKind } from '@/app/components/NavPanel/deviceInterconnectionOverview';
import { getMotionAwareScrollBehavior } from '@/shared/utils/motionPreference';

const SCROLL_EDGE_EPSILON = 1;

function openDeviceManagement() {
  window.dispatchEvent(new CustomEvent('openbitfun:open-remote-connect', { detail: { group: 'account' } }));
}

export function OverviewDevicesSection({ identity }: { identity: AccountIdentitySnapshot }) {
  const { t } = useI18n('scenes/personal-overview');
  const directory = useDeviceDirectory();
  const peer = usePeerDeviceModeOptional();
  const signedIn = identity.status === 'signed-in';
  const deviceTrackId = useId();
  const deviceTrackRef = useRef<HTMLUListElement>(null);
  const [scrollState, setScrollState] = useState({ hasOverflow: false, canScrollPrevious: false, canScrollNext: false });
  const [localDevice, setLocalDevice] = useState<DeviceInfo | null>(null);
  useEffect(() => {
    if (signedIn) return;
    let current = true;
    // Device identity is controller-local and available before account sign-in.
    void remoteConnectAPI.getDeviceInfo().then(device => {
      if (current) setLocalDevice(device);
    }).catch(() => undefined);
    return () => { current = false; };
  }, [signedIn]);
  const loading = !identity.resolved || identity.status === 'loading' || (signedIn && directory.status === 'loading');
  const activeDeviceId = peer?.peerMode.active ? peer.peerMode.deviceId : directory.localId;
  // Account inventory stays on the controller even while a peer surface is selected.
  // Show the active host first in the home-page device strip.
  const devices = signedIn ? [...directory.devices].sort((a, b) => (
    Number(b.device_id === activeDeviceId) - Number(a.device_id === activeDeviceId)
    || Number(b.device_id === directory.localId) - Number(a.device_id === directory.localId)
    || Number(b.online) - Number(a.online)
    || deviceDisplayName(a).localeCompare(deviceDisplayName(b))
  )) : [];
  const previewDevices = signedIn ? devices : [localDevice];
  const deviceOrderKey = JSON.stringify(previewDevices.map(device => device?.device_id ?? null));
  const showSignIn = !signedIn && !loading;
  const updateScrollState = useCallback(() => {
    const track = deviceTrackRef.current;
    const maxScrollLeft = track ? Math.max(0, track.scrollWidth - track.clientWidth) : 0;
    const scrollLeft = track?.scrollLeft ?? 0;
    const hasOverflow = !!track && track.clientWidth > 0 && maxScrollLeft > SCROLL_EDGE_EPSILON;
    const next = {
      hasOverflow,
      canScrollPrevious: hasOverflow && scrollLeft > SCROLL_EDGE_EPSILON,
      canScrollNext: hasOverflow && scrollLeft < maxScrollLeft - SCROLL_EDGE_EPSILON,
    };
    setScrollState(current => (
      current.hasOverflow === next.hasOverflow
      && current.canScrollPrevious === next.canScrollPrevious
      && current.canScrollNext === next.canScrollNext
        ? current
        : next
    ));
  }, []);
  useLayoutEffect(() => {
    updateScrollState();
    const track = deviceTrackRef.current;
    if (!track || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(track);
    Array.from(track.children).forEach(child => observer.observe(child));
    return () => observer.disconnect();
  }, [deviceOrderKey, showSignIn, updateScrollState]);
  useLayoutEffect(() => {
    if (deviceTrackRef.current) deviceTrackRef.current.scrollLeft = 0;
    updateScrollState();
  }, [activeDeviceId, signedIn, updateScrollState]);
  const scrollByCard = (direction: -1 | 1, animate: boolean) => {
    const track = deviceTrackRef.current;
    const first = track?.children[0] as HTMLElement | undefined;
    const second = track?.children[1] as HTMLElement | undefined;
    if (!track || !first) return;
    const step = second ? second.offsetLeft - first.offsetLeft : first.getBoundingClientRect().width;
    const left = Math.max(0, Math.min(track.scrollLeft + direction * step, track.scrollWidth - track.clientWidth));
    track.scrollTo({ left, behavior: getMotionAwareScrollBehavior(animate ? 'smooth' : 'auto') });
  };
  const statusContent = loading ? (
    <p className="personal-overview__catalog-empty" role="status">{t('devices.loading')}</p>
  ) : !signedIn ? null : directory.status === 'failed' || directory.status === 'idle' ? (
    <div className="personal-overview__catalog-status" role="status">
      <span>{t('devices.failed')}</span>
      <Button variant="secondary" size="sm" onClick={() => void refreshDeviceDirectory()}>{t('retry')}</Button>
    </div>
  ) : devices.length === 0 ? (
    <p className="personal-overview__catalog-empty">{t('devices.empty')}</p>
  ) : null;

  return (
    <section className="personal-overview__section" aria-labelledby="overview-devices-title" aria-busy={loading} data-openbitfun-scene="personal-overview" data-openbitfun-part="devices">
      <div className="personal-overview__section-header">
        <h2 id="overview-devices-title" className="personal-overview__section-title">{t('devices.title')}</h2>
        <Button className="personal-overview__section-action" variant="text" size="sm" leadingIcon={<Icon glyph={MonitorSmartphone} size="sm" />} onClick={openDeviceManagement} data-testid="personal-overview-manage-devices">
          {t('devices.manage')}
        </Button>
      </div>
      <div className="personal-overview__catalog">
        {previewDevices.length > 0 && (
          <div className="personal-overview__device-carousel" role="region" aria-labelledby="overview-devices-title">
            <ul className="personal-overview__device-track" id={deviceTrackId} ref={deviceTrackRef} onScroll={updateScrollState}>
              {previewDevices.map(device => {
                const name = (device && deviceDisplayName(device)) || t('devices.thisDevice');
                const isLocal = !signedIn || device?.device_id === directory.localId;
                const isCurrent = !signedIn || device?.device_id === activeDeviceId;
                const metadata = device ? deviceMetadataLabel(device) : '';
                const kind = device?.device_kind?.trim().toLowerCase();
                return (
                  <li className="personal-overview__catalog-cell" key={device?.device_id ?? 'current-device'} data-device-id={device?.device_id} data-testid={isLocal ? 'personal-overview-local-device' : undefined}>
                    <Card className="personal-overview__device" appearance="subtle" radius="lg">
                      <span className="personal-overview__device-icon" aria-hidden="true">
                        <DeviceSystemGlyph device={{ kind: kind === 'mobile' || kind === 'watch' ? 'mobile' : 'desktop', name, os: device?.device_os, hostKind: reportedHostKind(device?.device_kind) }} size="lg" />
                      </span>
                      <div className="personal-overview__catalog-copy" data-overflow-trigger>
                        <OverflowText className="personal-overview__catalog-item-name">{name}</OverflowText>
                        {metadata && <OverflowText className="personal-overview__catalog-item-description">{metadata}</OverflowText>}
                        <div className="personal-overview__device-status">
                          {!isLocal && device && 'online' in device && <StatusPill tone={device.online ? 'success' : 'neutral'}>{t(device.online ? 'devices.online' : 'devices.offline')}</StatusPill>}
                          {isCurrent && <StatusPill tone="info">{t('devices.current')}</StatusPill>}
                          {isLocal && !isCurrent && <StatusPill tone="neutral">{t('devices.thisDevice')}</StatusPill>}
                          {!isLocal && device && !isDeviceControllable(device) && <StatusPill tone="warning">{t('devices.incompatible')}</StatusPill>}
                        </div>
                      </div>
                    </Card>
                  </li>
                );
              })}
              {showSignIn && (
                <li className="personal-overview__device-sign-in">
                  <Button variant="quiet" size="sm" onClick={openDeviceManagement} data-testid="personal-overview-sign-in-devices">
                    {t('devices.signInHint')}
                  </Button>
                </li>
              )}
            </ul>
            {scrollState.hasOverflow && (
              <>
                <IconButton className="personal-overview__device-scroll-control personal-overview__device-scroll-control--previous" variant="fill" shape="circle" size="lg"
                  aria-label={t('devices.scrollPrevious')} aria-controls={deviceTrackId} disabled={!scrollState.canScrollPrevious}
                  icon={<Icon glyph={ChevronLeft} />} onClick={event => scrollByCard(-1, event.detail > 0)} data-testid="personal-overview-previous-devices" />
                <IconButton className="personal-overview__device-scroll-control personal-overview__device-scroll-control--next" variant="fill" shape="circle" size="lg"
                  aria-label={t('devices.scrollNext')} aria-controls={deviceTrackId} disabled={!scrollState.canScrollNext}
                  icon={<Icon glyph={ChevronRight} />} onClick={event => scrollByCard(1, event.detail > 0)} data-testid="personal-overview-next-devices" />
              </>
            )}
          </div>
        )}
        {statusContent}
      </div>
    </section>
  );
}
