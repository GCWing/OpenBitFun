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

/** An action whose row never mounted (the workspace closed meanwhile) lapses. */
const PENDING_WORKSPACE_ACTION_TTL_MS = 30_000;
let requestedAt = 0;

export const usePendingWorkspaceAction = create<{ action: PendingWorkspaceAction | null }>(() => ({ action: null }));

export function requestWorkspaceAction(action: PendingWorkspaceAction): void {
  requestedAt = Date.now();
  usePendingWorkspaceAction.setState({ action });
}

/** Withdraw `action` if it is still the pending one. */
export function clearWorkspaceAction(action: PendingWorkspaceAction): void {
  const pending = usePendingWorkspaceAction.getState().action;
  if (pending && pending.surfaceId === action.surfaceId && pending.workspaceId === action.workspaceId
    && pending.kind === action.kind) usePendingWorkspaceAction.setState({ action: null });
}

/** Take the action if it belongs to this row; it runs at most once. */
export function takeWorkspaceAction(surfaceId: DeviceSurfaceId, workspaceId: string): PendingWorkspaceActionKind | null {
  const { action } = usePendingWorkspaceAction.getState();
  if (action && Date.now() - requestedAt > PENDING_WORKSPACE_ACTION_TTL_MS) {
    usePendingWorkspaceAction.setState({ action: null });
    return null;
  }
  if (!action || action.surfaceId !== surfaceId || action.workspaceId !== workspaceId) return null;
  usePendingWorkspaceAction.setState({ action: null });
  return action.kind;
}
