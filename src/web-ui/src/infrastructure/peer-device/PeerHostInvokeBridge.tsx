/**
 * Peer-side bridge: execute HostInvoke requests through the same Tauri invoke
 * path as local UI, then report results back to Rust.
 */

import { useEffect } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { createLogger } from '@/shared/utils/logger';
import { isTauriRuntime } from '@/infrastructure/runtime';
import {
  PeerHostInvokeIdempotencyCache,
  type PeerHostInvokeExecutionResult,
} from './peerHostInvokeIdempotency';

const log = createLogger('PeerHostInvokeBridge');

function serializeInvokeError(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return 'Host operation failed';
  }
}

function safeCommandForLog(command: string): string {
  return /^[a-z0-9_]{1,80}$/i.test(command) ? command : 'invalid';
}

interface HostInvokeBridgeRequest {
  id: string;
  command: string;
  args: unknown;
}

async function executeHostInvoke(
  command: string,
  args: unknown,
): Promise<PeerHostInvokeExecutionResult> {
  try {
    const value = args === undefined || args === null
      ? await invoke(command)
      : await invoke(command, args as Record<string, unknown>);
    return {
      ok: true,
      value: value ?? null,
      error: null,
    };
  } catch (error) {
    const message = serializeInvokeError(error);
    log.warn('Peer host invoke failed', {
      command: safeCommandForLog(command),
      error_category: 'host_invoke',
    });
    return {
      ok: false,
      value: null,
      error: message,
    };
  }
}

/**
 * Tell the native host whether this bridge can execute product commands. While
 * it cannot, the host refuses controller requests as definitely not executed
 * instead of emitting into a webview with no listener.
 */
async function reportBridgeReady(ready: boolean): Promise<void> {
  try {
    await invoke('peer_host_bridge_ready', { request: { ready } });
  } catch {
    log.warn('Failed to report peer host bridge readiness', {
      ready,
      error_category: 'bridge_readiness',
    });
  }
}

export function PeerHostInvokeBridge(): null {
  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    let reportedReady = false;
    const idempotencyCache = new PeerHostInvokeIdempotencyCache();

    void (async () => {
      try {
        const resolvedUnlisten = await listen<HostInvokeBridgeRequest>('peer-host-invoke://request', async (event) => {
          if (disposed) return;
          const { id, command, args } = event.payload;
          const result = await idempotencyCache.execute(
            command,
            args,
            () => executeHostInvoke(command, args),
          );
          try {
            await invoke('peer_host_invoke_complete', {
              id,
              ok: result.ok,
              value: result.value,
              error: result.error,
            });
          } catch {
            const loggedCommand = safeCommandForLog(command);
            log.error('Failed to report peer host invoke result', {
              command: loggedCommand,
              error_category: 'completion',
            });
          }
        });
        // Cleanup may have run while awaiting: unlisten immediately instead
        // of leaking the registration (StrictMode first mount hits this).
        if (disposed) {
          resolvedUnlisten();
          return;
        }
        unlisten = resolvedUnlisten;
        reportedReady = true;
        await reportBridgeReady(true);
      } catch {
        log.error('Failed to register peer host invoke listener', {
          error_category: 'listener_registration',
        });
      }
    })();

    return () => {
      disposed = true;
      if (unlisten) {
        unlisten();
      }
      if (reportedReady) {
        void reportBridgeReady(false);
      }
    };
  }, []);

  return null;
}
