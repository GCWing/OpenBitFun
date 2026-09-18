import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { getActiveSurfaceId } from '@/infrastructure/peer-device/deviceSurface';
import { resolveSessionSceneTarget } from '@/app/services/sessionSceneTarget';
import { useSceneStore } from '@/app/stores/sceneStore';
import { dockConversationKey, miniAppDockKey, useConversationDockStore, type DockConversation } from '@/app/stores/conversationDockStore';
import { getMiniAppSceneId } from './miniAppActivity';
import { useMiniAppStore } from './miniAppStore';

/** Binding belongs to the runner; visibility belongs to the dock. Never creates a session. */
export function resolveMiniAppConversation(appId: string, surfaceId = getActiveSurfaceId()): DockConversation | undefined {
  if (surfaceId !== getActiveSurfaceId()) return;
  const claim = useMiniAppStore.getState().composerClaims[appId];
  if (!claim?.sessionId || claim.surfaceId !== surfaceId) return;
  const session = flowChatStore.getState().sessions.get(claim.sessionId);
  if (!session) return;
  return {
    ...resolveSessionSceneTarget(session, [], surfaceId),
    kind: 'miniapp', appId, claimToken: claim.token,
  };
}

export function openMiniAppConversation(appId: string, surfaceId = getActiveSurfaceId()): boolean {
  const entry = resolveMiniAppConversation(appId, surfaceId);
  if (!entry) return false;
  const dock = useConversationDockStore.getState();
  dock.add(entry);
  dock.setOpen(true);
  return true;
}

/** Registration/rebinding is silent, and cannot undo a user's Hide action. */
export function syncMiniAppConversations(surfaceId = getActiveSurfaceId()): void {
  if (surfaceId !== getActiveSurfaceId()) return;
  const claims = useMiniAppStore.getState().composerClaims;
  const dock = useConversationDockStore.getState();
  for (const entry of dock.entries) {
    if (entry.surfaceId !== surfaceId || entry.kind !== 'miniapp') continue;
    const claim = claims[entry.appId!];
    if (!claim || claim.surfaceId !== surfaceId || !claim.sessionId) dock.remove(dockConversationKey(entry));
  }
  for (const appId of Object.keys(claims)) {
    if (dock.hiddenMiniApps[miniAppDockKey(surfaceId, appId)]) continue;
    const entry = resolveMiniAppConversation(appId, surfaceId);
    if (!entry) continue;
    const existing = dock.entries.find(item => item.surfaceId === surfaceId && item.kind === 'miniapp' && item.appId === appId);
    if (existing && existing.claimToken === entry.claimToken && existing.sessionId === entry.sessionId && existing.workspaceKey === entry.workspaceKey) continue;
    dock.add(entry, false);
  }
}

export function followMiniAppConversation(appId: string, interactionLocked: boolean, surfaceId = getActiveSurfaceId()): void {
  const dock = useConversationDockStore.getState();
  const selected = dock.entries.find(entry => dockConversationKey(entry) === dock.activeBySurface[surfaceId]);
  if (!dock.open || interactionLocked || selected?.kind !== 'miniapp'
    || dock.hiddenMiniApps[miniAppDockKey(surfaceId, appId)]) return;
  const entry = resolveMiniAppConversation(appId, surfaceId);
  if (entry) dock.add(entry);
}

export function openMiniAppFromConversation(entry: DockConversation): void {
  if (entry.kind !== 'miniapp' || !entry.appId || entry.surfaceId !== getActiveSurfaceId()) return;
  useSceneStore.getState().openScene(getMiniAppSceneId(entry.appId));
}
