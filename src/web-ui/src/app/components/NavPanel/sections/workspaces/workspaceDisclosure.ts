import { create } from 'zustand';
import { surfaceScopedKey, type DeviceSurfaceId } from '@/infrastructure/peer-device/deviceSurface';
import { useWorkspaceSessionViewStore } from '../../workspaceSessionView';
import { resetSessionNavExpansion } from '../sessions/useSessionNavExpansion';

/**
 * Which project rows are collapsed, per device. Window-wide rather than
 * component state: a device switch remounts its list, and the live and
 * background projections of one device must agree on what is open.
 *
 * A "collapse all" request collapses every row until the user opens one again,
 * matching the previous component-local behaviour.
 */
export const workspaceDisclosureKey = (surfaceId: DeviceSurfaceId, workspaceId: string) => JSON.stringify([surfaceId, workspaceId]);

const useWorkspaceDisclosureStore = create<{ requestId: number; values: Record<string, boolean> }>(() => ({
  requestId: 0,
  values: {},
}));

export function useWorkspaceSessionsCollapsed(surfaceId: DeviceSurfaceId, workspaceId: string): boolean {
  const collapseAllRequestId = useWorkspaceSessionViewStore(state => state.collapseAllRequestId);
  const value = useWorkspaceDisclosureStore(state => (
    state.requestId === collapseAllRequestId ? state.values[workspaceDisclosureKey(surfaceId, workspaceId)] : undefined
  ));
  return value ?? collapseAllRequestId > 0;
}

export function isWorkspaceSessionsCollapsed(surfaceId: DeviceSurfaceId, workspaceId: string): boolean {
  const collapseAllRequestId = useWorkspaceSessionViewStore.getState().collapseAllRequestId;
  const state = useWorkspaceDisclosureStore.getState();
  const value = state.requestId === collapseAllRequestId ? state.values[workspaceDisclosureKey(surfaceId, workspaceId)] : undefined;
  return value ?? collapseAllRequestId > 0;
}

export function setWorkspaceSessionsCollapsed(surfaceId: DeviceSurfaceId, workspaceId: string, collapsed: boolean): void {
  if (collapsed) resetSessionNavExpansion(surfaceScopedKey(surfaceId, workspaceId));
  const requestId = useWorkspaceSessionViewStore.getState().collapseAllRequestId;
  useWorkspaceDisclosureStore.setState(state => ({
    requestId,
    values: { ...(state.requestId === requestId ? state.values : {}), [workspaceDisclosureKey(surfaceId, workspaceId)]: collapsed },
  }));
}
