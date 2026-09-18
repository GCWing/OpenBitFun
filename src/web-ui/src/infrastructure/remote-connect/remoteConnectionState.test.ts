import { describe, expect, it } from 'vitest';
import type { ConnectionResult, RemoteConnectStatus, RemoteConnectionMethod } from '../api/service-api/RemoteConnectAPI';
import { remoteNetworkMethod, selectRemoteNetworkConnection, invitationRelayUrl } from './remoteConnectionState';

const official = 'https://remote.openbitfun.com/v/1.0.2';
const lan = 'http://192.168.1.2:9700';
const method = (url: string): RemoteConnectionMethod => url === official ? 'openbitfun_server' : { lan: { ip: '192.168.1.2' } };
const status = (url: string): RemoteConnectStatus => ({
  relay_connected: true, relay_url: url, active_method: method(url), clients: [], bot_connected: null, bot_verbose_mode: false,
});
const invitation = (url: string): ConnectionResult => ({
  method: method(url), qr_data: null, qr_svg: null, qr_url: `${url}/#/pair?did=desktop-1`,
  bot_pairing_code: null, bot_link: null, pairing_state: 'waiting_for_scan',
});

describe('one account device connection contract', () => {
  it.each([official, lan])('uses the same authenticated invitation and status at %s', url => {
    expect(selectRemoteNetworkConnection(status(url), invitation(url))).toMatchObject({
      connected: true, relayUrl: url, invitationConnected: false,
    });
    expect(selectRemoteNetworkConnection({ ...status(url), clients: [{ id: 'phone', name: 'Safari' }] }, invitation(url)).invitationConnected).toBe(true);
    expect(selectRemoteNetworkConnection(status(url))).toMatchObject({ connected: true, invitationConnected: false });
    expect(selectRemoteNetworkConnection({ ...status(url), relay_connected: false }, invitation(url)).invitationConnected).toBe(false);
  });
  it('does not reuse an invitation after switching endpoints', () => {
    expect(selectRemoteNetworkConnection(status(lan), invitation(official)).invitationConnected).toBe(false);
    expect(selectRemoteNetworkConnection(status(official), invitation(lan)).invitationConnected).toBe(false);
  });
  it('accepts only canonical typed methods', () => {
    expect(remoteNetworkMethod({ lan: { ip: '192.168.1.2' } })).toBe('lan');
    expect(remoteNetworkMethod('openbitfun_server')).toBe('openbitfun_server');
    expect(remoteNetworkMethod('bot_feishu')).toBe(null);
  });
  it('does not infer connectivity from a missing or invalid endpoint', () => {
    for (const url of [null, 'invalid', 'https://user:password@relay.test']) {
      expect(selectRemoteNetworkConnection({ ...status(official), relay_url: url }, invitation(official)).connected).toBe(false);
    }
  });
  it('rejects legacy room invitations and ambiguous target selectors', () => {
    for (const suffix of ['room=old&pk=old', 'did=a&did=b', 'did=a&pk=old', 'did=']) {
      expect(invitationRelayUrl({ ...invitation(official), qr_url: `${official}/#/pair?${suffix}` })).toBe(null);
    }
  });
});
