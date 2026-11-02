import type { Session } from '@/flow_chat/types/flow-chat';
import { resolveSessionRelationship } from '@/flow_chat/utils/sessionMetadata';
import { sessionBelongsToWorkspaceNavRow } from '@/flow_chat/utils/sessionOrdering';

/** Build the same workspace-owned hierarchy for both rows and their count. */
export function getWorkspaceSessionHierarchy(
  sessions: Iterable<Session>,
  workspaceIds: readonly string[],
): { topLevelSessions: Session[]; childrenByParent: Map<string, Session[]> } {
  const scoped = Array.from(sessions).filter(session => {
    if (session.isTransient || session.sessionKind === 'subagent') return false;
    return workspaceIds.length
      ? workspaceIds.some(workspaceId => sessionBelongsToWorkspaceNavRow(session, workspaceId))
      : !session.workspaceId;
  });
  const knownIds = new Set(scoped.map(session => session.sessionId));
  const topLevelSessions: Session[] = [];
  const childrenByParent = new Map<string, Session[]>();
  for (const session of scoped) {
    const parentId = resolveSessionRelationship(session).parentSessionId;
    if (parentId && knownIds.has(parentId)) {
      const children = childrenByParent.get(parentId) ?? [];
      children.push(session);
      childrenByParent.set(parentId, children);
    } else {
      topLevelSessions.push(session);
    }
  }
  return { topLevelSessions, childrenByParent };
}
