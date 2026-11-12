import React, { useEffect, useState } from 'react';
import { Button, Tooltip } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { usePeerDeviceModeOptional } from './peerDeviceContextState';
import { Loader2, WifiOff } from 'lucide-react';
import './PeerConnectionStatus.scss';

/**
 * Keep the selected host visible while its control link recovers, or while
 * the host answers but its OpenBitFun UI is still starting.
 */
export const PeerConnectionStatus: React.FC = () => {
  const { t } = useI18n('common');
  const peer = usePeerDeviceModeOptional();
  const [returning, setReturning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deviceId = peer?.peerMode.active ? peer.peerMode.deviceId : null;
  const connection = peer?.attachments.find(item => item.deviceId === deviceId);

  const degraded = connection?.health === 'degraded';
  const starting = !degraded && connection?.hostStarting === true;

  useEffect(() => { setError(null); }, [deviceId, connection?.health]);

  if (!peer?.peerMode.active || (!degraded && !starting)) return null;

  const returnLocal = async () => {
    setReturning(true);
    setError(null);
    try {
      await peer.switchToLocal('manual');
    } catch (switchError) {
      setError(switchError instanceof Error ? switchError.message : String(switchError));
    } finally {
      setReturning(false);
    }
  };

  return (
    <div
      className="peer-connection-status"
      data-openbitfun-component="peer-device"
      data-openbitfun-part="connectionStatus"
    >
      <div
        className="peer-connection-status__content"
        data-openbitfun-component="peer-device"
        data-openbitfun-part="connectionStatusContent"
      >
        <Tooltip content={t(starting ? 'peerConnection.starting' : 'peerConnection.reconnecting', { name: peer.peerMode.deviceName })}>
          <span className="peer-connection-status__label" role="status" aria-live="polite"
            data-peer-connection-state={starting ? 'starting' : 'reconnecting'}>
            {starting
              ? <Loader2 size={13} aria-hidden="true" />
              : <WifiOff size={13} aria-hidden="true" />}
            <span>{t(starting ? 'peerConnection.startingShort' : 'peerConnection.reconnectingShort')}</span>
          </span>
        </Tooltip>
        <Button variant="text" size="sm" disabled={returning} onClick={() => { void returnLocal(); }}>
          {t(returning ? 'peerConnection.returningShort' : 'peerConnection.returnLocalShort')}
        </Button>
      </div>
      {error && <span className="peer-connection-status__error" role="alert">{error}</span>}
    </div>
  );
};
