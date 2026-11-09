import { isTauriRuntime } from '@/infrastructure/runtime';
import { peerConnectionManager } from '@/infrastructure/peer-device/PeerConnectionManager';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { api } from './ApiClient';

export interface MagpieModel {
  id: string;
  display_name?: string | null;
  owned_by?: string | null;
  context_window?: number | null;
  max_output_tokens?: number | null;
  tool_call?: boolean | null;
  reasoning?: boolean | null;
  modalities?: { input: string[]; output: string[] } | null;
}
export type MagpieProbeStatus = 'ready' | 'empty' | 'unreachable' | 'access_denied'
  | 'unrecognized' | 'catalog_error' | 'invalid_address';
export interface MagpieProbeResult {
  status: MagpieProbeStatus;
  base_url: string;
  version?: string | null;
  models: MagpieModel[];
}
export function supportsMagpieDiscovery(): boolean {
  const scope = getActiveSurfaceScope();
  return scope.surfaceId === 'local' ? isTauriRuntime() : peerConnectionManager.list()
    .find(peer => peer.surfaceId === scope.surfaceId)?.capabilities.magpieDiscoveryV1 === true;
}
export const magpieAPI = {
  async probe(baseUrl: string, apiKey: string): Promise<MagpieProbeResult> {
    const scope = getActiveSurfaceScope();
    if (!supportsMagpieDiscovery()) throw new Error('magpie_discovery_v1_unsupported');
    const result = await api.invoke<MagpieProbeResult>('probe_magpie_gateway', {
      request: { base_url: baseUrl, api_key: apiKey },
    });
    scope.assertCurrent('probe_magpie_gateway');
    return result;
  },
};
