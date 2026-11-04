import { create } from 'zustand';
import type { DeviceSurfaceId } from './deviceSurface';

/**
 * The cross-device open the user just asked for. Set on click, before the
 * device switch starts, and cleared when the open settles.
 *
 * Several owners read it: the clicked row highlights from it, navigation keeps
 * drawing background projections until it ends (one hand-over, after the
 * open), the device catalog defers its refreshes so they never compete with
 * the open for the relay link, and the switch lands on the session scene
 * instead of an empty workbench.
 */
export interface DeviceOpenIntent {
  surfaceId: DeviceSurfaceId;
  /** `session:<id>`, `assistant:<workspaceId>` or `new:<workspaceId>`. */
  key: string;
  /** Present when the open ends in a known session. */
  sessionId?: string;
  title?: string;
  startedAt: number;
}

export const useDeviceOpenIntent = create<{ intent: DeviceOpenIntent | null }>(() => ({ intent: null }));

export function beginDeviceOpen(intent: Omit<DeviceOpenIntent, 'startedAt'>): DeviceOpenIntent {
  const next = { ...intent, startedAt: typeof performance !== 'undefined' ? performance.now() : Date.now() };
  useDeviceOpenIntent.setState({ intent: next });
  return next;
}

export function endDeviceOpen(intent: DeviceOpenIntent): void {
  if (useDeviceOpenIntent.getState().intent === intent) useDeviceOpenIntent.setState({ intent: null });
}

export function getDeviceOpenIntent(): DeviceOpenIntent | null {
  return useDeviceOpenIntent.getState().intent;
}
