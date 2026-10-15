import { useSceneStore } from '../stores/sceneStore';
import type { WorkbenchPane } from './scenePaneModel';
import type { SceneTabId } from '../components/SceneBar/types';
import { useAgentCanvasStore, useGitCanvasStore, useBottomTerminalCanvasStore } from '../components/panels/content-canvas/stores';
import type { CanvasStoreMode } from '../components/panels/content-canvas/stores/canvasStore';
import { canvasTabDocumentId } from '../components/panels/content-canvas/types';
import type { EditorGroupId } from '../components/panels/content-canvas/types';
import { useContentResourceStore } from './contentResourceStore';
import { captureContentScope, openWorkbenchContent } from '@/shared/services/workbenchContentService';
import { getEditorDocument } from '@/tools/editor/services/EditorDocument';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';

export const SESSION_TAB_DRAG_TYPE = 'application/x-openbitfun-session-tab';

export interface WorkbenchTabDropTarget {
  tabId: SceneTabId;
  placement: 'before' | 'after';
}

/** Both menu pop-out and drag/drop transfer the live view, never its serialized content. */
export function popOutCanvasTab(mode: CanvasStoreMode, tabId: string, groupId: EditorGroupId,
  options: { workspacePath?: string; target?: WorkbenchTabDropTarget } = {}): string | null {
  const store = (mode === 'git' ? useGitCanvasStore
    : mode === 'bottom-terminal' ? useBottomTerminalCanvasStore : useAgentCanvasStore).getState();
  const group = groupId === 'primary' ? store.primaryGroup : groupId === 'secondary' ? store.secondaryGroup : store.tertiaryGroup;
  const tab = group.tabs.find(candidate => candidate.id === tabId);
  if (!tab) return null;
  const documentId = canvasTabDocumentId(tab);
  const document = getEditorDocument(documentId, tab.content.metadata?.resourceScope
    ?? captureContentScope({ ...tab.content.data, workspacePath: tab.content.data?.workspacePath ?? options.workspacePath }), tab.content.data?.filePath);
  if (!document.isCurrent()) return null;
  const content = typeof tab.content.data === 'object' && tab.content.data !== null
    ? { ...tab.content, data: { ...tab.content.data,
      _source: { ...tab.content.data._source,
        sessionId: tab.content.data._source?.sessionId ?? flowChatStore.getState().activeSessionId } } }
    : tab.content;
  const resourceId = openWorkbenchContent(content, {
    resourceKey: content.metadata?.duplicateCheckKey ?? tab.id, scope: document.scope, documentId,
  });
  const resource = useContentResourceStore.getState().resources[resourceId];
  const isDirty = tab.isDirty || document.snapshot?.isDirty === true;
  if (resource.documentId === documentId) {
    useContentResourceStore.getState().update(resourceId, { isDirty, fileMissing: tab.fileDeletedFromDisk === true });
  }
  // Keep an independently edited source until its draft can be resolved. Never
  // clear a destination's dirty state merely because the source view is clean.
  if (resource.documentId === documentId || !isDirty) store.detachTab(tabId, groupId);
  const sceneId = `content:${resourceId}` as const;
  if (tab.state === 'pinned' && !useSceneStore.getState().openTabs.find(candidate => candidate.id === sceneId)?.pinned) {
    useSceneStore.getState().togglePinScene(sceneId);
  }
  if (options.target) useSceneStore.getState().reorderScene(sceneId, options.target.tabId, options.target.placement);
  return resourceId;
}

export function writeSessionTabDrag(transfer: DataTransfer, tabId: string, groupId: EditorGroupId): void {
  const scope = getActiveSurfaceScope();
  transfer.setData(SESSION_TAB_DRAG_TYPE, JSON.stringify({ tabId, groupId, surfaceId: scope.surfaceId, epoch: scope.epoch }));
}

/** During dragover browsers expose formats, but protect the payload until drop. */
export function isSessionTabDrag(transfer: DataTransfer): boolean {
  const store = useAgentCanvasStore.getState();
  return Array.from(transfer.types).includes(SESSION_TAB_DRAG_TYPE)
    && Boolean(store.draggingTabId && store.draggingFromGroupId);
}

export function dropSessionTabOnWorkbench(transfer: DataTransfer, target?: WorkbenchTabDropTarget, pane: WorkbenchPane = 'primary'): string | null {
  if (!isSessionTabDrag(transfer)) return null;
  const store = useAgentCanvasStore.getState();
  try {
    let payload;
    try { payload = JSON.parse(transfer.getData(SESSION_TAB_DRAG_TYPE)); }
    catch { return null; }
    const scope = getActiveSurfaceScope();
    if (payload?.surfaceId !== scope.surfaceId || payload?.epoch !== scope.epoch
      || payload?.tabId !== store.draggingTabId || payload?.groupId !== store.draggingFromGroupId) return null;
    const id = popOutCanvasTab('agent', store.draggingTabId!, store.draggingFromGroupId!, { target });
    if (id && pane === 'secondary') void useSceneStore.getState().moveScene(`content:${id}`, pane, target?.tabId, target?.placement);
    return id;
  } finally {
    store.endDrag();
  }
}
