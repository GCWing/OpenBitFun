/**
 * navSceneStore — left-panel navigation mode (2-state toggle).
 *
 * Two visual states:
 *   - showSceneNav = false → MainNav (default sidebar)
 *   - showSceneNav = true  → scene-specific nav identified by navSceneId
 *
 * navSceneId can be set from two sources:
 *   1. Right-side scene sync (sceneStore subscription)
 *   2. Left-side nav item click (e.g. "Project" → file-viewer nav)
 *
 * goBack keeps navSceneId so goForward can restore it.
 * closeNavScene clears both (used when right-side switches to a scene without nav).
 */

import { create } from 'zustand';
import {
  getInteractionMotion,
  type InteractionMotion,
} from '@/shared/utils/motionPreference';
import type { SceneTabId } from '../components/SceneBar/types';
import { getActiveSurfaceId } from '@/infrastructure/peer-device/deviceSurface';
import type { WorkspaceInfo } from '@/shared/types';

export interface ResourceWorkspaceTarget {
  surfaceId: string;
  workspaceId: string;
  directoryPath?: string;
}

/** An explicit browse target never falls back to another workspace or device. */
export function resolveResourceWorkspace(
  target: ResourceWorkspaceTarget | null,
  surfaceId: string,
  openedWorkspaces: ReadonlyMap<string, WorkspaceInfo>,
  currentWorkspace: WorkspaceInfo | null,
): WorkspaceInfo | null {
  if (!target) return currentWorkspace;
  return target.surfaceId === surfaceId ? openedWorkspaces.get(target.workspaceId) ?? null : null;
}

interface NavSceneState {
  showSceneNav: boolean;
  navSceneId: SceneTabId | null;
  resourceWorkspace: ResourceWorkspaceTarget | null;
  navigationMotion: InteractionMotion;
  navigationSequence: number;
  openNavScene: (id: SceneTabId) => void;
  openWorkspaceResources: (workspaceId: string, directoryPath?: string) => void;
  closeNavScene: () => void;
  goBack: () => void;
  goForward: () => void;
}

export const useNavSceneStore = create<NavSceneState>((set) => ({
  showSceneNav: false,
  navSceneId: null,
  resourceWorkspace: null,
  navigationMotion: 'instant',
  navigationSequence: 0,
  openNavScene: (id) => set(state => ({
    showSceneNav: true,
    navSceneId: id,
    resourceWorkspace: id === 'file-viewer' ? null : state.resourceWorkspace,
    navigationMotion: getInteractionMotion(),
    navigationSequence: state.navigationSequence + 1,
  })),
  openWorkspaceResources: (workspaceId, directoryPath) => set(state => ({
    showSceneNav: true,
    navSceneId: 'file-viewer',
    resourceWorkspace: { surfaceId: getActiveSurfaceId(), workspaceId, ...(directoryPath !== undefined && { directoryPath }) },
    navigationMotion: getInteractionMotion(),
    navigationSequence: state.navigationSequence + 1,
  })),
  closeNavScene: () => set(state => ({
    showSceneNav: false,
    navSceneId: null,
    resourceWorkspace: null,
    navigationMotion: getInteractionMotion(),
    navigationSequence: state.navigationSequence + 1,
  })),
  goBack: () => set(state => ({
    showSceneNav: false,
    navigationMotion: getInteractionMotion(),
    navigationSequence: state.navigationSequence + 1,
  })),
  goForward: () => set(state => ({
    showSceneNav: true,
    navigationMotion: getInteractionMotion(),
    navigationSequence: state.navigationSequence + 1,
  })),
}));

export function selectNavCanGoBack(state: NavSceneState): boolean {
  return state.showSceneNav;
}
