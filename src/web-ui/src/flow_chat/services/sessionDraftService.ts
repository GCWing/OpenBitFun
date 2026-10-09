import { agentAPI, type CreateSessionResponse } from '@/infrastructure/api/service-api/AgentAPI';
import { sessionAPI } from '@/infrastructure/api/service-api/SessionAPI';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import { WorkspaceKind, type WorkspaceInfo } from '@/shared/types';
import type { FlowChatContext } from './flow-chat-manager/types';
import type { Session } from '../types/flow-chat';
import { isSessionBindingLocked } from '../utils/sessionLifecycle';
import { isUnmaterializedSessionDraft } from '../utils/sessionDraft';
import { requireSessionOwningWorkspaceId } from '../utils/sessionOrdering';
import { initializeSessionTitleMetadata } from './sessionTitleMetadata';
import { createDefaultSessionTitleDescriptor } from '../utils/sessionTitle';
import { i18nService } from '@/infrastructure/i18n';

const pendingCreations = new Map<string, Promise<void>>();

/** Explicit session commands may need a host before the first ordinary message. */
export async function prepareSessionDraftForCommand(session: Session): Promise<Session> {
  if (!session.draft) return session;
  const scope = getActiveSurfaceScope();
  const { FlowChatManager } = await import('./FlowChatManager');
  scope.assertCurrent('prepare draft command');
  const manager = FlowChatManager.getInstance();
  await manager.ensureBackendSession(session.sessionId);
  scope.assertCurrent('materialize draft command');
  const { flowChatStore } = await import('../store/FlowChatStore');
  scope.assertCurrent('commit draft command');
  // A command that needs the runtime commits the directory just like a first
  // message. Later model/permission edits now address the real host session.
  flowChatStore.setState(state => {
    const current = state.sessions.get(session.sessionId);
    return current?.draft ? { ...state, sessions: new Map(state.sessions).set(session.sessionId, {
      ...current, draft: undefined,
    }) } : state;
  });
  const current = manager.getFlowChatState().sessions.get(session.sessionId);
  if (!current) throw new Error('Draft session is unavailable');
  if (manager.getFlowChatState().activeSessionId === session.sessionId) {
    const { activateMainSession } = await import('./sessionActivation');
    await activateMainSession(session.sessionId, {
      isCurrent: () => scope.isCurrent()
        && manager.getFlowChatState().activeSessionId === session.sessionId,
    });
    scope.assertCurrent('activate draft command');
  }
  return current;
}

export function draftWorkspace(session: Session | undefined): WorkspaceInfo | undefined {
  const id = session?.draft?.workspaceId;
  return id ? workspaceManager.getState().openedWorkspaces.get(id) : undefined;
}

export function canSelectSessionWorkspace(session: Session | undefined, submitting = false): boolean {
  return !!session && !!session.draft && session.draft.phase === 'editing'
    && !isSessionBindingLocked(session, submitting)
    && !session.parentSessionId && !session.isTransient
    && !session.config.dispatchTarget && !session.config.dispatchJobId;
}

/** Selection changes preparation only; the shell stays on the same draft. */
export function selectDraftWorkspace(context: FlowChatContext, sessionId: string, workspaceId: string): void {
  const session = context.flowChatStore.getState().sessions.get(sessionId);
  if (!session || !canSelectSessionWorkspace(session)) throw new Error('Session workspace is locked');
  if (session.draft?.workspaceId === workspaceId) return;
  const target = workspaceManager.getState().openedWorkspaces.get(workspaceId);
  const origin = workspaceManager.getState().openedWorkspaces.get(session.workspaceId ?? '');
  if (!target || !origin) throw new Error('Workspace is unavailable');
  // Assistant identity is bound to its workspace; a project picker cannot change it.
  if (origin.workspaceKind === WorkspaceKind.Assistant || target.workspaceKind === WorkspaceKind.Assistant) {
    throw new Error('Assistant workspace cannot be changed');
  }
  context.flowChatStore.setState(state => {
    const current = state.sessions.get(sessionId);
    if (!current || !canSelectSessionWorkspace(current)) throw new Error('Session workspace is locked');
    return { ...state, sessions: new Map(state.sessions).set(sessionId, {
      ...current,
      draft: { ...current.draft!, workspaceId },
      // The choice belongs to one repository; do not carry it to an unrelated root.
      config: { ...current.config, worktreeIsolationRequested: undefined },
    }) };
  });
}

export function updateSessionDraft(
  context: FlowChatContext, sessionId: string, update: Partial<NonNullable<Session['draft']>>,
): void {
  context.flowChatStore.setState(state => {
    const session = state.sessions.get(sessionId);
    if (!session?.draft) return state;
    return { ...state, sessions: new Map(state.sessions).set(sessionId, {
      ...session, draft: { ...session.draft, ...update },
    }) };
  });
}

/**
 * The reserved session ID is stable across creation retries. A lost create ACK
 * is recovered from host metadata before trying again; existing data is never
 * replaced. Workspace identity is resolved on the captured device surface.
 */
export async function materializeSessionDraft(context: FlowChatContext, sessionId: string): Promise<void> {
  const scope = getActiveSurfaceScope();
  const key = scope.key('draft-create', scope.epoch, sessionId);
  const pending = pendingCreations.get(key);
  if (pending) return pending;
  const session = context.flowChatStore.getState().sessions.get(sessionId);
  if (!session?.draft) return;
  const target = draftWorkspace(session);
  if (!target) throw new Error('Draft workspace is unavailable');
  const remote = target.workspaceKind === WorkspaceKind.Remote;
  const projectId = !remote && target.worktree && !target.worktree.isMain
    ? target.worktree.mainWorkspaceId : target.id;
  const catalog = workspaceManager.getState();
  const project = projectId === target.id ? target
    : catalog.openedWorkspaces.get(projectId ?? '')
      ?? catalog.recentWorkspaces.find(item => item.id === projectId);
  // A local validation failure has sent nothing to the host, so leave the
  // draft editable. Once creation starts its outcome may require recovery.
  if (!project) throw new Error('Draft project workspace is unavailable');
  const previousPhase = session.draft.phase;
  if (previousPhase === 'editing') updateSessionDraft(context, sessionId, { phase: 'creating' });

  const creation = (async () => {
    if (isUnmaterializedSessionDraft(session)) {
      let response: CreateSessionResponse | undefined;
      if (previousPhase !== 'editing') {
        const saved = await sessionAPI.loadSessionMetadata(sessionId, target.id);
        scope.assertCurrent('recover draft creation');
        if (saved) {
          if (saved.workspaceId !== target.id) throw new Error('Draft session workspace does not match');
          response = { sessionId, sessionName: saved.sessionName, agentType: saved.agentType,
            modelId: saved.modelName, workspaceId: saved.workspaceId,
            workspacePath: saved.workspacePath, projectWorkspacePath: saved.projectWorkspacePath,
            executionTarget: saved.executionTarget };
        }
      }
      response ??= await agentAPI.createSession({
        sessionId, requestId: sessionId, sessionName: session.title ?? '', agentType: session.mode ?? 'Standard',
        workspaceId: target.id, workspacePath: target.rootPath, projectWorkspacePath: project.rootPath,
        remoteConnectionId: remote ? target.connectionId : undefined,
        remoteSshHost: remote ? target.sshHost : undefined,
        config: { modelName: session.config.modelName, reasoningPreset: session.config.reasoningPreset,
          enableTools: true, safeMode: true, autoCompact: true, enableContextCompression: true,
          remoteConnectionId: remote ? target.connectionId : undefined,
          remoteSshHost: remote ? target.sshHost : undefined },
      });
      scope.assertCurrent('create draft session');
      if (response.sessionId !== sessionId) throw new Error('Host did not preserve draft session identity');
      context.flowChatStore.setState(state => {
        const current = state.sessions.get(sessionId);
        if (!current?.draft) return state;
        const workspacePath = response.workspacePath ?? target.rootPath;
        const projectWorkspacePath = response.projectWorkspacePath ?? project.rootPath;
        return { ...state, sessions: new Map(state.sessions).set(sessionId, {
          ...current,
          workspaceId: response.workspaceId ?? target.id, workspacePath,
          projectWorkspaceId: project.id, projectWorkspacePath,
          remoteConnectionId: remote ? target.connectionId : undefined,
          remoteSshHost: remote ? target.sshHost : undefined,
          draft: { ...current.draft, phase: 'ready' },
          config: { ...current.config, workspaceId: response.workspaceId ?? target.id, workspacePath,
            projectWorkspaceId: project.id, projectWorkspacePath, executionTarget: response.executionTarget,
            remoteConnectionId: remote ? target.connectionId : undefined,
            remoteSshHost: remote ? target.sshHost : undefined,
            modelName: response.modelId ?? current.config.modelName },
        }) };
      });
      const created = context.flowChatStore.getState().sessions.get(sessionId)!;
      const descriptor = createDefaultSessionTitleDescriptor((key, options) => i18nService.t(key, options));
      if (created.titleSource === 'i18n') {
        const title = await initializeSessionTitleMetadata(sessionId, descriptor,
          requireSessionOwningWorkspaceId(created), scope);
        scope.assertCurrent('initialize draft title');
        context.flowChatStore.setState(state => {
          const current = state.sessions.get(sessionId);
          return current ? { ...state, sessions: new Map(state.sessions).set(sessionId, {
            ...current, workspaceSessionNumber: title.workspaceSessionNumber,
          }) } : state;
        });
      }
    }
    const ready = context.flowChatStore.getState().sessions.get(sessionId);
    if (ready?.draft?.permissionMode !== undefined) {
      await agentAPI.updateSessionPermissionMode({ sessionId, mode: ready.draft.permissionMode,
        workspaceId: requireSessionOwningWorkspaceId(ready), workspacePath: ready.projectWorkspacePath,
        remoteConnectionId: ready.remoteConnectionId, remoteSshHost: ready.remoteSshHost });
      scope.assertCurrent('apply draft permission mode');
    }
  })();
  pendingCreations.set(key, creation);
  try { await creation; } finally { if (pendingCreations.get(key) === creation) pendingCreations.delete(key); }
}
