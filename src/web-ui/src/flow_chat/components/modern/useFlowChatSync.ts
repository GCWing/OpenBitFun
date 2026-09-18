/**
 * FlowChat store synchronization effects.
 */

import { useEffect } from 'react';
import { useConversationViewScope } from '../../contexts/conversationViewScope';
import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import { flowChatStore } from '../../store/FlowChatStore';
import { startAutoSync } from '../../services/storeSync';

export function useFlowChatSync(): void {
  const scope = useConversationViewScope();
  useEffect(() => {
    if (scope) return;
    const unsubscribe = startAutoSync();
    return () => {
      unsubscribe();
    };
  }, [scope]);

  useEffect(() => {
    if (scope) return;
    const unlisten = agentAPI.onSessionTitleGenerated((event) => {
      flowChatStore.updateSessionTitle(
        event.sessionId,
        event.title,
        'generated',
      );
    });

    return () => {
      unlisten();
    };
  }, [scope]);
}
