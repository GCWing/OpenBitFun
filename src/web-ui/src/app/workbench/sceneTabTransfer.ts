import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import type { SceneTab, SceneTabId } from '../components/SceneBar/types';
import { useSceneStore } from '../stores/sceneStore';
import type { WorkbenchPane } from './scenePaneModel';
import type { WorkbenchTabDropTarget } from './canvasTabTransfer';

const MIME = 'application/x-openbitfun-workbench-scene';
let offer: { token: string; tab: SceneTab; scope: ReturnType<typeof getActiveSurfaceScope> } | null = null;

/** All scene kinds use the same live-identity move, without serializing content. */
export function writeSceneTabDrag(data: DataTransfer, id: SceneTabId) {
  offer = null;
  const tab = useSceneStore.getState().openTabs.find(candidate => candidate.id === id);
  if (!tab) return;
  offer = { token: crypto.randomUUID(), tab, scope: getActiveSurfaceScope() };
  data.setData(MIME, offer.token);
  data.effectAllowed = 'move';
}
export function endSceneTabDrag() {
  offer = null;
}
export function isSceneTabDrag(data: DataTransfer): boolean {
  if (!offer) return false;
  const { tab, scope } = offer;
  return Array.from(data.types).includes(MIME) && scope.isCurrent()
    && useSceneStore.getState().openTabs.find(candidate => candidate.id === tab.id) === tab;
}
export function dropSceneTab(data: DataTransfer, pane: WorkbenchPane, target?: WorkbenchTabDropTarget): Promise<boolean> {
  if (!isSceneTabDrag(data) || data.getData(MIME) !== offer?.token) {
    return Promise.resolve(false);
  }
  const tab = offer.tab;
  endSceneTabDrag();
  return useSceneStore.getState().moveScene(tab.id, pane, target?.tabId, target?.placement);
}
