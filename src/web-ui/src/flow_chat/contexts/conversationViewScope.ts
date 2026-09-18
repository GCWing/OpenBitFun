import { createContext, useContext } from 'react';

/** A view selects a session; it never takes ownership of the runtime selection. */
export interface ConversationSessionRef {
  surfaceId: string;
  sessionId: string;
}

export interface ConversationViewScope extends ConversationSessionRef {
  viewId: string;
  presentation: 'standard' | 'compact';
}

export const ConversationViewScopeContext = createContext<ConversationViewScope | null>(null);
export const useConversationViewScope = () => useContext(ConversationViewScopeContext);
export const ConversationTextVisibilityContext = createContext(true);
