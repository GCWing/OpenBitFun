import type { ConnectionResult, RemoteConnectionMethod, RemoteConnectStatus } from '../api/service-api/RemoteConnectAPI';

export type RemoteNetworkMethod = 'lan' | 'openbitfun_server';
export const OFFICIAL_RELAY_URL = 'https://remote.openbitfun.com/v/1.0.2';

export function remoteNetworkMethod(method: RemoteConnectionMethod | null | undefined): RemoteNetworkMethod | null {
  if (typeof method === 'object' && method !== null && 'lan' in method) return 'lan';
  return method === 'openbitfun_server' ? 'openbitfun_server' : null;
}

export function normalizeRelayUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/+$/, '');
  } catch { return null; }
}

export function invitationRelayUrl(invitation: ConnectionResult | null | undefined): string | null {
  if (!invitation?.qr_url) return null;
  try {
    const url = new URL(invitation.qr_url);
    if (!url.hash.startsWith('#/pair?')) return null;
    const params = new URLSearchParams(url.hash.slice(7));
    if (Array.from(params.keys()).some(key => key !== 'did') || params.getAll('did').length !== 1
      || !/^[A-Za-z0-9_.-]{1,128}$/.test(params.get('did') ?? '')) return null;
    return normalizeRelayUrl(`${url.origin}${url.pathname}`);
  } catch { return null; }
}

/** Every invitation points to the same authenticated device protocol. */
export function isDeviceInvitation(invitation: ConnectionResult | null | undefined): boolean {
  return invitationRelayUrl(invitation) !== null;
}

export function selectRemoteNetworkConnection(
  status: RemoteConnectStatus | null | undefined,
  invitation?: ConnectionResult | null,
  requestedMethod?: RemoteNetworkMethod,
) {
  const legacyUrl = normalizeRelayUrl(status?.relay_url);
  const legacyMethod = remoteNetworkMethod(status?.active_method)
    ?? (legacyUrl ? legacyUrl === OFFICIAL_RELAY_URL ? 'openbitfun_server' : 'lan' : null);
  const method = requestedMethod ?? remoteNetworkMethod(invitation?.method)
    ?? status?.connections?.find(route => route.relay_connected)?.method ?? legacyMethod;
  const route = status?.connections?.find(route => route.method === method);
  // The additive route list is also the scoped-stop capability. An empty list
  // means no connections, while omission keeps older hosts on their old path.
  const selected = status?.connections !== undefined ? route : method === legacyMethod ? status : null;
  const relayUrl = normalizeRelayUrl(selected?.relay_url);
  const connected = selected?.relay_connected === true && relayUrl !== null;
  const clients = connected ? selected?.clients ?? [] : [];
  return {
    connected,
    method,
    relayUrl,
    clients,
    invitationConnected: connected && clients.length > 0 && invitationRelayUrl(invitation) === relayUrl,
  };
}
