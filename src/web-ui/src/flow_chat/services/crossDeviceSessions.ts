/**
 * Sessions of devices this window is not rendering, with their activity.
 *
 * The rendered device has live containers. Every other device is known through
 * the sidebar device catalog, whose pages carry the host's activity summaries
 * and are refreshed by the host's catalog invalidations (turn started, ended,
 * state changed). Desktop hosts do not fan agentic events out to controllers,
 * so a catalog summary is the freshest fact about such a device; local events
 * observed while a peer is rendered only fill sessions the catalog lacks.
 */

import { getActiveSurfaceId, type DeviceSurfaceId } from '@/infrastructure/peer-device/deviceSurface';
import { deviceWorkspaceCatalog } from '@/infrastructure/peer-device/deviceWorkspaceCatalog';
import type { SessionActivitySummary, SessionMetadata } from '@/shared/types/session-history';
import { sessionActivityStore } from '../store/sessionActivityStore';

export interface CrossDeviceSession {
  surfaceId: DeviceSurfaceId;
  workspaceId: string;
  session: SessionMetadata;
  activity?: SessionActivitySummary;
}

/** Catalog summary first (refreshed from the host), then observed events. */
export function crossDeviceActivity(
  surfaceId: DeviceSurfaceId,
  sessionId: string,
  catalogSummary: SessionActivitySummary | undefined,
): SessionActivitySummary | undefined {
  return catalogSummary ?? sessionActivityStore.get(sessionId, surfaceId)?.summary;
}

export function listCrossDeviceSessions(surfaceId: DeviceSurfaceId): CrossDeviceSession[] {
  const snapshot = deviceWorkspaceCatalog.getSnapshot(surfaceId);
  const rows: CrossDeviceSession[] = [];
  for (const workspace of snapshot.workspaces) {
    const page = snapshot.sessions[workspace.id];
    if (!page) continue;
    for (const session of page.sessions) {
      rows.push({
        surfaceId,
        workspaceId: workspace.id,
        session,
        activity: crossDeviceActivity(surfaceId, session.sessionId, page.activities[session.sessionId]),
      });
    }
  }
  return rows;
}

/** Every loaded device except the one the window renders. */
export function listBackgroundDeviceSessions(): CrossDeviceSession[] {
  const rendered = getActiveSurfaceId();
  return deviceWorkspaceCatalog.loadedSurfaces()
    .filter(surfaceId => surfaceId !== rendered)
    .flatMap(listCrossDeviceSessions);
}

/** `surfaceId` limits notifications to one device (a device header). */
export function subscribeCrossDeviceSessions(listener: () => void, surfaceId?: DeviceSurfaceId): () => void {
  const unsubscribeCatalog = deviceWorkspaceCatalog.subscribe(changed => {
    if (!surfaceId || changed === surfaceId) listener();
  });
  const unsubscribeActivity = sessionActivityStore.subscribe(changed => {
    if (changed !== getActiveSurfaceId() && (!surfaceId || changed === surfaceId)) listener();
  });
  return () => {
    unsubscribeCatalog();
    unsubscribeActivity();
  };
}
