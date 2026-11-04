/**
 * Projects the device catalog into each background device's FlowChat
 * container.
 *
 * Navigation draws a background device from its container with exactly the
 * live list's hierarchy, sort and filters, and a switch finds the device's
 * sessions already present. The live list therefore paints the same rows in
 * the same order the moment a device is rendered, and opening one of them
 * needs no extra read.
 */

import { getActiveSurfaceId, type DeviceSurfaceId } from '@/infrastructure/peer-device/deviceSurface';
import { deviceWorkspaceCatalog } from '@/infrastructure/peer-device/deviceWorkspaceCatalog';
import { flowChatStore, type BackgroundSessionPage } from '../store/FlowChatStore';
import { DEFAULT_SESSION_VIEW_KEY, forgetSurfaceSessionTotals, rememberWorkspaceSessionTotal } from './workspaceSessionTotals';

let installs = 0;
/** Page record arrays already projected, per surface; the catalog replaces arrays on change. */
const seededRecords = new Map<DeviceSurfaceId, WeakSet<object>>();
let teardown: (() => void) | null = null;
export function seedBackgroundSurface(surfaceId: DeviceSurfaceId): void {
  const snapshot = deviceWorkspaceCatalog.getSnapshot(surfaceId);
  if (snapshot.status === 'idle') {
    // Catalog reset (account change): nothing of the previous read survives.
    flowChatStore.discardSeededSessions(surfaceId);
    forgetSurfaceSessionTotals(surfaceId);
    seededRecords.delete(surfaceId);
    return;
  }
  const pages: BackgroundSessionPage[] = [];
  let seen = seededRecords.get(surfaceId);
  if (!seen) seededRecords.set(surfaceId, seen = new WeakSet());
  for (const workspace of snapshot.workspaces) {
    const page = snapshot.sessions[workspace.id];
    if (!page || page.status === 'idle') continue;
    // A notification for another page, a status flip or a total does not
    // re-project rows that were already seeded.
    if (seen.has(page.records)) continue;
    seen.add(page.records);
    if (page.total !== null) rememberWorkspaceSessionTotal(surfaceId, workspace.id, DEFAULT_SESSION_VIEW_KEY, page.total);
    const remote = workspace.workspaceKind === 'remote';
    pages.push({
      workspaceId: workspace.id,
      workspacePath: workspace.rootPath,
      remoteConnectionId: remote ? workspace.connectionId : undefined,
      remoteSshHost: remote ? workspace.sshHost : undefined,
      sessions: page.records,
    });
  }
  if (surfaceId !== getActiveSurfaceId()) flowChatStore.seedSurfaceSessions(surfaceId, pages);
}

/** Reference-counted; navigation installs it while it lists several devices. */
export function installBackgroundSurfaceSeeding(): () => void {
  installs += 1;
  if (installs === 1) {
    const unsubscribe = deviceWorkspaceCatalog.subscribe(seedBackgroundSurface);
    for (const surfaceId of deviceWorkspaceCatalog.loadedSurfaces()) seedBackgroundSurface(surfaceId);
    teardown = unsubscribe;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    installs -= 1;
    if (installs === 0) {
      teardown?.();
      teardown = null;
    }
  };
}
