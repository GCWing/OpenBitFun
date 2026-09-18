import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import { sessionAPI } from '@/infrastructure/api/service-api/SessionAPI';
import { getActiveSurfaceScope, type SurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { flowChatStore } from '../store/FlowChatStore';
import { buildSessionLineageTree, type SessionLineageNode } from '../utils/sessionLineage';
import { FlowChatManager } from './FlowChatManager';
import { clearHistorySessionOpenTransition, clearRecentHistorySessionOpenIntent } from './sessionOpenIntent';

export interface SessionTreeBranchLocation {
  sessionId: string;
  workspaceId: string;
}

/** Read the complete lineage: the visible tree may hide inactive or unloaded descendants. */
export async function deleteSessionTreeBranch(
  location: SessionTreeBranchLocation,
  scope: SurfaceScope = getActiveSurfaceScope(),
): Promise<void> {
  scope.assertCurrent('read session branch before deletion');
  const snapshot = await sessionAPI.getSessionLineage(location);
  scope.assertCurrent('resolve session branch deletion');
  if (!snapshot) throw new Error('Agent session lineage is unavailable');
  const tree = buildSessionLineageTree(location.sessionId, snapshot, flowChatStore.getState().sessions);
  const findBranch = (node: SessionLineageNode | null): SessionLineageNode | undefined => {
    if (!node) return undefined;
    if (node.sessionId === location.sessionId) return node;
    for (const child of node.children) {
      const found = findBranch(child);
      if (found) return found;
    }
    return undefined;
  };
  const branch = findBranch(tree);
  if (!branch || !branch.parentSessionId) throw new Error('Agent session branch not found');
  const nodes: SessionLineageNode[] = [];
  const collect = (node: SessionLineageNode) => {
    node.children.forEach(collect);
    nodes.push(node);
  };
  collect(branch);
  for (const node of nodes) {
    scope.assertCurrent('delete session branch node');
    clearRecentHistorySessionOpenIntent(node.sessionId);
    clearHistorySessionOpenTransition(node.sessionId);
    await agentAPI.deleteSession(
      node.sessionId,
      location.workspaceId,
    );
    scope.assertCurrent('apply session branch deletion');
    FlowChatManager.getInstance().discardLocalSession(node.sessionId);
  }
}
