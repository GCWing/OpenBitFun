/** Service version announced by the official endpoint's `v` parameter. */
export const RELAY_SERVICE_VERSION = '1.0.9';
/** Paths served by the same deployed Relay and account database. */
const LIVE_RELAY_ENDPOINT_PATHS = ['/relay', '/v/1.0.2'];

export const OFFICIAL_RELAY_URL = `https://remote.openbitfun.com/relay?v=${RELAY_SERVICE_VERSION}`;

/** Base URL of an endpoint: validates it, accepts a single `v` parameter, and
 * removes it so the result can be joined with API paths. */
export function relayEndpointBase(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname
      || url.username || url.password || url.hash) return null;
    const keys = Array.from(url.searchParams.keys());
    if (keys.length > 0) {
      if (keys.length !== 1 || keys[0] !== 'v') return null;
      if (!/^[A-Za-z0-9.-]{1,32}$/.test(url.searchParams.get('v') ?? '')) return null;
    }
    url.search = '';
    return url.href.replace(/\/+$/, '');
  } catch { return null; }
}

export function normalizeRelayUrl(value: string): string | null {
  return relayEndpointBase(value);
}

function isLocalAddress(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const octets = hostname.split('.').map(Number);
  if (octets.length === 4 && octets.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) {
    return octets[0] === 10 || octets[0] === 127
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 169 && octets[1] === 254);
  }
  return /^\[(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):/i.test(hostname);
}

/** True when the normalized URL is one of the official deployment's live
 * paths (`/relay` or the older `/v/1.0.2`), so a page opened from either keeps
 * working while both reach the same Relay. */
function isOfficialRelayUrl(normalized: string): boolean {
  const official = relayEndpointBase(OFFICIAL_RELAY_URL);
  if (!official) return false;
  try {
    const url = new URL(normalized);
    const base = new URL(official);
    return url.origin === base.origin
      && LIVE_RELAY_ENDPOINT_PATHS.includes(url.pathname.replace(/\/+$/, ''));
  } catch { return false; }
}

/** Invitations may select the official endpoint or a locally hosted Relay. */
export function pairingRelayUrl(value: string): string | null {
  const normalized = normalizeRelayUrl(value);
  if (!normalized) return null;
  if (isOfficialRelayUrl(normalized)) return normalized;
  const url = new URL(normalized);
  return isLocalAddress(url.hostname) && url.pathname === '/' ? normalized : null;
}

export function currentRelayUrl(location: Pick<Location, 'origin' | 'pathname'> = window.location): string {
  const pathname = location.pathname.replace(/index\.html$/, '');
  const endpoint = pairingRelayUrl(`${location.origin}${pathname}`);
  if (endpoint) return endpoint;
  // The official root page is the controller itself, so the address bar may
  // carry no path at all while the endpoint is still the official `/relay`.
  if (pathname === '/' || pathname === '') {
    const official = relayEndpointBase(OFFICIAL_RELAY_URL);
    if (official) return official;
  }
  throw new Error('Open this page from the official Relay or a local Relay invitation.');
}

/** A target is resolved only through the authenticated device directory. */
export function accountDeviceIdFromHash(hash: string): string | null {
  if (!hash.startsWith('#/pair?')) return null;
  const params = new URLSearchParams(hash.slice(7));
  const ids = params.getAll('did');
  if (Array.from(params.keys()).some(key => key !== 'did') || ids.length !== 1
    || !/^[A-Za-z0-9_.-]{1,128}$/.test(ids[0]) || ['.', '..'].includes(ids[0])) return null;
  return ids[0];
}
