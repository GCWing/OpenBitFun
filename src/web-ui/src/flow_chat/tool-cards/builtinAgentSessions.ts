import type { FlowChatState, FlowToolItem } from '../types/flow-chat';
import { findProjectedSession } from '../utils/subagentProjection';
import { projectEffectiveToolItem } from '../utils/toolInvocationIdentity';
import { runtimeToolRecord } from './runtimeToolCardModel';
import { builtinText } from './builtinToolCardModel';

/** A roster is a historical snapshot. Later alias reuse must never change its identity. */
export function resolveBuiltinAgentSessions(toolItem: FlowToolItem, sessions: FlowChatState['sessions'], parentSessionId?: string): Record<string, string> {
  const parent = parentSessionId ? sessions.get(parentSessionId) : undefined;
  const links: Record<string, string> = {};
  if (!parent) return links;
  for (const turn of parent.dialogTurns) for (const round of turn.modelRounds) for (const candidate of round.items) {
    if (candidate.id === toolItem.id) return links;
    if (candidate.type !== 'tool') continue;
    const effective = projectEffectiveToolItem(candidate);
    if (!['Task', 'AgentSpawn', 'AgentSendInput'].includes(effective.toolName)) continue;
    const input = runtimeToolRecord(effective.toolCall?.input);
    const data = runtimeToolRecord(effective.toolResult?.result);
    const agent = builtinText(data.agent_id, input.agent_id);
    if (!agent) continue;
    const session = builtinText(effective.subagentSessionId, data.session_id)
      ?? findProjectedSession({ sessions }, { parentSessionId, parentToolIds: new Set([candidate.id, candidate.toolCall.id]) })?.sessionId;
    if (session) links[agent] = session;
    else if (effective.toolName === 'AgentSpawn') delete links[agent];
  }
  // The item is outside hydrated history, so a temporal link cannot be established.
  return {};
}
