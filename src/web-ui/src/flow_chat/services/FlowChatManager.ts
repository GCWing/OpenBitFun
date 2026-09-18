import { requireSessionWorkspaceId } from '../utils/sessionWorkspace';
/**
 * Flow Chat unified manager
 * Integrates Agent management and Flow Chat UI state management
 * 
 * Refactoring note:
 * This file is the main entry point, responsible for singleton management, initialization, and module coordination
 * Specific functionality is split into modules under flow-chat-manager/
 */

import { processingStatusManager } from './ProcessingStatusManager';
import { FlowChatStore } from '../store/FlowChatStore';
import { useModernFlowChatStore } from '../store/modernFlowChatStore';
import { ACPClientAPI } from '@/infrastructure/api/service-api/ACPClientAPI';
import { stateMachineManager } from '../state-machine';
import { EventBatcher } from './EventBatcher';
import { createLogger } from '@/shared/utils/logger';
import { installSessionNavStatusService, sessionNavStatusService } from './sessionNavStatusService';
import {
  getActiveSurfaceId,
  getActiveSurfaceScope,
  isSurfaceChangedError,
  onSurfaceActivated,
  type DeviceSurfaceId,
} from '@/infrastructure/peer-device/deviceSurface';
import type { WorkspaceInfo } from '@/shared/types';
import type { Session } from '../types/flow-chat';
import {
  compareSessionsForDisplay,
  sessionBelongsToWorkspaceNavRow,
} from '../utils/sessionOrdering';
import { resolveSessionRelationship } from '../utils/sessionMetadata';
import { createDefaultSessionTitleDescriptor } from '../utils/sessionTitle';
import { i18nService } from '@/infrastructure/i18n';
import { initializeSessionTitleMetadata } from './sessionTitleMetadata';

import type {
  FlowChatContext,
  SessionConfig,
  DialogTurn,
} from './flow-chat-manager/types';
import {
  saveAllInProgressTurns,
  immediateSaveDialogTurn,
  createChatSession as createChatSessionModule,
  hydrateSessionHistoryForDetail as hydrateSessionHistoryForDetailModule,
  preloadHistoricalSessionForOpen as preloadHistoricalSessionForOpenModule,
  switchChatSession as switchChatSessionModule,
  deleteChatSession as deleteChatSessionModule,
  archiveChatSession as archiveChatSessionModule,
  renameChatSessionTitle as renameChatSessionTitleModule,
  reloadSessionTitle as reloadSessionTitleModule,
  forkChatSession as forkChatSessionModule,
  cleanupSaveState,
  cleanupSessionBuffers,
  sendMessage as sendMessageModule,
  cancelCurrentTask as cancelCurrentTaskModule,
  cancelSessionTask as cancelSessionTaskModule,
  installPendingQueueDrainListener,
  drainPendingQueue,
  waitForInFlightSubmissions,
  pendingQueueManager,
  initializeEventListeners,
  processBatchedEvents,
  addDialogTurn as addDialogTurnModule,
  addImageAnalysisPhase as addImageAnalysisPhaseModule,
  updateImageAnalysisResults as updateImageAnalysisResultsModule,
  updateImageAnalysisItem as updateImageAnalysisItemModule,
  updateSessionMetadata,
} from './flow-chat-manager';
import { ensureBackendSession } from './flow-chat-manager/SessionModule';
import { installPeerSessionRefresh } from './flow-chat-manager/PeerSessionRefreshModule';
import { installDispatchJobObserver } from '../session-drivers/dispatch/install';
import { driverForSession } from '../session-drivers/registry';
import { registerDriverSessionLookup } from '../session-drivers/resolve';
import type { SendMessageOptions } from '../session-drivers/types';

const log = createLogger('FlowChatManager');

type FlowChatSendMessageOptions = Pick<
  SendMessageOptions,
  | 'imageContexts'
  | 'imageDisplayData'
  | 'pendingQueueDraft'
  | 'userMessageMetadata'
  | 'execution'
  | 'turnId'
  | 'preserveTurnOnStartError'
  | 'onSessionConflictRetryStart'
  | 'onSessionConflictRetrySuccess'
  | 'sessionMutationLeaseId'
>;

/** Backstop cadence for re-establishing a subscription that failed to start. */
const EVENT_LISTENER_RETRY_MS = 2000;

export class FlowChatManager {
  private static instance: FlowChatManager | null = null;
  private context: FlowChatContext;
  private eventListenerInitialized = false;
  private eventListenerInitializationPromise: Promise<void> | null = null;
  private eventListenerCleanup: (() => void) | null = null;
  private initializationRequests = new Map<string, Promise<boolean>>();
  private latestInitializationRequestKey: string | null = null;
  private peerSessionRefreshCleanup: (() => void) | null = null;
  private dispatchJobObserverCleanup: (() => void) | null = null;
  private navStatusCleanup: (() => void) | null = null;
  private surfaceActivationCleanup: (() => void) | null = null;
  private eventListenerRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  private constructor() {
    this.context = {
      flowChatStore: FlowChatStore.getInstance(),
      processingManager: processingStatusManager,
      eventBatcher: new EventBatcher({
        onFlush: (events) => this.processBatchedEvents(events)
      }),
      pendingTurnCompletions: new Map(),
      pendingHistoryLoads: new Map(),
      pendingHistoryLoadCapabilities: new Map(),
      pendingContextRestores: new Map(),
      contentBuffers: new Map(),
      activeTextItems: new Map(),
      saveDebouncers: new Map(),
      lastSaveTimestamps: new Map(),
      lastSaveHashes: new Map(),
      turnSaveInFlight: new Map(),
      turnSavePending: new Set(),
      deferredStorageIdentitySaves: new Set(),
      runtimeStatusTimers: new Map(),
      userCancelledSessionIds: new Set(),
      pendingHistoryFenceSessions: new Set(),
      handledTerminalTurnEvents: new Set(),
      currentWorkspaceId: null,
      currentWorkspacePath: null,
      ensureLiveSubscription: () => this.ensureEventListeners(),
    };

    registerDriverSessionLookup(
      sessionId => this.context.flowChatStore.getState().sessions.get(sessionId),
    );
    this.context.flowChatStore.registerPersistUnreadCompletionCallback((sessionId, value) => {
      updateSessionMetadata(this.context, sessionId, ['unreadCompletion', 'needsUserAttention']).catch(err => {
        log.warn('Failed to persist unread completion change', { sessionId, value, err });
      });
    });
    installPendingQueueDrainListener(this.context);
    this.peerSessionRefreshCleanup = installPeerSessionRefresh(this.context);
    this.dispatchJobObserverCleanup = installDispatchJobObserver(this.context);
    this.navStatusCleanup = installSessionNavStatusService();
    // The agentic subscription is this window's only live view of a running
    // Turn, so its lifetime must not depend on a workspace bootstrap that a
    // rapid switch is allowed to abandon. Re-arm on every activation instead.
    this.surfaceActivationCleanup = onSurfaceActivated(() => {
      void this.ensureEventListeners();
    });
  }

  /** Public hook used by the queue panel "send now" fallback to drain head item. */
  async drainPendingQueueForSession(
    sessionId: string,
    options?: { allowInterruptedRecoveryAbandon?: boolean },
  ): Promise<void> {
    return drainPendingQueue(this.context, sessionId, options);
  }

  public static getInstance(): FlowChatManager {
    if (!FlowChatManager.instance) {
      FlowChatManager.instance = new FlowChatManager();
    }
    return FlowChatManager.instance;
  }

  public static disposeInstance(): void {
    FlowChatManager.instance?.destroy();
    FlowChatManager.instance = null;
  }

  async initialize(workspace: Pick<WorkspaceInfo, 'id' | 'rootPath' | 'workspaceKind' | 'connectionId' | 'sshHost'>, preferredMode?: string): Promise<boolean> {
    const workspacePath = workspace.rootPath;
    if (this.disposed) {
      log.debug('Ignoring initialize call on disposed FlowChatManager', { workspacePath });
      return false;
    }

    const requestKey = JSON.stringify([getActiveSurfaceId(), workspace.id, preferredMode ?? '']);
    const existingRequest = this.initializationRequests.get(requestKey);
    this.latestInitializationRequestKey = requestKey;
    if (existingRequest) {
      return existingRequest;
    }

    const request = this.initializeWorkspace(
      requestKey,
      workspace.id,
      workspacePath,
      preferredMode,
    ).finally(() => {
      if (this.initializationRequests.get(requestKey) === request) {
        this.initializationRequests.delete(requestKey);
      }
    });
    this.initializationRequests.set(requestKey, request);
    return request;
  }

  private async initializeWorkspace(
    requestKey: string,
    workspaceId: string,
    workspacePath: string,
    preferredMode?: string
  ): Promise<boolean> {
    const scope = getActiveSurfaceScope();
    try {
      await this.initializeEventListeners();
      if (this.disposed) {
        return false;
      }

      const initialMetadataPage = await this.context.flowChatStore.loadSessionMetadataPage(
        workspaceId, 5, undefined,
        'flow_chat_manager'
      );
      if (this.disposed) {
        return false;
      }

      // This page belongs to the device it was read from and has already landed
      // in that surface's own container. Selecting a session out of it now would
      // apply one device's history to another; the surface this window moved to
      // runs its own bootstrap.
      scope.assertCurrent('initializeWorkspace');

      const sessionMatchesWorkspace = (session: Session) => {
        return sessionBelongsToWorkspaceNavRow(
          session, workspaceId
        );
      };
      const isAutoSelectableWorkspaceSession = (
        session: Pick<Session, 'isTransient' | 'persistedStatus' | 'sessionKind' | 'parentSessionId' | 'btwOrigin'>
      ) => {
        if (session.isTransient || session.persistedStatus === 'archived') {
          return false;
        }
        return !resolveSessionRelationship(session).displayAsChild;
      };

      let state = this.context.flowChatStore.getState();
      let workspaceSessions = Array
        .from(state.sessions.values())
        .filter(session => sessionMatchesWorkspace(session) && isAutoSelectableWorkspaceSession(session));
      if (
        preferredMode &&
        initialMetadataPage.hasMore &&
        !workspaceSessions.some(session => session.mode === preferredMode)
      ) {
        let nextCursor = initialMetadataPage.nextCursor;
        while (nextCursor) {
          const nextPage = await this.context.flowChatStore.loadSessionMetadataPage(
            workspaceId, 5, nextCursor,
            'flow_chat_manager_preferred_mode'
          );
          if (this.disposed) {
            return false;
          }
          scope.assertCurrent('initializeWorkspace');
          state = this.context.flowChatStore.getState();
          workspaceSessions = Array
            .from(state.sessions.values())
            .filter(session => sessionMatchesWorkspace(session) && isAutoSelectableWorkspaceSession(session));
          if (workspaceSessions.some(session => session.mode === preferredMode) || !nextPage.hasMore) {
            break;
          }
          nextCursor = nextPage.nextCursor;
        }
      }
      const hasHistoricalSessions =
        workspaceSessions.length > 0 ||
        initialMetadataPage.totalTopLevelCount > 0 ||
        initialMetadataPage.sessions.length > 0;
      const isCurrentInitializationRequest = () =>
        this.latestInitializationRequestKey === requestKey;
      const activeSession = state.activeSessionId
        ? state.sessions.get(state.activeSessionId) ?? null
        : null;
      const activeSessionBelongsToWorkspace =
        !!activeSession && activeSession.persistedStatus !== 'archived' && sessionMatchesWorkspace(activeSession);
      const activeSessionIdAtAutoSelectStart = state.activeSessionId;
      const clearUnavailableSelection = () => {
        if (!isCurrentInitializationRequest() || activeSessionIdAtAutoSelectStart === null) {
          return;
        }
        this.context.flowChatStore.setState(current =>
          current.activeSessionId === activeSessionIdAtAutoSelectStart
            ? { ...current, activeSessionId: null }
            : current
        );
      };

      // History is only restored on the auto-select path below. A session that
      // is already active — restored by the nav list after a Peer Device
      // surface switch, for example — keeps its metadata-only projection, so
      // the breadcrumb and turn rail render from the catalog while the message
      // area stays empty until the user clicks the session by hand.
      if (
        activeSessionBelongsToWorkspace &&
        activeSession &&
        activeSession.isHistorical === true &&
        isCurrentInitializationRequest()
      ) {
        await this.context.flowChatStore.loadSessionHistory(activeSession.sessionId);
        if (this.disposed) {
          return false;
        }
        scope.assertCurrent('initializeWorkspace');
      }

      if (hasHistoricalSessions && !activeSessionBelongsToWorkspace) {
        if (!isCurrentInitializationRequest()) {
          return hasHistoricalSessions;
        }
        const sortedWorkspaceSessions = [...workspaceSessions].sort(compareSessionsForDisplay);
        const latestSession = (preferredMode
          ? sortedWorkspaceSessions.find(session => session.mode === preferredMode)
          : undefined) || sortedWorkspaceSessions[0];

        if (!latestSession) {
          // The caller reads the return value as "a session is available, do
          // not create one". Reporting history we cannot select would leave the
          // surface with no active session and no new one, so report no history
          // and let the caller create against the live workspace instead.
          this.context.currentWorkspaceId = workspaceId;
          this.context.currentWorkspacePath = workspacePath;
          clearUnavailableSelection();
          log.warn('Session metadata reported history with nothing selectable for this workspace', {
            workspacePath,
            metadataSessionCount: initialMetadataPage.sessions.length,
            totalTopLevelCount: initialMetadataPage.totalTopLevelCount,
          });
          return false;
        }

        if (latestSession.isHistorical) {
          await this.context.flowChatStore.loadSessionHistory(latestSession.sessionId);
          if (this.disposed) {
            return false;
          }
          scope.assertCurrent('initializeWorkspace');
        }

        if (!isCurrentInitializationRequest()) {
          return hasHistoricalSessions;
        }

        const currentState = this.context.flowChatStore.getState();
        const currentActiveSession = currentState.activeSessionId
          ? currentState.sessions.get(currentState.activeSessionId) ?? null
          : null;
        const currentActiveSessionBelongsToWorkspace =
          !!currentActiveSession && currentActiveSession.persistedStatus !== 'archived' && sessionMatchesWorkspace(currentActiveSession);
        const activeSessionChangedDuringAutoSelect =
          currentState.activeSessionId !== activeSessionIdAtAutoSelectStart &&
          currentState.activeSessionId !== null;
        if (currentActiveSessionBelongsToWorkspace) {
          this.context.currentWorkspaceId = workspaceId;
          this.context.currentWorkspacePath = workspacePath;
          return hasHistoricalSessions;
        }
        if (activeSessionChangedDuringAutoSelect) {
          return hasHistoricalSessions;
        }

        // Archive/delete can finish while history is loading. Do not activate
        // the old catalog entry after that mutation removed it.
        const candidate = currentState.sessions.get(latestSession.sessionId);
        if (!candidate || !sessionMatchesWorkspace(candidate) || !isAutoSelectableWorkspaceSession(candidate)) {
          this.context.currentWorkspaceId = workspaceId;
          this.context.currentWorkspacePath = workspacePath;
          clearUnavailableSelection();
          return false;
        }

        await switchChatSessionModule(this.context, latestSession.sessionId);
      }

      if (isCurrentInitializationRequest()) {
        this.context.currentWorkspaceId = workspaceId;
        this.context.currentWorkspacePath = workspacePath;
        if (!hasHistoricalSessions && !activeSessionBelongsToWorkspace) {
          clearUnavailableSelection();
        }
      }

      return hasHistoricalSessions;
    } catch (error) {
      // Must not return false: callers treat false as "no history → create
      // session", which in Peer Device Mode can create on the peer with a
      // stale controller workspace path. A surface change is not a failure
      // either — this bootstrap simply no longer owns the rendered device —
      // but it must still not report "no history" to the caller.
      if (isSurfaceChangedError(error)) {
        log.debug('Abandoned workspace initialization after a device surface switch', {
          workspacePath,
        });
        throw error;
      }
      log.error('Initialization failed', error);
      throw error;
    }
  }

  /**
   * Guarantee this window has a live agentic subscription.
   *
   * Idempotent and safe to call from anywhere. It exists because the
   * subscription used to be re-established only as a side effect of a
   * successful workspace bootstrap: a switch tore it down, and a bootstrap that
   * a newer switch legitimately superseded left the window with no live Turn
   * events and nothing to retry — a permanently frozen chat.
   */
  public async ensureEventListeners(): Promise<void> {
    try {
      await this.initializeEventListeners();
    } catch (error) {
      if (isSurfaceChangedError(error)) {
        return;
      }
      log.warn('Failed to establish the agentic subscription; retrying', { error });
      this.scheduleEventListenerRetry();
    }
  }

  /**
   * A failed subscription cannot repair itself from the event path, so recovery
   * is time-based. The reconcile loop also calls `ensureEventListeners` when it
   * observes a dead subscription, so this is the backstop, not the only path.
   */
  private scheduleEventListenerRetry(): void {
    if (this.disposed || this.eventListenerRetryTimer !== null) {
      return;
    }
    this.eventListenerRetryTimer = setTimeout(() => {
      this.eventListenerRetryTimer = null;
      if (this.disposed || this.eventListenerInitialized) {
        return;
      }
      void this.ensureEventListeners();
    }, EVENT_LISTENER_RETRY_MS);
  }

  private async initializeEventListeners(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.eventListenerInitialized) {
      return;
    }
    if (this.eventListenerInitializationPromise) {
      return this.eventListenerInitializationPromise;
    }

    this.eventListenerInitializationPromise = (async () => {
      const cleanup = await initializeEventListeners(
        this.context,
        (sessionId, turnId, result) => this.handleTodoWriteResult(sessionId, turnId, result)
      );

      if (this.disposed) {
        cleanup();
        return;
      }

      this.eventListenerCleanup = cleanup;
      this.eventListenerInitialized = true;
      // Cron startup is gated on FlowChat listener readiness so startup-time
      // scheduled runs do not emit into an unregistered desktop event bridge.
      void import('@/infrastructure/api/service-api/CronAPI')
        .then(({ cronAPI }) => cronAPI.notifyHostReady())
        .catch(error => {
          log.warn('Failed to notify cron host readiness', error);
        });
    })();

    try {
      await this.eventListenerInitializationPromise;
    } finally {
      this.eventListenerInitializationPromise = null;
    }
  }

  public cleanupEventListeners(): void {
    if (this.eventListenerCleanup) {
      this.eventListenerCleanup();
      this.eventListenerCleanup = null;
      this.eventListenerInitialized = false;
    }
    this.eventListenerInitializationPromise = null;
  }

  /**
   * Let submissions that already created a projection turn hand it to their
   * host before the rendered transport changes.
   *
   * Without this, a switch during the async window in `startTurn` (state
   * transition, worktree binding, model sync) resumes against a store that no
   * longer holds the session, and the turn is lost before `start_dialog_turn`
   * ever runs. A timeout is safe: `sendMessage` detects the surface change and
   * re-queues the message.
   */
  public async waitForInFlightSubmissions(timeoutMs: number): Promise<boolean> {
    return waitForInFlightSubmissions(timeoutMs);
  }

  /**
   * Detach this window from the device it is rendering, before the transport
   * swaps to another one.
   *
   * The store keeps that device's sessions in its own container, so nothing is
   * deleted here: state machines and processing status stay alive for work the
   * device may still be running, and returning to it renders immediately.
   *
   * Debounced disk writes are the exception. They are addressed by session id
   * only, so a checkpoint that fires after the transport swap would persist one
   * device's turn onto another's disk. Drop them; the host keeps its own copy
   * and reconciliation re-reads it.
   */
  public resetForPeerModeSwitch(): string[] {
    this.cleanupEventListeners();
    this.initializationRequests.clear();
    this.latestInitializationRequestKey = null;
    // Drop controller-local path so createChatSession cannot reuse a stale
    // Windows/Mac path against the peer host after the surface switch.
    this.context.currentWorkspaceId = null;
    this.context.currentWorkspacePath = null;
    const detachedSessionIds = Array.from(
      this.context.flowChatStore.getState().sessions.keys(),
    );
    detachedSessionIds.forEach(sessionId => {
      cleanupSaveState(this.context, sessionId);
      cleanupSessionBuffers(this.context, sessionId);
    });
    this.context.flowChatStore.prepareForSurfaceSwitch();
    try {
      useModernFlowChatStore.getState().clear();
    } catch (error) {
      log.warn('Failed to clear modern FlowChat store during peer switch', error);
    }
    // No session ids: a switch removes nothing, and callers must not tear down
    // runtime state for sessions that still exist on their own device.
    return [];
  }

  /** Permanently forget a peer that was explicitly detached or became lost. */
  public discardDeviceSurface(surfaceId: DeviceSurfaceId): void {
    this.context.flowChatStore.discardSurfaceState(surfaceId);
    sessionNavStatusService.clearSurface(surfaceId);
    stateMachineManager.clearSurface(surfaceId);
    this.context.processingManager.clearSurface(surfaceId);
    pendingQueueManager.clearSurface(surfaceId);
  }

  public destroy(): void {
    if (this.disposed) {
      return;
    }

    this.context.eventBatcher.flushNow();
    this.disposed = true;
    this.initializationRequests.clear();
    this.latestInitializationRequestKey = null;
    this.cleanupEventListeners();
    if (this.eventListenerRetryTimer !== null) {
      clearTimeout(this.eventListenerRetryTimer);
      this.eventListenerRetryTimer = null;
    }
    this.surfaceActivationCleanup?.();
    this.surfaceActivationCleanup = null;
    this.peerSessionRefreshCleanup?.();
    this.peerSessionRefreshCleanup = null;
    this.dispatchJobObserverCleanup?.();
    this.dispatchJobObserverCleanup = null;
    this.navStatusCleanup?.();
    this.navStatusCleanup = null;
    this.context.eventBatcher.destroy();
  }

  private processBatchedEvents(events: Array<{ key: string; payload: any }>): void {
    if (this.disposed) {
      return;
    }

    processBatchedEvents(
      this.context,
      events,
      (sessionId, turnId, result) => this.handleTodoWriteResult(sessionId, turnId, result)
    );
  }

  async createChatSession(config: SessionConfig, mode?: string): Promise<string> {
    return createChatSessionModule(this.context, config, mode);
  }

  async createAcpChatSession(clientId: string, config: SessionConfig = {}): Promise<string> {
    const surfaceScope = getActiveSurfaceScope();
    const titleDescriptor = createDefaultSessionTitleDescriptor((key, options) => i18nService.t(key, options));
    // The workspace ID is the session's identity; the path is the ACP
    // client's execution root and is only kept as an IO projection.
    const workspaceId = requireSessionWorkspaceId({ config });
    const workspacePath =
      config.workspacePath?.trim() ||
      this.context.currentWorkspacePath?.trim();
    if (!workspacePath) {
      throw new Error('Workspace path is required to create an ACP session');
    }

    window.dispatchEvent(new CustomEvent('openbitfun:acp-session-creation', {
      detail: { phase: 'start', clientId, action: 'create' },
    }));

    let succeeded = false;
    try {
      const response = await ACPClientAPI.createFlowSession({
        clientId,
        workspaceId,
        workspacePath,
        remoteConnectionId: config.remoteConnectionId,
        remoteSshHost: config.remoteSshHost,
        sessionName: titleDescriptor.text,
      });

      surfaceScope.assertCurrent('create ACP backend session');
      const createdTitleDescriptor = await initializeSessionTitleMetadata(
        response.sessionId, titleDescriptor, workspaceId,
        surfaceScope,
      );

      this.context.flowChatStore.createSession(
        response.sessionId,
        {
          ...config,
          workspacePath,
          agentType: response.agentType,
        },
        undefined,
        response.sessionName,
        128128,
        response.agentType,
        workspacePath,
        config.remoteConnectionId,
        config.remoteSshHost,
        createdTitleDescriptor,
      );

      succeeded = true;
      return response.sessionId;
    } finally {
      window.dispatchEvent(new CustomEvent('openbitfun:acp-session-creation', {
        detail: { phase: 'finish', clientId, action: 'create', succeeded },
      }));
    }
  }

  async switchChatSession(sessionId: string, isStillRelevant?: () => boolean): Promise<void> {
    return switchChatSessionModule(this.context, sessionId, isStillRelevant);
  }

  preloadHistoricalSessionForOpen(sessionId: string): void {
    preloadHistoricalSessionForOpenModule(this.context, sessionId);
  }

  async hydrateSessionHistoryForDetail(
    sessionId: string,
    ): Promise<void> {
    await hydrateSessionHistoryForDetailModule(this.context, sessionId);
  }

  async deleteChatSession(sessionId: string): Promise<void> {
    return deleteChatSessionModule(this.context, sessionId);
  }

  async archiveChatSession(sessionId: string): Promise<void> {
    return archiveChatSessionModule(this.context, sessionId);
  }

  public discardLocalSession(sessionId: string): string[] {
    const removedSessionIds = this.context.flowChatStore.removeSession(sessionId);
    removedSessionIds.forEach(id => {
      stateMachineManager.delete(id);
      this.context.processingManager.clearSessionStatus(id);
      cleanupSaveState(this.context, id);
      cleanupSessionBuffers(this.context, id);
    });
    return removedSessionIds;
  }

  /** Restores a persisted session into the coordinator before a non-message workflow uses it. */
  public async ensureBackendSession(sessionId: string): Promise<void> {
    await ensureBackendSession(this.context, sessionId);
  }

  public discardLocalSessionsForWorkspace(
    workspace: Pick<WorkspaceInfo, 'id' | 'rootPath' | 'connectionId' | 'sshHost'>
  ): string[] {
    const removedSessionIds = this.context.flowChatStore.removeSessionsForWorkspace(workspace);
    removedSessionIds.forEach(id => {
      stateMachineManager.delete(id);
      this.context.processingManager.clearSessionStatus(id);
      cleanupSaveState(this.context, id);
      cleanupSessionBuffers(this.context, id);
    });
    return removedSessionIds;
  }

  async refreshWorkspaceSessions(
    workspace: Pick<WorkspaceInfo, 'id'>
  ): Promise<void> {
    await this.context.flowChatStore.refreshWorkspaceFromDisk(
      workspace.id
    );
  }

  async renameChatSessionTitle(sessionId: string, title: string): Promise<string> {
    return renameChatSessionTitleModule(this.context, sessionId, title);
  }

  async reloadSessionTitle(sessionId: string): Promise<void> {
    await reloadSessionTitleModule(this.context, sessionId);
  }

  async forkChatSession(sourceSessionId: string, sourceTurnId: string): Promise<string> {
    return forkChatSessionModule(this.context, sourceSessionId, sourceTurnId);
  }

  async resetWorkspaceSessions(
    workspace: Pick<WorkspaceInfo, 'id' | 'rootPath' | 'workspaceKind' | 'connectionId' | 'sshHost'>,
    options?: {
      reinitialize?: boolean;
      preferredMode?: string;
    }
  ): Promise<void> {
    const workspacePath = workspace.rootPath;
    const remoteConnectionId = workspace.connectionId ?? null;
    const remoteSshHost = workspace.sshHost ?? null;
    const removedSessionIds = this.context.flowChatStore.removeSessionsForWorkspace(workspace);

    removedSessionIds.forEach(sessionId => {
      stateMachineManager.delete(sessionId);
      this.context.processingManager.clearSessionStatus(sessionId);
      cleanupSaveState(this.context, sessionId);
      cleanupSessionBuffers(this.context, sessionId);
    });

    if (!options?.reinitialize) {
      return;
    }

    const hasHistoricalSessions = await this.initialize(
      workspace, options.preferredMode
    );
    const state = this.context.flowChatStore.getState();
    const activeSession = state.activeSessionId
      ? state.sessions.get(state.activeSessionId) ?? null
      : null;
    const hasActiveWorkspaceSession =
      !!activeSession &&
      sessionBelongsToWorkspaceNavRow(activeSession, workspace.id);

    if (!hasHistoricalSessions || !hasActiveWorkspaceSession) {
      await this.createChatSession(
        {
          workspacePath,
          workspaceId: workspace.id,
          ...(remoteConnectionId ? { remoteConnectionId } : {}),
          ...(remoteSshHost ? { remoteSshHost } : {}),
        },
        options.preferredMode
      );
    }
  }

  async sendMessage(
    message: string,
    sessionId?: string,
    displayMessage?: string,
    agentType?: string,
    switchToMode?: string,
    options?: FlowChatSendMessageOptions,
  ): Promise<void> {
    const targetSessionId = sessionId || this.context.flowChatStore.getState().activeSessionId;
    
    if (!targetSessionId) {
      throw new Error('No active session');
    }

    return sendMessageModule(
      this.context,
      message,
      targetSessionId,
      displayMessage,
      agentType,
      switchToMode,
      options
    );
  }

  async cancelCurrentTask(): Promise<boolean> {
    return cancelCurrentTaskModule(this.context);
  }

  async cancelSessionTask(sessionId: string): Promise<boolean> {
    return cancelSessionTaskModule(this.context, sessionId);
  }

  /** Manually compact a session's context through its driver. */
  async compactSession(sessionId: string): Promise<void> {
    const session = this.context.flowChatStore.getState().sessions.get(sessionId);
    return driverForSession(sessionId, session).compactSession(this.context, sessionId);
  }

  /** Produce the session usage report and show it, through its driver. */
  async runSessionUsageReport(
    sessionId: string,
    uiParams: import('../session-drivers/types').UsageReportUiParams,
  ): Promise<{ shown: boolean }> {
    const session = this.context.flowChatStore.getState().sessions.get(sessionId);
    return driverForSession(sessionId, session).runUsageReport(this.context, sessionId, uiParams);
  }

  public async saveAllInProgressTurns(): Promise<void> {
    return saveAllInProgressTurns(this.context);
  }

  /**
   * Save a specific dialog turn to disk.
   * Used when tool call data is updated after the turn has completed (e.g. mermaid code fix).
   */
  public async saveDialogTurn(sessionId: string, turnId: string): Promise<void> {
    return immediateSaveDialogTurn(this.context, sessionId, turnId, true);
  }

  addDialogTurn(sessionId: string, dialogTurn: DialogTurn): void {
    addDialogTurnModule(this.context, sessionId, dialogTurn);
  }

  addImageAnalysisPhase(
    sessionId: string,
    dialogTurnId: string,
    imageContexts: import('@/shared/types/context').ImageContext[]
  ): void {
    addImageAnalysisPhaseModule(this.context, sessionId, dialogTurnId, imageContexts);
  }

  updateImageAnalysisResults(
    sessionId: string,
    dialogTurnId: string,
    results: import('../types/flow-chat').ImageAnalysisResult[]
  ): void {
    updateImageAnalysisResultsModule(this.context, sessionId, dialogTurnId, results);
  }

  updateImageAnalysisItem(
    sessionId: string,
    dialogTurnId: string,
    imageId: string,
    updates: { status?: 'analyzing' | 'completed' | 'error'; error?: string; result?: any }
  ): void {
    updateImageAnalysisItemModule(this.context, sessionId, dialogTurnId, imageId, updates);
  }

  getCurrentSession() {
    return this.context.flowChatStore.getActiveSession();
  }

  getFlowChatState() {
    return this.context.flowChatStore.getState();
  }

  getAllProcessingStatuses() {
    return this.context.processingManager.getAllStatuses();
  }

  onFlowChatStateChange(callback: (state: any) => void) {
    return this.context.flowChatStore.subscribe(callback);
  }

  onProcessingStatusChange(callback: (statuses: any[]) => void) {
    return this.context.processingManager.addListener(callback);
  }

  getSessionIdByTaskId(taskId: string): string | undefined {
    return taskId;
  }

  private handleTodoWriteResult(sessionId: string, turnId: string, result: any): void {
    try {
      if (!result.todos || !Array.isArray(result.todos)) {
        log.debug('TodoWrite result missing todos array', { sessionId, turnId });
        return;
      }

      const incomingTodos: import('../types/flow-chat').TodoItem[] = result.todos.map((todo: any) => ({
        id: todo.id,
        content: todo.content,
        status: todo.status,
      }));

      if (result.merge) {
        const existingTodos = this.context.flowChatStore.getDialogTurnTodos(sessionId, turnId);
        const todoMap = new Map<string, import('../types/flow-chat').TodoItem>();
        
        existingTodos.forEach(todo => {
          todoMap.set(todo.id, todo);
        });
        
        incomingTodos.forEach(todo => {
          todoMap.set(todo.id, todo);
        });
        
        const mergedTodos = Array.from(todoMap.values());
        this.context.flowChatStore.setDialogTurnTodos(sessionId, turnId, mergedTodos);
      } else {
        this.context.flowChatStore.setDialogTurnTodos(sessionId, turnId, incomingTodos);
      }
      
      this.syncTodosToStateMachine(sessionId);
      
      window.dispatchEvent(new CustomEvent('openbitfun:todowrite-update', {
        detail: {
          sessionId,
          turnId,
          todos: incomingTodos,
          merge: result.merge
        }
      }));
    } catch (error) {
      log.error('Failed to handle TodoWrite result', { sessionId, turnId, error });
    }
  }

  private syncTodosToStateMachine(sessionId: string): void {
    const machine = stateMachineManager.get(sessionId);
    if (!machine) return;
    
    const todos = this.context.flowChatStore.getTodos(sessionId);
    const context = machine.getContext();
    
    const plannerTodos = todos.map(todo => ({
      id: todo.id,
      content: todo.content,
      status: todo.status,
    }));
    
    if (context) {
      context.planner = {
        todos: plannerTodos,
        isActive: todos.length > 0
      };
    }
  }
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    FlowChatManager.disposeInstance();
  });
}

export const flowChatManager = FlowChatManager.getInstance();
export default flowChatManager;
