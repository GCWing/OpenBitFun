import { useCallback, useLayoutEffect, useState, type PropsWithChildren } from 'react';
import { getActiveSurfaceId, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { createConversationContextStore, ConversationContextStoreContext } from '@/shared/stores/contextStore';
import { flowChatStore } from '../store/FlowChatStore';
import { createModernFlowChatStore, ModernFlowChatStoreContext } from '../store/modernFlowChatStore';
import { createChatInputStateStore, ChatInputStateStoreContext } from '../store/chatInputStateStore';
import { ConversationViewScopeContext, type ConversationViewScope } from './conversationViewScope';

/** View-local projections and geometry; all sessions and execution remain shared. */
export function ConversationViewProvider({ scope, children }: PropsWithChildren<{ scope: ConversationViewScope }>) {
  const selectSession = useCallback(() => getActiveSurfaceId() === scope.surfaceId
    ? flowChatStore.getState().sessions.get(scope.sessionId) ?? null : null, [scope.surfaceId, scope.sessionId]);
  const [projection] = useState(() => createModernFlowChatStore(selectSession()));
  const [contexts] = useState(createConversationContextStore);
  const [geometry] = useState(createChatInputStateStore);

  useLayoutEffect(() => {
    const sync = () => {
      const session = selectSession();
      if (projection.getState().activeSession !== session) projection.getState().setActiveSession(session);
    };
    sync();
    const unsubscribe = flowChatStore.subscribe(sync);
    const stopSurface = onSurfaceActivated(sync);
    return () => { unsubscribe(); stopSurface(); };
  }, [selectSession, projection]);

  return <ConversationViewScopeContext.Provider value={scope}>
    <ModernFlowChatStoreContext.Provider value={projection}>
      <ConversationContextStoreContext.Provider value={contexts}>
        <ChatInputStateStoreContext.Provider value={geometry}>{children}</ChatInputStateStoreContext.Provider>
      </ConversationContextStoreContext.Provider>
    </ModernFlowChatStoreContext.Provider>
  </ConversationViewScopeContext.Provider>;
}
