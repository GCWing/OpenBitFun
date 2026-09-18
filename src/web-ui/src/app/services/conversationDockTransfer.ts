import { getActiveSurfaceScope, type SurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { useSceneStore } from '../stores/sceneStore';
import { dockConversationKey, useConversationDockStore, type DockConversation } from '../stores/conversationDockStore';
import type { SceneTabId, SessionSceneTarget } from '../components/SceneBar/types';
import { stageConversationViewTransfer } from '@/flow_chat/components/modern/flowChatViewHandoff';

const MIME = 'application/x-openbitfun-conversation';
type Offer = { id: string; scope: SurfaceScope; ref: DockConversation; sourceTab?: SceneTabId };
let offer: Offer | null = null;

export function beginConversationTransfer(data: DataTransfer, ref: SessionSceneTarget, sourceTab?: SceneTabId) {
  const scope = getActiveSurfaceScope();
  if (scope.surfaceId !== ref.surfaceId) return;
  offer = { id: crypto.randomUUID(), scope, ref: { ...ref, kind: 'session' }, sourceTab };
  data.setData(MIME, offer.id);
  data.effectAllowed = 'move';
}
export function endConversationTransfer() { offer = null; }
export function isConversationTransfer(data: DataTransfer) {
  return data.types.includes(MIME) && Boolean(offer?.scope.isCurrent());
}
function accept(data: DataTransfer) {
  const current = offer;
  if (!current || !current.scope.isCurrent() || data.getData(MIME) !== current.id
    || !flowChatStore.getState().sessions.has(current.ref.sessionId)) return null;
  if (current.sourceTab) {
    const source = useSceneStore.getState().openTabs.find(tab => tab.id === current.sourceTab)?.session;
    if (source?.sessionId !== current.ref.sessionId || source.surfaceId !== current.ref.surfaceId) return null;
  }
  return current;
}
export async function dropConversationInDock(data: DataTransfer) {
  const current = accept(data);
  if (!current) return;
  const dock = useConversationDockStore.getState();
  stageConversationViewTransfer(current.ref, 'main');
  dock.add(current.ref);
  dock.setOpen(true);
  // The destination reference is committed before the original view is closed.
  if (current.sourceTab) await useSceneStore.getState().closeScene(current.sourceTab);
  endConversationTransfer();
}
export function dropConversationInWorkbench(data: DataTransfer) {
  const current = accept(data);
  if (!current || current.sourceTab) return;
  returnConversationToWorkbench(current.ref);
  endConversationTransfer();
}
export function returnConversationToWorkbench(ref: DockConversation) {
  const scope = getActiveSurfaceScope();
  if (ref.kind !== 'session' || ref.surfaceId !== scope.surfaceId) return;
  stageConversationViewTransfer(ref, 'dock');
  useSceneStore.getState().openSessionScene(ref, {
    isCurrent: () => scope.isCurrent(),
    onActivated: () => useConversationDockStore.getState().remove(dockConversationKey(ref)),
  });
}
