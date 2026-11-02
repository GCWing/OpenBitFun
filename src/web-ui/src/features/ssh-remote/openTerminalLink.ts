/**
 * Open a link clicked in a terminal, forwarding loopback ports for SSH terminals.
 *
 * A click is an explicit user action, so a forward is created without a
 * confirmation prompt. When forwarding cannot happen (Peer Device Mode, a
 * port-less link, a failed bind) the user is told why and the local URL is
 * never opened silently; an "open anyway" action keeps the escape hatch.
 *
 * WSL and local Docker terminals also carry a connection id, but they run on
 * this machine (WSL2 forwards localhost by default), have no SSH channel to
 * forward over, and so open links unchanged.
 */

import { parseLoopbackLink, rewriteLoopbackLink, sameRemoteHost, type LoopbackLink } from './loopbackLink';
import type { PortForward, PortForwardRequest, SavedConnection } from './types';

export interface TerminalLinkContext {
  /** Connection that owns the terminal's PTY; absent for local terminals. */
  connectionId?: string;
}

export interface TerminalLinkNotice {
  label: string;
  onClick: () => void;
}

export interface TerminalLinkDeps {
  listSavedConnections: () => Promise<SavedConnection[]>;
  listPortForwards: (connectionId: string) => Promise<PortForward[]>;
  startPortForward: (request: PortForwardRequest) => Promise<PortForward>;
  stopPortForward: (forwardId: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  isPeerDeviceModeActive: () => boolean;
  notifyInfo: (message: string) => void;
  notifyWarning: (message: string, action?: TerminalLinkNotice) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
  logError?: (message: string, data: Record<string, unknown>) => void;
}

export type TerminalLinkOutcome =
  | 'opened'
  | 'opened-local-target'
  | 'forward-reused'
  | 'forward-created'
  | 'no-port'
  | 'peer-unsupported'
  | 'forward-failed';

/** WSL and local Docker targets run on this machine; nothing to forward. */
export function isLocalProcessConnection(connection: SavedConnection | undefined): boolean {
  return Boolean(connection && (connection.wsl || connection.container?.local));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : String(error);
}

function findForward(
  forwards: PortForward[],
  remoteHost: string,
  remotePort: number,
): PortForward | undefined {
  const candidates = forwards.filter(
    forward => forward.direction === 'local' && forward.remotePort === remotePort,
  );
  return (
    candidates.find(forward => forward.remoteHost.toLowerCase() === remoteHost) ??
    candidates.find(forward => sameRemoteHost(forward.remoteHost, remoteHost))
  );
}

async function resolvesToLocalProcess(connectionId: string, deps: TerminalLinkDeps): Promise<boolean> {
  try {
    const saved = await deps.listSavedConnections();
    return isLocalProcessConnection(saved.find(connection => connection.id === connectionId));
  } catch (error) {
    // Unknown target: try forwarding; the backend rejects local targets loudly.
    deps.logError?.('Failed to resolve terminal connection target', { connectionId, error });
    return false;
  }
}

export async function openTerminalLink(
  uri: string,
  context: TerminalLinkContext,
  deps: TerminalLinkDeps,
): Promise<TerminalLinkOutcome> {
  const connectionId = context.connectionId?.trim();
  const link = connectionId ? parseLoopbackLink(uri) : null;

  if (!connectionId || !link) {
    await deps.openExternal(uri);
    return 'opened';
  }

  const openAnyway: TerminalLinkNotice = {
    label: deps.t('linkForward.openAnyway'),
    onClick: () => {
      void deps.openExternal(uri).catch(error => {
        deps.logError?.('Failed to open external link', { uri, error });
      });
    },
  };

  // The forward would bind on the peer host, not on this controller.
  if (deps.isPeerDeviceModeActive()) {
    deps.notifyWarning(deps.t('linkForward.peerUnsupported'), openAnyway);
    return 'peer-unsupported';
  }

  if (await resolvesToLocalProcess(connectionId, deps)) {
    await deps.openExternal(uri);
    return 'opened-local-target';
  }

  if (link.remotePort === null) {
    deps.notifyWarning(deps.t('linkForward.noPort'), openAnyway);
    return 'no-port';
  }

  const remotePort = link.remotePort;
  let forward: PortForward;
  let outcome: TerminalLinkOutcome;
  try {
    ({ forward, outcome } = await ensureForward(connectionId, link, remotePort, deps));
  } catch (error) {
    deps.logError?.('Failed to forward terminal link', { connectionId, remotePort, error });
    deps.notifyWarning(
      deps.t('linkForward.failed', { port: remotePort, error: errorMessage(error) }),
      openAnyway,
    );
    return 'forward-failed';
  }

  if (outcome === 'forward-created') {
    deps.notifyInfo(
      deps.t('linkForward.created', {
        remotePort,
        localAddress: `${forward.localHost}:${forward.localPort}`,
      }),
    );
  }
  await deps.openExternal(rewriteLoopbackLink(link, forward.localHost, forward.localPort));
  return outcome;
}

async function ensureForward(
  connectionId: string,
  link: LoopbackLink,
  remotePort: number,
  deps: TerminalLinkDeps,
): Promise<{ forward: PortForward; outcome: 'forward-reused' | 'forward-created' }> {
  const existing = findForward(await deps.listPortForwards(connectionId), link.remoteHost, remotePort);
  if (existing && (!existing.lastError || existing.activeConnections > 0)) {
    return { forward: existing, outcome: 'forward-reused' };
  }
  if (existing) {
    // The forward reported a failure and carries no traffic. Starting again
    // reconnects the SSH session if needed; keep its local port and exposure.
    await deps.stopPortForward(existing.id);
  }

  const request: PortForwardRequest = {
    connectionId,
    remotePort,
    remoteHost: link.remoteHost,
    // Prefer the same port locally; the backend binds another if it is taken.
    localPort: existing?.localPort ?? remotePort,
    exposeOnLan: existing?.localHost === '0.0.0.0' ? true : undefined,
    label: existing?.label ?? deps.t('linkForward.label'),
  };
  try {
    return { forward: await deps.startPortForward(request), outcome: 'forward-created' };
  } catch (startError) {
    // A concurrent click may have created the same forward first.
    let raced: PortForward | undefined;
    try {
      raced = findForward(await deps.listPortForwards(connectionId), link.remoteHost, remotePort);
    } catch {
      throw startError;
    }
    if (!raced) throw startError;
    return { forward: raced, outcome: 'forward-reused' };
  }
}
