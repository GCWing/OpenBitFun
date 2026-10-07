import type { Session } from '../types/flow-chat';
import { readInteractionInput, readToolRecord, resolveInteractionAgentSessionId, toolString, type ToolSessionContext } from './toolInteractionModel';
import { projectEffectiveToolItem } from '../utils/toolInvocationIdentity';

export interface AgentWaitAvatarTarget {
  /** The background run stays stable while its child relationship hydrates. */
  id: string;
  sessionId?: string;
  parentToolCallId?: string;
}

function taskIds(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map(toolString).filter(Boolean))];
}

/** Preserve unresolved targets for hatch artwork; only explicit links enable navigation. */
export function resolveAgentWaitAvatarTargets(
  waitInput: unknown,
  waitResult: unknown,
  parentSession: Pick<Session, 'dialogTurns'> | undefined,
  context?: ToolSessionContext,
): AgentWaitAvatarTarget[] {
  const input = readToolRecord(waitInput);
  const result = readToolRecord(waitResult);
  const outcomes = new Map((Array.isArray(result.results) ? result.results : []).map(value => {
    const outcome = readToolRecord(value);
    return [toolString(outcome.bg_task_id), outcome] as const;
  }));
  const requestedIds = taskIds(input?.bg_task_ids ?? input?.background_task_ids);
  if (requestedIds.length === 0) {
    requestedIds.push(...taskIds(result?.pending_bg_task_ids));
    if (Array.isArray(result?.results)) {
      for (const outcome of result.results) {
        const id = toolString(readToolRecord(outcome).bg_task_id);
        if (id && !requestedIds.includes(id)) requestedIds.push(id);
      }
    }
  }
  if (requestedIds.length === 0) return [];

  const requested = new Set(requestedIds);
  const targetsByTaskId = new Map<string, AgentWaitAvatarTarget & { agentId: string }>();
  const turns = parentSession?.dialogTurns ?? [];
  for (let turnIndex = turns.length - 1; turnIndex >= 0 && targetsByTaskId.size < requested.size; turnIndex--) {
    const turn = turns[turnIndex];
    for (let roundIndex = turn.modelRounds.length - 1; roundIndex >= 0 && targetsByTaskId.size < requested.size; roundIndex--) {
      const round = turn.modelRounds[roundIndex];
      for (let itemIndex = round.items.length - 1; itemIndex >= 0 && targetsByTaskId.size < requested.size; itemIndex--) {
        const candidate = round.items[itemIndex];
        if (candidate.type !== 'tool') continue;
        const item = projectEffectiveToolItem(candidate);
        const data = readToolRecord(item.toolResult?.result);
        const bgTaskId = toolString(data.bg_task_id);
        if (!requested.has(bgTaskId) || targetsByTaskId.has(bgTaskId)) continue;
        const subagentSessionId = resolveInteractionAgentSessionId(item, parentSession, context);
        targetsByTaskId.set(bgTaskId, {
          id: bgTaskId,
          agentId: toolString(data.agent_id) || toolString(readInteractionInput(item).agent_id),
          sessionId: subagentSessionId || undefined,
          parentToolCallId: context?.sessions.get(subagentSessionId)?.parentToolCallId || item.toolCall?.id || item.id,
        });
      }
    }
  }

  const seenIdentities = new Set<string>();
  return requestedIds.flatMap(id => {
    const target = targetsByTaskId.get(id);
    const agentId = target?.agentId || toolString(outcomes.get(id)?.agent_id);
    const identityKey = target?.sessionId ? `session:${target.sessionId}` : agentId ? `agent:${agentId}` : `task:${id}`;
    if (seenIdentities.has(identityKey)) return [];
    seenIdentities.add(identityKey);
    return [{ id, sessionId: target?.sessionId, parentToolCallId: target?.parentToolCallId }];
  });
}
