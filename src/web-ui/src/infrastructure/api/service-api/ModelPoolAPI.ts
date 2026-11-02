import { isTauriRuntime } from '@/infrastructure/runtime';
import { api } from './ApiClient';
import { peerConnectionManager } from '@/infrastructure/peer-device/PeerConnectionManager';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';

export type ModelSelection = { kind: 'model'; model_ref: string } | { kind: 'pool'; pool_id: string };
export interface ModelPoolDefinition {
  id: string;
  name: string;
  strategy: string;
  member_model_ids: string[];
  [extension: string]: unknown;
}
export interface ModelPoolDocument {
  version: number;
  pools: unknown[];
}
export interface ModelPoolBinding {
  poolId: string;
  modelId: string;
  configurationFingerprint: string;
  generation: number;
}
export interface SessionModelTarget {
  sessionId: string;
  selection: ModelSelection;
  binding?: ModelPoolBinding;
}
export interface ModelPoolMemberStatus {
  modelId: string;
  status: 'unverified' | 'available' | 'cooling_down' | 'probing' | 'needs_attention' | 'disabled' | 'missing';
  reason?: string;
  retryAtMs?: number;
  contextBudget?: ModelPoolContextBudget;
}
export interface ModelPoolContextBudget {
  contextWindow: number;
  inputLimit: number;
}

export interface SessionModelTargetScope {
  sessionId: string;
  workspaceId?: string;
  workspacePath?: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
  includeInternal?: boolean;
}

export function readableModelPools(document: ModelPoolDocument): ModelPoolDefinition[] {
  return document.pools.filter((value): value is ModelPoolDefinition => {
    if (!value || typeof value !== 'object') return false;
    const pool = value as Partial<ModelPoolDefinition>;
    return typeof pool.id === 'string' && typeof pool.name === 'string'
      && typeof pool.strategy === 'string' && Array.isArray(pool.member_model_ids)
      && pool.member_model_ids.every(id => typeof id === 'string');
  });
}

async function invoke<T>(command: string, request?: unknown): Promise<T> {
  const scope = getActiveSurfaceScope();
  const result = await api.invoke<T>(command, request === undefined ? undefined : { request });
  scope.assertCurrent(command);
  return result;
}

export function supportsModelPools(): boolean {
  const scope = getActiveSurfaceScope();
  return scope.surfaceId === 'local' ? isTauriRuntime() : peerConnectionManager.list()
    .find(peer => peer.surfaceId === scope.surfaceId)?.capabilities.modelPoolSelectionV1 === true;
}

export function supportsBtwModelPools(): boolean {
  if (!supportsModelPools()) return false;
  const scope = getActiveSurfaceScope();
  return scope.surfaceId === 'local' || peerConnectionManager.list()
    .find(peer => peer.surfaceId === scope.surfaceId)?.capabilities.btwModelPoolSelectionV1 === true;
}

export const modelPoolAPI = {
  retryMember: (modelId: string) => invoke<void>('retry_model_pool_member', { modelId }),
  list: () => invoke<ModelPoolDocument>('get_model_pools'),
  // Empty draft IDs create a pool; the execution host allocates its stable ID.
  // Non-empty IDs only update an existing pool.
  save: (pool: ModelPoolDefinition) =>
    invoke<ModelPoolDocument>('save_model_pool', { pool }),
  remove: (poolId: string) =>
    invoke<ModelPoolDocument>('delete_model_pool', { poolId }),
  status: (poolId: string) => invoke<ModelPoolMemberStatus[]>('get_model_pool_status', { poolId }),
  target: (scope: SessionModelTargetScope) => invoke<SessionModelTarget>('get_session_model_target', scope),
  select: (scope: SessionModelTargetScope, selection: ModelSelection) =>
    invoke<SessionModelTarget>('update_session_model_target', { ...scope, selection }),
};
