/**
 * Open catalog entries of a device the window is not rendering.
 *
 * The catalog is read-only. Acting on an entry first renders its device through
 * the Peer Device Mode surface switch, then runs the exact local handler on the
 * now-rendered surface, so ownership, capability gates, permission prompts and
 * surface fences are the ones remote control already uses.
 */

import { getActiveSurfaceId, getActiveSurfaceScope, isSurfaceChangedError } from '@/infrastructure/peer-device/deviceSurface';
import { i18nService } from '@/infrastructure/i18n';
import { clearHistorySessionOpenTransition, dispatchHistorySessionOpenIntent } from '@/flow_chat/services/sessionOpenIntent';
import type { SessionMetadata } from '@/shared/types/session-history';
import { createLogger } from '@/shared/utils/logger';
import type { PeerDeviceContextValue } from '@/infrastructure/peer-device/peerDeviceContextState';
import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { flowChatManager } from '@/flow_chat/services/FlowChatManager';
import { openMainSession } from '@/flow_chat/services/sessionActivation';
import { findReusableEmptySessionId, flowChatSessionConfigForWorkspace } from '@/app/utils/projectSessionWorkspace';
import { WorkspaceKind, type WorkspaceInfo } from '@/shared/types';
import { openLatestAssistantSession } from '../workspaces/openLatestAssistantSession';
import { useSceneStore } from '@/app/stores/sceneStore';
import { projectResourceSceneId } from '@/app/scenes/project-resources/projectResourceTarget';
import {
  requestWorkspaceAction,
  usePendingWorkspaceAction,
  type PendingWorkspaceActionKind,
} from '../workspaces/pendingWorkspaceAction';
import { sessionSceneWorkspaceKey } from '@/app/services/sessionSceneTarget';
import type { SidebarDeviceSlot } from './useSidebarDevices';

const log = createLogger('OpenOnDevice');

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export type DeviceActivationResult = 'activated' | 'superseded';

/**
 * Render `slot`'s device. Returns `superseded` when a newer switch won.
 *
 * The device's sessions are already in its container (seeded from the device
 * catalog), so nothing is read here beyond the switch itself. Seeds are
 * promoted through the normal metadata path before anything opens them.
 */
export async function activateDeviceSlot(
  peer: PeerDeviceContextValue | null,
  slot: Pick<SidebarDeviceSlot, 'surfaceId' | 'deviceId' | 'isLocal' | 'name'>,
): Promise<DeviceActivationResult> {
  if (getActiveSurfaceId() === slot.surfaceId) return 'activated';
  if (!peer) throw new Error('Peer Device Mode is unavailable in this window');
  if (!slot.isLocal && !slot.deviceId) throw new Error('Device id is unavailable');
  const startedAt = now();
  const outcome = slot.isLocal
    ? await peer.switchToLocal('sidebar')
    : await peer.switchToDevice(slot.deviceId!, slot.name);
  log.info('Device surface rendered for open', { surfaceId: slot.surfaceId, outcome, switchMs: Math.round(now() - startedAt) });
  if (outcome === 'activated') {
    const promoteStartedAt = now();
    try {
      await flowChatStore.promoteSeededSessions();
    } catch (error) {
      if (isSurfaceChangedError(error)) throw error;
      log.warn('Failed to promote seeded sessions', { surfaceId: slot.surfaceId, error });
    }
    log.info('Seeded sessions promoted', { surfaceId: slot.surfaceId, promoteMs: Math.round(now() - promoteStartedAt) });
  }
  return outcome;
}

/** The live record of a workspace on the rendered surface. */
function liveWorkspace(workspaceId: string): WorkspaceInfo {
  const workspace = workspaceManager.getState().openedWorkspaces.get(workspaceId);
  if (!workspace) throw new Error(`Workspace is unavailable on this device: ${workspaceId}`);
  return workspace;
}

const activateWorkspace = (workspaceId: string) => workspaceManager.setActiveWorkspace(workspaceId);

/** A cross-device open shows the main-area session overlay for this long at most. */
const CROSS_DEVICE_OPEN_OVERLAY_MS = 20_000;

export async function openDeviceSession(
  peer: PeerDeviceContextValue | null,
  slot: SidebarDeviceSlot,
  workspaceId: string,
  session: Pick<SessionMetadata, 'sessionId'> & Partial<SessionMetadata>,
  title?: string,
): Promise<void> {
  const sessionId = session.sessionId;
  const startedAt = now();
  // From the click on, the main area shows this session's tab and its loading
  // presentation; the tab is held through the switch until the open settles.
  if (getActiveSurfaceId() !== slot.surfaceId) {
    useSceneStore.getState().holdSessionScene({
      surfaceId: slot.surfaceId, workspaceKey: sessionSceneWorkspaceKey(workspaceId), sessionId,
    });
    dispatchHistorySessionOpenIntent(sessionId, title, CROSS_DEVICE_OPEN_OVERLAY_MS);
  }
  if (await activateDeviceSlot(peer, slot) !== 'activated') {
    clearHistorySessionOpenTransition(sessionId);
    return;
  }
  const scope = getActiveSurfaceScope();
  if (!flowChatStore.getState().sessions.has(sessionId) && session.createdAt !== undefined) {
    // Not seeded yet (opened before the catalog read finished): the row's own
    // record is the host's, so no second read is needed.
    await flowChatStore.adoptHostSessionMetadata(workspaceId, [session as SessionMetadata]);
    scope.assertCurrent('adopt device catalog session');
  }
  if (!flowChatStore.getState().sessions.has(sessionId)) {
    clearHistorySessionOpenTransition(sessionId);
    throw new Error(i18nService.t('common:nav.devices.sessionUnavailable'));
  }
  dispatchHistorySessionOpenIntent(sessionId, title, CROSS_DEVICE_OPEN_OVERLAY_MS);
  flowChatStore.clearSessionUnreadCompletion(sessionId);
  await openMainSession(sessionId, { workspaceId, activateWorkspace, isCurrent: scope.isCurrent });
  log.info('Cross-device session opened', { surfaceId: slot.surfaceId, sessionId, totalMs: Math.round(now() - startedAt) });
}

export async function openDeviceAssistant(
  peer: PeerDeviceContextValue | null,
  slot: SidebarDeviceSlot,
  workspaceId: string,
  onDefaultUnavailable?: () => void,
): Promise<void> {
  if (await activateDeviceSlot(peer, slot) !== 'activated') return;
  await openLatestAssistantSession(liveWorkspace(workspaceId), activateWorkspace, onDefaultUnavailable);
}

/** Render the device, then let its live row run the action (menu, history). */
export async function openDeviceWorkspaceAction(
  peer: PeerDeviceContextValue | null,
  slot: SidebarDeviceSlot,
  workspaceId: string,
  kind: PendingWorkspaceActionKind,
): Promise<void> {
  requestWorkspaceAction({ surfaceId: slot.surfaceId, workspaceId, kind });
  if (await activateDeviceSlot(peer, slot) !== 'activated') usePendingWorkspaceAction.setState({ action: null });
}

export async function openDeviceProjectResources(
  peer: PeerDeviceContextValue | null,
  slot: SidebarDeviceSlot,
  workspaceId: string,
): Promise<void> {
  if (await activateDeviceSlot(peer, slot) !== 'activated') return;
  liveWorkspace(workspaceId);
  useSceneStore.getState().openScene(projectResourceSceneId({ surfaceId: getActiveSurfaceId(), workspaceId }));
}

export async function createDeviceSession(
  peer: PeerDeviceContextValue | null,
  slot: SidebarDeviceSlot,
  workspaceId: string,
): Promise<void> {
  if (await activateDeviceSlot(peer, slot) !== 'activated') return;
  const scope = getActiveSurfaceScope();
  const workspace = liveWorkspace(workspaceId);
  const mode = workspace.workspaceKind === WorkspaceKind.Assistant ? 'Claw' : undefined;
  // Same reuse rule as the local "new session" action.
  const sessionId = findReusableEmptySessionId(workspace, mode)
    ?? await flowChatManager.createChatDraft(flowChatSessionConfigForWorkspace(workspace), mode);
  scope.assertCurrent('open new device session');
  await openMainSession(sessionId, { workspaceId, activateWorkspace, isCurrent: scope.isCurrent });
}
