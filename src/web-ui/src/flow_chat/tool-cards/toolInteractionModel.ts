import type { FlowChatState, FlowToolItem, Session } from '../types/flow-chat';
import { findProjectedSession } from '../utils/subagentProjection';
import { projectEffectiveToolItem } from '../utils/toolInvocationIdentity';

export interface ToolSessionContext {
  sessions: FlowChatState['sessions'];
  parentSessionId?: string;
}

/** History and remote transports can carry either JSON text or a decoded record. */
export function readToolRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { return readToolRecord(JSON.parse(value)); } catch { return {}; }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function toolString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** A completed tool call says nothing about the target's later runtime lifecycle. */
export function interactionOutcome(status: FlowToolItem['status'], t: (key: string) => string, completed: string, active: string): string {
  switch (status) {
    case 'completed': case 'confirmed': return completed;
    case 'error': return t('toolCards.default.failed');
    case 'cancelled': return t('toolCards.default.cancelled');
    case 'rejected': return t('toolCards.default.rejected');
    case 'pending_confirmation': return t('toolCards.default.waitingConfirm');
    case 'queued': return t('toolCards.default.queued');
    default: return active;
  }
}

export function readInteractionInput(item: FlowToolItem): Record<string, unknown> {
  const input = readToolRecord(item.toolCall?.input);
  const partial = readToolRecord(item.partialParams);
  const params = partial.tool_name === item.toolName ? readToolRecord(partial.args) : partial;
  return item.isParamsStreaming ? { ...input, ...params }
    : Object.keys(input).length ? input : params;
}

/** Agent IDs are not session IDs. Only follow explicit links from recorded calls. */
export function resolveInteractionAgentSessionId(
  item: FlowToolItem,
  parent?: Pick<Session, 'dialogTurns'>,
  context?: ToolSessionContext,
): string {
  const input = readInteractionInput(item);
  const result = readToolRecord(item.toolResult?.result);
  const direct = toolString(item.subagentSessionId) || toolString(result.session_id ?? result.sessionId)
    || toolString(input.session_id ?? input.sessionId);
  if (direct) return direct;
  const projected = context && findProjectedSession(context, {
    parentSessionId: context.parentSessionId,
    parentToolIds: new Set([item.id, item.toolCall?.id].filter((id): id is string => Boolean(id))),
  });
  if (projected) return projected.sessionId;
  // A new launch cannot borrow a former session merely by reusing its alias.
  if (projectEffectiveToolItem(item).toolName === 'AgentSpawn') return '';
  const agentId = toolString(input.agent_id ?? input.agentId) || toolString(result.agent_id ?? result.agentId);
  if (!agentId || !parent) return '';

  let linkedSessionId = '';
  for (const turn of parent.dialogTurns) {
    for (const round of turn.modelRounds) {
      for (const candidate of round.items) {
        // A later relaunch with the same alias must not rewrite a historical send.
        if (candidate.id === item.id) return linkedSessionId;
        if (candidate.type !== 'tool') continue;
        const effective = projectEffectiveToolItem(candidate);
        if (!['Task', 'AgentSpawn', 'AgentSendInput'].includes(effective.toolName)) continue;
        const data = readToolRecord(effective.toolResult?.result);
        const params = readInteractionInput(effective);
        if ((toolString(data.agent_id ?? data.agentId) || toolString(params.agent_id ?? params.agentId)) !== agentId) continue;
        const linked = toolString(effective.subagentSessionId) || toolString(data.session_id ?? data.sessionId)
          || (context && findProjectedSession(context, {
            parentSessionId: context.parentSessionId,
            parentToolIds: new Set([candidate.id, candidate.toolCall?.id].filter((id): id is string => Boolean(id))),
          })?.sessionId);
        if (linked || effective.toolName === 'AgentSpawn') linkedSessionId = linked || '';
      }
    }
  }
  return linkedSessionId;
}
