import type { Session } from '@/flow_chat/types/flow-chat';
import { resolveSessionRelationship } from '@/flow_chat/utils/sessionMetadata';
import { sessionOwningWorkspaceId } from '@/flow_chat/utils/sessionOrdering';

/** Fast parent-id resolver: avoid full relationship normalization for ordinary normal sessions. */
function resolveParentSessionId(session: Session): string | undefined {
  if (session.sessionKind === 'normal' && !session.parentSessionId && !session.btwOrigin) {
    return undefined;
  }
  return resolveSessionRelationship(session).parentSessionId;
}

/** Build the same workspace-owned hierarchy for both rows and their count. */
export function getWorkspaceSessionHierarchy(
  sessions: Iterable<Session>,
  workspaceIds: readonly string[],
): { topLevelSessions: Session[]; childrenByParent: Map<string, Session[]> } {
  const hasWorkspaceScope = workspaceIds.length > 0;
  const workspaceIdSet = hasWorkspaceScope ? new Set(workspaceIds) : null;
  const scoped: Session[] = [];
  const knownIds = new Set<string>();

  for (const session of sessions) {
    if (session.isTransient || session.sessionKind === 'subagent') continue;
    const ownerId = sessionOwningWorkspaceId(session);
    const inScope = hasWorkspaceScope
      ? (ownerId ? workspaceIdSet!.has(ownerId) : false)
      : !ownerId;
    if (!inScope) continue;
    scoped.push(session);
    knownIds.add(session.sessionId);
  }

  const topLevelSessions: Session[] = [];
  const childrenByParent = new Map<string, Session[]>();
  // Resolve each parent link once, then bucket children and top-level rows in a
  // single pass without intermediate arrays.
  for (let i = 0; i < scoped.length; i++) {
    const session = scoped[i];
    const parentId = resolveParentSessionId(session);
    if (parentId && knownIds.has(parentId)) {
      const children = childrenByParent.get(parentId);
      if (children) {
        children.push(session);
      } else {
        childrenByParent.set(parentId, [session]);
      }
    } else {
      topLevelSessions.push(session);
    }
  }
  return { topLevelSessions, childrenByParent };
}
