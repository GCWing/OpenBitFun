import { useCallback, useEffect, useSyncExternalStore, type Dispatch } from 'react';

import { createLogger } from '@/shared/utils/logger';
import type { ModeAction } from '../reducers/modeReducer';
import { flowChatStore } from '../store/FlowChatStore';
import { acpAgentTypeFromSession } from '../utils/acpSession';
import { resolveAvailableChatInputMode } from '../utils/chatInputMode';

const log = createLogger('ChatInput');
const subscribe = (notify: () => void) => flowChatStore.subscribe(notify);

/** Read the selected Session directly; the composer's broader snapshot may lag a switch. */
export function useChatInputModeSync({
  sessionId,
  currentMode,
  isAssistantWorkspace,
  userDefaultModeId,
  availableModeIds,
  dispatchMode,
}: {
  sessionId: string | null;
  currentMode: string;
  isAssistantWorkspace: boolean;
  userDefaultModeId: string | null;
  availableModeIds: ReadonlySet<string>;
  dispatchMode: Dispatch<ModeAction>;
}): void {
  const getSnapshot = useCallback(() => {
    const session = sessionId ? flowChatStore.getState().sessions.get(sessionId) : undefined;
    return acpAgentTypeFromSession(session) || session?.mode || session?.config.agentType;
  }, [sessionId]);
  const sessionMode = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    // A selected Session without a loaded binding is not a new-session composer.
    if (sessionId && !sessionMode) return;

    const nextMode = sessionMode === 'OpenBitFun' ? 'OpenBitFun' : resolveAvailableChatInputMode({
      currentMode,
      isAssistantWorkspace,
      sessionMode,
      userDefaultModeId,
      availableModeIds,
    });
    if (!nextMode || nextMode === currentMode) return;

    log.debug('Syncing mode with workspace, session, and available modes', {
      sessionId,
      mode: nextMode,
      sessionMode,
      isAssistantWorkspace,
      availableModeCount: availableModeIds.size,
    });
    // Passive hydration updates presentation only. Session mutation belongs to
    // an explicit selection accepted by useSessionModeSelection.
    dispatchMode({ type: 'SET_CURRENT_MODE', payload: nextMode });
  }, [sessionId, sessionMode, currentMode, isAssistantWorkspace, userDefaultModeId, availableModeIds, dispatchMode]);
}
