import { api } from '@/infrastructure/api/service-api/ApiClient';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import type { GenerativeWidgetOrigin } from '@/flow_chat/utils/generativeWidgetProjection';
import type { GenUIAppDefinition, GenUIAppState } from './genUITypes';
export interface GenUIOwnerRevision { revision: string; app: GenUIAppDefinition; state: GenUIAppState; evidence: unknown }
export interface GenUIOwnerIdentity { libraryId?: string; libraryRevision?: number; designSpec?: { id: string; revision: number }; sourceKind?: string }
export async function accessGenUIOwner(origin: GenerativeWidgetOrigin, appId: string, update?: { revision: string; state: GenUIAppState }, identity?: GenUIOwnerIdentity): Promise<GenUIOwnerRevision> {
  const scope = getActiveSurfaceScope();
  if (scope.surfaceId !== origin.surfaceId || !origin.scope.workspaceId) throw new Error('GenUI requires its owning workspace on the active device');
  const result = await api.invoke<GenUIOwnerRevision | null>('gen_ui_app', { request: { workspaceId: origin.scope.workspaceId, sessionId: origin.sessionId, appId, ...(identity?.libraryId ? { libraryId: identity.libraryId } : {}), ...(identity?.libraryRevision !== undefined ? { libraryRevision: identity.libraryRevision } : {}), ...(identity?.designSpec ? { designSpec: identity.designSpec } : {}), ...(identity?.sourceKind ? { sourceKind: identity.sourceKind } : {}), ...update } });
  scope.assertCurrent();
  if (!result) throw new Error('No accepted GenUI revision exists on the owner');
  return result;
}
