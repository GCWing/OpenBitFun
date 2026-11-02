/**
 * Store choreography for marking a session's in-flight turn as cancelled.
 *
 * Leaf module shared by the local session driver and flow-chat-manager.
 */

import type { FlowChatContext } from '../services/flow-chat-manager/types';
import { settleDialogTurnToTerminalStatus } from './dialogTurnStability';

export function markCurrentTurnItemsAsCancelled(
  context: FlowChatContext,
  sessionId: string
): void {
  const state = context.flowChatStore.getState();
  const session = state.sessions.get(sessionId);
  if (!session) return;

  const lastDialogTurn = session.dialogTurns[session.dialogTurns.length - 1];
  if (!lastDialogTurn) return;

  context.flowChatStore.updateDialogTurn(sessionId, lastDialogTurn.id, turn =>
    settleDialogTurnToTerminalStatus(turn, 'cancelled', Date.now()),
  );
}
