import { agentAPI, btwAPI } from '@/infrastructure/api';
import { notificationService } from '@/shared/notification-system';
import { flowChatStore } from '../store/FlowChatStore';
import { stateMachineManager } from '../state-machine';
import { flowChatManager } from './FlowChatManager';
import type { Session } from '../types/flow-chat';
import type { SessionKind, SessionRelationship } from '@/shared/types/session-history';
import type {
  ReviewTargetEvidence,
  ReviewTeamRunManifest,
} from '@/shared/services/reviewTeamService';
import type { ImagePayload } from '../utils/imagePayload';
import { absoluteSessionTurnIndexForId } from '../utils/flowChatTurnOrdinal';
import { requireSessionWorkspaceId, sessionWorkspaceId } from '../utils/sessionWorkspace';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';

export function createBtwRequestId(prefix = 'btw'): string {
  try {
    const fn = (globalThis as any)?.crypto?.randomUUID as (() => string) | undefined;
    if (fn) return fn();
  } catch {
    // ignore
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function toOneLine(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function buildPersistentReviewSessionId(requestId: string): string {
  const safeRequestId = requestId.trim().replace(/[^A-Za-z0-9_-]/g, '_');
  return `review_child_${safeRequestId}`;
}

function buildChildSessionName(question: string): string {
  const one = toOneLine(question);
  const clipped = one.length > 48 ? `${one.slice(0, 48)}…` : one;
  return clipped || 'Side thread';
}

function getParentInterruptionContext(parentSessionId: string): { parentDialogTurnId?: string; parentTurnIndex?: number } {
  const machine = stateMachineManager.get(parentSessionId);
  const ctx = machine?.getContext?.();
  const machineTurnId = ctx?.currentDialogTurnId || undefined;

  const session = flowChatStore.getState().sessions.get(parentSessionId);
  if (!session) {
    return { parentDialogTurnId: machineTurnId, parentTurnIndex: undefined };
  }

  const parentDialogTurnId = machineTurnId || session.dialogTurns[session.dialogTurns.length - 1]?.id;
  if (!parentDialogTurnId) return { parentDialogTurnId: undefined, parentTurnIndex: undefined };

  return {
    parentDialogTurnId,
    parentTurnIndex: absoluteSessionTurnIndexForId(session, parentDialogTurnId),
  };
}

function requireSession(sessionId: string): Session {
  const session = flowChatStore.getState().sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  return session;
}

export async function createBtwChildSession(params: {
  parentSessionId: string;
  /** Owning workspace ID; defaults to the parent session's workspace. */
  workspaceId?: string;
  /** Execution root (IO operand); defaults to the parent session's root. */
  workspacePath?: string;
  childSessionName: string;
  agentType?: string;
  modelName?: string;
  enableTools?: boolean;
  safeMode?: boolean;
  autoCompact?: boolean;
  enableContextCompression?: boolean;
  requestId?: string;
  addMarker?: boolean;
  isTransient?: boolean;
  sessionKind?: Extract<SessionKind, 'btw' | 'review' | 'deep_review'>;
  deepReviewRunManifest?: ReviewTeamRunManifest;
  reviewTargetEvidence?: ReviewTargetEvidence;
  reviewTargetFilePaths?: string[];
}): Promise<{
  requestId: string;
  childSessionId: string;
  parentDialogTurnId?: string;
  parentTurnIndex?: number;
}> {
  const { parentSessionId } = params;
  const requestId = params.requestId || createBtwRequestId('btw');
  const childSessionKind = params.sessionKind ?? 'btw';
  const shouldPersistStandaloneSession =
    !params.isTransient && childSessionKind !== 'btw';
  const createdAt = Date.now();
  const { parentDialogTurnId, parentTurnIndex } = getParentInterruptionContext(parentSessionId);

  const parentSession = flowChatStore.getState().sessions.get(parentSessionId);
  // The child inherits the parent's workspace identity; the path is only the
  // execution root the backend runs the child in.
  const workspaceId = params.workspaceId || sessionWorkspaceId(parentSession);
  if (!workspaceId) {
    throw new Error(`Workspace ID is required for BTW child session: ${parentSessionId}`);
  }
  const workspacePath = params.workspacePath || parentSession?.workspacePath;
  if (!workspacePath) {
    throw new Error(`Workspace path is required for BTW child session: ${parentSessionId}`);
  }

  const agentType = params.agentType || parentSession?.mode || 'Standard';
  const modelName = params.modelName || parentSession?.config?.modelName || 'default';
  const childSessionName = params.childSessionName.trim() || 'Side thread';
  const remoteConnectionId = parentSession?.remoteConnectionId;
  const remoteSshHost = parentSession?.remoteSshHost;
  const projectWorkspacePath =
    parentSession?.projectWorkspacePath
    || parentSession?.config.projectWorkspacePath
    || workspacePath;
  const inheritedExecutionTarget = parentSession?.config.executionTarget;
  const relationship: SessionRelationship | undefined =
    childSessionKind === 'btw'
      ? undefined
      : {
          kind: childSessionKind,
          parentSessionId,
          parentRequestId: requestId,
          parentDialogTurnId,
          parentTurnIndex,
        };
  const createdSession = shouldPersistStandaloneSession
    ? await agentAPI.createSession({
          sessionId: buildPersistentReviewSessionId(requestId),
          sessionName: childSessionName,
          agentType,
          workspacePath,
          projectWorkspacePath,
          executionTarget: inheritedExecutionTarget?.worktreeId
            ? {
                kind: 'existingWorktree',
                worktreeId: inheritedExecutionTarget.worktreeId,
              }
            : { kind: 'local' },
          workspaceId,
          remoteConnectionId,
          remoteSshHost,
          relationship,
          deepReviewRunManifest: params.deepReviewRunManifest,
          reviewTargetEvidence: params.reviewTargetEvidence,
          config: {
            modelName,
            enableTools: params.enableTools ?? false,
            safeMode: params.safeMode ?? true,
            autoCompact: params.autoCompact ?? true,
            enableContextCompression: params.enableContextCompression ?? true,
            remoteConnectionId,
            remoteSshHost,
          },
        })
    : null;
  const childSessionId = createdSession?.sessionId ?? createBtwRequestId('btw_session');
  const childWorkspacePath = createdSession?.workspacePath || workspacePath;
  flowChatStore.addExternalSession(
    childSessionId,
    childSessionName,
    agentType,
    childWorkspacePath,
    {
      parentSessionId,
      sessionKind: childSessionKind,
      btwOrigin: {
        requestId,
        parentSessionId,
        parentDialogTurnId,
        parentTurnIndex,
      },
      deepReviewRunManifest: params.deepReviewRunManifest,
      reviewTargetEvidence: params.reviewTargetEvidence,
      reviewTargetFilePaths: params.reviewTargetFilePaths,
      projectWorkspacePath:
        createdSession?.projectWorkspacePath || projectWorkspacePath,
      executionTarget:
        createdSession?.executionTarget || inheritedExecutionTarget,
      workspaceId: createdSession?.workspaceId || workspaceId,
      isTransient: params.isTransient ?? false,
      agentBackedTransient: params.isTransient ?? false,
    },
    remoteConnectionId,
    remoteSshHost
  );
  flowChatStore.updateSessionRelationship(childSessionId, {
    parentSessionId,
    sessionKind: childSessionKind,
  });
  flowChatStore.updateSessionBtwOrigin(childSessionId, {
    requestId,
    parentSessionId,
    parentDialogTurnId,
    parentTurnIndex,
  }, childSessionKind);

  if (params.addMarker ?? false) {
    flowChatStore.addBtwThreadMarker(parentSessionId, {
      requestId,
      childSessionId,
      title: childSessionName,
      status: 'running',
      createdAt,
      parentDialogTurnId,
      parentTurnIndex,
    });
  }

  return {
    requestId,
    childSessionId,
    parentDialogTurnId,
    parentTurnIndex,
  };
}

export function createBtwSessionPlaceholder(params: {
  parentSessionId: string;
  workspacePath?: string;
  childSessionName: string;
  parentDialogTurnId?: string;
}): { childSessionId: string; parentDialogTurnId?: string; parentTurnIndex?: number } {
  const parentSession = requireSession(params.parentSessionId);
  const workspaceId = requireSessionWorkspaceId(parentSession);
  const workspacePath = params.workspacePath || parentSession.workspacePath;
  if (!workspacePath) {
    throw new Error(`Workspace path is required for BTW child session: ${params.parentSessionId}`);
  }

  const childSessionId = createBtwRequestId('btw_session');
  const childSessionName = params.childSessionName.trim() || 'Side thread';
  const { parentDialogTurnId, parentTurnIndex } = params.parentDialogTurnId
    ? { parentDialogTurnId: params.parentDialogTurnId,
        parentTurnIndex: absoluteSessionTurnIndexForId(parentSession, params.parentDialogTurnId) }
    : getParentInterruptionContext(params.parentSessionId);

  flowChatStore.addExternalSession(
    childSessionId,
    childSessionName,
    parentSession.mode || 'Standard',
    workspacePath,
    {
      parentSessionId: params.parentSessionId,
      sessionKind: 'btw',
      btwOrigin: {
        parentSessionId: params.parentSessionId,
        parentDialogTurnId,
        parentTurnIndex,
      },
      isTransient: false,
      agentBackedTransient: false,
      projectWorkspacePath:
        parentSession.projectWorkspacePath
        || parentSession.config.projectWorkspacePath
        || workspacePath,
      executionTarget: parentSession.config.executionTarget,
      workspaceId,
    },
    parentSession.remoteConnectionId,
    parentSession.remoteSshHost
  );

  flowChatStore.updateSessionRelationship(childSessionId, {
    parentSessionId: params.parentSessionId,
    sessionKind: 'btw',
  });
  if (parentSession.config.modelName) {
    flowChatStore.updateSessionModelName(childSessionId, parentSession.config.modelName);
  }
  flowChatStore.updateSessionReasoningPreset(childSessionId, parentSession.config.reasoningPreset);

  return { childSessionId, parentDialogTurnId, parentTurnIndex };
}

export async function sendMessageToBtwSession(params: {
  parentSessionId: string;
  childSessionId: string;
  question: string;
  childSessionName?: string;
  modelId?: string;
  imagePayload?: ImagePayload;
  parentDialogTurnId?: string;
  parentTurnIndex?: number;
  userMessageMetadata?: Record<string, unknown>;
  initialModelSelection?: { modelId: string; reasoningPreset?: string };
  requestId?: string;
}): Promise<{ requestId: string }> {
  const question = params.question.trim();
  if (!question) {
    notificationService.warning('Please provide a question after /btw');
    throw new Error('Empty /btw question');
  }

  const childSession = requireSession(params.childSessionId);
  if (childSession.sessionKind !== 'btw' || childSession.isTransient) {
    throw new Error(`Session is not a persistent /btw session: ${params.childSessionId}`);
  }

  const scope = getActiveSurfaceScope();
  const requestId = params.requestId ?? createBtwRequestId('btw');
  flowChatStore.updateSessionBtwOrigin(params.childSessionId, {
    ...(childSession.btwOrigin || {}),
    requestId,
    parentSessionId: params.parentSessionId,
    parentDialogTurnId: params.parentDialogTurnId ?? childSession.btwOrigin?.parentDialogTurnId,
    parentTurnIndex: params.parentTurnIndex ?? childSession.btwOrigin?.parentTurnIndex,
  }, 'btw');
  const modelId = params.modelId?.trim();
  await btwAPI.askStream({
    requestId,
    sessionId: params.parentSessionId,
    childSessionId: params.childSessionId,
    childSessionName: params.childSessionName || childSession.title || 'Side thread',
    question,
    ...(modelId ? { modelId } : {}),
    parentDialogTurnId: params.parentDialogTurnId ?? childSession.btwOrigin?.parentDialogTurnId,
    parentTurnIndex: params.parentTurnIndex ?? childSession.btwOrigin?.parentTurnIndex,
    imageContexts: params.imagePayload?.imageContexts,
    ...(params.userMessageMetadata ? { userMessageMetadata: params.userMessageMetadata } : {}),
    ...(params.initialModelSelection ? { initialModelSelection: params.initialModelSelection } : {}),
  });
  if (modelId && scope.isCurrent()) {
    flowChatStore.updateSessionModelName(params.childSessionId, modelId);
  }

  return { requestId };
}

export async function startBtwThread(params: {
  parentSessionId: string;
  workspacePath: string;
  question: string;
  modelId?: string;
  imagePayload?: ImagePayload;
}): Promise<{ requestId: string; childSessionId: string }> {
  const question = params.question.trim();
  if (!question) {
    notificationService.warning('Please provide a question after /btw');
    throw new Error('Empty /btw question');
  }

  await flowChatManager.ensureBackendSession(params.parentSessionId);
  const childSessionName = buildChildSessionName(question);
  const { childSessionId, parentDialogTurnId, parentTurnIndex } = createBtwSessionPlaceholder({
    parentSessionId: params.parentSessionId,
    workspacePath: params.workspacePath,
    childSessionName,
  });

  try {
    const { requestId } = await sendMessageToBtwSession({
      parentSessionId: params.parentSessionId,
      childSessionId,
      question,
      childSessionName,
      modelId: params.modelId,
      imagePayload: params.imagePayload,
      parentDialogTurnId,
      parentTurnIndex,
    });
    return { requestId, childSessionId };
  } catch (error) {
    flowChatManager.discardLocalSession(childSessionId);
    throw error;
  }
}
