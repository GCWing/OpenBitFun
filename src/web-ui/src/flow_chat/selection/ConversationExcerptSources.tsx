import { useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { getActiveSurfaceScope, surfaceScopedKey } from '@/infrastructure/peer-device/deviceSurface';
import { flowChatStore } from '../store/FlowChatStore';
import { sessionComposerStore } from '../store/sessionComposerStore';
import { pendingQueueManager } from '../services/flow-chat-manager/PendingQueueModule';
import { createConversationExcerptInventory, EMPTY_SOURCE_INDEX } from './conversationExcerptInventory';
import { ConversationExcerptSourceContext } from './conversationExcerptSourceContext';

const inventory = createConversationExcerptInventory();

function subscribe(notify: () => void) {
  const stopSession = flowChatStore.subscribe(notify);
  const stopDraft = sessionComposerStore.subscribe(notify);
  const stopQueue = pendingQueueManager.subscribe(notify);
  return () => { stopSession(); stopDraft(); stopQueue(); };
}
const noSubscription = () => () => undefined;

export function ConversationExcerptSourceProvider({ sessionId, active = true, children }: {
  sessionId?: string;
  active?: boolean;
  children: ReactNode;
}) {
  const scope = getActiveSurfaceScope();
  const getSnapshot = useMemo(() => () => {
    if (!active || !sessionId || !scope.isCurrent()) return EMPTY_SOURCE_INDEX;
    const sessions = flowChatStore.getState().sessions;
    const queue = [...sessions.keys()].flatMap(id => pendingQueueManager.listForSurface(scope.surfaceId, id));
    return inventory(sessionComposerStore.getState().drafts, queue)
      .get(surfaceScopedKey(scope.surfaceId, sessionId)) ?? EMPTY_SOURCE_INDEX;
  }, [active, sessionId, scope]);
  const value = useSyncExternalStore(active && sessionId ? subscribe : noSubscription, getSnapshot, () => EMPTY_SOURCE_INDEX);
  return <ConversationExcerptSourceContext.Provider value={value}>{children}</ConversationExcerptSourceContext.Provider>;
}
