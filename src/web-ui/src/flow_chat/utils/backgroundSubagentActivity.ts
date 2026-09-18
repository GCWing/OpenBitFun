import { SessionExecutionState } from '../state-machine/types';
import type { DialogTurn, FlowChatState, FlowToolItem, Session } from '../types/flow-chat';
import { getEffectiveToolName } from './toolInvocationIdentity';

export type BackgroundSubagentActivityStatus = 'processing' | 'finishing';

export interface BackgroundSubagentActivityItem {
  sessionId: string;
  parentSessionId: string;
  title: string;
  agentType?: string;
  status: BackgroundSubagentActivityStatus;
  /** Owning workspace ID; the path and SSH facts below are display projections. */
  workspaceId?: string;
  workspacePath?: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
  parentToolCallId?: string;
  subagentType?: string;
  createdAt: number;
  updatedAt: number;
}

export interface BackgroundSubagentActivity {
  runningCount: number;
  finishingCount: number;
  totalCount: number;
  items: BackgroundSubagentActivityItem[];
}

export type SessionExecutionStateResolver = (
  sessionId: string,
) => SessionExecutionState | undefined;

type BackgroundTaskTool = FlowToolItem & { subagentSessionId?: string };

const EMPTY_BACKGROUND_SUBAGENT_ACTIVITY: BackgroundSubagentActivity = {
  runningCount: 0,
  finishingCount: 0,
  totalCount: 0,
  items: [],
};

function isBackgroundTaskTool(item: FlowToolItem): boolean {
  const input = item.toolCall?.input;
  if (!input || typeof input !== 'object') {
    return false;
  }

  return (input as Record<string, unknown>).run_in_background === true;
}

function deriveStatusFromTurn(turn?: DialogTurn): BackgroundSubagentActivityStatus | null {
  switch (turn?.status) {
    case 'pending':
    case 'image_analyzing':
    case 'processing':
      return 'processing';
    case 'finishing':
    case 'cancelling':
      return 'finishing';
    default:
      return null;
  }
}

export function deriveBackgroundSubagentExecutionStatus(
  session: Session,
  executionState?: SessionExecutionState,
): BackgroundSubagentActivityStatus | null {
  switch (executionState) {
    case SessionExecutionState.PROCESSING:
      return 'processing';
    case SessionExecutionState.FINISHING:
      return 'finishing';
    case SessionExecutionState.ERROR:
      return null;
    case SessionExecutionState.IDLE:
    default:
      return deriveStatusFromTurn(session.dialogTurns[session.dialogTurns.length - 1]);
  }
}

function collectBackgroundTaskToolsBySubagentId(
  sessions: Map<string, Session>,
  parentSessionIds: Set<string>,
): Map<string, BackgroundTaskTool> {
  const taskBySubagentId = new Map<string, BackgroundTaskTool>();

  for (const parentSessionId of parentSessionIds) {
    const parentSession = sessions.get(parentSessionId);
    if (!parentSession) {
      continue;
    }

    for (const turn of parentSession.dialogTurns) {
      for (const round of turn.modelRounds) {
        for (const item of round.items) {
          if (item.type !== 'tool') {
            continue;
          }

          const toolItem = item as BackgroundTaskTool;
          if (
            getEffectiveToolName(toolItem).toLowerCase() === 'task' &&
            toolItem.subagentSessionId &&
            isBackgroundTaskTool(toolItem)
          ) {
            taskBySubagentId.set(toolItem.subagentSessionId, toolItem);
          }
        }
      }
    }
  }

  return taskBySubagentId;
}

function findBackgroundTaskToolForSubagent(
  sessions: Map<string, Session>,
  parentSessionId: string,
  subagentSessionId: string,
): BackgroundTaskTool | null {
  const parentSession = sessions.get(parentSessionId);
  if (!parentSession) {
    return null;
  }

  for (const turn of parentSession.dialogTurns) {
    for (const round of turn.modelRounds) {
      for (const item of round.items) {
        if (item.type !== 'tool') {
          continue;
        }

        const toolItem = item as BackgroundTaskTool;
        if (
          getEffectiveToolName(toolItem).toLowerCase() === 'task' &&
          toolItem.subagentSessionId === subagentSessionId &&
          isBackgroundTaskTool(toolItem)
        ) {
          return toolItem;
        }
      }
    }
  }

  return null;
}

function buildBackgroundSubagentActivityItem(
  session: Session,
  parentSessionId: string,
  status: BackgroundSubagentActivityStatus,
  parentTask: BackgroundTaskTool,
): BackgroundSubagentActivityItem {
  const input = parentTask.toolCall?.input ?? {};
  return {
    sessionId: session.sessionId,
    parentSessionId,
    title: session.title?.trim() || input.description || 'Background subagent',
    agentType: session.subagentType || input.subagent_type || input.subagentType,
    status,
    workspaceId: session.workspaceId || session.config?.workspaceId,
    workspacePath: session.workspacePath,
    remoteConnectionId: session.remoteConnectionId,
    remoteSshHost: session.remoteSshHost,
    parentToolCallId: session.parentToolCallId || parentTask.toolCall?.id || parentTask.id,
    subagentType: session.subagentType || input.subagent_type || input.subagentType,
    createdAt: session.createdAt,
    updatedAt: session.lastActiveAt || session.updatedAt || session.createdAt,
  };
}

function emptyActivity(): BackgroundSubagentActivity {
  return EMPTY_BACKGROUND_SUBAGENT_ACTIVITY;
}

export function buildBackgroundSubagentActivityIndex(
  sessions: Map<string, Session>,
  resolveExecutionState?: SessionExecutionStateResolver,
): Map<string, BackgroundSubagentActivity> {
  const candidateSubagents: Array<{
    session: Session;
    parentSessionId: string;
    status: BackgroundSubagentActivityStatus;
  }> = [];
  const parentSessionIds = new Set<string>();

  for (const session of sessions.values()) {
    const parentSessionId = session.parentSessionId;
    if (session.sessionKind !== 'subagent' || !parentSessionId) {
      continue;
    }

    const status = deriveBackgroundSubagentExecutionStatus(
      session,
      resolveExecutionState?.(session.sessionId),
    );
    if (!status) {
      continue;
    }

    candidateSubagents.push({ session, parentSessionId, status });
    parentSessionIds.add(parentSessionId);
  }

  if (candidateSubagents.length === 0) {
    return new Map();
  }

  const taskBySubagentId = collectBackgroundTaskToolsBySubagentId(sessions, parentSessionIds);
  const itemsByParentId = new Map<string, BackgroundSubagentActivityItem[]>();

  for (const { session, parentSessionId, status } of candidateSubagents) {
    const parentTask = taskBySubagentId.get(session.sessionId);
    if (!parentTask) {
      continue;
    }

    const item = buildBackgroundSubagentActivityItem(session, parentSessionId, status, parentTask);

    const items = itemsByParentId.get(parentSessionId) ?? [];
    items.push(item);
    itemsByParentId.set(parentSessionId, items);
  }

  const index = new Map<string, BackgroundSubagentActivity>();
  for (const [parentSessionId, items] of itemsByParentId) {
    const sortedItems = [...items].sort((left, right) => {
      const createdAtDiff = left.createdAt - right.createdAt;
      return createdAtDiff !== 0 ? createdAtDiff : left.sessionId.localeCompare(right.sessionId);
    });
    index.set(parentSessionId, {
      runningCount: sortedItems.filter(item => item.status === 'processing').length,
      finishingCount: sortedItems.filter(item => item.status === 'finishing').length,
      totalCount: sortedItems.length,
      items: sortedItems,
    });
  }

  return index;
}

export function deriveBackgroundSubagentActivityItemForSession(
  state: FlowChatState,
  subagentSessionId: string,
  resolveExecutionState?: SessionExecutionStateResolver,
): BackgroundSubagentActivityItem | null {
  const session = state.sessions.get(subagentSessionId);
  const parentSessionId = session?.parentSessionId;
  if (!session || session.sessionKind !== 'subagent' || !parentSessionId) {
    return null;
  }

  const status = deriveBackgroundSubagentExecutionStatus(
    session,
    resolveExecutionState?.(session.sessionId),
  );
  if (!status) {
    return null;
  }

  const parentTask = findBackgroundTaskToolForSubagent(
    state.sessions,
    parentSessionId,
    session.sessionId,
  );
  if (!parentTask) {
    return null;
  }

  return buildBackgroundSubagentActivityItem(session, parentSessionId, status, parentTask);
}

export function deriveBackgroundSubagentActivity(
  state: FlowChatState,
  parentSessionId?: string | null,
  resolveExecutionState?: SessionExecutionStateResolver,
): BackgroundSubagentActivity {
  if (!parentSessionId) {
    return emptyActivity();
  }

  return buildBackgroundSubagentActivityIndex(
    state.sessions,
    resolveExecutionState,
  ).get(parentSessionId) ?? emptyActivity();
}

export function buildBackgroundSubagentActivitySnapshotKey(
  sessions: Map<string, Session>,
  parentSessionId?: string | null,
  resolveExecutionState?: SessionExecutionStateResolver,
): string | null {
  if (!parentSessionId) {
    return null;
  }

  const activity = buildBackgroundSubagentActivityIndex(
    sessions,
    resolveExecutionState,
  ).get(parentSessionId);
  if (!activity || activity.items.length === 0) {
    return null;
  }

  return activity.items
    .map(item => `${item.sessionId}:${item.status}:${item.title}`)
    .join('|');
}
