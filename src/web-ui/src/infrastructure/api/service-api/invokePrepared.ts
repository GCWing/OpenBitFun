import { getActiveSurfaceScope, type SurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { PEER_CONTROLLER_LOCAL_COMMANDS } from '../generated/remoteSurface';
import { api } from './ApiClient';
import type { ApiRequestConfig } from './types';

/**
 * Own the device scope before asynchronous argument preparation starts.
 *
 * Workspace capability negotiation can yield even on the local fast path.
 * Capturing the surface only in api.invoke would then adopt the next device
 * and send the previous device's IDs or paths to it. Keep preparation and
 * dispatch in one scope; ApiClient retains that scope through transport/retry.
 *
 * Controller-local commands keep their authority across surface activation,
 * matching ApiClient, so they are never cancelled by a device switch.
 */
export async function invokePrepared<T = any>(
  command: string,
  prepare: (scope: SurfaceScope) => Promise<Record<string, unknown> | undefined>,
  config?: ApiRequestConfig,
): Promise<T> {
  const scope = getActiveSurfaceScope();
  const controllerLocal = PEER_CONTROLLER_LOCAL_COMMANDS.has(command);
  const assertCurrent = () => {
    if (!controllerLocal) scope.assertCurrent(command);
  };
  try {
    const args = await prepare(scope);
    assertCurrent();
    const result = config === undefined
      ? await api.invoke<T>(command, args)
      : await api.invoke<T>(command, args, config);
    assertCurrent();
    return result;
  } catch (error) {
    // A late preparation/transport failure belongs to the departed device too.
    // Preserve the shared cancellation signal so callers never retry it here.
    assertCurrent();
    throw error;
  }
}
