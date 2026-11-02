import { useEffect } from 'react';
import { api } from '@/infrastructure/api/service-api/ApiClient';
import { miniAppPresentationAPI, hasLocalMiniAppPresentation, type MiniAppInstanceSnapshot } from '@/infrastructure/api/service-api/MiniAppPresentationAPI';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { useSceneStore } from '@/app/stores/sceneStore';
import { useMiniAppPresentationStore } from './miniAppPresentationStore';
import { createLogger } from '@/shared/utils/logger';
import { isMiniAppClosing } from './miniAppLifecycle';

const log = createLogger('MiniAppPresence');

/** Exactly one observer in the main window; independently launched shells never mount it. */
export function MiniAppPresence() {
  useEffect(() => {
    let disposed = false;
    let refreshing = false;
    const apply = (snapshot: MiniAppInstanceSnapshot) => {
      if (disposed || !hasLocalMiniAppPresentation() || snapshot.protocolVersion !== 1) return;
      const store = useMiniAppPresentationStore.getState();
      if (store.snapshot?.hostEpoch === snapshot.hostEpoch && store.snapshot.revision > snapshot.revision) return;
      store.apply(snapshot);
      const tabs = useMiniAppPresentationStore.getState().tabs;
      for (const instance of snapshot.instances) {
        const tab = instance.pendingView?.kind === 'tab' ? instance.pendingView
          : instance.primaryView?.kind === 'tab' ? instance.primaryView : null;
        if (tab && !tabs[instance.appId] && !isMiniAppClosing(instance.appId)) {
          store.bind({ instance, view: tab });
          useSceneStore.getState().openScene(`miniapp:${instance.appId}`);
        }
      }
      for (const [appId, ticket] of Object.entries(tabs)) {
        const instance = snapshot.instances.find(item => item.instanceId === ticket.instance.instanceId);
        if (store.snapshot?.hostEpoch === snapshot.hostEpoch && !instance) {
          void useSceneStore.getState().closeScene(`miniapp:${appId}`);
          continue;
        }
        // Retain the ticket until closeScene commits. Releasing it here makes
        // the still-mounted scene request a new tab while its close is in flight.
        if (instance && instance.primaryView?.viewId !== ticket.view.viewId && instance.pendingView?.viewId !== ticket.view.viewId) {
          void useSceneStore.getState().closeScene(`miniapp:${appId}`);
        }
      }
    };
    const refresh = async () => {
      if (disposed || refreshing || !hasLocalMiniAppPresentation()) return;
      refreshing = true;
      const scope = getActiveSurfaceScope();
      try {
        // Heartbeats are owned here, not by mounting or focusing a scene.
        for (const ticket of Object.values(useMiniAppPresentationStore.getState().tabs)) {
          await miniAppPresentationAPI.heartbeat(ticket).catch(() => undefined);
        }
        const snapshot = await miniAppPresentationAPI.snapshot();
        if (scope.isCurrent()) apply(snapshot);
      } catch (error) { log.debug('MiniApp presence unavailable', { error }); }
      finally { refreshing = false; }
    };
    const unlisten = api.listen<MiniAppInstanceSnapshot>('miniapp-instances-changed', apply);
    const unsubscribe = onSurfaceActivated(() => {
      void refresh();
    });
    void refresh();
    // Full revisioned snapshots heal subscription races, process restarts and missed events.
    const timer = setInterval(() => void refresh(), 5000);
    return () => { disposed = true; clearInterval(timer); unlisten(); unsubscribe(); };
  }, []);
  return null;
}
