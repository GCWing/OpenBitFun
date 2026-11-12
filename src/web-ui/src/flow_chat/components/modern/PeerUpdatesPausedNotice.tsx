import { Button, Icon } from '@openbitfun/ui';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { resolveDeviceNameFrom, useDeviceDirectory } from '@/infrastructure/account/deviceDirectory';
import { isLocalSurface, type DeviceSurfaceId } from '@/infrastructure/peer-device/deviceSurface';
import './PeerUpdatesPausedNotice.scss';

interface PeerUpdatesPausedNoticeProps {
  surfaceId: DeviceSurfaceId;
  onRetry: () => void;
}

/**
 * A device session whose live reads failed keeps its rendered records, so the
 * transcript looks current while nothing new arrives. Say so, and offer a
 * re-read. The next live ready event clears the failed state and this notice.
 */
export const PeerUpdatesPausedNotice: React.FC<PeerUpdatesPausedNoticeProps> = ({ surfaceId, onRetry }) => {
  const { t } = useTranslation('flow-chat');
  const devices = useDeviceDirectory(state => state.devices);
  if (isLocalSurface(surfaceId)) return null;
  const device = resolveDeviceNameFrom(devices, surfaceId);
  return (
    <div
      className="peer-updates-paused-notice"
      role="status"
      data-testid="peer-updates-paused-notice"
    >
      <span className="peer-updates-paused-notice__text">
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
