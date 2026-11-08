import type { Session } from '@/flow_chat/types/flow-chat';
import { resolveSessionRelationship } from '@/flow_chat/utils/sessionMetadata';
import { sessionBelongsToWorkspaceNavRow } from '@/flow_chat/utils/sessionOrdering';

export interface WorkspaceSessionHierarchy {
  topLevelSessions: Session[];
  childrenByParent: Map<string, Session[]>;
}

interface HierarchyCacheEntry {
  sessionsRef: Iterable<Session>;
  workspaceIdsRef: readonly string[];
  workspaceKey: string;
  result: WorkspaceSessionHierarchy;
}

/**
 * Single-entry memo keyed on the identity of the sessions collection and the
 * workspace id list. Repeated calls during a render pass (rows + counts) reuse
 * the exact same result object, preserving strict identity for downstream
 * memoization while avoiding a full re-traversal of the catalog.
 */
let cache: HierarchyCacheEntry | null = null;

function computeWorkspaceKey(workspaceIds: readonly string[]): string {
  return workspaceIds.length ? workspaceIds.join('\u0000') : '\u0000';
}

/** Build the same workspace-owned hierarchy for both rows and their count. */
export function getWorkspaceSessionHierarchy(
  sessions: Iterable<Session>,
  workspaceIds: readonly string[],
): WorkspaceSessionHierarchy {
  const workspaceKey = computeWorkspaceKey(workspaceIds);
  if (
    cache &&
    cache.sessionsRef === sessions &&
    cache.workspaceIdsRef === workspaceIds &&
    cache.workspaceKey === workspaceKey
  ) {
    return cache.result;
  }

  const hasWorkspaces = workspaceIds.length > 0;
  const scoped: Session[] = [];
  const knownIds = new Set<string>();
  for (const session of sessions) {
    if (session.isTransient || session.sessionKind === 'subagent') continue;
    if (hasWorkspaces) {
      let matched = false;
      for (let i = 0; i < workspaceIds.length; i += 1) {
        if (sessionBelongsToWorkspaceNavRow(session, workspaceIds[i])) {
          matched = true;
          break;
        }
      }
      if (!matched) continue;
    } else if (session.workspaceId) {
      continue;
    }
    scoped.push(session);
    knownIds.add(session.sessionId);
  }

  const topLevelSessions: Session[] = [];
  const childrenByParent = new Map<string, Session[]>();
  for (let i = 0; i < scoped.length; i += 1) {
    const session = scoped[i];
    const parentId = resolveSessionRelationship(session).parentSessionId;
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

  const result: WorkspaceSessionHierarchy = { topLevelSessions, childrenByParent };
  cache = { sessionsRef: sessions, workspaceIdsRef: workspaceIds, workspaceKey, result };
  return result;
}
