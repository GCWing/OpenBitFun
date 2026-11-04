/**
 * Last known top-level session total of a workspace view, per device.
 *
 * Navigation reloads a workspace's catalog whenever its reader restarts (a
 * device switch, a refresh after a local change, a new activation epoch).
 * While it reloads, only the loaded rows are countable, so the "show more" row
 * and its count would vanish and come back. Both projections of a device (the
 * background rows and the live list) read and write this one value, so the row
 * keeps the last host-reported total until a newer one arrives.
 */

import type { DeviceSurfaceId } from '@/infrastructure/peer-device/deviceSurface';

/** The view every host total without a query describes. */
export const DEFAULT_SESSION_VIEW_KEY = 'default';

const totals = new Map<string, number>();
const key = (surfaceId: DeviceSurfaceId, workspaceId: string, viewKey: string) => JSON.stringify([surfaceId, workspaceId, viewKey]);

export function rememberWorkspaceSessionTotal(surfaceId: DeviceSurfaceId, workspaceId: string, viewKey: string, total: number): void {
  totals.set(key(surfaceId, workspaceId, viewKey), total);
}

export function knownWorkspaceSessionTotal(surfaceId: DeviceSurfaceId, workspaceId: string, viewKey: string): number | undefined {
  return totals.get(key(surfaceId, workspaceId, viewKey));
}

export function forgetSurfaceSessionTotals(surfaceId: DeviceSurfaceId): void {
  const prefix = JSON.stringify([surfaceId]).slice(0, -1) + ',';
  for (const entry of Array.from(totals.keys())) if (entry.startsWith(prefix)) totals.delete(entry);
}

/** The total to present: settled reads are authoritative, restarts keep the last one. */
export function presentedSessionTotal(settled: boolean, liveTotal: number, remembered: number | undefined): number {
  return settled ? liveTotal : Math.max(liveTotal, remembered ?? 0);
}
