/**
 * Small helpers shared by driver implementations.
 */

import { generateTempTitle } from '../utils/titleUtils';
import type { FlowChatContext } from '../services/flow-chat-manager/types';
import type { SurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import type { DialogTurn } from '../types/flow-chat';
import { finishSubmittedMessagePreview, getSubmittedMessagePreview, registerSubmittedMessage } from '../services/submittedMessagePresentation';
import { registerSubmittedMessageScrollIntent, peekSubmittedMessageScrollIntent } from '../services/submittedMessageScrollIntent';

/** Register send feedback before the synchronous optimistic projection can render. */
export function addSubmittedDialogTurn(
  context: FlowChatContext,
  scope: SurfaceScope,
  sessionId: string,
  turn: DialogTurn,
): void {
  const session = context.flowChatStore.getState().sessions.get(sessionId);
  if (session && !session.dialogTurns.some(existing => existing.id === turn.id)) {
    registerSubmittedMessage(scope, sessionId, turn.id, turn.userMessage.id);
    if (!getSubmittedMessagePreview(sessionId, turn.id)
      && !peekSubmittedMessageScrollIntent(scope, sessionId, turn.id)) {
      registerSubmittedMessageScrollIntent(scope, sessionId, turn.id, turn.userMessage.id);
    }
  }
  context.flowChatStore.addDialogTurn(sessionId, turn);
  finishSubmittedMessagePreview(scope, sessionId, turn.id);
}

/**
 * Show a readable placeholder title immediately; the backend later confirms
 * the authoritative title via AI or local fallback generation.
 */
export function applyGeneratingTitlePlaceholder(
  context: FlowChatContext,
  sessionId: string,
  message: string,
): void {
  const tempTitle = generateTempTitle(message, 20);
  context.flowChatStore.updateSessionTitle(sessionId, tempTitle, 'generating');
}
