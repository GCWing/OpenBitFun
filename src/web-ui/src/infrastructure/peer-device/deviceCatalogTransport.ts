/**
 * Read-only product reads on a device the window is not rendering.
 *
 * The product transport is bound to the rendered surface: a peer adapter that
 * is not rendered refuses requests, and `api.invoke` targets whatever device is
 * rendered. The sidebar device catalog must read every other device without
 * changing what the window draws, so it talks to each host directly:
 *
 * - a peer through a raw `host_invoke` device RPC (no control attachment, no
 *   event fan-out; the host's Product Operation Registry still decides what
 *   it may run);
 * - this machine through its own Tauri transport.
 *
 * Only the catalog reads below may use this path. Mutations always go through
 * the rendered surface after activation so they keep Peer Device Mode's
 * capability gates, permission mailboxes and surface fences.
 */

import { TauriTransportAdapter } from '@/infrastructure/api/adapters/tauri-adapter';
import { remoteConnectAPI } from '@/infrastructure/api/service-api/RemoteConnectAPI';
import {
  translateAgentIdentityCommand,
  translateAgentIdentityResponse,
} from '../../../../shared/agent-harness/wire';

export const DEVICE_CATALOG_READ_COMMANDS = new Set([
  'peer_mode_ping',
  'get_opened_workspaces',
  'list_persisted_sessions_page',
]);

const DEVICE_CATALOG_RPC_TIMEOUT_MS = 15_000;

interface HostInvokeEnvelope {
  resp?: string;
  ok?: boolean;
  value?: unknown;
  error?: string;
  message?: string;
}

/** A host answered and refused the command; the link itself is healthy. */
export class DeviceCatalogCommandError extends Error {
  constructor(message: string, readonly command: string) {
    super(message);
    this.name = 'DeviceCatalogCommandError';
  }
}

let localTransport: TauriTransportAdapter | null = null;

/** Never disposed with a surface: background reads outlive every switch. */
export function deviceCatalogLocalTransport(): TauriTransportAdapter {
  localTransport ??= new TauriTransportAdapter();
  return localTransport;
}

/**
 * Run one catalog read on `deviceId`, or on this machine when it is `null`.
 */
export async function invokeOnDevice<T>(
  deviceId: string | null,
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (!DEVICE_CATALOG_READ_COMMANDS.has(command)) {
    throw new Error(`'${command}' is not a device catalog read`);
  }
  if (deviceId === null) {
    return deviceCatalogLocalTransport().request<T>(command, args);
  }
  const raw = await remoteConnectAPI.accountDeviceRpc(
    deviceId,
    JSON.stringify({
      cmd: 'host_invoke',
      command,
      args: translateAgentIdentityCommand(command, args, 'legacy'),
    }),
    DEVICE_CATALOG_RPC_TIMEOUT_MS,
  );
  const envelope = JSON.parse(raw) as HostInvokeEnvelope;
  if (envelope.resp === 'error') {
    throw new Error(envelope.message || `Device '${command}' failed`);
  }
  if (envelope.resp !== 'host_invoke_result') {
    throw new Error(`Unexpected device RPC response for '${command}': ${envelope.resp || 'unknown'}`);
  }
  if (!envelope.ok) {
    throw new DeviceCatalogCommandError(envelope.error || `Device '${command}' failed`, command);
  }
  return translateAgentIdentityResponse(command, envelope.value, args, 'canonical') as T;
}
