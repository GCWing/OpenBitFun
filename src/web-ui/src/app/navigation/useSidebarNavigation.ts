import { useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import { useSceneStore } from '@/app/stores/sceneStore';
import { useSkillsSceneStore } from '@/app/scenes/skills/skillsSceneStore';
import { getActiveSurfaceScope, isLocalSurface, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { isTauriRuntime } from '@/infrastructure/runtime';
import { isVisibleSidebarPin, sidebarPreferences } from './sidebarPreferences';
import { sidebarRegistry } from './sidebarContributions';
import { selectedSidebarEntry, type SidebarContext } from './sidebarRegistry';

export function useSidebarNavigation() {
  const entries = useSyncExternalStore(sidebarRegistry.subscribe, sidebarRegistry.getSnapshot, sidebarRegistry.getSnapshot);
  const pinnedIds = useStore(sidebarPreferences, state => state.pinnedIds);
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const activeSceneId = useSceneStore(state => state.activeTabId);
  const skillsTab = useSkillsSceneStore(state => state.activeTab);
  const context: SidebarContext = {
    activeSceneId, skillsTab, isDesktop: isTauriRuntime(),
    isPeer: !isLocalSurface(scope.surfaceId), surfaceId: scope.surfaceId,
  };
  // Retain old preferences on disk while retiring the former standalone page pin.
  const visiblePinnedIds = pinnedIds.filter(isVisibleSidebarPin);
  return { entries, pinnedIds: visiblePinnedIds, context, scope, selectedId: selectedSidebarEntry(entries, visiblePinnedIds, context) };
}
