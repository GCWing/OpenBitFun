import { Icon, IconButton } from '@openbitfun/ui';
import { ConnectionStateMark } from './ConnectionStateMark';
import { QRCodeSVG } from 'qrcode.react';
import { useI18n } from '@/infrastructure/i18n';

interface RemotePairingCardProps {
  qrUrl?: string | null;
  pairingCode?: string | null;
  owner: 'bot' | 'network';
  connected?: boolean;
  statusState?: 'loading' | 'ready' | 'unavailable';
  copied: boolean;
  onCopyUrl: () => void | Promise<void>;
}

/** One shared pending state for chat-app codes, network QR links, and restored connections. */
export function RemotePairingCard({ qrUrl, pairingCode, owner, connected = false, statusState = 'ready', copied, onCopyUrl }: RemotePairingCardProps) {
  const { t } = useI18n('common');
  const hasCopiedUrl = Boolean(qrUrl && copied);

  return (
    <div
      className={`openbitfun-remote-connect__pairing-card${qrUrl ? '' : ' openbitfun-remote-connect__pairing-card--compact'}`}
      data-openbitfun-component="remote-connect-dialog"
      data-openbitfun-part="pairingCard"
    >
      {(qrUrl || pairingCode) && (
        <div className="openbitfun-remote-connect__pairing-visual">
          {qrUrl && (
            <button
              type="button"
              className="openbitfun-remote-connect__qr-box"
              title={t('remoteConnect.copyUrl')}
              aria-label={t('remoteConnect.copyUrl')}
              onClick={() => void onCopyUrl()}
            >
              <QRCodeSVG value={qrUrl} size={180} level="M" includeMargin />
            </button>
          )}
          {pairingCode && (
            <div className="openbitfun-remote-connect__pairing-code" dir="ltr">
              {pairingCode}
            </div>
          )}
        </div>
      )}
      <div className="openbitfun-remote-connect__pairing-details">
        <div className="openbitfun-remote-connect__pairing-status" role="status">
          <ConnectionStateMark tone={statusState !== 'ready' ? 'neutral' : hasCopiedUrl || connected ? 'success' : 'warning'}
            live={statusState === 'ready' && connected}>
            {statusState === 'unavailable'
              ? t('remoteConnect.statusUnavailable')
              : statusState === 'loading'
                ? t('remoteConnect.statusChecking')
                : hasCopiedUrl
                  ? t('remoteConnect.urlCopied')
                  : connected
                    ? t('remoteConnect.stateConnected')
                    : owner === 'bot'
                      ? t('remoteConnect.stateWaitingBot')
                      : t('remoteConnect.stateWaiting')}
          </ConnectionStateMark>
        </div>
        {qrUrl ? (
          <>
            <span className="openbitfun-remote-connect__pairing-label">
              {t('remoteConnect.workspaceAddress')}
            </span>
            <div className="openbitfun-remote-connect__pairing-url-row">
              <span className="openbitfun-remote-connect__pairing-url">{qrUrl}</span>
              <IconButton
                aria-label={t('remoteConnect.copyUrl')}
                title={t('remoteConnect.copyUrl')}
                icon={<Icon name={hasCopiedUrl ? 'check-line' : 'duplicate'} size="lg" />}
                onClick={() => void onCopyUrl()}
                size="sm"
                variant="quiet"
              />
            </div>
            <p className="openbitfun-remote-connect__pairing-instruction">{t('remoteConnect.scanHint')}</p>
          </>
        ) : owner === 'bot' && pairingCode ? (
          <p className="openbitfun-remote-connect__hint">{t('remoteConnect.botHint')}</p>
        ) : null}
      </div>
    </div>
  );
}
