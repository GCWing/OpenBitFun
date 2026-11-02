import { invokePrepared } from '@/infrastructure/api/service-api/invokePrepared';
import type { Session } from '../types/flow-chat';
import type { TrajectoryPage } from './trajectoryModel';

export function loadTrajectoryPage(session: Session, ordinal: number, query: string, nodeOffset = 0): Promise<TrajectoryPage> {
  const entry = session.turnCatalog?.entries.find(item => item.ordinal === ordinal);
  if (!entry || !session.workspaceId) return Promise.reject(new Error('Session trajectory history is unavailable'));
  return invokePrepared('load_session_trajectory', async () => ({ request: {
    sessionId: session.sessionId, workspaceId: session.workspaceId, workspacePath: session.workspacePath ?? '',
    remoteConnectionId: session.remoteConnectionId, targetStorageTurnIndex: entry.storageTurnIndex,
    expectedTurnId: entry.turnId, expectedCatalogRevision: session.turnCatalog?.revision,
    before: 0, after: 8, query, nodeOffset,
  } }));
}

export function loadTrajectoryCatalog(session: Session): Promise<TrajectoryPage> {
  return invokePrepared('load_session_trajectory', async () => ({ request: {
    sessionId: session.sessionId, workspaceId: session.workspaceId, workspacePath: session.workspacePath ?? '',
    remoteConnectionId: session.remoteConnectionId, targetStorageTurnIndex: 0, catalogOnly: true,
  } }));
}
