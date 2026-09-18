import type {
  SessionLineageEntry,
  SessionLineageSnapshot,
} from '@/infrastructure/api/service-api/SessionAPI';
import type { Session } from '../types/flow-chat';

export type SessionLineageLifecycle =
  | 'running'
  | 'finishing'
  | 'waiting'
  | 'completed'
  | 'cancelled'
  | 'error'
  | 'idle';

export interface SessionLineageNode {
  sessionId: string;
  parentSessionId?: string;
  parentToolCallId?: string;
  title: string;
  agentType?: string;
  subagentType?: string;
  agentId?: string;
  lifecycle: SessionLineageLifecycle;
  createdAt: number;
  /** Owning workspace ID; authoritative when present. */
  workspaceId?: string;
  workspacePath?: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
  isRoot: boolean;
  children: SessionLineageNode[];
}

type FlatSessionLineageNode = Omit<SessionLineageNode, 'children'>;

function metadataLifecycle(metadata: SessionLineageEntry): SessionLineageLifecycle {
  if (metadata.needsUserAttention) return 'waiting';
  if (metadata.unreadCompletion === 'error' || metadata.unreadCompletion === 'interrupted') {
    return 'error';
  }
  if (metadata.activeTurnId) return 'running';
  return metadata.status === 'completed' ? 'completed' : 'idle';
}

export function sessionLineageLifecycleForSession(session: Session): SessionLineageLifecycle {
  if (session.needsUserAttention) return 'waiting';
  if (session.status === 'error' || session.hasUnreadCompletion === 'error') return 'error';

  const latestTurn = session.dialogTurns[session.dialogTurns.length - 1];
  switch (latestTurn?.status) {
    case 'pending':
    case 'image_analyzing':
    case 'processing':
      return 'running';
    case 'finishing':
    case 'cancelling':
      return 'finishing';
    case 'cancelled':
      return 'cancelled';
    case 'error':
      return 'error';
    case 'completed':
      return 'completed';
    default:
      return session.persistedStatus === 'completed' ? 'completed' : 'idle';
  }
}

function isActiveSessionLineageLifecycle(lifecycle: SessionLineageLifecycle): boolean {
  return lifecycle === 'running' || lifecycle === 'finishing';
}

/** Keep active nodes and the ancestor paths needed to reach them. */
export function filterActiveSessionLineageTree(node: SessionLineageNode | null): SessionLineageNode | null {
  if (!node) return null;
  const children = node.children
    .map(filterActiveSessionLineageTree)
    .filter((child): child is SessionLineageNode => child !== null);
  return isActiveSessionLineageLifecycle(node.lifecycle) || children.length > 0
    ? { ...node, children }
    : null;
}

function nodeFromMetadata(metadata: SessionLineageEntry): FlatSessionLineageNode {
  return {
    sessionId: metadata.sessionId,
    parentSessionId: metadata.parentSessionId,
    parentToolCallId: metadata.parentToolCallId,
    title: metadata.sessionName,
    agentType: metadata.agentType,
    subagentType: metadata.subagentType,
    agentId: metadata.agentId,
    lifecycle: metadataLifecycle(metadata),
    createdAt: metadata.createdAtMs,
    workspaceId: metadata.workspaceId,
    workspacePath: metadata.workspacePath,
    remoteConnectionId: metadata.remoteConnectionId,
    remoteSshHost: metadata.remoteSshHost,
    isRoot: false,
  };
}

function nodeFromSession(session: Session): FlatSessionLineageNode {
  return {
    sessionId: session.sessionId,
    parentSessionId: session.parentSessionId,
    parentToolCallId: session.parentToolCallId,
    title: session.title?.trim() || session.subagentType || session.mode || 'Agent',
    agentType: session.mode || session.config.agentType,
    subagentType: session.subagentType,
    agentId: undefined,
    lifecycle: sessionLineageLifecycleForSession(session),
    createdAt: session.createdAt,
    workspaceId: session.workspaceId || session.config.workspaceId,
    workspacePath: session.workspacePath,
    remoteConnectionId: session.remoteConnectionId,
    remoteSshHost: session.remoteSshHost,
    isRoot: false,
  };
}

function resolveRootSessionId(
  nodes: Map<string, FlatSessionLineageNode>,
  anchorSessionId: string,
  snapshotRootSessionId?: string,
): string | null {
  if (snapshotRootSessionId && nodes.has(snapshotRootSessionId)) {
    return snapshotRootSessionId;
  }
  if (!nodes.has(anchorSessionId)) {
    return null;
  }

  let currentSessionId = anchorSessionId;
  const visited = new Set([currentSessionId]);
  while (true) {
    const parentSessionId = nodes.get(currentSessionId)?.parentSessionId;
    if (!parentSessionId || !nodes.has(parentSessionId) || visited.has(parentSessionId)) {
      return currentSessionId;
    }
    visited.add(parentSessionId);
    currentSessionId = parentSessionId;
  }
}

export function buildSessionLineageTree(
  anchorSessionId: string,
  snapshot: SessionLineageSnapshot | null,
  liveSessions: Map<string, Session>,
): SessionLineageNode | null {
  const nodes = new Map<string, FlatSessionLineageNode>();
  for (const metadata of snapshot?.sessions ?? []) {
    nodes.set(metadata.sessionId, nodeFromMetadata(metadata));
  }

  for (const session of liveSessions.values()) {
    if (
      session.sessionId === anchorSessionId ||
      session.sessionKind === 'subagent' ||
      nodes.has(session.sessionId)
    ) {
      const liveNode = nodeFromSession(session);
      const persistedNode = nodes.get(session.sessionId);
      // Opened subagent shells can expose a generic title; persisted metadata remains
      // the display-title authority while live fields provide current runtime state.
      if (persistedNode?.title.trim()) {
        liveNode.title = persistedNode.title;
      }
      liveNode.agentId = persistedNode?.agentId;
      nodes.set(session.sessionId, liveNode);
    }
  }

  const rootSessionId = resolveRootSessionId(nodes, anchorSessionId, snapshot?.rootSessionId);
  if (!rootSessionId) return null;

  const childrenByParent = new Map<string, FlatSessionLineageNode[]>();
  for (const node of nodes.values()) {
    if (!node.parentSessionId || !nodes.has(node.parentSessionId)) continue;
    const children = childrenByParent.get(node.parentSessionId) ?? [];
    children.push(node);
    childrenByParent.set(node.parentSessionId, children);
  }
  const visited = new Set<string>();
  const buildNode = (sessionId: string): SessionLineageNode | null => {
    if (visited.has(sessionId)) return null;
    const node = nodes.get(sessionId);
    if (!node) return null;
    visited.add(sessionId);
    return {
      ...node,
      isRoot: sessionId === rootSessionId,
      children: (childrenByParent.get(sessionId) ?? [])
        .map(child => buildNode(child.sessionId))
        .filter((child): child is SessionLineageNode => child !== null),
    };
  };

  return buildNode(rootSessionId);
}

export function hasActiveSessionLineageDescendants(
  rootSessionId: string | undefined,
  liveSessions: Map<string, Session>,
): boolean {
  if (!rootSessionId) return false;

  for (const session of liveSessions.values()) {
    if (
      session.sessionId === rootSessionId ||
      !isActiveSessionLineageLifecycle(sessionLineageLifecycleForSession(session))
    ) {
      continue;
    }

    const visited = new Set<string>();
    let currentSessionId: string | undefined = session.sessionId;
    while (currentSessionId && !visited.has(currentSessionId)) {
      if (currentSessionId === rootSessionId) return true;
      visited.add(currentSessionId);
      currentSessionId = liveSessions.get(currentSessionId)?.parentSessionId;
    }
  }

  return false;
}

export function countSessionLineageDescendants(root: SessionLineageNode | null): number {
  if (!root) return 0;
  return root.children.reduce(
    (count, child) => count + 1 + countSessionLineageDescendants(child),
    0,
  );
}

export function collectExpandedRunningBranches(root: SessionLineageNode | null): Set<string> {
  const expanded = new Set<string>();
  const visit = (node: SessionLineageNode): boolean => {
    const hasActiveDescendant = node.children.some(visit);
    const isActive = node.lifecycle === 'running' || node.lifecycle === 'finishing';
    if (node.isRoot || hasActiveDescendant) expanded.add(node.sessionId);
    return isActive || hasActiveDescendant;
  };
  if (root) visit(root);
  return expanded;
}
