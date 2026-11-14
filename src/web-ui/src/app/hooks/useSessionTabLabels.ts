import { useMemo, useSyncExternalStore } from 'react';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import type { SceneTab } from '../components/SceneBar/types';
import { getActiveSurfaceId } from '@/infrastructure/peer-device/deviceSurface';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { resolveSessionTitle } from '@/flow_chat/utils/sessionTitle';

export interface SessionTabLabel {
  title: string;
}

function readSessionTabLabels(
  tabs: readonly SceneTab[],
  translate: (key: string, options?: Record<string, unknown>) => string,
  previous?: Record<string, SessionTabLabel>,
): Record<string, SessionTabLabel> {
  const labels: Record<string, SessionTabLabel> = {};
  const activeSurfaceId = getActiveSurfaceId();
  const activeSessions = flowChatStore.getState().sessions;
  for (const tab of tabs) {
    if (!tab.session) continue;
    // A tab held for a cross-device open names its device's session.
    const sessions = tab.session.surfaceId === activeSurfaceId
      ? activeSessions
      : flowChatStore.getSurfaceSessions(tab.session.surfaceId);
    const session = sessions.get(tab.session.sessionId);
    if (!session) continue;
    const title = resolveSessionTitle(session, translate);
    // Reuse the previous label object when nothing changed so tab rows keep identity.
    const cached = previous?.[tab.id];
    labels[tab.id] = cached?.title === title ? cached : { title };
  }
  return labels;
}

function subscribeToLabels(notify: () => void): () => void {
  // Use subscribeSelector to only trigger when the sessions Map identity changes or surface changes,
  // preventing unrelated store state changes from broadcasting to tab labels.
  const unsubscribe = flowChatStore.subscribeSelector(
    state => state.sessions,
    () => notify(),
  );
  const unsubscribeSurfaces = flowChatStore.subscribeSurfaceSessions(notify);
  return () => { unsubscribe(); unsubscribeSurfaces(); };
}

/** A synchronous resource projection with stable snapshots during streaming. */
export function useSessionTabLabels(tabs: readonly SceneTab[]): Record<string, SessionTabLabel> {
  const { t } = useI18n('flow-chat');
  const getSnapshot = useMemo(() => {
    let snapshot: Record<string, SessionTabLabel> = {};
    return () => {
      const next = readSessionTabLabels(tabs, t, snapshot);
      if (Object.keys(snapshot).length !== Object.keys(next).length
        || Object.entries(next).some(([id, label]) => snapshot[id] !== label)) {
        snapshot = next;
      }
      return snapshot;
    };
  }, [tabs, t]);
  return useSyncExternalStore(subscribeToLabels, getSnapshot, getSnapshot);
}
