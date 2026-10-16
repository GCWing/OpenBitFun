import { appManager } from '@/app/services/AppManager';
import { useSceneStore } from '@/app/stores/sceneStore';
import { flowChatStore } from '../store/FlowChatStore';
import { flowChatManager } from './FlowChatManager';
import { syncSessionToModernStore } from './storeSync';
import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { resolveSessionSceneWorkspace } from '@/app/services/sessionSceneTarget';
import { sessionProjectWorkspacePath } from '../utils/sessionWorkspace';
import { i18nService } from '@/infrastructure/i18n';

interface SessionActivationOptions {
  workspaceId?: string;
  activateWorkspace?: (workspaceId: string) => void | Promise<unknown>;
  isCurrent?: () => boolean;
}

let activationRequest = 0;
let workspaceActivation: Promise<unknown> = Promise.resolve();

export async function openMainSession(
  sessionId: string,
  options?: SessionActivationOptions,
): Promise<void> {
  const activated = await activateMainSession(sessionId, options);
  if (!activated) return;
  appManager.updateLayout({
    leftPanelActiveTab: 'sessions',
    leftPanelCollapsed: false,
  });

  useSceneStore.getState().openScene('session');
}

export async function activateMainSession(sessionId: string, options?: SessionActivationOptions): Promise<boolean> {
  const scope = getActiveSurfaceScope();
  const request = ++activationRequest;
  const isCurrent = () => scope.isCurrent() && request === activationRequest && (options?.isCurrent?.() ?? true);
  if (!isCurrent()) return false;
  const session = flowChatStore.getState().sessions.get(sessionId);
  const workspace = session && resolveSessionSceneWorkspace(session, workspaceManager.getState().openedWorkspaces.values());
  const workspaceId = options?.workspaceId ?? workspace?.id;
  if (session && sessionProjectWorkspacePath(session) && !workspaceId
    && workspaceManager.getState().currentWorkspace) {
    throw new Error(i18nService.t('common:sceneBar.workspaceUnavailable'));
  }
  if (workspaceId) {
    // Workspace activation mutates the host as well as the frontend. Serialize
    // it so a slow A request cannot finish after a newer B request on the host.
    const activation = workspaceActivation.then(async () => {
      if (!isCurrent() || workspaceManager.getState().activeWorkspaceId === workspaceId) return;
      await (options?.activateWorkspace ?? (id => workspaceManager.setActiveWorkspace(id)))(workspaceId);
    });
    workspaceActivation = activation.catch(() => undefined);
    await activation;
    if (!isCurrent()) return false;
  }
  const isTargetActive = () => {
    const state = flowChatStore.getState();
    return isCurrent() && state.activeSessionId === sessionId && state.sessions.has(sessionId);
  };
  const targetSession = flowChatStore.getState().sessions.get(sessionId) ?? null;
  if (!targetSession) {
    return false;
  }

  if (isTargetActive()) {
    const activeSession = flowChatStore.getState().sessions.get(sessionId) ?? null;
    if (
      activeSession?.externalHistory?.mode === 'follow' || (activeSession?.isHistorical &&
      (activeSession.historyState === 'metadata-only' || activeSession.historyState === 'failed'))
    ) {
      await flowChatManager.switchChatSession(sessionId, isCurrent);
      if (!isTargetActive()) {
        return false;
      }
    }
    syncSessionToModernStore(sessionId);
  } else {
    await flowChatManager.switchChatSession(sessionId, isCurrent);
    if (!isTargetActive()) {
      return false;
    }
    syncSessionToModernStore(sessionId);
  }

  return true;
}
