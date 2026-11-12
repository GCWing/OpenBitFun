import { Button, Icon } from '@openbitfun/ui';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveDeviceNameFrom, useDeviceDirectory } from '@/infrastructure/account/deviceDirectory';
import { isLocalSurface, type DeviceSurfaceId } from '@/infrastructure/peer-device/deviceSurface';
import './PeerUpdatesPausedNotice.scss';

interface PeerUpdatesPausedNoticeProps {
  surfaceId: DeviceSurfaceId;
  onRetry: () => void;
  /** How long the failure must last before the notice appears. */
  delayMs?: number;
}

/**
 * A live read that fails and recovers within a few seconds is routine on a
 * weak link. Showing the notice for it would flash and shift the transcript.
 */
export const PEER_UPDATES_PAUSED_NOTICE_DELAY_MS = 4_000;

/**
 * A device session whose live reads failed keeps its rendered records, so the
 * transcript looks current while nothing new arrives. Say so, and offer a
 * re-read. The next live ready event clears the failed state and this notice.
 */
export const PeerUpdatesPausedNotice: React.FC<PeerUpdatesPausedNoticeProps> = ({
  surfaceId,
  onRetry,
  delayMs = PEER_UPDATES_PAUSED_NOTICE_DELAY_MS,
}) => {
  const { t } = useTranslation('flow-chat');
  const devices = useDeviceDirectory(state => state.devices);
  const [shown, setShown] = useState(delayMs <= 0);
  // Mounted while the failure lasts; a recovery before the delay unmounts it unseen.
  useEffect(() => {
    if (delayMs <= 0) {
      setShown(true);
      return undefined;
    }
    setShown(false);
    const timer = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs, surfaceId]);
  if (isLocalSurface(surfaceId) || !shown) return null;
  const device = resolveDeviceNameFrom(devices, surfaceId);
  return (
    <div
      className="peer-updates-paused-notice"
      role="status"
      data-testid="peer-updates-paused-notice"
      data-openbitfun-component="peer-updates-paused-notice"
      data-openbitfun-part="root"
    >
      <span
        className="peer-updates-paused-notice__text"
        data-openbitfun-component="peer-updates-paused-notice"
        data-openbitfun-part="text"
      >
        {t('historyState.updatesPaused', { device })}
      </span>
      <Button
        variant="outline"
        size="sm"
        leadingIcon={<Icon name="refresh" size="sm" aria-hidden="true" />}
        onClick={onRetry}
      >
        {t('historyState.retry')}
      </Button>
    </div>
  );
};

PeerUpdatesPausedNotice.displayName = 'PeerUpdatesPausedNotice';
