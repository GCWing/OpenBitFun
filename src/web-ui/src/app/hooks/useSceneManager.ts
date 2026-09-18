/**
 * useSceneManager — thin wrapper around the shared sceneStore.
 *
 * All consumers (SceneBar, SceneViewport, NavPanel, …) now read from and
 * write to the same Zustand store, so state is always in sync.
 */

import { SCENE_TAB_REGISTRY, getMiniAppSceneDef, getSceneDef } from '../scenes/registry';
import type { SceneTabDef, SceneTabId } from '../components/SceneBar/types';
import { useSceneStore } from '../stores/sceneStore';
import { useMiniAppStore } from '../scenes/miniapps/miniAppStore';
import { pickLocalizedString } from '../scenes/miniapps/utils/pickLocalizedString';
import { useI18n } from '@/infrastructure/i18n';
import { useContentResourceStore } from '../workbench/contentResourceStore';

export interface UseSceneManagerReturn {
  openTabs: ReturnType<typeof useSceneStore.getState>['openTabs'];
  activeTabId: ReturnType<typeof useSceneStore.getState>['activeTabId'];
  pendingTabId: ReturnType<typeof useSceneStore.getState>['pendingTabId'];
  navigationMotion: ReturnType<typeof useSceneStore.getState>['navigationMotion'];
  navigationSequence: ReturnType<typeof useSceneStore.getState>['navigationSequence'];
  tabDefs: SceneTabDef[];
  activateScene: (id: SceneTabId) => void;
  openScene: (id: SceneTabId) => void;
  closeScene: (id: SceneTabId) => void | Promise<void>;
}

export function useSceneManager(): UseSceneManagerReturn {
  const {
    openTabs,
    activeTabId,
    pendingTabId,
    navigationMotion,
    navigationSequence,
    activateScene,
    openScene,
    closeScene,
  } = useSceneStore();
  const apps = useMiniAppStore((s) => s.apps);
  const { currentLanguage } = useI18n();
  const resources = useContentResourceStore(state => state.resources);
  const contentDefs: SceneTabDef[] = openTabs.flatMap(tab => {
    const resource = tab.contentId ? resources[tab.contentId] : undefined;
    return resource ? [{ id: tab.id, label: resource.content.title, pinned: false,
      closable: true, singleton: false, defaultOpen: false }] : [];
  });

  const miniAppDefs: SceneTabDef[] = openTabs
    .filter((t) => typeof t.id === 'string' && t.id.startsWith('miniapp:'))
    .map((t) => {
      const appId = (t.id as string).slice('miniapp:'.length);
      const app = apps.find((a) => a.id === appId);
      const localizedName = app ? pickLocalizedString(app, currentLanguage, 'name') : undefined;
      return getMiniAppSceneDef(appId, localizedName ?? app?.name);
    });

  const sessionDefs: SceneTabDef[] = openTabs
    .filter(tab => tab.session)
    .map(tab => ({ ...getSceneDef('session')!, id: tab.id }));

  return {
    openTabs,
    activeTabId,
    pendingTabId,
    navigationMotion,
    navigationSequence,
    tabDefs: [...SCENE_TAB_REGISTRY, ...sessionDefs, ...miniAppDefs, ...contentDefs],
    activateScene,
    openScene,
    closeScene,
  };
}
