/** Hosted Relay service version announced by the official endpoint. */
export const RELAY_SERVICE_VERSION: string = '1.0.9';

const OFFICIAL_RELAY_ORIGIN: string = 'https://remote.openbitfun.com';

/** Paths served by the same deployed Relay and the same account database.
 * `?v=` replaced the path segment as the client-facing version, but `/v/1.0.2`
 * stays live for builds that predate the change: a token, master key, or device
 * registration obtained through either path is interchangeable, because both
 * reach one process and one database. Any other `/v/<version>` path is a
 * different deployment. */
const LIVE_RELAY_ENDPOINT_PATHS: string[] = ['/relay', '/v/1.0.2'];

const VERSION_PATTERN: RegExp = /^[A-Za-z0-9.]{1,32}$/;

/** Identity of the official Relay: no version query, no fragment, no trailing
 * slash. Every path join and every deployment comparison uses this value. */
export const OFFICIAL_RELAY_URL: string = `${OFFICIAL_RELAY_ORIGIN}/relay`;

/** The same deployment as a user sees and shares it: the service version
 * travels as a GET parameter instead of a path segment, so a release no longer
 * needs a proxy location of its own. */
export const OFFICIAL_RELAY_ENDPOINT: string = `${OFFICIAL_RELAY_URL}?v=${RELAY_SERVICE_VERSION}`;

export interface AccountDeviceLink { relayUrl: string; deviceId: string; }

/** Strip the version parameter and any trailing slash, or explain why not.
 * Exactly one `v=<version>` parameter is accepted; every other query parameter
 * is rejected so the query can never carry per-request data, and a fragment
 * means the value is a page rather than an endpoint. */
function endpointBase(value: string): string | undefined {
  const text = value.trim();
  if (text === '' || text.indexOf('#') >= 0) return undefined;
  const mark = text.indexOf('?');
  const base = (mark >= 0 ? text.substring(0, mark) : text).replace(/\/+$/, '');
  if (mark >= 0) {
    const pairs = text.substring(mark + 1).split('&');
    if (pairs.length !== 1 || pairs[0].substring(0, 2) !== 'v=' ||
      !VERSION_PATTERN.test(pairs[0].substring(2))) return undefined;
  }
  return base;
}

function officialPath(value: string): string {
  return value.startsWith(OFFICIAL_RELAY_ORIGIN) ? value.substring(OFFICIAL_RELAY_ORIGIN.length) : '';
}

export function normalizeAccountRelayUrl(value: string): string {
  const base = endpointBase(value);
  if (!base) return '';
  // Both live aliases of the official host answer as one deployment, so an
  // endpoint stored by an older build still resolves to today's identity.
  if (LIVE_RELAY_ENDPOINT_PATHS.indexOf(officialPath(base)) >= 0) return OFFICIAL_RELAY_URL;
  const match = /^(https?:\/\/)(localhost|\[[0-9a-fA-F:]+\]|[0-9.]+)(?::([0-9]{1,5}))?$/.exec(base);
  if (!match) return '';
  if (match[3] && (Number(match[3]) < 1 || Number(match[3]) > 65535)) return '';
  const host = match[2].toLowerCase();
  const octets = host.split('.').map((part: string): number => Number(part));
  const local = host === 'localhost' || host === '[::1]' ||
    /^\[(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):/.test(host) ||
    (octets.length === 4 && octets.every((part: number): boolean => Number.isInteger(part) && part >= 0 && part <= 255) &&
      (octets[0] === 10 || octets[0] === 127 || (octets[0] === 192 && octets[1] === 168) ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 169 && octets[1] === 254)));
  return local ? base : '';
}

interface RelayEndpointIdentity { origin: string; path: string; }

function endpointIdentity(value: string): RelayEndpointIdentity | undefined {
  const base = endpointBase(value);
  if (!base) return undefined;
  const match = /^(https?):\/\/(\[[0-9a-fA-F:]+\]|[^/?#:@]+)(?::([0-9]{1,5}))?([^?#]*)$/.exec(base);
  if (!match) return undefined;
  const scheme = match[1].toLowerCase();
  const port = match[3] ? Number(match[3]) : (scheme === 'https' ? 443 : 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { origin: `${scheme}://${match[2].toLowerCase()}:${port}`, path: match[4] };
}

/** Whether two endpoints resolve to the same deployed Relay.
 * This is the comparison behind reusing a stored token or master key: both live
 * aliases of one host count as one deployment, so a build that moves from
 * `/v/1.0.2` to `/relay?v=` keeps its credential, while any other versioned
 * path is a different or retired deployment. */
export function sameRelayDeployment(left: string, right: string): boolean {
  const a = endpointIdentity(left);
  const b = endpointIdentity(right);
  if (!a || !b || a.origin !== b.origin) return false;
  return a.path === b.path ||
    (LIVE_RELAY_ENDPOINT_PATHS.indexOf(a.path) >= 0 && LIVE_RELAY_ENDPOINT_PATHS.indexOf(b.path) >= 0);
}

/** Endpoint and target are hints; the account directory is the authority. */
export function accountDeviceLink(value: string): AccountDeviceLink | undefined {
  const text = value.trim();
  if (text.length > 8192) return undefined;
  const parts = text.split('/#/pair?did=');
  if (parts.length !== 2) return undefined;
  const relayUrl = normalizeAccountRelayUrl(parts[0]);
  let deviceId = '';
  try { deviceId = decodeURIComponent(parts[1]); } catch (_error) { return undefined; }
  if (!relayUrl || !/^[A-Za-z0-9_.-]{1,128}$/.test(deviceId) || deviceId === '.' || deviceId === '..') return undefined;
  return { relayUrl, deviceId };
}
