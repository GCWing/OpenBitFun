import type { SessionConversationCapability } from '../session-drivers/conversationCapability';

export type ChatInputTarget = 'main' | 'btw';

export interface ComposerTargetCandidate {
  sessionId: string;
  role: ChatInputTarget;
  conversation: SessionConversationCapability;
  /** The view may be a read-only slice of an otherwise conversational Session. */
  readOnly?: boolean;
}

export interface ComposerTargetSelection {
  surfaceId: string;
  parentSessionId: string | null;
  sessionId: string;
}

export function resolveComposerTargets(params: {
  surfaceId: string;
  currentSessionId: string | null;
  requested: ComposerTargetSelection | null;
  candidates: readonly ComposerTargetCandidate[];
}) {
  const targets = params.candidates.filter(target =>
    !target.readOnly && target.conversation.access === 'available');
  const requestedId = params.requested?.surfaceId === params.surfaceId
    && params.requested.parentSessionId === params.currentSessionId
    ? params.requested.sessionId : undefined;
  // A removed child returns only to its parent, never to a newly opened sibling.
  const selected = targets.find(target => target.sessionId === requestedId)
    ?? targets.find(target => target.sessionId === params.currentSessionId);
  return {
    targets,
    selected,
    // A read-only main view still owns its draft and stop controls. It must not
    // be mistaken for the empty composer that creates a new session.
    effectiveSessionId: selected?.sessionId ?? params.currentSessionId,
    showSwitcher: targets.length > 1,
    canCompose: selected !== undefined || params.currentSessionId === null,
    canSubmit: selected?.conversation.canSubmit ?? params.currentSessionId === null,
  };
}
