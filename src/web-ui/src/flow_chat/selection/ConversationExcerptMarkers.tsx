import { useConversationExcerptMarkers } from './useConversationExcerptMarkers';

export function ConversationExcerptMarkers({ wrapper, turnId }: { wrapper: HTMLElement | null; turnId: string }) {
  return useConversationExcerptMarkers(wrapper, turnId);
}
