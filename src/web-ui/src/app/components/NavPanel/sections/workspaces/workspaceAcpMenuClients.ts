import {
  ACPClientAPI,
  type AcpClientInfo,
} from '@/infrastructure/api/service-api/ACPClientAPI';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';

interface LoadWorkspaceAcpMenuClientsOptions {
  remoteWorkspace?: boolean;
  remoteConnectionId?: string;
  /** Completion events consume the new snapshot without starting another probe. */
  refreshIfMissing?: boolean;
}

const forcedRemoteRequirementRefreshes = new Set<string>();
let refreshEpoch = -1;

export async function loadWorkspaceAcpMenuClients(
  options: LoadWorkspaceAcpMenuClientsOptions = {}
): Promise<AcpClientInfo[]> {
  const scope = getActiveSurfaceScope();
  if (refreshEpoch !== scope.epoch) {
    refreshEpoch = scope.epoch;
    forcedRemoteRequirementRefreshes.clear();
  }
  const clients = await ACPClientAPI.getClients();
  scope.assertCurrent('load workspace ACP menu');

  if (!options.remoteWorkspace) {
    return clients.filter(client => client.enabled);
  }

  if (!options.remoteConnectionId) {
    return [];
  }

  const enabledClients = clients.filter(client => client.enabled);
  if (enabledClients.length === 0) {
    return [];
  }

  let probes = await ACPClientAPI.probeClientRequirements({
    remoteConnectionId: options.remoteConnectionId,
  });
  scope.assertCurrent('load workspace ACP requirements');
  let visibleClients = filterRunnableClients(enabledClients, probes);
  if (
    options.refreshIfMissing !== false &&
    visibleClients.length === 0 &&
    (probes.length === 0 || !forcedRemoteRequirementRefreshes.has(options.remoteConnectionId))
  ) {
    forcedRemoteRequirementRefreshes.add(options.remoteConnectionId);
    probes = await ACPClientAPI.probeClientRequirements({
      remoteConnectionId: options.remoteConnectionId,
      force: true,
    });
    scope.assertCurrent('refresh workspace ACP requirements');
    visibleClients = filterRunnableClients(enabledClients, probes);
  }
  return visibleClients;
}

function filterRunnableClients(
  clients: AcpClientInfo[],
  probes: Awaited<ReturnType<typeof ACPClientAPI.probeClientRequirements>>
): AcpClientInfo[] {
  const runnableRemoteIds = new Set(
    probes.filter(probe => probe.runnable).map(probe => probe.id)
  );
  return clients.filter(client => runnableRemoteIds.has(client.id));
}
