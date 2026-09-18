import { useSceneStore } from '@/app/stores/sceneStore';
import { useContentResourceStore, contentResourceIdentity, mergeContentOpenIntent } from '@/app/workbench/contentResourceStore';
import { switchAgentCanvasWorkspace, useAgentCanvasStore, useGitCanvasStore } from '@/app/components/panels/content-canvas/stores';
import type { EditorGroupId } from '@/app/components/panels/content-canvas/types';
import type { SessionSceneTarget } from '@/app/components/SceneBar/types';
import { resolveSessionSceneWorkspace } from '@/app/services/sessionSceneTarget';
import { expandSessionAuxPane } from '@/app/scenes/session/sessionPanelLayout';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import type { Session } from '@/flow_chat/types/flow-chat';
import { resolveLegacySessionWorkspace } from '@/infrastructure/api/service-api/legacyWorkspaceCompatibility';
import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import { getActiveSurfaceId, getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import type { PanelContent } from '@/app/components/panels/base/types';
import type { ContentResourceScope, OpenContentOptions } from '@/shared/types/contentResource';

export function captureContentScope(data?: { workspaceId?: string; workspacePath?: string; remoteConnectionId?: string }): ContentResourceScope {
  const state = workspaceManager.getState();
  const records = [...state.openedWorkspaces.values(), ...state.recentWorkspaces];
  const workspace = data?.workspaceId
    ? records.find(record => record.id === data.workspaceId)
    : data?.workspacePath
      // Temporary ingress for old tab data. Never prefer the active record when paths collide.
      ? resolveLegacySessionWorkspace(data, records.filter((record, index) => records.findIndex(candidate => candidate.id === record.id) === index))
      : state.currentWorkspace;
  if ((data?.workspaceId || data?.workspacePath) && !workspace) {
    throw new Error('Workspace identity is unavailable or ambiguous; select its workspace ID.');
  }
  return {
    surfaceId: getActiveSurfaceId(), workspaceId: workspace?.id,
    workspacePath: workspace?.rootPath,
    remoteConnectionId: workspace?.workspaceKind === 'remote' ? workspace.connectionId : undefined,
  };
}

/** Content opens commit state directly, independently of any mounted view. */
export function openWorkbenchContent(content: PanelContent, options: OpenContentOptions = {}): string {
  const scope = options.scope ?? captureContentScope(content.data);
  if (scope.surfaceId !== getActiveSurfaceId()) throw new Error('The resource belongs to another device surface.');
  const id = useContentResourceStore.getState().open(content, scope, options.resourceKey, options.replaceExisting, options.documentId);
  useSceneStore.getState().openContentScene(id, options.focus !== false);
  return id;
}

export interface ContentOpenOptions extends Pick<OpenContentOptions, 'scope' | 'resourceKey' | 'replaceExisting'> {
  isCurrent?: () => boolean;
  targetGroup?: EditorGroupId;
  splitView?: boolean;
}

/** Commit to an explicitly selected inline host; the host owns navigation and layout. */
export function openCanvasContent(mode: 'agent' | 'git', input: PanelContent, options: ContentOpenOptions = {}): void {
  if (options.isCurrent && !options.isCurrent()) return;
  const scope = options.scope ?? captureContentScope(input.data);
  if (scope.surfaceId !== getActiveSurfaceId()) throw new Error('The resource belongs to another device surface.');
  const { key, target } = contentResourceIdentity(input, scope, options.resourceKey);
  const content = { ...input,
    data: input.data !== null && typeof input.data === 'object' ? { ...input.data,
      ...(target.kind === 'file' ? { filePath: target.path } : {}),
      workspaceId: scope.workspaceId, workspacePath: scope.workspacePath, remoteConnectionId: scope.remoteConnectionId } : input.data,
    metadata: { ...input.metadata, resourceScope: scope, contentResourceKey: key },
  };
  const store = (mode === 'git' ? useGitCanvasStore : useAgentCanvasStore).getState();
  const groups = [store.primaryGroup, store.secondaryGroup, store.tertiaryGroup];
  const groupIds: EditorGroupId[] = ['primary', 'secondary', 'tertiary'];
  for (const [index, group] of groups.entries()) {
    const existing = group.tabs.find(tab => (tab.content.metadata?.contentResourceKey
      ?? contentResourceIdentity(tab.content, tab.content.metadata?.resourceScope
        ?? captureContentScope(tab.content.data)).key) === key);
    if (!existing) continue;
    const groupId = groupIds[index];
    store.updateTabContent(existing.id, groupId,
      mergeContentOpenIntent(existing.content, content, options.replaceExisting, existing.isDirty));
    store.switchToTab(existing.id, groupId);
    store.promoteTab(existing.id, groupId);
    return;
  }
  if (options.splitView && store.layout.splitMode === 'none') store.setSplitMode('vertical');
  store.addTab(content, 'active', options.targetGroup);
}

function sessionMatchesContentScope(session: Session, scope: ContentResourceScope): boolean {
  if (session.isTransient || session.sessionKind === 'subagent' || session.persistedStatus === 'archived') return false;
  if (!scope.workspaceId) return false;
  return session.workspaceId === scope.workspaceId || session.config?.workspaceId === scope.workspaceId
    || session.projectWorkspaceId === scope.workspaceId || session.config?.projectWorkspaceId === scope.workspaceId;
}

function preferredOpenSessionTarget(scope: ContentResourceScope): SessionSceneTarget | undefined {
  const { sessions } = flowChatStore.getState();
  const { openTabs, activeTabId } = useSceneStore.getState();
  // Only the tab owner knows whether a session is open. FlowChat's selection and
  // cached history survive closing a tab and must never reopen it for content.
  const tabs = openTabs.filter(tab => tab.session?.surfaceId === scope.surfaceId)
    .sort((a, b) => Number(b.id === activeTabId) - Number(a.id === activeTabId) || b.lastUsed - a.lastUsed);
  for (const tab of tabs) {
    const target = tab.session!;
    const session = sessions.get(target.sessionId);
    if (session && sessionMatchesContentScope(session, scope)) return target;
  }
  return undefined;
}

/** Reuse a main view; new content prefers an already open session in its scope. */
export function openContentInBestTarget(content: PanelContent, options: ContentOpenOptions = {}): void {
  if (options.isCurrent && !options.isCurrent()) return;
  const scope = options.scope ?? captureContentScope(content.data);
  if (scope.surfaceId !== getActiveSurfaceId()) throw new Error('The resource belongs to another device surface.');
  const identity = contentResourceIdentity(content, scope, options.resourceKey);
  const mainView = Object.values(useContentResourceStore.getState().resources).find(resource => resource.key === identity.key);
  const target = preferredOpenSessionTarget(scope);
  if (mainView || !target) {
    openWorkbenchContent(content, { ...options, scope });
    return;
  }

  const surface = getActiveSurfaceScope();
  const isCurrent = () => {
    const currentSession = flowChatStore.getState().sessions.get(target.sessionId);
    return surface.isCurrent() && (options.isCurrent?.() ?? true)
      && Boolean(currentSession && sessionMatchesContentScope(currentSession, scope));
  };
  useSceneStore.getState().activateSessionScene(target, {
    isCurrent,
    onActivated: () => {
      if (!isCurrent()) return;
      // Snapshot selection must precede the write, including before AuxPane's first mount.
      const session = flowChatStore.getState().sessions.get(target.sessionId)!;
      const workspace = resolveSessionSceneWorkspace(session, workspaceManager.getState().openedWorkspaces.values());
      switchAgentCanvasWorkspace(undefined, workspace?.id);
      openCanvasContent('agent', content, { ...options, scope });
      expandSessionAuxPane();
    },
  });
}
