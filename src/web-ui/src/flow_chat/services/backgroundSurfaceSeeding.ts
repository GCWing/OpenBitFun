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
/** Top-level session ids each workspace page listed last time, per surface. */
const listedIds = new Map<DeviceSurfaceId, Map<string, Set<string>>>();
let teardown: (() => void) | null = null;
export function seedBackgroundSurface(surfaceId: DeviceSurfaceId): void {
  const snapshot = deviceWorkspaceCatalog.getSnapshot(surfaceId);
  if (snapshot.status === 'idle') {
    // Catalog reset (account change): nothing of the previous read survives.
    flowChatStore.discardSeededSessions(surfaceId);
    forgetSurfaceSessionTotals(surfaceId);
    seededRecords.delete(surfaceId);
    listedIds.delete(surfaceId);
    return;
  }
  let listed = listedIds.get(surfaceId);
  if (!listed) listedIds.set(surfaceId, listed = new Map());
  const removed: string[] = [];
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
    // A session the host listed before and no longer lists was deleted or
    // archived there (or fell past the loaded rows, where it is not drawn).
    // With the complete list, anything absent from it is gone.
    if (page.status === 'ready' && !page.error) {
      const current = new Set(page.sessions.map(session => session.sessionId));
      const previous = listed.get(workspace.id);
      if (previous) for (const sessionId of previous) if (!current.has(sessionId)) removed.push(sessionId);
      if (!page.hasMore) {
        for (const session of flowChatStore.getSurfaceSessions(surfaceId).values()) {
          if (session.workspaceId === workspace.id && !session.parentSessionId && session.sessionKind !== 'subagent'
            && !current.has(session.sessionId)) removed.push(session.sessionId);
        }
      }
      listed.set(workspace.id, current);
    }
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
  if (surfaceId === getActiveSurfaceId()) return;
  flowChatStore.seedSurfaceSessions(surfaceId, pages);
  flowChatStore.dropSurfaceSessions(surfaceId, removed);
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
