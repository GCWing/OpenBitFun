/**
 * Shared FlowChat session summary for the floating chat surfaces.
 *
 * Both the floating window mode header and the floating chat bubble header need
 * the same three things — the active session's title, the recent session list,
 * and the active session itself to derive stream state from. Agentic MiniApps
 * may additionally track their bound hidden session after the normal active
 * session is restored. Keeping both lookups in one hook means one store
 * subscription per surface and one definition of "recent sessions" instead of
 * two copies drifting apart.
 */

import { useEffect, useMemo, useState } from 'react';
import { flowChatStore } from '../../store/FlowChatStore';
import type { FlowChatState, Session } from '../../types/flow-chat';
import { compareSessionsForDisplay } from '../../utils/sessionOrdering';
import { resolveSessionTitle } from '../../utils/sessionTitle';
import { i18nService } from '@/infrastructure/i18n';

/** How many recent sessions the session menu offers. */
export const RECENT_SESSION_LIMIT = 10;

export interface FlowChatSessionsSnapshot {
  activeSessionId: string | null;
  activeSession: Session | undefined;
  /** Optional session a host surface owns even while another session is active. */
  trackedSession: Session | undefined;
  sessionTitle: string;
  sessions: Session[];
}

export function resolveDisplayTitle(session: Session | undefined): string {
  return resolveSessionTitle(session, (key, options) => i18nService.t(key, options));
}

export function useFlowChatSessions(
  trackedSessionId?: string | null,
): FlowChatSessionsSnapshot {
  const [state, setState] = useState<FlowChatState>(() => flowChatStore.getState());

  useEffect(() => {
    const unsubscribe = flowChatStore.subscribe(setState);
    return () => unsubscribe();
  }, []);

  const activeSessionId = state.activeSessionId ?? null;
  const activeSession = useMemo(
    () => (activeSessionId ? state.sessions.get(activeSessionId) : undefined),
    [state, activeSessionId]
  );
  const trackedSession = useMemo(
    () => (trackedSessionId ? state.sessions.get(trackedSessionId) : undefined),
    [state, trackedSessionId],
  );

  const sessionTitle = resolveDisplayTitle(activeSession);

  const sessions = useMemo(
    () =>
      Array.from(state.sessions.values())
        .sort(compareSessionsForDisplay)
        .slice(0, RECENT_SESSION_LIMIT),
    [state]
  );

  return {
    activeSessionId,
    activeSession,
    trackedSession,
    sessionTitle,
    sessions,
  };
}
