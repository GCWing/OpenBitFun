/**
 * Open a link clicked in a terminal, forwarding loopback ports for SSH terminals.
 *
 * A click is an explicit user action, so a forward is created without a
 * confirmation prompt. When forwarding cannot happen (Peer Device Mode, local
 * Docker/WSL targets, a failed bind) the user is told why and the local URL is
 * never opened silently; an "open anyway" action keeps the escape hatch.
 */

import { parseLoopbackLink, rewriteLoopbackLink, isLoopbackRemoteHost } from './loopbackLink';
import type { PortForward, PortForwardRequest } from './types';

export interface TerminalLinkContext {
  /** SSH connection that owns the terminal's PTY; absent for local terminals. */
  connectionId?: string;
}

export interface TerminalLinkNotice {
  label: string;
  onClick: () => void;
}

export interface TerminalLinkDeps {
  listPortForwards: (connectionId: string) => Promise<PortForward[]>;
  startPortForward: (request: PortForwardRequest) => Promise<PortForward>;
  openExternal: (url: string) => Promise<void>;
  isPeerDeviceModeActive: () => boolean;
  notifyInfo: (message: string) => void;
  notifyWarning: (message: string, action?: TerminalLinkNotice) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
  logError?: (message: string, data: Record<string, unknown>) => void;
}

export type TerminalLinkOutcome =
  | 'opened'
  | 'forward-reused'
  | 'forward-created'
  | 'peer-unsupported'
  | 'forward-failed';

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : String(error);
}

function findForward(forwards: PortForward[], remotePort: number): PortForward | undefined {
  return forwards.find(
    forward =>
      forward.direction === 'local' &&
      forward.remotePort === remotePort &&
      isLoopbackRemoteHost(forward.remoteHost),
  );
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

  if (deps.isPeerDeviceModeActive()) {
    deps.notifyWarning(
      deps.t('linkForward.peerUnsupported', { port: link.remotePort }),
      openAnyway,
    );
    return 'peer-unsupported';
  }

  let forward: PortForward;
  let outcome: TerminalLinkOutcome;
  try {
    const existing = findForward(await deps.listPortForwards(connectionId), link.remotePort);
    if (existing) {
      forward = existing;
      outcome = 'forward-reused';
    } else {
      forward = await startForward(connectionId, link.remotePort, link.remoteHost, deps);
      outcome = 'forward-created';
      deps.notifyInfo(
        deps.t('linkForward.created', {
          remotePort: link.remotePort,
          localAddress: `${forward.localHost}:${forward.localPort}`,
        }),
      );
    }
  } catch (error) {
    deps.logError?.('Failed to forward terminal link', {
      connectionId,
      remotePort: link.remotePort,
      error,
    });
    deps.notifyWarning(
      deps.t('linkForward.failed', { port: link.remotePort, error: errorMessage(error) }),
      openAnyway,
    );
    return 'forward-failed';
  }

  await deps.openExternal(rewriteLoopbackLink(link, forward.localHost, forward.localPort));
  return outcome;
}

async function startForward(
  connectionId: string,
  remotePort: number,
  remoteHost: string,
  deps: TerminalLinkDeps,
): Promise<PortForward> {
  try {
    // Prefer the same port locally; the backend binds another if it is taken.
    return await deps.startPortForward({
      connectionId,
      remotePort,
      remoteHost,
      localPort: remotePort,
      label: deps.t('linkForward.label'),
    });
  } catch (startError) {
    // A concurrent click may have created the same forward first.
    const raced = findForward(await deps.listPortForwards(connectionId), remotePort);
    if (!raced) throw startError;
    return raced;
  }
}

