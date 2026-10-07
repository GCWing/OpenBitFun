import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { startAutoSync } from '@/flow_chat/services/storeSync';
import { workspaceManager, type WorkspaceEvent } from '@/infrastructure/services/business/workspaceManager';
import { getActiveSurfaceId, isSurfaceChangedError } from '@/infrastructure/peer-device/deviceSurface';
import { createLogger } from '@/shared/utils/logger';
import { registerSessionSceneNavigation, useSceneStore } from '../stores/sceneStore';
import { isSessionSceneId, type SessionSceneTarget } from '../components/SceneBar/types';
import { startSessionPaneLayoutSync } from '../scenes/session/sessionPaneLayoutSync';
import { resolveSessionSceneTarget, resolveSessionSceneWorkspace } from './sessionSceneTarget';

const log = createLogger('SessionSceneLifecycle');

/**
 * Tabs own one resource reference per workspace; FlowChat owns all sessions.
 * The shell coordinates navigation with the one active-session presentation.
 */
export function startSessionSceneLifecycle(): () => void {
  const stopProjectionSync = startAutoSync();
  const stopPaneLayoutSync = startSessionPaneLayoutSync();
  const current = () => {
    const session = flowChatStore.getActiveSession();
    return session ? resolveSessionSceneTarget(
      session, workspaceManager.getState().openedWorkspaces.values(), getActiveSurfaceId(),
    ) : null;
  };
  const stopNavigation = registerSessionSceneNavigation({
    current,
    isActive: target => {
      if (target.surfaceId !== getActiveSurfaceId() || current()?.sessionId !== target.sessionId) return false;
      const session = flowChatStore.getActiveSession()!;
      const state = workspaceManager.getState();
      // A session is active when the workspace it is listed under is active, and
      // that is the same owning row its tab key and the navigation list use. A
      // worktree session therefore counts as active in its project; comparing its
      // execution worktree instead would leave the scene permanently inactive and
      // re-activate it on every change, which cancels the selection the user made.
      const workspace = resolveSessionSceneWorkspace(session, state.openedWorkspaces.values());
      return workspace ? workspace.id === state.activeWorkspaceId : !state.currentWorkspace;
    },
    activate: async (target, isCurrent) => {
      if (target.surfaceId !== getActiveSurfaceId() || !isCurrent()) return false;
      try {
        const { activateMainSession } = await import('@/flow_chat/services/sessionActivation');
        if (!isCurrent()) return false;
        return await activateMainSession(target.sessionId, { isCurrent });
      } catch (error) {
        if (isCurrent() && !isSurfaceChangedError(error)) {
          log.error('Failed to activate session tab', { sessionId: target.sessionId, error });
          const { notificationService } = await import('@/shared/notification-system');
          if (isCurrent()) notificationService.error(error instanceof Error ? error.message : String(error));
        }
        return false;
      }
    },
  });

  let previousSelection = current();
  let previousSurface = getActiveSurfaceId();
  let previousWorkspaces = new Map(workspaceManager.getState().openedWorkspaces);
  let reconciling = false;
  const reconcile = (event?: WorkspaceEvent) => {
    if (reconciling) return;
    reconciling = true;
    try {
      const surfaceId = getActiveSurfaceId();
      if (surfaceId !== previousSurface) {
        previousSurface = surfaceId;
        previousSelection = current();
        previousWorkspaces = new Map(workspaceManager.getState().openedWorkspaces);
        useSceneStore.getState().resetForPeerSwitch(true);
      }
      const closedWorkspace = event?.type === 'workspace:closed' || event?.type === 'workspace:removed'
        ? previousWorkspaces.get(event.workspaceId) : undefined;
      if (event) previousWorkspaces = new Map(workspaceManager.getState().openedWorkspaces);
      const selected = current();
      // Identity enrichment (or a closed workspace falling back to a path) is
      // reconciled below. It is not a request to activate the session again.
      const selectionChanged = selected?.sessionId !== previousSelection?.sessionId;
      previousSelection = selected;
      const scenes = useSceneStore.getState();
      // The pending navigation owns the upcoming selection. Bootstrap/hydrate
      // notifications cannot replace its destination or steal its focus.
      if (selectionChanged && selected && !scenes.pendingTabId) {
        if (isSessionSceneId(scenes.activeTabId)) {
          scenes.openSessionScene(selected);
        } else {
          scenes.updateSessionScene(selected);
        }
      }
      const source = flowChatStore.getState();
      const targets = new Map<string, SessionSceneTarget>();
      for (const tab of useSceneStore.getState().openTabs) {
        const session = tab.session?.surfaceId === surfaceId
          ? source.sessions.get(tab.session.sessionId) : undefined;
        // Retire only explicitly closed workspace tabs. Cached sessions remain
        // recoverable, and an offline remote workspace is not a close event.
        if (session && closedWorkspace && resolveSessionSceneWorkspace(session, [closedWorkspace])) continue;
        if (session) targets.set(session.sessionId, scenes.pendingTabId && tab.session
          // Keep the transaction's identity until it commits. Metadata may
          // acquire a workspace id while activation is awaiting the host.
          ? tab.session
          : resolveSessionSceneTarget(
            session, workspaceManager.getState().openedWorkspaces.values(), surfaceId,
          ));
      }
      useSceneStore.getState().reconcileSessionScenes(targets);
    } finally {
      reconciling = false;
    }
  };

  const unsubscribeSessions = flowChatStore.subscribe(() => reconcile());
  const unsubscribeScenes = useSceneStore.subscribe(() => reconcile());
  const unsubscribeWorkspaces = workspaceManager.addEventListener(reconcile);
  reconcile();

  return () => {
    unsubscribeSessions();
    unsubscribeScenes();
    unsubscribeWorkspaces();
    stopNavigation();
    stopPaneLayoutSync();
    stopProjectionSync();
  };
}
