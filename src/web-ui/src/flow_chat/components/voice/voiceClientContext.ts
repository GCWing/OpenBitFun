import { selectActiveSceneId, useSceneStore } from '@/app/stores/sceneStore';
import { getSceneViewId } from '@/app/components/SceneBar/types';
import { FlowChatManager } from '@/flow_chat/services/FlowChatManager';
import { stateMachineManager } from '@/flow_chat/state-machine';
import type { Session } from '@/flow_chat/types/flow-chat';
import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import { WorkspaceKind, isRemoteWorkspace, type WorkspaceInfo } from '@/shared/types';

const MAX_CONTEXT_WORKSPACES = 24;
const MAX_CONTEXT_SESSIONS = 12;
// The speech adapter accepts 16 KiB tool results. Reserve space for the envelope.
export const MAX_VOICE_CONTEXT_BYTES = 12 * 1024;
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

interface VoiceOwnedTaskBaseContext {
  sessionId: string | null;
  state: 'starting' | 'running' | 'stopping';
}

export type VoiceOwnedTaskContext = VoiceOwnedTaskBaseContext & (
  | {
      kind: 'workspace';
      workspaceId: string;
      workspaceName: string;
    }
  | {
      kind: 'miniapp';
      appId: string;
      appName: string;
    }
);

/** Immutable routing target captured when Voice starts inside a MiniApp bubble. */
export interface VoiceMiniAppCallTarget {
  kind: 'miniapp';
  surfaceId?: string;
  appId: string;
  appName: string;
  claimToken: string;
  sessionId: string;
  workspacePath?: string;
}

export interface VoiceSessionCallTarget {
  kind: 'control' | 'session';
  surfaceId: string;
  sessionId: string;
  /** Owning workspace of the bound conversation; required to persist voice history. */
  workspaceId?: string;
  /** IO root shown to the realtime model as context; never used as identity. */
  workspacePath: string;
}
export type VoiceCallTarget = VoiceMiniAppCallTarget | VoiceSessionCallTarget;

export function voiceConversationHistory(session: Session | undefined) {
  // Only the explicitly bound conversation's public text goes to the speech provider.
  return (session?.dialogTurns ?? []).slice(-20).map(turn => ({
    user: turn.userMessage.content.slice(-4000),
    assistant: turn.modelRounds.flatMap(round => round.items)
      .filter(item => item.type === 'text').map(item => item.content).join('\n').slice(-4000),
  }));
}

function latestTurnStatus(session: Session): string {
  return session.dialogTurns[session.dialogTurns.length - 1]?.status ?? 'empty';
}

export function workspaceForSession(
  session: Session,
  workspaces: WorkspaceInfo[],
): WorkspaceInfo | undefined {
  const id = session.workspaceId ?? session.config.workspaceId;
  return id ? workspaces.find(workspace => workspace.id === id) : undefined;
}

/**
 * Build a compact, public snapshot for the realtime model. This contains only
 * navigation/session facts already visible in the controller UI; it excludes
 * unrelated message contents, tool payloads, credentials, and private Agent reasoning.
 * The bound conversation also contributes its recent public text history.
 * This is context data for the Voice control plane, not a workspace Agent tool
 * registry. Do not add Agent tool schemas or execution capabilities here.
 */
export function buildVoiceClientContext(
  voiceTask: VoiceOwnedTaskContext | null = null,
  callTarget: VoiceCallTarget | null = null,
) {
  const workspaceState = workspaceManager.getState();
  const allWorkspaces = Array.from(workspaceState.openedWorkspaces.values());
  const workspaces = allWorkspaces.slice(0, MAX_CONTEXT_WORKSPACES);
  const flowState = FlowChatManager.getInstance().getFlowChatState();
  const allSessions = Array.from(flowState.sessions.values()) as Session[];
  const sessions = allSessions
    .sort((left, right) => right.lastActiveAt - left.lastActiveAt)
    .slice(0, MAX_CONTEXT_SESSIONS)
    .map(session => {
      const workspace = workspaceForSession(session, allWorkspaces);
      return {
        id: session.sessionId,
        title: session.title || null,
        workspace_id: workspace?.id ?? null,
        workspace_name: workspace?.name ?? null,
        workspace_path: session.config.projectWorkspacePath ?? session.config.workspacePath ?? null,
        turn_status: latestTurnStatus(session),
        execution_state: stateMachineManager.getCurrentState(session.sessionId),
        active: session.sessionId === flowState.activeSessionId,
      };
    });

  const sceneState = useSceneStore.getState();
  const activeWorkspace = workspaceState.currentWorkspace;
  const context = {
    scope: 'openbitfun_client',
    captured_at: new Date().toISOString(),
    // Keep immutable call routing near the front of the bounded snapshot so it
    // remains prominent even when the client has many open workspaces/sessions.
    voice_call_target: callTarget ? {
      kind: callTarget.kind,
      app_id: callTarget.kind === 'miniapp' ? callTarget.appId : null,
      app_name: callTarget.kind === 'miniapp' ? callTarget.appName : null,
      session_id: callTarget.sessionId,
      workspace_path: callTarget.workspacePath ?? null,
      task_routing: callTarget.kind === 'miniapp' ? 'miniapp_conversation' : 'bound_conversation',
      history: voiceConversationHistory(flowState.sessions.get(callTarget.sessionId)),
      history_truncated: (flowState.sessions.get(callTarget.sessionId)?.dialogTurns.length ?? 0) > 20,
    } : null,
    active_scene: selectActiveSceneId(sceneState),
    open_scenes: [...new Set(sceneState.openTabs.map(tab => getSceneViewId(tab.id)))],
    active_workspace_id: activeWorkspace?.id ?? null,
    active_workspace: activeWorkspace ? {
      id: activeWorkspace.id,
      name: activeWorkspace.name,
      path: activeWorkspace.rootPath,
      kind: activeWorkspace.workspaceKind,
      remote: isRemoteWorkspace(activeWorkspace),
      connection_name: activeWorkspace.connectionName ?? null,
    } : null,
    opened_workspace_count: allWorkspaces.length,
    opened_workspaces_truncated: allWorkspaces.length > workspaces.length,
    opened_workspaces: workspaces.map(workspace => ({
      id: workspace.id,
      name: workspace.name,
      path: workspace.rootPath,
      kind: workspace.workspaceKind,
      active: workspace.id === workspaceState.activeWorkspaceId,
      remote: isRemoteWorkspace(workspace),
      connection_name: workspace.connectionName ?? null,
      supports_project_tasks: workspace.workspaceKind !== WorkspaceKind.Assistant,
    })),
    visible_session_count: allSessions.length,
    visible_sessions_truncated: allSessions.length > sessions.length,
    active_session_id: flowState.activeSessionId ?? null,
    visible_sessions: sessions,
    voice_owned_task: voiceTask ? {
      session_id: voiceTask.sessionId,
      state: voiceTask.state,
      target_kind: voiceTask.kind,
      workspace_id: voiceTask.kind === 'workspace' ? voiceTask.workspaceId : null,
      workspace_name: voiceTask.kind === 'workspace' ? voiceTask.workspaceName : null,
      miniapp_id: voiceTask.kind === 'miniapp' ? voiceTask.appId : null,
      miniapp_name: voiceTask.kind === 'miniapp' ? voiceTask.appName : null,
    } : null,
  };
  // Budget the complete JSON in UTF-8, retaining valid structure and exact resource
  // identities. Large inventories give way to the conversation currently in use.
  while (jsonBytes(context) > MAX_VOICE_CONTEXT_BYTES && context.visible_sessions.length) {
    context.visible_sessions.pop();
    context.visible_sessions_truncated = true;
  }
  while (jsonBytes(context) > MAX_VOICE_CONTEXT_BYTES && context.opened_workspaces.length) {
    context.opened_workspaces.pop();
    context.opened_workspaces_truncated = true;
  }
  const target = context.voice_call_target;
  while (jsonBytes(context) > MAX_VOICE_CONTEXT_BYTES && target?.history.length) {
    target.history_truncated = true;
    if (target.history.length > 1) target.history.shift();
    else {
      const turn = target.history[0];
      const field = turn.assistant.length >= turn.user.length ? 'assistant' : 'user';
      const points = Array.from(turn[field]);
      if (points.length <= 1) target.history.pop();
      else turn[field] = points.slice(-Math.floor(points.length / 2)).join('');
    }
  }
  if (jsonBytes(context) > MAX_VOICE_CONTEXT_BYTES) {
    throw new Error('The voice context identity exceeds the speech provider limit');
  }
  return context;
}

export function serializeVoiceClientContext(
  voiceTask: VoiceOwnedTaskContext | null = null,
  callTarget: VoiceCallTarget | null = null,
): string {
  return JSON.stringify(buildVoiceClientContext(voiceTask, callTarget));
}

/** An explicit workspace in the provider tool call always overrides MiniApp routing. */
export function shouldRouteVoiceTaskToMiniApp(
  callTarget: VoiceCallTarget | null,
  workspaceReference?: string,
): callTarget is VoiceMiniAppCallTarget {
  return Boolean(callTarget?.kind === 'miniapp' && !workspaceReference?.trim());
}

function matchingOpenedWorkspaces(reference: string): WorkspaceInfo[] {
  const normalized = reference.trim().toLocaleLowerCase();
  const workspaces = Array.from(workspaceManager.getState().openedWorkspaces.values());
  const exactId = workspaces.find(workspace => workspace.id === reference);
  if (exactId) return [exactId];
  return workspaces.filter(workspace => {
    const rootName = workspace.rootPath.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
    return workspace.name.toLocaleLowerCase() === normalized
      || workspace.rootPath.toLocaleLowerCase() === normalized
      || rootName.toLocaleLowerCase() === normalized;
  });
}

export function resolveOpenedVoiceWorkspace(
  workspaceReference?: string | null,
): WorkspaceInfo {
  if (!workspaceReference?.trim()) {
    const activeWorkspace = workspaceManager.getState().currentWorkspace;
    if (!activeWorkspace) {
      throw new Error('No OpenBitFun workspace is currently open');
    }
    if (activeWorkspace.workspaceKind === WorkspaceKind.Assistant) {
      const projectWorkspace = Array.from(
        workspaceManager.getState().openedWorkspaces.values(),
      ).find(workspace => workspace.workspaceKind !== WorkspaceKind.Assistant);
      if (!projectWorkspace) {
        throw new Error('No opened project workspace is available for this Agent task');
      }
      return projectWorkspace;
    }
    return activeWorkspace;
  }

  const matches = matchingOpenedWorkspaces(workspaceReference);
  if (matches.length === 0) {
    throw new Error(`Opened workspace not found: ${workspaceReference}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Workspace reference is ambiguous: ${matches.map(workspace => `${workspace.name} (${workspace.id})`).join(', ')}`,
    );
  }
  const workspace = matches[0];
  if (workspace.workspaceKind === WorkspaceKind.Assistant) {
    throw new Error(`Workspace ${workspace.name} is an assistant workspace, not a project workspace`);
  }
  return workspace;
}

export async function switchOpenedVoiceWorkspace(
  workspaceReference: string,
): Promise<WorkspaceInfo> {
  const matches = matchingOpenedWorkspaces(workspaceReference);
  if (matches.length === 0) {
    throw new Error(`Opened workspace not found: ${workspaceReference}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Workspace reference is ambiguous: ${matches.map(workspace => `${workspace.name} (${workspace.id})`).join(', ')}`,
    );
  }
  return workspaceManager.setActiveWorkspace(matches[0].id);
}
