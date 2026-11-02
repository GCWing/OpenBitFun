/**
 * Loopback link detection and rewriting for remote terminals.
 *
 * A dev server running on an SSH host prints `http://127.0.0.1:5173`. That
 * address names the remote machine, not this one, so opening it verbatim hits
 * whatever happens to listen locally. These helpers recognize such links and
 * rewrite them onto a local forward. They are pure: no IO, no forwarding.
 */

export interface LoopbackLink {
  /** Parsed link. */
  url: URL;
  /**
   * Port the service listens on, as seen from the remote host. `null` when the
   * link carries no explicit port: it still names the remote machine, but there
   * is no dev-server port worth forwarding.
   */
  remotePort: number | null;
  /** Host the forward should dial on the remote side. */
  remoteHost: string;
}

/** Lower-case, drop a trailing root dot (`localhost.`) and IPv6 brackets. */
function canonicalHost(hostname: string): string {
  let host = hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return host;
}

function isLoopbackHostname(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '0.0.0.0' || host === '::1') return true;
  return /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** Map the link host to the address the forward should dial remotely. */
function remoteDialHost(host: string): string {
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === 'localhost' || host.endsWith('.localhost')) return 'localhost';
  return host;
}

/** Recognize an http(s) link whose host is a loopback address. */
export function parseLoopbackLink(uri: string): LoopbackLink | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = canonicalHost(url.hostname);
  if (!isLoopbackHostname(host)) return null;
  let remotePort: number | null = null;
  if (url.port) {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    remotePort = port;
  }
  return { url, remotePort, remoteHost: remoteDialHost(host) };
}

/** Remote hosts that name the same service: exact, plus `localhost` <-> `127.0.0.1`. */
export function sameRemoteHost(left: string, right: string): boolean {
  const a = canonicalHost(left);
  const b = canonicalHost(right);
  if (a === b) return true;
  const ipv4Localhost = new Set(['localhost', '127.0.0.1']);
  return ipv4Localhost.has(a) && ipv4Localhost.has(b);
}

/**
 * Point a loopback link at a local forward, keeping path, query and hash.
 *
 * The host is always replaced with the forward's bound address. Keeping a
 * `localhost` name would let the browser try `::1` first and reach a local
 * server on the same port, which is the bug this rewrite exists to avoid.
 */
export function rewriteLoopbackLink(link: LoopbackLink, localHost: string, localPort: number): string {
  const url = new URL(link.url.href);
  let bound = canonicalHost(localHost || '127.0.0.1');
  if (bound === '0.0.0.0') bound = '127.0.0.1';
  if (bound === '::') bound = '::1';
  url.hostname = bound.includes(':') ? `[${bound}]` : bound;
  url.port = String(localPort);
  return url.href;
}
