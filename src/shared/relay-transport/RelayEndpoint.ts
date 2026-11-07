/** Hosted Relay endpoint identity.
 *
 * The service version travels as a `v` query parameter so a release no longer
 * needs its own proxy location, while the endpoint a client stores stays a
 * plain base URL: every path join, socket path, and deployment comparison uses
 * `relayEndpointBase`, and only user-facing links keep the parameter.
 */

export const RELAY_SERVICE_VERSION = '1.0.9';

/** Paths served by the same deployed Relay and the same account database.
 * `/v/1.0.2` stays live for builds that predate the version parameter, so a
 * credential or master key from either path is interchangeable. */
export const LIVE_RELAY_ENDPOINT_PATHS = ['/relay', '/v/1.0.2'];

export const OFFICIAL_RELAY_URL = `https://remote.openbitfun.com/relay?v=${RELAY_SERVICE_VERSION}`;

const VERSION_PATTERN = /^[A-Za-z0-9.-]{1,32}$/;

/** Validate an endpoint and return its base URL (no query, fragment, or
 * trailing slash). Exactly one `v=<version>` parameter is allowed; every other
 * query parameter is rejected so the query can never carry per-request data. */
export function relayEndpointBase(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname
      || url.username || url.password || url.hash) return null;
    const keys = Array.from(url.searchParams.keys());
    if (keys.length > 0) {
      if (keys.length !== 1 || keys[0] !== 'v') return null;
      if (!VERSION_PATTERN.test(url.searchParams.get('v') ?? '')) return null;
    }
    url.search = '';
    return url.href.replace(/\/+$/, '');
  } catch { return null; }
}

/** Service version announced by the endpoint, when it carries one. */
export function relayEndpointVersion(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const version = new URL(value.trim()).searchParams.get('v');
    return version && VERSION_PATTERN.test(version) ? version : null;
  } catch { return null; }
}

function endpointPath(base: string): string {
  try {
    return new URL(base).pathname.replace(/\/+$/, '');
  } catch { return ''; }
}

/** Whether two endpoints resolve to the same deployed Relay. Both live aliases
 * of one host count as one deployment so a build that switches from
 * `/v/1.0.2` to `/relay?v=` keeps its stored credential and master key. */
export function sameRelayDeployment(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = relayEndpointBase(left);
  const b = relayEndpointBase(right);
  if (!a || !b) return false;
  const urlA = new URL(a);
  const urlB = new URL(b);
  if (urlA.origin !== urlB.origin) return false;
  const pathA = endpointPath(a);
  const pathB = endpointPath(b);
  return pathA === pathB
    || (LIVE_RELAY_ENDPOINT_PATHS.includes(pathA) && LIVE_RELAY_ENDPOINT_PATHS.includes(pathB));
}

/** User-facing page URL: keeps `?v=` before the fragment so the version
 * survives in the address bar and in shared links. */
export function relayPageUrl(endpoint: string, fragment: string): string {
  const base = relayEndpointBase(endpoint);
  if (!base) throw new Error('Invalid Relay URL');
  const version = relayEndpointVersion(endpoint);
  return version ? `${base}/?v=${version}${fragment}` : `${base}/${fragment}`;
}
