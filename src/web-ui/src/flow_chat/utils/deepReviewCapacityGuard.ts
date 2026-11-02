import type { FlowChatState, FlowToolItem, Session } from '../types/flow-chat';
import { getEffectiveToolName } from './toolInvocationIdentity';

export const DEEP_REVIEW_SESSION_CONCURRENCY_WARNING_THRESHOLD = 2;

export interface DeepReviewSessionConcurrencyGuard {
  activeSubagentCount: number;
  highActivity: boolean;
}

const ACTIVE_TOOL_STATUSES = new Set<FlowToolItem['status']>([
  'pending',
  'preparing',
  'running',
  'streaming',
  'receiving',
  'analyzing',
]);

function isActiveSubagentTask(item: unknown): item is FlowToolItem {
  if (!item || typeof item !== 'object') {
    return false;
  }
  const toolItem = item as FlowToolItem;
  if (
    toolItem.type !== 'tool' ||
    !['Task', 'AgentSpawn', 'LaunchReviewAgent'].includes(getEffectiveToolName(toolItem)) ||
    !ACTIVE_TOOL_STATUSES.has(toolItem.status)
  ) {
    return false;
  }

  const input = toolItem.toolCall?.input ?? {};
  const subagentType = input.subagent_type ?? input.subagentType ?? input.agent_type ?? input.agentType;
  return typeof subagentType === 'string' && subagentType.trim().length > 0;
}

function countActiveSubagentTasks(session?: Session): number {
  if (!session) {
    return 0;
  }

  let count = 0;
  for (const turn of session.dialogTurns ?? []) {
    for (const round of turn.modelRounds ?? []) {
      for (const item of round.items ?? []) {
        if (isActiveSubagentTask(item)) {
          count += 1;
        }
      }
    }
  }
  return count;
}

export function deriveDeepReviewSessionConcurrencyGuard(
  state: FlowChatState,
  parentSessionId?: string | null,
): DeepReviewSessionConcurrencyGuard {
  const activeSubagentCount = countActiveSubagentTasks(
    parentSessionId ? state.sessions.get(parentSessionId) : undefined,
  );

  return {
    activeSubagentCount,
    highActivity: activeSubagentCount >= DEEP_REVIEW_SESSION_CONCURRENCY_WARNING_THRESHOLD,
  };
}
