import type { WorkspaceInfo } from '@/shared/types';
import type { ContentResourceScope } from '@/shared/types/contentResource';
import { isSessionSceneId, type SceneTab } from '../SceneBar/types';
import { sessionSceneWorkspaceKey } from '@/app/services/sessionSceneTarget';

export type SessionNavigationScope = 'all' | 'assistants' | 'projects';
export type WorkspaceBackedSessionGroupKind = 'assistant' | 'project';

/**
 * Navigation-facing projection of a session owner.
 *
 * Projects and assistants currently share the WorkspaceInfo persistence model,
 * but the sidebar treats them as peer session groups. Long-term tracking should
 * join this projection through its own durable owner identity once that contract
 * exists; it must not be inferred from a session title.
 */
export interface WorkspaceBackedSessionGroup {
  groupId: `workspace:${string}`;
  kind: WorkspaceBackedSessionGroupKind;
  workspace: WorkspaceInfo;
}

/** Resolve the active sidebar group by its stable workspace identity. */
export function isWorkspaceBackedSessionGroupActive(
  workspace: WorkspaceInfo,
  activeWorkspace: WorkspaceInfo | null | undefined,
): boolean {
  return Boolean(activeWorkspace && workspace.id === activeWorkspace.id);
}

/** Sidebar selection follows the visible resource, independently of runtime context. */
export function isWorkspaceBackedSessionGroupSelected(
  workspace: WorkspaceInfo,
  {
    activeTab,
    contentScope,
    surfaceId,
    activeWorkspaceId,
  }: {
    activeTab: SceneTab | undefined;
    contentScope: ContentResourceScope | undefined;
    surfaceId: string;
    activeWorkspaceId: string | null;
  },
): boolean {
  if (!activeTab) return false;
  if (isSessionSceneId(activeTab.id)) {
    return activeTab.session?.surfaceId === surfaceId
      && activeTab.session.workspaceKey === sessionSceneWorkspaceKey(workspace.id);
  }
  if (activeTab.contentId) {
    return contentScope?.surfaceId === surfaceId && contentScope.workspaceId === workspace.id;
  }
  // Git renders the current workspace; global pages have no workspace selection.
  return activeTab.id === 'git' && workspace.id === activeWorkspaceId;
}

const isWorkspaceInScope = (
  workspace: WorkspaceInfo,
  scope: SessionNavigationScope,
): boolean => {
  if (scope === 'all') return true;
  return scope === 'assistants'
    ? workspace.workspaceKind === 'assistant'
    : workspace.workspaceKind !== 'assistant';
};

export function projectWorkspaceBackedSessionGroups(
  openedWorkspaces: readonly WorkspaceInfo[],
  scope: SessionNavigationScope,
): WorkspaceBackedSessionGroup[] {
  const scopedWorkspaces = openedWorkspaces.filter(workspace => (
    isWorkspaceInScope(workspace, scope)
  ));

  const projectedGroups = scopedWorkspaces.map(workspace => ({
    groupId: `workspace:${workspace.id}` as const,
    kind: workspace.workspaceKind === 'assistant' ? 'assistant' as const : 'project' as const,
    workspace,
  }));

  return projectedGroups;
}
