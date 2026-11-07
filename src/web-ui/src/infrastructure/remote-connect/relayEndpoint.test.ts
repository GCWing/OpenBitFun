import { describe, expect, it } from 'vitest';
import {
  OFFICIAL_RELAY_URL,
  relayEndpointBase,
  relayEndpointVersion,
  relayPageUrl,
  sameRelayDeployment,
} from '../../../../shared/relay-transport/RelayEndpoint';

describe('relay endpoint identity', () => {
  it('carries the service version as a query parameter', () => {
    expect(OFFICIAL_RELAY_URL).toBe('https://remote.openbitfun.com/relay?v=1.0.9');
    expect(relayEndpointVersion(OFFICIAL_RELAY_URL)).toBe('1.0.9');
  });

  it('strips the version so paths are never appended to a query', () => {
    expect(relayEndpointBase(OFFICIAL_RELAY_URL)).toBe('https://remote.openbitfun.com/relay');
    expect(relayEndpointBase('https://remote.openbitfun.com/relay/?v=1.0.9')).toBe(
      'https://remote.openbitfun.com/relay',
    );
    expect(relayEndpointBase('https://remote.openbitfun.com/v/1.0.2/')).toBe(
      'https://remote.openbitfun.com/v/1.0.2',
    );
  });

  it('rejects credentials, fragments, and unknown query content', () => {
    for (const invalid of [
      'https://user@remote.openbitfun.com/relay',
      'https://remote.openbitfun.com/relay#/pair',
      'https://remote.openbitfun.com/relay?v=1.0.9&x=1',
      'https://remote.openbitfun.com/relay?next=https://evil.example',
      'ftp://remote.openbitfun.com/relay',
      '',
    ]) {
      expect(relayEndpointBase(invalid)).toBeNull();
    }
  });

  it('treats both live aliases as one deployment and other releases as different', () => {
    expect(sameRelayDeployment(OFFICIAL_RELAY_URL, 'https://remote.openbitfun.com/v/1.0.2')).toBe(true);
    expect(sameRelayDeployment(OFFICIAL_RELAY_URL, 'https://other.example.com/relay')).toBe(false);
    expect(sameRelayDeployment(OFFICIAL_RELAY_URL, 'https://remote.openbitfun.com/v/1.0.1')).toBe(false);
    expect(sameRelayDeployment('http://remote.openbitfun.com/relay', OFFICIAL_RELAY_URL)).toBe(false);
  });

  it('keeps the version before the fragment in user-facing links', () => {
    expect(relayPageUrl(OFFICIAL_RELAY_URL, '#/pair?did=abc')).toBe(
      'https://remote.openbitfun.com/relay/?v=1.0.9#/pair?did=abc',
    );
    expect(relayPageUrl('https://remote.openbitfun.com/v/1.0.2', '#/pair?did=abc')).toBe(
      'https://remote.openbitfun.com/v/1.0.2/#/pair?did=abc',
    );
  });
});
