import type { DialogTurn } from '../../types/flow-chat';
import type { ConversationSessionRef } from '../../contexts/conversationViewScope';
import type { VoiceConversationTranscript, VoiceTranscriptExchange } from './voiceConversationLedger';

export type ControlTranscriptTurn = { id: string; startedAt: number; turn: DialogTurn } | { id: string; startedAt: number; exchange: VoiceTranscriptExchange };

/** Keep the expanded history boundary stable while new records arrive. */
export function controlTranscriptStartIndex(
  rows: readonly ControlTranscriptTurn[],
  firstVisibleId: string | null,
  pageSize: number,
): number {
  const index = firstVisibleId === null ? -1 : rows.findIndex(row => row.id === firstVisibleId);
  return index < 0 ? Math.max(0, rows.length - pageSize) : index;
}

/** Canonical Runtime records replace live voice previews by identity, never by text. */
export function controlConversationTranscript(
  scope: ConversationSessionRef,
  turns: readonly DialogTurn[],
  live: VoiceConversationTranscript | null | undefined,
): ControlTranscriptTurn[] {
  const ids = new Set<string>();
  const result: ControlTranscriptTurn[] = turns.map(turn => {
    const voiceTaskId = turn.userMessage.metadata?.voiceTaskId;
    ids.add(turn.id);
    if (typeof voiceTaskId === 'string') ids.add(voiceTaskId);
    return { id: typeof voiceTaskId === 'string' ? voiceTaskId : turn.id, startedAt: turn.startTime, turn };
  });
  if (live?.target.surfaceId === scope.surfaceId && live.target.sessionId === scope.sessionId) {
    for (const exchange of live.exchanges) {
      if (!ids.has(exchange.id) && (exchange.user || exchange.assistant)) {
        ids.add(exchange.id);
        result.push({ id: exchange.id, startedAt: exchange.startedAt, exchange });
      }
    }
  }
  return result.sort((a, b) => a.startedAt - b.startedAt);
}
