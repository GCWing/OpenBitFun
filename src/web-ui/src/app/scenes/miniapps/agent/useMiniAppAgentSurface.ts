/**
 * Mount point for the Agent-controlled MiniApp surface.
 *
 * Exactly one instance exists in the main window. It registers the window as a
 * surface listener, presents the requested app in a tab, and answers every
 * request with either a result or a typed error. It never runs on a device
 * surface that cannot present a local MiniApp, and it never pretends a request
 * succeeded when the frame is unreachable.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { hasLocalMiniAppPresentation } from '@/infrastructure/api/service-api/MiniAppPresentationAPI';
import { miniAppAgentSurfaceAPI } from '@/infrastructure/api/service-api/MiniAppAgentSurfaceAPI';
import { useSceneStore } from '@/app/stores/sceneStore';
import type { SceneTabId } from '@/app/components/SceneBar/types';
import { createLogger } from '@/shared/utils/logger';
import {
  MINIAPP_AGENT_OPEN_TIMEOUT_MS,
  handleMiniAppAgentRequest,
  type MiniAppAgentRouterDeps,
} from './miniAppAgentRouter';
import { ensureMiniAppTab, useMiniAppPresentationStore } from '../miniAppPresentationStore';
import { miniAppAgentErrorMessage, surfaceError } from './miniAppAgentProtocol';
import { releaseMiniAppAgentSurfaces } from './miniAppAgentSurfaceRegistry';

const log = createLogger('MiniAppAgentSurface');

/**
 * Present the app where the controller can read it, or fail honestly.
 *
 * A MiniApp can be reached from wherever the user opened it. A tab is already
 * readable; an app running in its own window is a separate WebView this window
 * cannot inspect, so the host transfers that live instance into a tab of the
 * window the user is watching. The Agent then drives the same instance the user
 * sees, instead of a second copy or an invisible headless one.
 */
async function presentApp(
  appId: string,
): Promise<{ instanceId?: string; presentedFrom?: 'window' | 'tab' }> {
  if (!hasLocalMiniAppPresentation()) {
    throw surfaceError(
      'SURFACE_UNAVAILABLE',
      'This device surface cannot present a MiniApp locally, so the Agent cannot control it from here.',
    );
  }
  const scope = getActiveSurfaceScope();
  const store = useMiniAppPresentationStore.getState();
  const existing = store.tabs[appId];
  const inSeparateWindow = !existing && store.snapshot?.instances.some(
    (instance) => instance.appId === appId && instance.primaryView?.kind === 'window',
  );
  if (inSeparateWindow) {
    log.debug('Transferring MiniApp window presentation into an Agent-readable tab', { appId });
  }
  const ticket = existing ?? await ensureMiniAppTab(appId);
  scope.assertCurrent('present MiniApp for Agent');
  if (ticket.view.kind !== 'tab') {
    throw surfaceError(
      'SURFACE_UNAVAILABLE',
      `The MiniApp '${appId}' is presented as a ${ticket.view.kind}, which this surface cannot read.`,
    );
  }
  useSceneStore.getState().openScene(`miniapp:${appId}` as SceneTabId);
  return {
    instanceId: ticket.instance.instanceId,
    ...(inSeparateWindow ? { presentedFrom: 'window' as const } : {}),
  };
}

export function useMiniAppAgentSurface(): void {
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  useEffect(() => () => releaseMiniAppAgentSurfaces(), []);
  const handleRequest = useCallback(async (request: unknown) => {
    const deps: MiniAppAgentRouterDeps = {
      presentApp,
      openTimeoutMs: MINIAPP_AGENT_OPEN_TIMEOUT_MS,
      signal: scope.signal,
    };
    const requestId = (request as { requestId?: unknown })?.requestId;
    if (typeof requestId !== 'string' || !requestId) return;
    try {
      if (!scope.isCurrent() || !hasLocalMiniAppPresentation()) {
        throw surfaceError('SURFACE_UNAVAILABLE', 'The local MiniApp surface is not active.');
      }
      const result = await handleMiniAppAgentRequest(request, deps);
      scope.assertCurrent('complete MiniApp Agent request');
      await miniAppAgentSurfaceAPI.reportResult({ requestId, success: true, result });
    } catch (error) {
      const message = scope.isCurrent() ? miniAppAgentErrorMessage(error)
        : surfaceError('SURFACE_UNAVAILABLE', 'The local MiniApp device surface is no longer active.').message;
      log.debug('MiniApp surface request failed', { requestId, error: message });
      await miniAppAgentSurfaceAPI
        .reportResult({ requestId, success: false, error: message })
        .catch((reportError) => log.debug('Failed to report MiniApp surface failure', { reportError }));
    }
  }, [scope]);

  useEffect(() => {
    let disposed = false;
    const ready = hasLocalMiniAppPresentation();
    // An epoch may change during a reconnect on the same device. Keep mounted
    // frames in that case; only leaving local presentation retires them.
    if (!ready) releaseMiniAppAgentSurfaces();
    const unlisten = ready ? miniAppAgentSurfaceAPI.listenRequests((request) => {
      if (disposed) return;
      void handleRequest(request);
    }) : () => undefined;
    // Only a surface that can actually present a local MiniApp may answer.
    void miniAppAgentSurfaceAPI.markReady(ready).catch((error) => {
      log.debug('MiniApp agent surface unavailable', { error });
    });
    return () => {
      disposed = true;
      unlisten();
      void miniAppAgentSurfaceAPI.markReady(false).catch(() => undefined);
    };
  }, [handleRequest]);
}
