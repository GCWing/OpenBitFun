/**
 * Open catalog entries of a device the window is not rendering.
 *
 * The catalog is read-only. Acting on an entry first renders its device through
 * the Peer Device Mode surface switch, then runs the exact local handler on the
 * now-rendered surface, so ownership, capability gates, permission prompts and
 * surface fences are the ones remote control already uses.
 */

import { getActiveSurfaceId, getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { i18nService } from '@/infrastructure/i18n';
import { clearHistorySessionOpenTransition, dispatchHistorySessionOpenIntent } from '@/flow_chat/services/sessionOpenIntent';
import type { SessionMetadata } from '@/shared/types/session-history';
import { createLogger } from '@/shared/utils/logger';
import type { PeerDeviceContextValue } from '@/infrastructure/peer-device/peerDeviceContextState';
import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { flowChatManager } from '@/flow_chat/services/FlowChatManager';
import { openMainSession } from '@/flow_chat/services/sessionActivation';
import { prewarmRelaySessionHistory } from '@/flow_chat/services/RelaySessionHistory';
import { findReusableEmptySessionId, flowChatSessionConfigForWorkspace } from '@/app/utils/projectSessionWorkspace';
import { WorkspaceKind, type WorkspaceInfo } from '@/shared/types';
import { openLatestAssistantSession } from '../workspaces/openLatestAssistantSession';
import { useSceneStore } from '@/app/stores/sceneStore';
import { projectResourceSceneId } from '@/app/scenes/project-resources/projectResourceTarget';
import {
  clearWorkspaceAction,
  requestWorkspaceAction,
  type PendingWorkspaceActionKind,
} from '../workspaces/pendingWorkspaceAction';
import { sessionSceneWorkspaceKey } from '@/app/services/sessionSceneTarget';
import type { SidebarDeviceSlot } from './useSidebarDevices';
import { isNonLocalDispatchTarget } from '@/features/dispatch/types';
import { sessionAPI } from '@/infrastructure/api/service-api/SessionAPI';
import { peerConnectionManager } from '@/infrastructure/peer-device/PeerConnectionManager';
import { canCopySessionsOnSurface } from '@/infrastructure/peer-device/peerCapabilityResolution';
import { sessionNavStatusService } from '@/flow_chat/services/sessionNavStatusService';
import { requireSessionOwningWorkspaceId } from '@/flow_chat/utils/sessionOrdering';
import { exportSessionToMarkdown } from '@/flow_chat/services/sessionMarkdownExport';
import type { TranscriptExportScope } from '@/flow_chat/utils/dialogTranscriptExport';
import {
  archiveSessionRow,
  deleteSessionRow,
  duplicateSessionRow,
  openWorktreeWorkspaceRow,
  renameSessionRow,
  type SessionRowTranslate,
} from '../sessions/sessionRowActions';

const log = createLogger('OpenOnDevice');

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export type DeviceActivationResult = 'activated' | 'superseded';

/**
 * Render `slot`'s device. Returns `superseded` when a newer switch won.
 *
 * The device's sessions are already in its container (seeded from the device
 * catalog). Session activation promotes the chosen row lazily.
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
    // The session is what the user waits for: its host starts reading it now,
    // while the device switch runs, instead of after it.
    if (!slot.isLocal) prewarmRelaySessionHistory(slot.surfaceId, sessionId);
    useSceneStore.getState().holdSessionScene({
      surfaceId: slot.surfaceId, workspaceKey: sessionSceneWorkspaceKey(workspaceId), sessionId,
    });
    dispatchHistorySessionOpenIntent(sessionId, title, CROSS_DEVICE_OPEN_OVERLAY_MS);
  }
  let settled = false;
  try {
    if (await activateDeviceSlot(peer, slot) !== 'activated') return;
    const scope = getActiveSurfaceScope();
    if (!flowChatStore.getState().sessions.has(sessionId) && session.createdAt !== undefined) {
      // Not seeded yet (opened before the catalog read finished): the row's own
      // record is the host's, so no second read is needed.
      await flowChatStore.adoptHostSessionMetadata(workspaceId, [session as SessionMetadata]);
      scope.assertCurrent('adopt device catalog session');
    }
    if (!flowChatStore.getState().sessions.has(sessionId)) {
      throw new Error(i18nService.t('common:nav.devices.sessionUnavailable'));
    }
    settled = true;
  } finally {
    // A failed or superseded switch must not leave the overlay up.
    if (!settled) clearHistorySessionOpenTransition(sessionId);
  }
  const scope = getActiveSurfaceScope();
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
  const action = { surfaceId: slot.surfaceId, workspaceId, kind };
  requestWorkspaceAction(action);
  let activated = false;
  try {
    activated = await activateDeviceSlot(peer, slot) === 'activated';
  } finally {
    if (!activated) clearWorkspaceAction(action);
  }
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

/** A session row menu action started on a device the window is not rendering. */
export type DeviceSessionAction =
  | { kind: 'rename'; title: string }
  | { kind: 'duplicate' }
  | { kind: 'export'; scope: TranscriptExportScope; title: string }
  | { kind: 'open-worktree'; worktreePath: string }
  | { kind: 'reveal-storage' }
  | { kind: 'archive' }
  | { kind: 'delete' };

/** Whole-session copy is negotiated per host; this machine always has it. */
function deviceCanCopySessions(slot: SidebarDeviceSlot): boolean {
  if (slot.isLocal) return true;
  const capabilities = slot.deviceId ? peerConnectionManager.get(slot.deviceId)?.getState().capabilities ?? null : null;
  return canCopySessionsOnSurface(true, capabilities);
}

/**
 * Render the session's device, then run the live row's handler for `action`
 * on the now-rendered surface. Gates the live menu evaluates from rendered
 * state (host capability, running turn, dispatch ownership) are re-checked
 * here and fail loudly; nothing runs against another device.
 */
export async function runDeviceSessionAction(
  peer: PeerDeviceContextValue | null,
  slot: SidebarDeviceSlot,
  sessionId: string,
  action: DeviceSessionAction,
  t: SessionRowTranslate,
): Promise<void> {
  if (await activateDeviceSlot(peer, slot) !== 'activated') return;
  const scope = getActiveSurfaceScope();
  if (scope.surfaceId !== slot.surfaceId) return;
  await flowChatStore.promoteSeededSessions(sessionId);
  if (!scope.isCurrent()) return;
  const session = flowChatStore.getState().sessions.get(sessionId);
  if (!session) throw new Error(i18nService.t('common:nav.devices.sessionUnavailable'));
  const dispatched = isNonLocalDispatchTarget(session.config.dispatchTarget);
  switch (action.kind) {
    case 'rename':
      await renameSessionRow(sessionId, action.title, t);
      return;
    case 'duplicate':
      if (dispatched) throw new Error(t('nav.sessions.duplicateDispatchUnsupported'));
      if (!deviceCanCopySessions(slot)) throw new Error(t('nav.sessions.duplicateHostUnsupported'));
      if (sessionNavStatusService.isRunning(sessionId)) throw new Error(t('nav.sessions.duplicateRunning'));
      await duplicateSessionRow(sessionId, t);
      return;
    case 'export':
      await exportSessionToMarkdown(
        { sessionId, title: action.title, workspaceId: requireSessionOwningWorkspaceId(session) },
        action.scope,
      );
      return;
    case 'open-worktree':
      await openWorktreeWorkspaceRow(action.worktreePath, t);
      return;
    case 'reveal-storage':
      if (!sessionAPI.canRevealStorageDirectory() || dispatched) {
        throw new Error(t('nav.sessions.storageDirectoryDesktopOnly'));
      }
      await sessionAPI.revealStorageDirectory(requireSessionOwningWorkspaceId(session), sessionId);
      return;
    case 'archive':
      await archiveSessionRow(sessionId, t);
      return;
    case 'delete':
      await deleteSessionRow(sessionId);
      return;
  }
}
