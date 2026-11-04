import { FlowChatStore } from '@/flow_chat/store/FlowChatStore';
import { openBtwSessionInAuxPane } from '@/flow_chat/services/btwSessionPane';
import { openMainSession } from '@/flow_chat/services/sessionActivation';
import { prewarmRelaySessionHistory } from '@/flow_chat/services/RelaySessionHistory';
import { resolveSessionRelationship } from '@/flow_chat/utils/sessionMetadata';
import { resolveSessionSceneWorkspace } from './sessionSceneTarget';
import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import { getActiveSurfaceId, getActiveSurfaceScope, isLocalSurface } from '@/infrastructure/peer-device/deviceSurface';
import { resolveDeviceName } from '@/infrastructure/account/deviceDirectory';
import { beginDeviceOpen, endDeviceOpen } from '@/infrastructure/peer-device/deviceOpenIntent';
import { clearHistorySessionOpenTransition, dispatchHistorySessionOpenIntent } from '@/flow_chat/services/sessionOpenIntent';
import { useSceneStore } from '../stores/sceneStore';
import { sessionSceneWorkspaceKey } from './sessionSceneTarget';

/**
 * `surfaceId` names a device this window may not be rendering (a companion
 * task from another device); that device is rendered first, exactly like
 * opening the session from its sidebar section.
 */
export async function openAgentCompanionSession(
  sessionId: string,
  surfaceId?: string,
  sourceWorkspaceId?: string,
): Promise<boolean> {
  if (surfaceId && surfaceId !== getActiveSurfaceId()) {
    // Same presentation as a sidebar open: the session's tab and loading state
    // are shown at once and held through the device switch.
    const intent = beginDeviceOpen({ surfaceId, key: `session:${sessionId}`, sessionId });
    // The host starts reading the session while the device switch runs.
    if (!isLocalSurface(surfaceId)) prewarmRelaySessionHistory(surfaceId, sessionId);
    try {
      if (sourceWorkspaceId) {
        useSceneStore.getState().holdSessionScene({
          surfaceId, workspaceKey: sessionSceneWorkspaceKey(sourceWorkspaceId), sessionId,
        });
      }
      dispatchHistorySessionOpenIntent(sessionId, undefined, 20_000);
      const { peerDeviceSurfaceController } = await import('@/infrastructure/peer-device/peerDeviceSurfaceRuntime');
      const outcome = isLocalSurface(surfaceId)
        ? await peerDeviceSurfaceController.switchToLocal('agent_companion')
        : await peerDeviceSurfaceController.switchToDevice(surfaceId, resolveDeviceName(surfaceId));
      if (outcome !== 'activated') {
        clearHistorySessionOpenTransition(sessionId);
        return false;
      }
      return await openOnRenderedSurface(sessionId, surfaceId, sourceWorkspaceId);
    } finally {
      endDeviceOpen(intent);
    }
  }
  return openOnRenderedSurface(sessionId, surfaceId, sourceWorkspaceId);
}

async function openOnRenderedSurface(
  sessionId: string,
  surfaceId?: string,
  sourceWorkspaceId?: string,
): Promise<boolean> {
  const flowChatStore = FlowChatStore.getInstance();
  if (surfaceId && sourceWorkspaceId && !flowChatStore.getState().sessions.has(sessionId)) {
    const scope = getActiveSurfaceScope();
    await flowChatStore.ensurePersistedSessionMetadata(sessionId, sourceWorkspaceId);
    scope.assertCurrent('open companion session on its device');
  }
  const session = flowChatStore.getState().sessions.get(sessionId);
  if (!session) {
    return false;
  }

  const relationship = resolveSessionRelationship(session);
  const parentSessionId = relationship.parentSessionId;

  // Activate the workspace the session is listed under when it differs from the
  // current one, mirroring the sidebar handleSwitch path so the chat-input
  // workspace folder stays consistent after opening from the pet bubble.
  const workspace = resolveSessionSceneWorkspace(
    session,
    workspaceManager.getState().openedWorkspaces.values(),
  );
  const currentWorkspaceId = workspaceManager.getState().activeWorkspaceId;
  const workspaceId = workspace?.id;
  const activateWorkspace =
    workspaceId && workspaceId !== currentWorkspaceId
      ? async (targetWorkspaceId: string) => {
          await workspaceManager.setActiveWorkspace(targetWorkspaceId);
        }
      : undefined;

  if (relationship.canOpenInAuxPane && parentSessionId) {
    await openMainSession(parentSessionId, {
      workspaceId,
      activateWorkspace,
    });
    openBtwSessionInAuxPane({
      childSessionId: sessionId,
      parentSessionId,
      workspaceId: session.workspaceId ?? workspaceId,
      workspacePath: session.workspacePath,
    });
    return true;
  }

  await openMainSession(sessionId, {
    workspaceId,
    activateWorkspace,
  });

  // When the session was already active before the pet bubble was clicked,
  // activateMainSession takes an early-return path that does not call
  // switchChatSession, so `openbitfun:session-switched` is never dispatched and
  // SessionsSection's listener never clears the unread marks. Clear them
  // explicitly here so the bubble and workspace dot dismiss reliably.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      flowChatStore.clearSessionUnreadCompletion(sessionId);
      flowChatStore.clearSessionNeedsAttention(sessionId);
    });
  });

  return true;
}
