import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { getActiveSurfaceId, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { flowChatStore } from '../store/FlowChatStore';
import { stateMachineManager } from '../state-machine';
import { ProcessingPhase } from '../state-machine/types';
import { useConversationViewScope } from '../contexts/conversationViewScope';

export interface ActiveSessionState {
  sessionId: string | null;
  isProcessing: boolean;
  processingPhase: ProcessingPhase | null;
  error: string | null;
  status: 'active' | 'idle' | 'error';
}

/** Explicit view selection takes precedence over the main scene selection. */
export const useActiveSessionState = (): ActiveSessionState => {
  const scope = useConversationViewScope();
  const surfaceId = scope?.surfaceId;
  const sessionId = scope?.sessionId;
  const getSnapshot = useMemo(() => {
    let previous: ActiveSessionState | undefined;
    return () => {
      const state = flowChatStore.getState();
      const session = sessionId !== undefined && surfaceId !== undefined
        ? (surfaceId === getActiveSurfaceId() ? state.sessions.get(sessionId) : undefined)
        : state.sessions.get(state.activeSessionId ?? '');
      const machine = session ? stateMachineManager.get(session.sessionId) : undefined;
      const next: ActiveSessionState = {
        sessionId: session?.sessionId ?? null,
        isProcessing: machine?.getCurrentState() === 'processing',
        processingPhase: machine?.getContext().processingPhase ?? null,
        error: session?.error ?? null,
        status: session?.status ?? 'idle',
      };
      if (!previous || Object.keys(next).some(key => next[key as keyof ActiveSessionState] !== previous![key as keyof ActiveSessionState])) previous = next;
      return previous;
    };
  }, [surfaceId, sessionId]);
  const subscribe = useCallback((notify: () => void) => {
    const stopStore = flowChatStore.subscribe(notify);
    const stopMachine = stateMachineManager.subscribeGlobal(notify);
    const stopSurface = onSurfaceActivated(notify);
    return () => { stopStore(); stopMachine(); stopSurface(); };
  }, []);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};
