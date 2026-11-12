import { readModelSelections } from '@/infrastructure/config/services/modelSelections';
import { readProjectDefaults } from '@/infrastructure/config/services/ProjectDefaultsService';
import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import { supportsModelPools } from '@/infrastructure/api/service-api/ModelPoolAPI';
import { acpClientIdFromAgentType } from '../../utils/acpSession';
import { hostQueueSupported, hostDialogQueue, queueImageAttachments } from '../../services/hostDialogQueue';
import { promoteAcceptedHostMessage } from '../../services/hostQueueSubmission';
import { requireSessionOwningWorkspaceId, sessionOwningWorkspaceId } from '../../utils/sessionOrdering';
/**
 * Local session driver: the default flavor backed by this machine's (or the
 * attached peer's) agent runtime via `agentAPI`.
 *
 * Peer Device Mode is invisible here by design: it swaps the transport
 * underneath `api.invoke`, so this driver must never consult it. Session
 * creation sends only an explicit model selection and projects the Runtime's
 * authoritative resolved model from the response.
 */

import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import { ACPClientAPI } from '@/infrastructure/api/service-api/ACPClientAPI';
import { sessionAPI } from '@/infrastructure/api/service-api/SessionAPI';
import { worktreeAPI } from '@/infrastructure/api/service-api/WorktreeAPI';
import { createLogger } from '@/shared/utils/logger';
import { getActiveSurfaceScope, isLocalSurface, type SurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { stateMachineManager } from '../../state-machine';
import { SessionExecutionEvent, SessionExecutionState } from '../../state-machine/types';
import type { FlowChatContext, SessionConfig, DialogTurn } from '../../services/flow-chat-manager/types';
import type {
  SessionCascadeRemoval,
  SessionCreationSeed,
  SessionDriver,
  CompactSessionResult,
  StartTurnInput,
  StartTurnResult,
  SubmissionPlan,
  TurnTracker,
  UsageReportUiParams,
} from '../types';
import {
  getModelMaxTokens,
  resolveReasoningPresetForSessionCreation,
} from '../../utils/modelResolution';
import { syncSessionModelSelection } from '../../utils/modelSync';
import { nextStorageTurnIndex } from '../../utils/flowChatTurnIdentity';
import { markCurrentTurnItemsAsCancelled } from '../../utils/turnCancellation';
import {
  sessionProjectWorkspacePath,
  sessionWorkspaceId,
} from '../../utils/sessionWorkspace';
import { sessionWorktreeMaterializationPlan } from '../../utils/sessionWorktree';
import { cleanupSaveState, updateSessionMetadata } from '../../services/flow-chat-manager/PersistenceModule';
import { cleanupSessionBuffers } from '../../services/flow-chat-manager/TextChunkModule';
import { addSubmittedDialogTurn, applyGeneratingTitlePlaceholder } from '../shared';
import { finishSubmittedMessagePreview, getSubmittedMessagePreview } from '../../services/submittedMessagePresentation';
import { initializeSessionTitleMetadata } from '../../services/sessionTitleMetadata';
import { inheritReviewPermissionMode } from '../../services/inheritReviewPermissionMode';

const log = createLogger('LocalSessionDriver');

async function syncCreatedSessionTitle(
  context: FlowChatContext,
  sessionId: string,
  descriptor: SessionCreationSeed['titleDescriptor'],
  workspaceId: string,
  surfaceScope: SessionCreationSeed['surfaceScope'],
): Promise<void> {
  try {
    const title = await initializeSessionTitleMetadata(sessionId, descriptor, workspaceId, surfaceScope);
    if (title.workspaceSessionNumber === undefined) return;
    context.flowChatStore.setState(state => {
      const current = state.sessions.get(sessionId);
      // A title generated or edited meanwhile owns the display; keep it.
      if (!current || current.titleSource !== 'i18n') return state;
      return { ...state, sessions: new Map(state.sessions).set(sessionId, {
        ...current, workspaceSessionNumber: title.workspaceSessionNumber,
      }) };
    });
  } catch (error) {
    // A surface change abandons this projection; the session itself was
    // created and the next catalog read carries the host-owned number.
    log.debug('Skipped created session title synchronization', { sessionId, error });
  }
}

/** Long enough for a genuine stop's terminal event, which the host emits within its drain window. */
const STALE_STOP_REPAIR_DELAY_MS = 3000;

/**
 * A stop for a turn the host no longer runs settles nothing there: the host
 * either acknowledges it without an event (FINISHING forever) or fails it
 * because the session is not loaded (back to PROCESSING). Either way this
 * window keeps a phantom running turn. On a device surface, if the stop has
 * not settled after the host's drain window, re-read the session from the
 * host: its record projects a turn without a live executor as settled, and a
 * turn that really is still running stays running.
 */
function scheduleStaleStopRepair(
  context: FlowChatContext,
  scope: SurfaceScope,
  sessionId: string,
  turnId: string,
): void {
  if (isLocalSurface(scope.surfaceId)) return;
  const stillUnsettled = () => {
    const machine = stateMachineManager.get(sessionId);
    const state = machine?.getCurrentState();
    return scope.isCurrent()
      && machine?.getContext().currentDialogTurnId === turnId
      && (state === SessionExecutionState.PROCESSING || state === SessionExecutionState.FINISHING);
  };
  setTimeout(() => {
    if (!stillUnsettled()) return;
    log.warn('Stop did not settle; re-reading the session from its host', { sessionId, turnId });
    void context.flowChatStore.reloadRelaySessionFromHost(sessionId).then(() => {
      if (!scope.isCurrent()) return;
      const latest = context.flowChatStore.getState().sessions.get(sessionId)?.dialogTurns.at(-1);
      const state = stateMachineManager.getCurrentState(sessionId);
      // The authoritative record settled the stopped turn; its cancellation gate
      // has nothing left to wait for.
      if (latest?.id === turnId && ['completed', 'cancelled', 'error'].includes(latest.status)
        && state !== SessionExecutionState.PROCESSING && state !== SessionExecutionState.FINISHING) {
        context.userCancelledSessionIds.delete(sessionId);
      }
    }).catch(error => {
      log.warn('Failed to re-read the session after an unsettled stop', { sessionId, turnId, error });
    });
  }, STALE_STOP_REPAIR_DELAY_MS);
}

export const localSessionDriver: SessionDriver = {
  id: 'local',

  async createSession(context: FlowChatContext, seed: SessionCreationSeed): Promise<string> {
    const {
      surfaceScope,
      config: seedConfig,
      agentType,
      sessionName,
      titleDescriptor,
      workspacePath,
      projectWorkspacePath,
      workspaceId,
      remoteConnectionId,
      remoteSshHost,
    } = seed;
    surfaceScope.assertCurrent('start local session creation');
    let config = seedConfig;
    if (!config.modelName && !config.modelPoolId && !acpClientIdFromAgentType(agentType)) {
      const catalog = workspaceManager.getState();
      const workspace = catalog.openedWorkspaces.get(workspaceId ?? '')
        ?? catalog.recentWorkspaces.find(item => item.id === workspaceId);
      const projectId = workspace?.worktree && !workspace.worktree.isMain && workspace.workspaceKind !== 'remote'
        ? workspace.worktree.mainWorkspaceId : workspaceId;
      // Reuse the creation's project defaults read: the mode resolver usually
      // issued it already, so this costs no second host round trip.
      const readDefaults = seed.readProjectDefaults
        ?? (projectId ? () => readProjectDefaults(projectId) : undefined);
      const projectPrimary = readDefaults ? (await readDefaults()).defaults.primary_model : undefined;
      surfaceScope.assertCurrent('resolve project default model');
      if (projectPrimary) config = { ...config, modelName: projectPrimary };
    }
    if (!config.modelName && !config.modelPoolId && !acpClientIdFromAgentType(agentType)) {
      // Served from the config manager cache when warm; read only when no
      // project model applies.
      const { mode: selection } = await readModelSelections();
      surfaceScope.assertCurrent('resolve default model target');
      if (selection.kind === 'pool') {
        if (!supportsModelPools()) throw new Error('This host does not support model_pool_selection_v1');
        config = { ...config, modelPoolId: selection.pool_id, modelPoolSelectionPending: true, reasoningPreset: undefined };
      } else if (selection.kind === 'model') {
        config = { ...config, modelName: selection.model_ref };
      } else {
        throw new Error('Unsupported default model target');
      }
    }


    const explicitModelName = config.modelName?.trim() || undefined;
    const requestedReasoningPreset = config.modelPoolId ? undefined : config.reasoningPreset;
    const readReasoningPreset = (): Promise<string | undefined> => (
      config.modelPoolId || requestedReasoningPreset != null
        ? Promise.resolve(requestedReasoningPreset ?? undefined)
        : resolveReasoningPresetForSessionCreation(explicitModelName)
    );

    if (seed.draftId && agentType !== 'Claw' && !config.executionTargetRequest) {
      if (!workspaceId) throw new Error('Draft workspace ID is unavailable');
      // Both reads only depend on the model already resolved above.
      const [reasoningPreset, maxContextTokens] = await Promise.all([
        readReasoningPreset(),
        getModelMaxTokens(explicitModelName, agentType),
      ]);
      surfaceScope.assertCurrent('prepare conversation draft');
      context.flowChatStore.createSession(seed.draftId, {
        ...config, workspaceId, workspacePath, projectWorkspacePath, reasoningPreset,
      }, undefined, sessionName, maxContextTokens, agentType, workspacePath,
      remoteConnectionId, remoteSshHost, titleDescriptor, {
        workspaceId, phase: 'editing', turnId: crypto.randomUUID(),
      });
      return seed.draftId;
    }

    const reasoningPreset = await readReasoningPreset();
    surfaceScope.assertCurrent('resolve session creation reasoning preset');

    const response = await agentAPI.createSession({
      sessionName,
      agentType,
      workspacePath,
      projectWorkspacePath,
      executionTarget: config.executionTargetRequest,
      requestId: globalThis.crypto?.randomUUID?.() ?? `worktree-${Date.now()}-${Math.random()}`,
      workspaceId: workspaceId ?? config.workspaceId,
      remoteConnectionId,
      remoteSshHost,
      config: {
        modelName: explicitModelName,
        reasoningPreset,
        enableTools: true,
        safeMode: true,
        autoCompact: true,
        enableContextCompression: true,
        remoteConnectionId,
        remoteSshHost,
      }
    });
    surfaceScope.assertCurrent('create local backend session');

    const sessionModelName = response.modelId ?? explicitModelName;
    const maxContextTokens = await getModelMaxTokens(sessionModelName, agentType);
    surfaceScope.assertCurrent('resolve created session model');
    const mergedConfig: SessionConfig = {
      ...config,
      modelName: sessionModelName,
      reasoningPreset,
      workspaceId: workspaceId ?? config.workspaceId,
    };

    const effectiveWorkspacePath =
      response.workspacePath || response.executionTarget?.rootPath || workspacePath;
    const effectiveProjectWorkspacePath =
      response.projectWorkspacePath || projectWorkspacePath || workspacePath;
    const resolvedConfig: SessionConfig = {
      ...mergedConfig,
      workspacePath: effectiveWorkspacePath,
      projectWorkspacePath: effectiveProjectWorkspacePath,
      workspaceId: response.workspaceId ?? mergedConfig.workspaceId,
      executionTarget: response.executionTarget,
    };

    // The session exists on the host already; its default title renders from
    // the descriptor at once. Synchronize the host-owned title identity and
    // workspace session number off the creation critical path (three metadata
    // round trips, each a relay round trip in Peer Device Mode), the same way
    // a materialized draft does.
    context.flowChatStore.createSession(
      response.sessionId,
      resolvedConfig,
      undefined,
      sessionName,
      maxContextTokens,
      agentType,
      effectiveWorkspacePath,
      remoteConnectionId,
      remoteSshHost,
      titleDescriptor,
    );
    void syncCreatedSessionTitle(
      context, response.sessionId, titleDescriptor,
      requireSessionOwningWorkspaceId({ config: resolvedConfig }), surfaceScope,
    );

    return response.sessionId;
  },

  async deleteSession(
    context: FlowChatContext,
    sessionId: string,
    removal: SessionCascadeRemoval,
  ): Promise<void> {
    const scope = getActiveSurfaceScope();
    const session = context.flowChatStore.getState().sessions.get(sessionId);
    log.info('Dispatch diagnostic: delete routed to persisted backend session', {
      sessionId,
      hasWorkspacePath: Boolean(session && sessionProjectWorkspacePath(session)),
    });
    await context.flowChatStore.deleteSession(
      sessionId,
      removal.removedActiveSession ? { nextActiveSessionId: null } : undefined,
    );
    scope.assertCurrent('clean up deleted session');

    removal.removedSessionIds.forEach(id => {
      context.processingManager.clearSessionStatus(id);
      cleanupSaveState(context, id);
    });
  },

  async archiveSession(
    context: FlowChatContext,
    sessionId: string,
    removal: SessionCascadeRemoval,
  ): Promise<void> {
    const scope = getActiveSurfaceScope();
    const session = context.flowChatStore.getState().sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session does not exist: ${sessionId}`);
    }

    if (session.draft?.phase !== 'editing') {
      await sessionAPI.archiveSession(sessionId, requireSessionOwningWorkspaceId(session));
      scope.assertCurrent('complete session archive');
    }

    context.flowChatStore.removeSession(
      sessionId,
      removal.removedActiveSession ? { nextActiveSessionId: null } : undefined,
    );

    removal.removedSessionIds.forEach(id => {
      stateMachineManager.delete(id);
      context.processingManager.clearSessionStatus(id);
      cleanupSaveState(context, id);
      cleanupSessionBuffers(context, id);
    });
  },

  async renameSession(
    context: FlowChatContext,
    sessionId: string,
    title: string,
  ): Promise<string> {
    const scope = getActiveSurfaceScope();
    const session = context.flowChatStore.getState().sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session does not exist: ${sessionId}`);
    }
    if (session.draft?.phase === 'editing') {
      await context.flowChatStore.updateSessionTitle(sessionId, title, 'generated');
      return title;
    }
    const updatedTitle = await agentAPI.updateSessionTitle({
      sessionId,
      title,
      workspaceId: sessionOwningWorkspaceId(session),
      workspacePath: sessionProjectWorkspacePath(session),
      remoteConnectionId: session.remoteConnectionId,
      remoteSshHost: session.remoteSshHost,
    });

    scope.assertCurrent('rename session title');
    await context.flowChatStore.updateSessionTitle(sessionId, updatedTitle, 'generated');
    scope.assertCurrent('persist renamed session title identity');
    await updateSessionMetadata(context, sessionId, ['titleMetadata']);
    return updatedTitle;
  },

  async ensureReady(context: FlowChatContext, sessionId: string): Promise<void> {
    // Deliberate lazy import: SessionModule routes lifecycle calls through the
    // driver registry, so a static import here would create a module cycle.
    const { ensureBackendSession } = await import('../../services/flow-chat-manager/SessionModule');
    await ensureBackendSession(context, sessionId);
  },

  async cancel(context: FlowChatContext, sessionId: string): Promise<boolean> {
    const scope = getActiveSurfaceScope();
    const originalTurnId = stateMachineManager.get(sessionId)?.getContext().currentDialogTurnId;
    const currentState = stateMachineManager.getCurrentState(sessionId);
    if (currentState !== SessionExecutionState.PROCESSING) {
      return false;
    }
    // Gate pending-queue auto-drain before the asynchronous interrupt RPC can
    // race an Idle/terminal event back to the UI.
    context.userCancelledSessionIds.add(sessionId);
    const success = await stateMachineManager.transition(
      sessionId,
      SessionExecutionEvent.USER_CANCEL,
    );
    scope.assertCurrent('apply cancellation outcome');
    const currentTurnId = stateMachineManager.get(sessionId)?.getContext().currentDialogTurnId;
    if (currentTurnId && currentTurnId !== originalTurnId) return false;
    const settledInFinishing = success
      && stateMachineManager.getCurrentState(sessionId) === SessionExecutionState.FINISHING;
    if (!settledInFinishing) {
      context.userCancelledSessionIds.delete(sessionId);
    }

    if (settledInFinishing) {
      markCurrentTurnItemsAsCancelled(context, sessionId);
      cleanupSessionBuffers(context, sessionId);
    }
    if (originalTurnId) scheduleStaleStopRepair(context, scope, sessionId, originalTurnId);

    return settledInFinishing;
  },

  planSubmission(): SubmissionPlan {
    // Local sessions park messages while busy; the drain listener replays
    // them when the state machine returns to IDLE.
    return { kind: 'queue' };
  },

  async compactSession(context: FlowChatContext, sessionId: string, turnId?: string): Promise<CompactSessionResult> {
    const session = context.flowChatStore.getState().sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session does not exist: ${sessionId}`);
    }
    const response = await agentAPI.compactSession({
      sessionId,
      turnId,
      workspaceId: sessionOwningWorkspaceId(session),
      workspacePath: sessionProjectWorkspacePath(session),
      remoteConnectionId: session.remoteConnectionId,
      remoteSshHost: session.remoteSshHost,
    });
    return { accepted: response.success, turnId: response.turnId };
  },

  async runUsageReport(
    context: FlowChatContext,
    sessionId: string,
    uiParams: UsageReportUiParams,
  ): Promise<{ shown: boolean }> {
    const session = context.flowChatStore.getState().sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session does not exist: ${sessionId}`);
    }
    const { runUsageReportCommand } = await import('../../services/usageReportService');
    const result = await runUsageReportCommand({ session, ...uiParams });
    return { shown: result.shown };
  },

  permissionRequestSource(): 'live' {
    return 'live';
  },

  async respondPermission(
    _sessionId: string,
    requestId: string,
    reply: 'once' | 'always' | 'reject',
    feedback?: string,
  ): Promise<void> {
    await agentAPI.respondPermission(requestId, reply, feedback);
  },

  async respondPermissionBatch(
    _sessionId: string,
    requestId: string,
    reply: 'once' | 'always' | 'reject',
    feedback?: string,
  ): Promise<string[]> {
    return agentAPI.respondPermissionBatch(requestId, reply, feedback);
  },

  async steer(): Promise<void> {
    throw new Error('Local sessions queue messages while a turn is running');
  },

  async startTurn(
    context: FlowChatContext,
    input: StartTurnInput,
    tracker: TurnTracker,
  ): Promise<StartTurnResult> {
    const {
      surfaceScope,
      sessionId,
      message,
      displayMessage,
      currentAgentType,
      acpClientId,
      isFirstMessage,
      readySession,
      options,
    } = input;

    const prepareSubmission = async () => {
      if (readySession.config.worktreeIsolationRequested !== undefined) {
        const materialization = sessionWorktreeMaterializationPlan(readySession);
        if (materialization) {
          log.info('Materializing requested worktree after prompt submission', {
            sessionId,
            enabled: materialization.enabled,
            projectWorkspaceId: materialization.projectWorkspaceId,
            projectWorkspacePath: materialization.projectWorkspacePath,
          });
          const result = await worktreeAPI.bindSession(
            sessionId,
            materialization.enabled,
            globalThis.crypto?.randomUUID?.() ?? `worktree-first-turn-${Date.now()}`,
            materialization,
          );
          surfaceScope.assertCurrent('bind session worktree');
          context.flowChatStore.updateSessionExecutionTarget(sessionId, {
            workspacePath: result.workspacePath,
            projectWorkspacePath: result.projectWorkspacePath,
            workspaceId: result.workspaceId,
            projectWorkspaceId: result.projectWorkspaceId,
            executionTarget: result.executionTarget,
          });
          if (result.retainedWorktreePath) {
            log.warn('Released worktree retained because it contains local work', {
              sessionId,
              retainedWorktreePath: result.retainedWorktreePath,
            });
          }
        }
        context.flowChatStore.setSessionWorktreeIsolationRequested(sessionId, undefined);
      }

      if (isFirstMessage) {
        applyGeneratingTitlePlaceholder(context, sessionId, message);
      }

    };
    if (!acpClientId && hostQueueSupported(sessionId) && (!options?.execution || options.execution.kind === 'standard')) {
      if (readySession.isHistorical || context.pendingHistoryLoads.has(surfaceScope.key('history-load', surfaceScope.epoch, sessionId))) {
        throw new Error('Session history is still restoring, please retry once loading finishes');
      }
      await prepareSubmission();
      const queue = hostDialogQueue(sessionId);
      // Worktree binding above may change the host's session storage scope.
      // Its completion fences both independent preparation reads below.
      const [, queueSnapshot] = await Promise.all([
        syncSessionModelSelection(context, sessionId, currentAgentType, surfaceScope),
        queue.refresh(),
      ]);
      surfaceScope.assertCurrent('prepare host message');
      await inheritReviewPermissionMode(readySession, context.flowChatStore.getState().sessions,
        () => surfaceScope.assertCurrent('inherit review session permission mode'));
      tracker.hostSubmitStarted = true;
      const accepted = await queue.submit({ content: message, displayContent: displayMessage,
        agentType: currentAgentType, attachments: queueImageAttachments(options?.imageContexts),
        metadata: options?.userMessageMetadata ?? {} },
        { composerDraft: options?.pendingQueueDraft, imageContexts: options?.imageContexts, imageDisplayData: options?.imageDisplayData }, options?.turnId, queueSnapshot);
      tracker.hostAcceptedTurn = true;
      surfaceScope.assertCurrent('accept host message');
      if (options?.turnId && accepted.receipt?.turnId && accepted.receipt.turnId !== options.turnId) {
        // An existing outbox record can deduplicate the request under its older Turn id.
        finishSubmittedMessagePreview(surfaceScope, sessionId, options.turnId);
      }
      if (options?.sendImmediately) {
        await promoteAcceptedHostMessage(queue, accepted);
        surfaceScope.assertCurrent('accept immediate host message');
      }
      context.flowChatStore.updateSessionLastSubmittedMode(sessionId, currentAgentType);
      if (isFirstMessage) await updateSessionMetadata(context, sessionId, ['titleMetadata']);
      return accepted.receipt?.status === 'started' ? 'completed' : 'queued';
    }

    const dialogTurnId = options?.turnId?.trim() ||
      `dialog_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const hasImages = (options?.imageContexts?.length ?? 0) > 0;

    // An ACP agent runs outside the local runtime, so no backend
    // DialogTurnStarted arrives with a storage slot for this Turn. Without one
    // every save of the Turn is deferred and the Session never reaches disk, so
    // the projection — the only writer of these Turns — allocates it here.
    const acpStorageTurnIndex = acpClientId
      ? nextStorageTurnIndex(readySession)
      : undefined;
    if (acpClientId && acpStorageTurnIndex === undefined) {
      log.warn('ACP turn starts without a storage slot; its saves stay deferred', {
        sessionId,
        dialogTurnId,
      });
    }

    const dialogTurn: DialogTurn = {
      id: dialogTurnId,
      sessionId: sessionId,
      agentType: currentAgentType,
      userMessage: {
        id: getSubmittedMessagePreview(sessionId, dialogTurnId)?.message.id ?? `user_${Date.now()}`,
        content: displayMessage || message,
        timestamp: Date.now(),
        hasImages,
        images: options?.imageDisplayData,
        metadata: options?.userMessageMetadata,
      },
      modelRounds: [],
      // Images are attached for multimodal primary models or reduced to text placeholders for text-only models.
      // We don't run a separate frontend "image pre-analysis" phase here.
      status: 'pending',
      startTime: Date.now(),
      storageTurnIndex: acpStorageTurnIndex,
    };

    addSubmittedDialogTurn(context, surfaceScope, sessionId, dialogTurn);
    tracker.createdLocalTurnId = dialogTurnId;
    const isRestoringHistoricalSession =
      readySession.isHistorical
      || context.pendingHistoryLoads.has(
        surfaceScope.key('history-load', surfaceScope.epoch, sessionId),
      );
    if (isRestoringHistoricalSession) {
      context.processingManager.clearSessionStatus(sessionId);
      context.flowChatStore.deleteDialogTurn(sessionId, dialogTurnId);
      throw new Error('Session history is still restoring, please retry once loading finishes');
    }

    const startOk = await stateMachineManager.transition(sessionId, SessionExecutionEvent.START, {
      taskId: sessionId,
      dialogTurnId,
    });
    surfaceScope.assertCurrent('start session state machine');
    if (!startOk) {
      const currentState = stateMachineManager.getCurrentState(sessionId);
      throw new Error(`Session is still busy finishing the previous turn (current state: ${currentState})`);
    }

    context.processingManager.registerStatus({
      sessionId: sessionId,
      status: 'thinking',
      message: '',
      metadata: { sessionId: sessionId, dialogTurnId }
    });

    await prepareSubmission();
    if (!acpClientId) {
      await syncSessionModelSelection(context, sessionId, currentAgentType, surfaceScope);
    }

    const updatedSession = context.flowChatStore.getState().sessions.get(sessionId);
    if (!updatedSession) {
      throw new Error(`Session lost after adding dialog turn: ${sessionId}`);
    }

    context.contentBuffers.set(sessionId, new Map());
    context.activeTextItems.set(sessionId, new Map());

    const workspaceId = sessionWorkspaceId(updatedSession);
    const workspacePath = updatedSession.workspacePath;
    const projectWorkspacePath = sessionProjectWorkspacePath(updatedSession);

    if (acpClientId) {
      tracker.hostSubmitStarted = true;
      await ACPClientAPI.startDialogTurn({
        sessionId,
        clientId: acpClientId,
        userInput: message,
        originalUserInput: displayMessage || message,
        turnId: dialogTurnId,
        workspaceId,
        workspacePath,
        imageContexts: options?.imageContexts,
        userMessageMetadata: options?.userMessageMetadata,
        remoteConnectionId: updatedSession.remoteConnectionId,
        remoteSshHost: updatedSession.remoteSshHost,
      });
      tracker.hostAcceptedTurn = true;
      surfaceScope.assertCurrent('start ACP dialog turn');
      context.flowChatStore.updateSessionLastSubmittedMode(sessionId, currentAgentType);
    } else {
      await inheritReviewPermissionMode(
        updatedSession,
        context.flowChatStore.getState().sessions,
        () => surfaceScope.assertCurrent('inherit review session permission mode'),
      );
      try {
        tracker.hostSubmitStarted = true;
        await agentAPI.startDialogTurn({
          sessionId: sessionId,
          userInput: message,
          originalUserInput: displayMessage || message,
          turnId: dialogTurnId,
          agentType: currentAgentType,
          workspaceId,
          workspacePath,
          projectWorkspacePath,
          remoteConnectionId: updatedSession.remoteConnectionId,
          remoteSshHost: updatedSession.remoteSshHost,
          imageContexts: options?.imageContexts,
          userMessageMetadata: options?.userMessageMetadata,
          execution: options?.execution,
        });
        tracker.hostAcceptedTurn = true;
        surfaceScope.assertCurrent('start dialog turn');
        context.flowChatStore.updateSessionLastSubmittedMode(sessionId, currentAgentType);
      } catch (error: any) {
        if (error?.message?.includes('Session does not exist') || error?.message?.includes('Not found')) {
          log.warn('Backend session still not found, retrying creation', {
            sessionId: sessionId,
            dialogTurnsCount: updatedSession.dialogTurns.length
          });
          tracker.hostSubmitStarted = false;

          // Lazy import: SessionModule routes lifecycle calls through the
          // driver registry, so a static import would create a module cycle.
          const { retryCreateBackendSession } =
            await import('../../services/flow-chat-manager/SessionModule');
          surfaceScope.assertCurrent('load backend session retry');
          await retryCreateBackendSession(context, sessionId);
          surfaceScope.assertCurrent('retry backend session creation');
          await inheritReviewPermissionMode(
            updatedSession,
            context.flowChatStore.getState().sessions,
            () => surfaceScope.assertCurrent('inherit recreated review session permission mode'),
          );

          tracker.hostSubmitStarted = true;
          await agentAPI.startDialogTurn({
            sessionId: sessionId,
            userInput: message,
            originalUserInput: displayMessage || message,
            turnId: dialogTurnId,
            agentType: currentAgentType,
            workspaceId,
            workspacePath,
            projectWorkspacePath,
            remoteConnectionId: updatedSession.remoteConnectionId,
            remoteSshHost: updatedSession.remoteSshHost,
            imageContexts: options?.imageContexts,
            userMessageMetadata: options?.userMessageMetadata,
            execution: options?.execution,
          });
          tracker.hostAcceptedTurn = true;
          surfaceScope.assertCurrent('retry dialog turn submission');
          context.flowChatStore.updateSessionLastSubmittedMode(sessionId, currentAgentType);
        } else {
          throw error;
        }
      }
    }

    if (isFirstMessage) {
      // Release the default title's display slot after the host accepts the
      // first turn, without waiting for asynchronous AI title generation.
      await updateSessionMetadata(context, sessionId, ['titleMetadata']);
      surfaceScope.assertCurrent('release submitted session title slot');
    }

    const sessionStateMachine = stateMachineManager.get(sessionId);
    if (sessionStateMachine) {
      sessionStateMachine.getContext().taskId = sessionId;
    }
    return 'completed';
  },
};
