import { create } from 'zustand';
import type { DeviceSurfaceId } from '@/infrastructure/peer-device/deviceSurface';

/**
 * An action the user started on another device's workspace row (its "more"
 * menu, the assistant history). The device is rendered first; the live row
 * for the same workspace then runs the action once, so the menu or panel is
 * the real one with that device's capabilities.
 */
export type PendingWorkspaceActionKind = 'menu' | 'assistant-history';

interface PendingWorkspaceAction {
  surfaceId: DeviceSurfaceId;
  workspaceId: string;
  kind: PendingWorkspaceActionKind;
}

export const usePendingWorkspaceAction = create<{ action: PendingWorkspaceAction | null }>(() => ({ action: null }));

export function requestWorkspaceAction(action: PendingWorkspaceAction): void {
  usePendingWorkspaceAction.setState({ action });
}

/** Take the action if it belongs to this row; it runs at most once. */
export function takeWorkspaceAction(surfaceId: DeviceSurfaceId, workspaceId: string): PendingWorkspaceActionKind | null {
  const { action } = usePendingWorkspaceAction.getState();
  if (!action || action.surfaceId !== surfaceId || action.workspaceId !== workspaceId) return null;
  usePendingWorkspaceAction.setState({ action: null });
  return action.kind;
}
