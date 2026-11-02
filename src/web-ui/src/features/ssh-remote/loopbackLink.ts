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
  /** Port the service listens on, as seen from the remote host. */
  remotePort: number;
  /** Host the forward should dial on the remote side. */
  remoteHost: string;
}

/** Remote-side hosts considered equivalent when reusing an existing forward. */
const LOOPBACK_REMOTE_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '0.0.0.0') return true;
  if (host === '[::1]' || host === '::1') return true;
  return /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** Map the link host to the address the forward should dial remotely. */
function remoteDialHost(hostname: string): string {
  const host = hostname.toLowerCase();
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '[::1]' || host === '::1') return '::1';
  if (host === 'localhost' || host.endsWith('.localhost')) return 'localhost';
  return host;
}

/**
 * Recognize an http(s) link to a loopback address with an explicit port.
 * Links without an explicit port are left alone: a scheme-default port on the
 * remote is rarely a dev server and usually needs privileges to forward.
 */
export function parseLoopbackLink(uri: string): LoopbackLink | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!isLoopbackHostname(url.hostname)) return null;
  if (!url.port) return null;
  const remotePort = Number(url.port);
  if (!Number.isInteger(remotePort) || remotePort <= 0 || remotePort > 65535) return null;
  return { url, remotePort, remoteHost: remoteDialHost(url.hostname) };
}

/** Whether an existing forward's remote host reaches the same loopback service. */
export function isLoopbackRemoteHost(remoteHost: string): boolean {
  return LOOPBACK_REMOTE_HOSTS.has(remoteHost.toLowerCase());
}

/**
 * Point a loopback link at a local forward, keeping path, query and hash.
 *
 * `localhost` and `*.localhost` names are kept so cookies and OAuth callback
 * origins still match; other loopback spellings (`0.0.0.0`, `[::1]`, `127.x`)
 * become the forward's bound address, since the forward may not listen on them.
 */
export function rewriteLoopbackLink(link: LoopbackLink, localHost: string, localPort: number): string {
  const url = new URL(link.url.href);
  const hostname = url.hostname.toLowerCase();
  const keepName = hostname === 'localhost' || hostname.endsWith('.localhost');
  if (!keepName) {
    const bound = localHost === '0.0.0.0' || localHost === '::' || !localHost ? '127.0.0.1' : localHost;
    url.hostname = bound.includes(':') && !bound.startsWith('[') ? `[${bound}]` : bound;
  }
  url.port = String(localPort);
  return url.href;
}
