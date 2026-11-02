import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import type { Session } from '../types/flow-chat';
import { resolveSessionRelationship } from '../utils/sessionMetadata';
import { sessionProjectWorkspacePath } from '../utils/sessionWorkspace';

/** Refresh the review session's permission selection before submitting work. */
export async function inheritReviewPermissionMode(
  child: Session,
  sessions: ReadonlyMap<string, Session>,
  assertCurrent: () => void,
): Promise<void> {
  const relationship = resolveSessionRelationship(child);
  if (!relationship.isReview || !relationship.parentSessionId) {
    return;
  }

  const parent = sessions.get(relationship.parentSessionId);
  const parentScope = {
    sessionId: relationship.parentSessionId,
    workspacePath: parent?.workspacePath ?? sessionProjectWorkspacePath(child),
    remoteConnectionId: parent?.remoteConnectionId ?? child.remoteConnectionId,
    remoteSshHost: parent?.remoteSshHost ?? child.remoteSshHost,
  };
  assertCurrent();
  const { mode } = await agentAPI.getSessionPermissionMode(parentScope);
  assertCurrent();
  // A cleared parent override must also clear a previously inherited override.
  // Turn-only grants remain scoped to the parent's exact turn.
  await agentAPI.updateSessionPermissionMode({
    sessionId: child.sessionId,
    workspacePath: child.workspacePath,
    remoteConnectionId: child.remoteConnectionId,
    remoteSshHost: child.remoteSshHost,
    mode: mode ?? null,
  });
  assertCurrent();
}
