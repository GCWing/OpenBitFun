import { Button, Icon, StatusPill } from '@openbitfun/ui';
import type { ReactNode } from 'react';
import type { ConnectionResult, RemoteConnectStatus } from '@/infrastructure/api/service-api/RemoteConnectAPI';
import { useI18n } from '@/infrastructure/i18n';
import { normalizeRelayUrl, selectRemoteNetworkConnection } from '@/infrastructure/remote-connect/remoteConnectionState';
import { RemotePairingCard } from './RemotePairingCard';

interface RemoteNetworkConnectionsProps {
  status: RemoteConnectStatus | null;
  method: 'openbitfun_server' | 'lan';
  icon: ReactNode;
  settings?: ReactNode;
  title: string;
  description: string;
  relayUrl: string;
  invitation: ConnectionResult | null;
  statusState: 'loading' | 'ready' | 'unavailable';
  loading: boolean;
  pairingUrlCopied: boolean;
  error: ReactNode;
  onCopyPairingUrl: () => Promise<void>;
  onConnect: () => void;
  onCancel: () => void;
  onDisconnect: () => void;
}

/** Authenticated Relay connection and controller presence, independent of hosting. */
export function RemoteNetworkConnections({
  status, method, icon, title, description, relayUrl, settings, invitation, statusState,
  loading, pairingUrlCopied, error, onCopyPairingUrl, onConnect, onCancel,
  onDisconnect,
}: RemoteNetworkConnectionsProps) {
  const { t, formatNumber } = useI18n('common');
  const connection = selectRemoteNetworkConnection(status, invitation);
  const connected = connection.connected && connection.method === method
    && connection.relayUrl === normalizeRelayUrl(relayUrl);
  const clients = connected ? status?.clients ?? [] : [];
  const count = clients.length;

  return <div className="openbitfun-remote-connect__body">
    <section
      className="openbitfun-remote-connect__network-card"
      data-openbitfun-component="remote-connect-dialog"
      data-openbitfun-part="connections"
      aria-label={title}
    >
      <div className="openbitfun-remote-connect__card-header">
        <span className="openbitfun-remote-connect__card-header-icon" aria-hidden="true">{icon}</span>
        <div className="openbitfun-remote-connect__card-header-copy">
          <h3 className="openbitfun-remote-connect__card-header-title">{title}</h3>
          <p className="openbitfun-remote-connect__card-header-description">{description}</p>
        </div>
        {!invitation && (
          <span className="openbitfun-remote-connect__status" role="status">
            <StatusPill tone={statusState === 'ready' && connected ? 'success' : 'neutral'}>
              {t(statusState === 'unavailable' ? 'remoteConnect.statusUnavailable'
                : statusState === 'loading' ? 'remoteConnect.statusChecking'
                  : connected ? 'remoteConnect.stateConnected' : 'remoteConnect.notConnected')}
            </StatusPill>
          </span>
        )}
      </div>
      {settings && <div className="openbitfun-remote-connect__card-section">{settings}</div>}
      {invitation && <div className="openbitfun-remote-connect__card-section">
        <RemotePairingCard
          owner="network"
          qrUrl={invitation.qr_url}
          connected={connection.invitationConnected}
          copied={pairingUrlCopied}
          statusState={statusState}
          onCopyUrl={onCopyPairingUrl}
        />
      </div>}
      {(count > 0 || !invitation) && <div className="openbitfun-remote-connect__card-section openbitfun-remote-connect__connections">
        <div className="openbitfun-remote-connect__connections-heading">
          <h4 className="openbitfun-remote-connect__connections-title" title={t('remoteConnect.clientCountHint')}>
            {t('remoteConnect.connectedClients')}
          </h4>
          <span
            className="openbitfun-remote-connect__connections-count"
            role="status"
            aria-label={t('remoteConnect.clientCount', { count, formattedCount: formatNumber(count) })}
          >
            {formatNumber(count)}
          </span>
        </div>
        {count > 0 && <ul className="openbitfun-remote-connect__connections-list" tabIndex={count > 3 ? 0 : undefined}>
          {clients.map((client, index) => <li className="openbitfun-remote-connect__client" key={client.id}>
            <span className="openbitfun-remote-connect__client-icon" aria-hidden="true">
              <Icon name="browser" size="sm" />
            </span>
            <span className="openbitfun-remote-connect__client-name">{client.name || t('remoteConnect.mobileBrowserTitle')}</span>
            <span className="openbitfun-remote-connect__client-meta">
              {t('remoteConnect.clientNumber', { number: formatNumber(index + 1) })}
            </span>
          </li>)}
        </ul>}
        {count === 0 && <p className="openbitfun-remote-connect__connections-empty">{t('remoteConnect.noConnectedClients')}</p>}
      </div>}
      {connection.invitationConnected && invitation && <div className="openbitfun-remote-connect__card-section">
        <div className="openbitfun-remote-connect__notice">
          <Icon name="info" size="sm" />
          <p>{t('remoteConnect.accountConnectedHint')}</p>
        </div>
      </div>}
      {error && <div className="openbitfun-remote-connect__card-section">{error}</div>}
      <div className="openbitfun-remote-connect__card-actions">
        {connected && (
          <Button variant="outline" tone="danger" size="sm" onClick={onDisconnect}>
            {t('remoteConnect.disconnect')}
          </Button>
        )}
        {invitation
          ? <Button variant="fill" size="sm" onClick={onCancel}>{t('remoteConnect.cancelInvitation')}</Button>
          : <Button variant="primary" size="sm" loading={loading} onClick={onConnect}>
            {loading ? t('remoteConnect.connecting') : t('remoteConnect.showConnectionCode')}
          </Button>}
      </div>
    </section>
  </div>;
}
