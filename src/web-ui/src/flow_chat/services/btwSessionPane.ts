import { i18nService } from '@/infrastructure/i18n';
import { createTab } from '@/shared/utils/tabUtils';
import type { PanelContent } from '@/app/components/panels/base/types';
import { useAgentCanvasStore } from '@/app/components/panels/content-canvas/stores';
import type { CanvasTab } from '@/app/components/panels/content-canvas/types';
import { flowChatStore } from '../store/FlowChatStore';
import type { Session } from '../types/flow-chat';
import { resolveSessionTitle } from '../utils/sessionTitle';
import { flowChatManager } from './FlowChatManager';

export const BTW_SESSION_PANEL_TYPE = 'btw-session' as const;

export type BtwSessionViewKind = 'review-check';

export interface BtwSessionPanelData {
  childSessionId: string;
  parentSessionId: string;
  /** Workspace that owns the parent session; the identity used for routing. */
  workspaceId?: string;
  /** Main project workspace when the parent session executes in a linked worktree. */
  projectWorkspaceId?: string;
  /** Execution root of the parent session. IO projection only, kept for legacy tabs. */
  workspacePath?: string;
  viewKind?: BtwSessionViewKind;
  displayTitle?: string;
}

export interface BtwSessionPanelMetadata {
  duplicateCheckKey: string;
  childSessionId: string;
  parentSessionId: string;
  contentRole: 'btw-session';
}

export interface EnsureBtwSessionAvailableParams {
  childSessionId: string;
  parentSessionId: string;
  workspaceId?: string;
  workspacePath?: string;
  sessionKind?: 'btw' | 'review' | 'deep_review' | 'miniapp' | 'subagent';
  sessionTitle?: string;
  agentType?: string;
  parentToolCallId?: string;
  subagentType?: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
  includeInternal?: boolean;
}

export interface LoadBtwSessionHistoryParams {
  childSessionId: string;
  parentSessionId?: string;
}

type AgentCanvasState = ReturnType<typeof useAgentCanvasStore.getState>;

export const getBtwSessionDuplicateKey = (childSessionId: string) => `btw-session-${childSessionId}`;

const resolveBtwSessionTitle = (childSessionId: string): string => {
  const session = flowChatStore.getState().sessions.get(childSessionId);
  const title = session
    ? resolveSessionTitle(session, (key, options) => i18nService.t(key, options))
    : undefined;
  if (title) return title;
  return i18nService.t('flow-chat:btw.threadLabel');
};

export const isBtwSessionPanelContent = (content: PanelContent | null | undefined): boolean =>
  content?.type === BTW_SESSION_PANEL_TYPE;

const isRightPanelCollapsed = (): boolean => {
  try {
    if (typeof window === 'undefined') {
      return false;
    }
    const layoutState = (window as unknown as {
      __OPENBITFUN_LAYOUT_STATE__?: { rightPanelCollapsed?: boolean };
    }).__OPENBITFUN_LAYOUT_STATE__;
    return layoutState?.rightPanelCollapsed ?? false;
  } catch {
    return false;
  }
};

const requestRightPanelExpansion = (): void => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new window.CustomEvent('expand-right-panel'));
  }
};

export interface BtwSessionPanelWorkspace {
  workspaceId?: string;
  projectWorkspaceId?: string;
  workspacePath?: string;
}

/** Workspace identity of the parent session, falling back to an explicit override. */
const resolveBtwSessionPanelWorkspace = (
  parentSessionId: string,
  override: { workspaceId?: string; workspacePath?: string },
): BtwSessionPanelWorkspace => {
  const parent = flowChatStore.getState().sessions.get(parentSessionId);
  const workspaceId = override.workspaceId
    || parent?.workspaceId
    || parent?.config?.workspaceId
    || undefined;
  const projectWorkspaceId = parent?.projectWorkspaceId
    || parent?.config?.projectWorkspaceId
    || undefined;
  return {
    ...(workspaceId ? { workspaceId } : {}),
    ...(projectWorkspaceId && projectWorkspaceId !== workspaceId ? { projectWorkspaceId } : {}),
    workspacePath: override.workspacePath || parent?.workspacePath,
  };
};

export const buildBtwSessionPanelContent = (
  childSessionId: string,
  parentSessionId: string,
  workspace: BtwSessionPanelWorkspace,
  viewKind?: BtwSessionViewKind,
  displayTitle?: string,
): PanelContent => ({
  type: BTW_SESSION_PANEL_TYPE,
  title: displayTitle?.trim() || resolveBtwSessionTitle(childSessionId),
  data: {
    childSessionId,
    parentSessionId,
    ...(workspace.workspaceId ? { workspaceId: workspace.workspaceId } : {}),
    ...(workspace.projectWorkspaceId ? { projectWorkspaceId: workspace.projectWorkspaceId } : {}),
    workspacePath: workspace.workspacePath,
    ...(viewKind ? { viewKind } : {}),
    ...(displayTitle?.trim() ? { displayTitle: displayTitle.trim() } : {}),
  } satisfies BtwSessionPanelData,
  metadata: {
    duplicateCheckKey: getBtwSessionDuplicateKey(childSessionId),
    childSessionId,
    parentSessionId,
    contentRole: 'btw-session',
  } satisfies BtwSessionPanelMetadata,
});

export const selectActiveAgentTab = (state: AgentCanvasState) => {
  const activeGroup = state.activeGroupId === 'primary'
    ? state.primaryGroup
    : state.activeGroupId === 'secondary'
      ? state.secondaryGroup
      : state.tertiaryGroup;
  const activeTabId = activeGroup.activeTabId;
  if (!activeTabId) return null;
  return activeGroup.tabs.find(tab => tab.id === activeTabId && !tab.isHidden) ?? null;
};

export const selectActiveBtwSessionTab = (state: AgentCanvasState): CanvasTab | null => {
  const activeTab = selectActiveAgentTab(state);
  if (!activeTab || !isBtwSessionPanelContent(activeTab.content)) {
    return null;
  }

  const data = activeTab.content.data as BtwSessionPanelData | undefined;
  if (!data?.childSessionId || !data.parentSessionId) {
    return null;
  }

  return activeTab;
};

export async function loadBtwSessionHistory(params: LoadBtwSessionHistoryParams): Promise<void> {
  const sessions = flowChatStore.getState().sessions;
  const child = sessions.get(params.childSessionId);
  if (!(child?.workspaceId ?? child?.config?.workspaceId)) {
    const parentId = params.parentSessionId ?? child?.parentSessionId;
    const parent = parentId ? sessions.get(parentId) : undefined;
    // Read the child's persisted binding from its parent's project store.
    // Never assign the parent's execution ID: a child may own a worktree.
    const storageOwnerId = parent?.projectWorkspaceId ?? parent?.config?.projectWorkspaceId
      ?? parent?.workspaceId ?? parent?.config?.workspaceId;
    if (!storageOwnerId || !await flowChatStore.ensurePersistedSessionMetadata(params.childSessionId, storageOwnerId)) {
      throw new Error('Child session workspace is unavailable');
    }
  }
  await flowChatManager.hydrateSessionHistoryForDetail(params.childSessionId);
}

interface EnsureBtwSessionAvailableResult {
  historyLoadRequested: boolean;
}

const isSessionHistoryComplete = (session: Session | undefined): boolean =>
  Boolean(
    session &&
    session.historyState === 'ready' &&
    session.isPartial !== true &&
    typeof session.loadedTurnCount === 'number' &&
    typeof session.totalTurnCount === 'number' &&
    session.loadedTurnCount >= session.totalTurnCount
  );

function ensureBtwSessionAvailableInternal(
  params: EnsureBtwSessionAvailableParams,
): EnsureBtwSessionAvailableResult {
  const existingSession = flowChatStore.getState().sessions.get(params.childSessionId);
  const parentSession = flowChatStore.getState().sessions.get(params.parentSessionId);
  const resolvedWorkspacePath = params.workspacePath || parentSession?.workspacePath;
  const resolvedRemoteConnectionId =
    params.remoteConnectionId || existingSession?.remoteConnectionId || parentSession?.remoteConnectionId;
  const resolvedRemoteSshHost =
    params.remoteSshHost || existingSession?.remoteSshHost || parentSession?.remoteSshHost;

  if (
    existingSession &&
    (params.sessionKind === 'subagent' || existingSession.sessionKind === 'subagent')
  ) {
    flowChatStore.updateSessionRelationship(params.childSessionId, {
      parentSessionId: params.parentSessionId,
      sessionKind: params.sessionKind || existingSession.sessionKind,
      parentToolCallId: params.parentToolCallId,
      subagentType: params.subagentType,
    });
  }

  if (!existingSession) {
    flowChatStore.addExternalSession(
      params.childSessionId,
      params.sessionTitle || resolveBtwSessionTitle(params.childSessionId),
      params.agentType || parentSession?.mode || 'Standard',
      resolvedWorkspacePath,
      {
        parentSessionId: params.parentSessionId,
        sessionKind: params.sessionKind || 'btw',
        parentToolCallId: params.parentToolCallId,
        subagentType: params.subagentType,
        // Only an explicitly supplied child workspace ID is trusted here; the
        // parent's ID is never inherited because a child may own a worktree.
        ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
      },
      resolvedRemoteConnectionId,
      resolvedRemoteSshHost,
    );
  }

  const sessionToHydrate = flowChatStore.getState().sessions.get(params.childSessionId);
  const hasLoadedDialogTurns = Boolean(sessionToHydrate?.dialogTurns?.length);
  const shouldHydrateMissingSubagentModel =
    Boolean(
      sessionToHydrate &&
      (params.sessionKind === 'subagent' || sessionToHydrate.sessionKind === 'subagent') &&
      !sessionToHydrate.config?.modelName &&
      !hasLoadedDialogTurns
    );
  const shouldHydrate =
    !existingSession ||
    shouldHydrateMissingSubagentModel ||
    Boolean(
      sessionToHydrate?.isHistorical &&
      (sessionToHydrate.historyState === 'metadata-only' || sessionToHydrate.historyState === 'failed')
    );

  if (!shouldHydrate) return { historyLoadRequested: false };
  void loadBtwSessionHistory({
    childSessionId: params.childSessionId, parentSessionId: params.parentSessionId,
  }).catch(() => undefined);
  return { historyLoadRequested: true };
}

export function ensureBtwSessionAvailable(params: EnsureBtwSessionAvailableParams): void {
  ensureBtwSessionAvailableInternal(params);
}

export function openBtwSessionInAuxPane(params: {
  childSessionId: string;
  parentSessionId: string;
  workspaceId?: string;
  workspacePath?: string;
  expand?: boolean;
  sessionKind?: 'btw' | 'review' | 'deep_review' | 'miniapp' | 'subagent';
  sessionTitle?: string;
  agentType?: string;
  parentToolCallId?: string;
  subagentType?: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
  includeInternal?: boolean;
  viewKind?: BtwSessionViewKind;
}): void {
  const ensureResult = ensureBtwSessionAvailableInternal(params);
  const childSession = flowChatStore.getState().sessions.get(params.childSessionId);
  const isSubagentSession =
    params.sessionKind === 'subagent' || childSession?.sessionKind === 'subagent';
  if (
    isSubagentSession &&
    !ensureResult.historyLoadRequested &&
    !isSessionHistoryComplete(childSession)
  ) {
    void loadBtwSessionHistory({
      childSessionId: params.childSessionId, parentSessionId: params.parentSessionId,
    }).catch(() => undefined);
  }

  const content = buildBtwSessionPanelContent(
    params.childSessionId,
    params.parentSessionId,
    resolveBtwSessionPanelWorkspace(params.parentSessionId, params),
    params.viewKind,
    params.sessionTitle,
  );

  const duplicateCheckKey = content.metadata?.duplicateCheckKey;
  const canvasStore = useAgentCanvasStore.getState();
  if (duplicateCheckKey) {
    const existing = canvasStore.findTabByMetadata({ duplicateCheckKey });
    if (existing) {
      if (params.expand !== false && isRightPanelCollapsed()) {
        requestRightPanelExpansion();
      }
      canvasStore.updateTabContent(existing.tab.id, existing.groupId, content);
      canvasStore.switchToTab(existing.tab.id, existing.groupId);
      return;
    }
  }

  if (params.expand !== false) {
    requestRightPanelExpansion();
  }

  createTab({
    type: content.type,
    title: content.title,
    data: content.data,
    metadata: content.metadata,
    checkDuplicate: true,
    duplicateCheckKey,
    replaceExisting: false,
    mode: 'agent',
  });
}

export function closeBtwSessionInAuxPane(childSessionId: string): boolean {
  const duplicateCheckKey = getBtwSessionDuplicateKey(childSessionId);
  const canvasStore = useAgentCanvasStore.getState();
  const result = canvasStore.findTabByMetadata({ duplicateCheckKey });
  if (!result) {
    return false;
  }

  canvasStore.closeTab(result.tab.id, result.groupId, { forceRemove: true });
  return true;
}
