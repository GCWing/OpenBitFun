import { requireSessionWorkspaceId } from '../../utils/sessionWorkspace';
/**
 * Session management module
 * Handles session creation, switching, deletion, and other operations
 */

import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import { configAPI } from '@/infrastructure/api/service-api/ConfigAPI';
import { sessionAPI } from '@/infrastructure/api/service-api/SessionAPI';
import { isSessionInUseError } from '@/infrastructure/api/errors/TauriCommandError';
import { notificationService } from '../../../shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { isRemoteTraceContext, startupTrace } from '@/shared/utils/startupTrace';
import { elapsedMs, nowMs } from '@/shared/utils/timing';
import { i18nService } from '@/infrastructure/i18n';
import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import {
  getActiveSurfaceScope,
  isSurfaceChangedError,
  type SurfaceScope,
} from '@/infrastructure/peer-device/deviceSurface';
import { WorkspaceKind, type WorkspaceInfo } from '@/shared/types';
import type {
  FlowChatContext,
  SessionConfig,
} from './types';
import type { Session } from '../../types/flow-chat';
import { touchSessionActivity } from './PersistenceModule';
import {
  createTextSessionTitleDescriptor,
  createDefaultSessionTitleDescriptor,
  deriveSessionTitleStateFromMetadata,
  resolveSessionTitle,
} from '../../utils/sessionTitle';
import { buildCreateSessionRelationship } from '../../utils/sessionMetadata';
import {
  clearHistorySessionOpenTransition,
  clearRecentHistorySessionOpenIntent,
  consumeRecentHistorySessionOpenIntent,
  hasRenderableSessionContent,
} from '../sessionOpenIntent';
import {
  clearHistorySessionHydratePending,
  markHistorySessionHydratePending,
  recordHistorySessionDiagnosticEvent,
} from '../historySessionDiagnostics';
import {
  CHAT_INPUT_MODE_PREFERENCE_CONFIG_PATH,
  normalizeChatInputModePreference,
  resolveConfiguredChatInputDefaultModeId,
} from '../ChatInputModePreferenceService';
import type { AppFlowChatConfig } from '@/infrastructure/config/types';
import {
  requireSessionProjectWorkspacePath,
} from '../../utils/sessionWorkspace';
import { driverForCreation, driverForSession } from '../../session-drivers/registry';
import {
  isProjectedFirstRuntimeTurn,
  isProjectedSessionEmpty,
} from '../../utils/flowChatTurnIdentity';

const log = createLogger('SessionModule');
const pendingSessionCreations = new Map<string, Promise<string>>();

export const SESSION_ACTIVITY_TOUCH_DELAY_MS = 350;
let latestSwitchRequestId = 0;
let pendingActivityTouchTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSessionActivityTouch(scope: SurfaceScope, task: () => void): void {
  if (pendingActivityTouchTimer !== null) {
    clearTimeout(pendingActivityTouchTimer);
  }
  pendingActivityTouchTimer = setTimeout(() => {
    pendingActivityTouchTimer = null;
    if (!scope.isCurrent()) {
      return;
    }
    task();
  }, SESSION_ACTIVITY_TOUCH_DELAY_MS);
}

export function pendingHistoryLoadKey(
  sessionId: string,
  scope: SurfaceScope = getActiveSurfaceScope(),
): string {
  return scope.key('history-load', scope.epoch, sessionId);
}

function pendingHistoryLoadSessionId(
  key: string,
  scope: SurfaceScope,
): string | null {
  try {
    const parsed = JSON.parse(key) as unknown;
    if (
      Array.isArray(parsed)
      && parsed[0] === scope.surfaceId
      && parsed[1] === 'history-load'
      && parsed[2] === scope.epoch
      && typeof parsed[3] === 'string'
    ) {
      return parsed[3];
    }
  } catch {
    // In-flight keys are internal and non-persistent; unknown keys are ignored.
  }
  return null;
}

function hasCompetingHistoryLoad(
  context: FlowChatContext,
  sessionId: string,
  scope: SurfaceScope = getActiveSurfaceScope(),
): boolean {
  return Array.from(context.pendingHistoryLoads.keys()).some(key => {
    const pendingSessionId = pendingHistoryLoadSessionId(key, scope);
    return pendingSessionId !== null && pendingSessionId !== sessionId;
  });
}

async function hydrateHistoricalSession(
  context: FlowChatContext,
  sessionId: string,
  notifyOnError: boolean,
  options?: {
    isRetryStillRelevant?: () => boolean;
    retryActiveStaleReuse?: boolean;
    allowNonHistorical?: boolean;
    includeInternal?: boolean;
    deferFullHistoryUntilActive?: boolean;
  },
): Promise<void> {
  const surfaceScope = getActiveSurfaceScope();
  const initialSession = context.flowChatStore.getState().sessions.get(sessionId);
  if (!initialSession) return;
  const workspaceId = requireSessionWorkspaceId(initialSession);
  const pendingKey = pendingHistoryLoadKey(sessionId, surfaceScope);
  const existing = context.pendingHistoryLoads.get(pendingKey);
  if (existing) {
    const existingCapabilities = context.pendingHistoryLoadCapabilities?.get(pendingKey);
    const requiresStrongerHydrate =
      (options?.includeInternal === true && existingCapabilities?.includeInternal !== true) ||
      (options?.deferFullHistoryUntilActive === false &&
        existingCapabilities?.deferFullHistoryUntilActive !== false) ||
      existingCapabilities?.workspaceId !== workspaceId;
    startupTrace.markPhase('historical_session_hydrate_reused');
    recordHistorySessionDiagnosticEvent(sessionId, 'hydrate_reused_pending', {
      notifyOnError,
      retryActiveStaleReuse: options?.retryActiveStaleReuse === true,
    });
    let existingFailed = false;
    let existingError: unknown;
    try {
      await existing;
      surfaceScope.assertCurrent('reuse historical session hydration');
    } catch (error) {
      existingFailed = true;
      existingError = error;
    }
    if (requiresStrongerHydrate) {
      surfaceScope.assertCurrent('upgrade historical session hydration');
      if (context.pendingHistoryLoads.get(pendingKey) === existing) {
        context.pendingHistoryLoads.delete(pendingKey);
      }
      if (context.pendingHistoryLoadCapabilities?.get(pendingKey)?.promise === existing) {
        context.pendingHistoryLoadCapabilities.delete(pendingKey);
      }
      await hydrateHistoricalSession(context, sessionId, notifyOnError, options);
      return;
    }
    if (existingFailed) {
      throw existingError;
    }
    const retryStillRelevant = options?.isRetryStillRelevant?.() !== false;
    const shouldRetryActiveStale = shouldRetryActiveStaleHydrate(context, sessionId);
    recordHistorySessionDiagnosticEvent(sessionId, 'hydrate_reused_settled', {
      retryActiveStaleReuse: options?.retryActiveStaleReuse === true,
      retryStillRelevant,
      shouldRetryActiveStale,
    });
    if (
      options?.retryActiveStaleReuse === true &&
      retryStillRelevant &&
      shouldRetryActiveStale
    ) {
      if (context.pendingHistoryLoads.get(pendingKey) === existing) {
        context.pendingHistoryLoads.delete(pendingKey);
      }
      startupTrace.markPhase('historical_session_hydrate_retry_active_stale_reuse', {
        sessionId,
      });
      recordHistorySessionDiagnosticEvent(sessionId, 'hydrate_retry_active_stale_reuse_started');
      await hydrateHistoricalSession(context, sessionId, notifyOnError);
    } else if (options?.retryActiveStaleReuse === true) {
      recordHistorySessionDiagnosticEvent(sessionId, 'hydrate_retry_active_stale_reuse_skipped', {
        reason: retryStillRelevant ? 'active_stale_condition_not_met' : 'switch_superseded',
      });
    }
    return;
  }
  const traceStartedAt = nowMs();

  const loadPromise = (async () => {
    surfaceScope.assertCurrent('start historical session hydration');
    const session = context.flowChatStore.getState().sessions.get(sessionId);
    if (!session || (!session.isHistorical && options?.allowNonHistorical !== true)) {
      recordHistorySessionDiagnosticEvent(sessionId, 'hydrate_request_skipped', {
        reason: session ? 'not_historical' : 'missing_session',
      });
      return;
    }

    const storedConnectionId = session.remoteConnectionId;
    const storedSshHost = session.remoteSshHost;
    const remote = isRemoteTraceContext(storedConnectionId, storedSshHost);
    const deferFullHistoryUntilActive = options?.deferFullHistoryUntilActive ?? true;
    markHistorySessionHydratePending(sessionId, {
      notifyOnError,
      remote,
      deferFullHistoryUntilActive,
    });
    startupTrace.markPhase('historical_session_hydrate_request', { remote });
    recordHistorySessionDiagnosticEvent(sessionId, 'hydrate_request_started', {
      remote,
      historyState: session.historyState,
      hasRenderableContent: hasRenderableSessionContent(session),
    });

    await context.flowChatStore.loadSessionHistory(sessionId, {
        includeInternal: options?.includeInternal,
        deferFullHistoryUntilActive,
      });
    surfaceScope.assertCurrent('finish historical session hydration');
  })();

  context.pendingHistoryLoads.set(pendingKey, loadPromise);
  const pendingHistoryLoadCapabilities =
    context.pendingHistoryLoadCapabilities ??= new Map();
  pendingHistoryLoadCapabilities.set(pendingKey, {
    promise: loadPromise,
    includeInternal: options?.includeInternal === true,
    deferFullHistoryUntilActive: options?.deferFullHistoryUntilActive ?? true,
    workspaceId,
  });

  try {
    await loadPromise;
    recordHistorySessionDiagnosticEvent(sessionId, 'hydrate_request_finished');
    startupTrace.markPhase('historical_session_hydrate_request_end', {
      durationMs: elapsedMs(traceStartedAt),
    });
  } catch (error) {
    if (isSurfaceChangedError(error)) {
      throw error;
    }
    recordHistorySessionDiagnosticEvent(sessionId, 'hydrate_request_failed');
    startupTrace.markPhase('historical_session_hydrate_request_failed', {
      durationMs: elapsedMs(traceStartedAt),
    });
    log.error('Failed to load session history', { sessionId, error });
    if (notifyOnError) {
      notificationService.warning('Failed to load session history, showing empty session', {
        duration: 3000
      });
    }
    throw error;
  } finally {
    if (surfaceScope.isCurrent()) {
      clearHistorySessionHydratePending(sessionId, 'settled', {
        pendingStillCurrent: context.pendingHistoryLoads.get(pendingKey) === loadPromise,
      });
    }
    if (context.pendingHistoryLoads.get(pendingKey) === loadPromise) {
      context.pendingHistoryLoads.delete(pendingKey);
    }
    if (context.pendingHistoryLoadCapabilities?.get(pendingKey)?.promise === loadPromise) {
      context.pendingHistoryLoadCapabilities.delete(pendingKey);
    }
  }
}

export async function hydrateSessionHistoryForDetail(
  context: FlowChatContext,
  sessionId: string,
): Promise<void> {
  const session = context.flowChatStore.getState().sessions.get(sessionId);
  await hydrateHistoricalSession(context, sessionId, false, {
    allowNonHistorical: true,
    includeInternal: session?.sessionKind === 'subagent',
    deferFullHistoryUntilActive: false,
  });
}

function shouldHydrateHistoricalSessionBeforeSwitch(session: Session | undefined): session is Session {
  if (session?.isHistorical !== true) {
    return false;
  }
  if (isRemoteTraceContext(session.remoteConnectionId, session.remoteSshHost)) {
    return false;
  }
  return !hasRenderableSessionContent(session);
}

function shouldRetryActiveStaleHydrate(context: FlowChatContext, sessionId: string): boolean {
  const state = context.flowChatStore.getState();
  if (state.activeSessionId !== sessionId) {
    return false;
  }

  const session = state.sessions.get(sessionId);
  if (!session || session.historyState !== 'metadata-only') {
    return false;
  }

  return shouldHydrateHistoricalSessionBeforeSwitch(session);
}

export function preloadHistoricalSessionForOpen(
  context: FlowChatContext,
  sessionId: string
): void {
  if (!hasCompetingHistoryLoad(context, sessionId)) {
    return;
  }

  const session = context.flowChatStore.getState().sessions.get(sessionId);
  if (!shouldHydrateHistoricalSessionBeforeSwitch(session)) {
    return;
  }

  void hydrateHistoricalSession(context, sessionId, false).catch(error => {
    if (isSurfaceChangedError(error)) {
      return;
    }
    log.debug('Historical session preload failed', { sessionId, error });
  });
}

const isAssistantWorkspace = (workspace?: WorkspaceInfo | null): boolean => {
  return workspace?.workspaceKind === WorkspaceKind.Assistant;
};

const resolveSessionWorkspace = (config: SessionConfig): WorkspaceInfo => {
  const state = workspaceManager.getState();
  const id = config.workspaceId ?? state.currentWorkspace?.id;
  if (!id) throw new Error('Workspace ID is required to create a session');
  const workspace = state.openedWorkspaces.get(id)
    ?? (state.currentWorkspace?.id === id ? state.currentWorkspace : undefined)
    ?? state.recentWorkspaces?.find(record => record.id === id);
  if (!workspace) throw new Error(`Workspace ID is unavailable: ${id}`);
  return workspace;
};

export const resolveAgentTypeForSessionCreation = async (
  requestedMode: string | undefined,
  workspace: WorkspaceInfo | null
): Promise<string> => {
  if (isAssistantWorkspace(workspace)) {
    return 'Claw';
  }

  const normalizedRequestedMode = requestedMode?.trim();
  // A provided mode is an explicit caller decision. Only an omitted mode asks
  // this owner to resolve the user's default preference. In particular,
  // `agentic` is the real Standard Harness id, not a default-mode sentinel.
  if (normalizedRequestedMode) {
    return normalizedRequestedMode;
  }

  try {
    const configuredDefaultMode = resolveConfiguredChatInputDefaultModeId(
      normalizeChatInputModePreference(
        await configAPI.getConfig(CHAT_INPUT_MODE_PREFERENCE_CONFIG_PATH, {
          skipRetryOnNotFound: true,
        }) as AppFlowChatConfig | undefined,
      ),
    );
    if (!configuredDefaultMode) {
      return 'Standard';
    }

    const availableModes = await agentAPI.getAvailableModes({
      workspaceId: workspace?.id,
    });
    if (availableModes.some(mode => mode.id === configuredDefaultMode)) {
      return configuredDefaultMode;
    }

    log.warn('Ignoring unavailable default chat input mode preference during session creation', {
      modeId: configuredDefaultMode,
    });
  } catch (error) {
    if (isSurfaceChangedError(error)) {
      throw error;
    }
    log.warn('Failed to resolve default chat input mode preference during session creation', {
      error,
    });
  }

  return 'Standard';
};

function requireSessionWorkspacePath(
  workspacePath: string | undefined,
  sessionId: string
): string {
  if (!workspacePath) {
    throw new Error(`Workspace path is required for session: ${sessionId}`);
  }
  return workspacePath;
}

export { getModelMaxTokens } from '../../utils/modelResolution';

/**
 * Create new chat session (managed by backend)
 */
export async function createChatSession(
  context: FlowChatContext,
  config: SessionConfig,
  mode?: string
): Promise<string> {
  const surfaceScope = getActiveSurfaceScope();
  try {
    const workspace = resolveSessionWorkspace(config);
    const workspacePath = workspace.rootPath;
    const linkedWorktree = workspace.workspaceKind !== WorkspaceKind.Remote
      && workspace.worktree && !workspace.worktree.isMain;
    const projectId = linkedWorktree ? workspace.worktree?.mainWorkspaceId : workspace.id;
    if (!projectId) throw new Error('Worktree project workspace ID is unavailable');
    const catalog = workspaceManager.getState();
    const projectWorkspace = projectId === workspace.id ? workspace
      : catalog.openedWorkspaces.get(projectId)
        ?? catalog.recentWorkspaces.find(record => record.id === projectId);
    if (!projectWorkspace) throw new Error(`Project workspace ID is unavailable: ${projectId}`);
    const projectWorkspacePath = projectWorkspace.rootPath;
    const remoteConnectionId =
      workspace?.workspaceKind === WorkspaceKind.Remote ? workspace.connectionId : undefined;
    const remoteSshHost =
      workspace?.workspaceKind === WorkspaceKind.Remote
        ? workspace.sshHost?.trim() || undefined
        : undefined;
    const agentType = await resolveAgentTypeForSessionCreation(mode, workspace);
    surfaceScope.assertCurrent('resolve session creation mode');
    const workspaceCreationKey = workspace.id;
    const creationKey = surfaceScope.key(
      'session-create',
      surfaceScope.epoch,
      workspaceCreationKey,
      agentType,
      JSON.stringify(config.executionTargetRequest ?? { kind: 'local' }),
      JSON.stringify(config.dispatchTargetRequest ?? { kind: 'local' }),
    );

    const pendingCreation = pendingSessionCreations.get(creationKey);
    if (pendingCreation) {
      return pendingCreation;
    }

    // Register the pending promise before any async work below. Remote workspace
    // activation can rerun initialization while model config is still loading.
    const createPromise = Promise.resolve().then(async () => {
      surfaceScope.assertCurrent('start session creation');
      const titleDescriptor = createDefaultSessionTitleDescriptor(
        (key, options) => i18nService.t(key, options),
      );
      const sessionName = titleDescriptor.text;

      const sessionId = await driverForCreation(config).createSession(context, {
        surfaceScope,
        config,
        agentType,
        sessionName,
        titleDescriptor,
        workspacePath,
        projectWorkspacePath,
        workspaceId: workspace?.id,
        remoteConnectionId,
        remoteSshHost,
      });
      surfaceScope.assertCurrent('finish session creation');
      return sessionId;
    });

    pendingSessionCreations.set(creationKey, createPromise);
    try {
      return await createPromise;
    } finally {
      if (pendingSessionCreations.get(creationKey) === createPromise) {
        pendingSessionCreations.delete(creationKey);
      }
    }
  } catch (error) {
    if (isSurfaceChangedError(error)) {
      throw error;
    }
    log.error('Failed to create chat session', { config, error });
    
    notificationService.error('Failed to create chat session', {
      duration: 3000
    });
    throw error;
  }
}

/**
 * Switch to specified session
 */
export async function switchChatSession(
  context: FlowChatContext,
  sessionId: string,
  isStillRelevant: () => boolean = () => true,
): Promise<void> {
  const surfaceScope = getActiveSurfaceScope();
  try {
    if (!isStillRelevant()) return;
    const switchRequestId = ++latestSwitchRequestId;
    const session = context.flowChatStore.getState().sessions.get(sessionId);
    const isRemoteSession = isRemoteTraceContext(session?.remoteConnectionId, session?.remoteSshHost);
    const shouldHydrateBeforeSwitch = shouldHydrateHistoricalSessionBeforeSwitch(session);
    const shouldActivateBeforeHydrate =
      shouldHydrateBeforeSwitch &&
      consumeRecentHistorySessionOpenIntent(sessionId);
    recordHistorySessionDiagnosticEvent(sessionId, 'switch_requested', {
      switchRequestId,
      isRemoteSession,
      isHistorical: session?.isHistorical === true,
      historyState: session?.historyState,
      hasRenderableContent: session ? hasRenderableSessionContent(session) : false,
      shouldHydrateBeforeSwitch,
      shouldActivateBeforeHydrate,
    });

    const touchActiveSessionInBackground = () => {
      if (driverForSession(sessionId, session).id === 'dispatch') {
        return;
      }
      scheduleSessionActivityTouch(surfaceScope, () => {
        const latestState = context.flowChatStore.getState();
        const latestSession = latestState.sessions.get(sessionId);
        if (switchRequestId !== latestSwitchRequestId || latestState.activeSessionId !== sessionId || !latestSession) {
          return;
        }
        touchSessionActivity(
          sessionId,
          requireSessionWorkspaceId(latestSession)
        ).catch(error => {
          if (isSurfaceChangedError(error)) {
            return;
          }
          log.debug('Failed to touch session activity', { sessionId, error });
        });
      });
    };

    if (shouldActivateBeforeHydrate) {
      context.flowChatStore.switchSession(sessionId);
      recordHistorySessionDiagnosticEvent(sessionId, 'switch_activated_before_hydrate', {
        switchRequestId,
      });
      startupTrace.markPhase('historical_session_switch', {
        historical: true,
        remote: false,
        activation: 'before-hydrate',
      });
      touchActiveSessionInBackground();
    }

    if (shouldHydrateBeforeSwitch) {
      try {
        await hydrateHistoricalSession(context, sessionId, true, {
          isRetryStillRelevant: () => (
            surfaceScope.isCurrent() && switchRequestId === latestSwitchRequestId && isStillRelevant()
          ),
          retryActiveStaleReuse: shouldActivateBeforeHydrate,
        });
        surfaceScope.assertCurrent('hydrate session before switch');
      } catch (error) {
        if (isSurfaceChangedError(error)) {
          throw error;
        }
        // The hydrate path already marks the session failed and notifies the user.
        // Continue with activation so the failed state is visible.
      }

      if (switchRequestId !== latestSwitchRequestId || !isStillRelevant()) {
        recordHistorySessionDiagnosticEvent(sessionId, 'switch_superseded', {
          switchRequestId,
          latestSwitchRequestId,
        });
        startupTrace.markPhase('historical_session_switch_superseded', {
          sessionId,
        });
        return;
      }
    }

    // Avoid showing an empty loading page between two sessions. Historical
    // sessions without a renderable tail are activated after their first
    // visible content is restored unless a fresh user open intent is present.
    // In that explicit path the intent shield keeps metadata-only content from
    // flashing while the old large session is unmounted immediately.
    if (!shouldActivateBeforeHydrate) {
      surfaceScope.assertCurrent('activate switched session');
      context.flowChatStore.switchSession(sessionId);
      recordHistorySessionDiagnosticEvent(sessionId, 'switch_activated_after_hydrate', {
        switchRequestId,
        shouldHydrateBeforeSwitch,
      });
      startupTrace.markPhase('historical_session_switch', {
        historical: Boolean(session?.isHistorical),
        remote: isRemoteSession,
        activation: shouldHydrateBeforeSwitch ? 'after-hydrate' : 'immediate',
      });
      touchActiveSessionInBackground();
    }

    if (session?.isHistorical && !shouldHydrateBeforeSwitch) {
      // Load history in the background — do not block the UI.
      recordHistorySessionDiagnosticEvent(sessionId, 'switch_background_hydrate_started', {
        switchRequestId,
      });
      void hydrateHistoricalSession(context, sessionId, true).catch(error => {
        if (!isSurfaceChangedError(error)) {
          log.debug('Historical session background hydrate failed', { sessionId, error });
        }
      });
    }
  } catch (error) {
    if (isSurfaceChangedError(error)) {
      throw error;
    }
    log.error('Failed to switch chat session', { sessionId, error });
    notificationService.error('Failed to switch session', {
      duration: 3000
    });
    throw error;
  }
}

/**
 * Delete session (cascading delete Terminal)
 */
export async function deleteChatSession(
  context: FlowChatContext,
  sessionId: string
): Promise<void> {
  try {
    const stateBeforeDelete = context.flowChatStore.getState();
    const removedSessionIds = context.flowChatStore.getCascadeSessionIds(sessionId);
    const removedSessionIdSet = new Set(removedSessionIds);
    const removedActiveSession = Boolean(
      stateBeforeDelete.activeSessionId
      && removedSessionIdSet.has(stateBeforeDelete.activeSessionId)
    );
    // Deletion cancels any speculative pointer-down transition before awaiting
    // the backend. Otherwise a target that is never activated can leave the
    // history-open shield visible until its safety timeout.
    removedSessionIds.forEach(removedSessionId => {
      clearRecentHistorySessionOpenIntent(removedSessionId);
      clearHistorySessionOpenTransition(removedSessionId);
    });
    const session = stateBeforeDelete.sessions.get(sessionId);
    await driverForSession(sessionId, session).deleteSession(context, sessionId, {
      removedSessionIds,
      removedActiveSession,
    });
  } catch (error) {
    log.error('Failed to delete chat session', { sessionId, error });
    notificationService.error('Failed to delete session', {
      duration: 3000
    });
    throw error;
  }
}

export async function archiveChatSession(
  context: FlowChatContext,
  sessionId: string
): Promise<void> {
  try {
    const stateBeforeArchive = context.flowChatStore.getState();
    const session = stateBeforeArchive.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session does not exist: ${sessionId}`);
    }

    const removedSessionIds = context.flowChatStore.getCascadeSessionIds(sessionId);
    const removedSessionIdSet = new Set(removedSessionIds);
    const removedActiveSession = Boolean(
      stateBeforeArchive.activeSessionId
      && removedSessionIdSet.has(stateBeforeArchive.activeSessionId)
    );

    // Match deletion: a removed session must not leave a pending history-open
    // shield or navigation intent behind while the archive request settles.
    removedSessionIds.forEach(removedSessionId => {
      clearRecentHistorySessionOpenIntent(removedSessionId);
      clearHistorySessionOpenTransition(removedSessionId);
    });

    await driverForSession(sessionId, session).archiveSession(context, sessionId, {
      removedSessionIds,
      removedActiveSession,
    });
  } catch (error) {
    log.error('Failed to archive chat session', { sessionId, error });
    notificationService.error('Failed to archive session', {
      duration: 3000
    });
    throw error;
  }
}

export async function renameChatSessionTitle(
  context: FlowChatContext,
  sessionId: string,
  title: string
): Promise<string> {
  const session = context.flowChatStore.getState().sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session does not exist: ${sessionId}`);
  }

  const trimmedTitle = title.trim();
  if (!trimmedTitle) {
    throw new Error('Session title must not be empty');
  }
  if (session.isTransient) {
    await context.flowChatStore.updateSessionTitle(sessionId, trimmedTitle, 'generated');
    return trimmedTitle;
  }
  return driverForSession(sessionId, session).renameSession(context, sessionId, trimmedTitle);
}

export async function reloadSessionTitle(
  context: FlowChatContext,
  sessionId: string,
): Promise<void> {
  const session = context.flowChatStore.getState().sessions.get(sessionId);
  if (!session) return;

  const metadata = await sessionAPI.loadSessionMetadata(
    sessionId,
    requireSessionWorkspaceId(session));
  if (!metadata) return;

  const titleState = deriveSessionTitleStateFromMetadata(metadata);
  context.flowChatStore.setState(previous => {
    const current = previous.sessions.get(sessionId);
    if (!current) return previous;

    const sessions = new Map(previous.sessions);
    sessions.set(sessionId, {
      ...current,
      ...titleState,
      titleStatus: 'generated',
    });
    return { ...previous, sessions };
  });
}

export async function forkChatSession(
  context: FlowChatContext,
  sourceSessionId: string,
  sourceTurnId: string
): Promise<string> {
  const sourceSession = context.flowChatStore.getState().sessions.get(sourceSessionId);
  if (!sourceSession) {
    throw new Error(`Session does not exist: ${sourceSessionId}`);
  }
  if (driverForSession(sourceSessionId, sourceSession).id === 'dispatch') {
    throw new Error('Forking a detached dispatch session is not supported');
  }

  const executionWorkspacePath = requireSessionWorkspacePath(
    sourceSession.workspacePath,
    sourceSessionId
  );
  const projectWorkspacePath = requireSessionProjectWorkspacePath(
    sourceSession,
    sourceSessionId,
  );

  const response = await sessionAPI.forkSession(
    sourceSessionId,
    sourceTurnId,
    requireSessionWorkspaceId(sourceSession));

  const currentState = context.flowChatStore.getState();
  if (!currentState.sessions.has(response.sessionId)) {
    context.flowChatStore.createSession(
      response.sessionId,
      {
        ...sourceSession.config,
        workspacePath: executionWorkspacePath,
        projectWorkspacePath,
        workspaceId: sourceSession.workspaceId,
        remoteConnectionId: sourceSession.remoteConnectionId,
        remoteSshHost: sourceSession.remoteSshHost,
      },
      undefined,
      response.sessionName,
      sourceSession.maxContextTokens,
      sourceSession.mode,
      executionWorkspacePath,
      sourceSession.remoteConnectionId,
      sourceSession.remoteSshHost,
      createTextSessionTitleDescriptor(response.sessionName),
    );
  } else {
    context.flowChatStore.switchSession(response.sessionId);
  }

  await context.flowChatStore.loadSessionHistory(response.sessionId, { deferFullHistoryUntilActive: true });
  context.flowChatStore.switchSession(response.sessionId);

  return response.sessionId;
}

/**
 * Ensure backend session exists (check before sending message)
 */
export async function ensureBackendSession(
  context: FlowChatContext,
  sessionId: string
): Promise<void> {
  const surfaceScope = getActiveSurfaceScope();
  const session = context.flowChatStore.getState().sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session does not exist: ${sessionId}`);
  }
  if (session.isTransient) {
    return;
  }
  if (driverForSession(sessionId, session).id === 'dispatch') {
    return;
  }

  if (session.isHistorical) {
    await hydrateHistoricalSession(context, sessionId, false);
    surfaceScope.assertCurrent('hydrate session before backend readiness');
  }

  const latestSession = context.flowChatStore.getState().sessions.get(sessionId) ?? session;
  const workspaceId = requireSessionWorkspaceId(latestSession);
  const workspace = resolveSessionWorkspace({ workspaceId });
  const workspacePath = workspace.rootPath;
  const projectWorkspacePath = requireSessionProjectWorkspacePath(latestSession, sessionId);
  const effectiveConnectionId = workspace.workspaceKind === WorkspaceKind.Remote ? workspace.connectionId : undefined;
  const effectiveSshHost = workspace.workspaceKind === WorkspaceKind.Remote ? workspace.sshHost : undefined;

  const isHistoricalSession = latestSession.isHistorical === true;
  const isFirstTurn = isProjectedFirstRuntimeTurn(latestSession);
  const requiresContextRestore =
    latestSession.contextRestoreState === 'pending' ||
    latestSession.contextRestoreState === 'failed';
  const needsBackendSetup = isHistoricalSession || isFirstTurn || requiresContextRestore;
  const hasProjectedTurns = !isProjectedSessionEmpty(latestSession);
  /** Avoid createSession when historical data is already loaded but backend files are missing (e.g. new SSH connection id). */
  const allowRecreateOnCoordinatorFailure =
    needsBackendSetup &&
    !(requiresContextRestore && hasProjectedTurns) &&
    !(isHistoricalSession && hasProjectedTurns);

  const markBackendContextReady = () => {
    if (!isHistoricalSession && !requiresContextRestore) return;
    if (!surfaceScope.isCurrent()) return;
    context.flowChatStore.setState(prev => {
      const newSessions = new Map(prev.sessions);
      const sess = newSessions.get(sessionId);
      if (sess) {
        newSessions.set(sessionId, {
          ...sess,
          isHistorical: false,
          historyState: 'ready',
          contextRestoreState: 'ready',
        });
      }
      return { ...prev, sessions: newSessions };
    });
  };

  const markBackendContextFailed = () => {
    if (!requiresContextRestore) return;
    if (!surfaceScope.isCurrent()) return;
    context.flowChatStore.setState(prev => {
      const newSessions = new Map(prev.sessions);
      const sess = newSessions.get(sessionId);
      if (sess) {
        newSessions.set(sessionId, { ...sess, contextRestoreState: 'failed' });
      }
      return { ...prev, sessions: newSessions };
    });
  };

  const ensureCoordinator = async () => {
    surfaceScope.assertCurrent('ensure coordinator session');
    await agentAPI.ensureCoordinatorSession({
      sessionId,
      workspaceId,
      includeInternal: latestSession.sessionKind === 'subagent',
    });
    surfaceScope.assertCurrent('ensure coordinator session');
    markBackendContextReady();
  };

  const restorePendingBackendContext = async () => {
    if (!context.pendingContextRestores) {
      context.pendingContextRestores = new Map();
    }
    const restoreKey = surfaceScope.key(
      'context-restore',
      surfaceScope.epoch,
      sessionId,
      workspaceId,
    );
    const existingRestore = context.pendingContextRestores.get(restoreKey);
    if (existingRestore) {
      await existingRestore;
      surfaceScope.assertCurrent('reuse backend context restore');
      return;
    }

    const restorePromise = ensureCoordinator().catch(error => {
      if (!isSurfaceChangedError(error)) {
        markBackendContextFailed();
      }
      throw error;
    }).finally(() => {
      if (context.pendingContextRestores?.get(restoreKey) === restorePromise) {
        context.pendingContextRestores.delete(restoreKey);
      }
    });
    context.pendingContextRestores.set(restoreKey, restorePromise);
    await restorePromise;
  };

  try {
    if (requiresContextRestore) {
      await restorePendingBackendContext();
      return;
    }

    await ensureCoordinator();
  } catch (e: any) {
    if (isSurfaceChangedError(e)) {
      throw e;
    }
    surfaceScope.assertCurrent('handle coordinator session failure');
    if (isSessionInUseError(e)) {
      throw e;
    }
    if (!allowRecreateOnCoordinatorFailure) {
      const raw = typeof e?.message === 'string' ? e.message : String(e);
      const hint =
        raw.includes('Session metadata not found') || raw.includes('Not found')
          ? i18nService.t('flow-chat:historyState.remoteSessionMissing')
          : raw;
      throw new Error(hint);
    }

    log.debug('Coordinator session missing, creating backend session', { sessionId, error: e });
    surfaceScope.assertCurrent('recreate backend session');
    await agentAPI.createSession({
      sessionId: sessionId,
      sessionName:
        resolveSessionTitle(latestSession, (key, options) => i18nService.t(key, options)) ||
        `Session ${sessionId.slice(0, 8)}`,
      agentType: latestSession.mode || 'Standard',
      workspacePath,
      projectWorkspacePath,
      executionTarget:
        latestSession.config.executionTarget?.worktreeId
          ? {
              kind: 'existingWorktree',
              worktreeId: latestSession.config.executionTarget.worktreeId,
            }
          : { kind: 'local' },
      workspaceId: latestSession.workspaceId,
      remoteConnectionId: effectiveConnectionId,
      remoteSshHost: effectiveSshHost,
      relationship: buildCreateSessionRelationship(latestSession),
      deepReviewRunManifest: latestSession.deepReviewRunManifest,
      reviewTargetEvidence: latestSession.reviewTargetEvidence,
      config: {
        modelName: latestSession.config.modelName || 'primary',
        enableTools: true,
        safeMode: true,
        remoteConnectionId: effectiveConnectionId,
        remoteSshHost: effectiveSshHost,
      }
    });
    surfaceScope.assertCurrent('recreate backend session');
    markBackendContextReady();
  }
}

/**
 * Retry creating backend session (retry after message send failure)
 */
export async function retryCreateBackendSession(
  context: FlowChatContext,
  sessionId: string
): Promise<void> {
  const session = context.flowChatStore.getState().sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session does not exist: ${sessionId}`);
  }
  if (session.isTransient) {
    return;
  }

  const workspacePath = requireSessionWorkspacePath(session.workspacePath, sessionId);
  const projectWorkspacePath = requireSessionProjectWorkspacePath(session, sessionId);
  
  await agentAPI.createSession({
    sessionId: sessionId,
    sessionName:
      resolveSessionTitle(session, (key, options) => i18nService.t(key, options)) ||
      `Session ${sessionId.slice(0, 8)}`,
    agentType: session.mode || 'Standard',
    workspacePath,
    projectWorkspacePath,
    executionTarget:
      session.config.executionTarget?.worktreeId
        ? {
            kind: 'existingWorktree',
            worktreeId: session.config.executionTarget.worktreeId,
          }
        : { kind: 'local' },
    workspaceId: session.workspaceId,
    remoteConnectionId: session.remoteConnectionId,
    remoteSshHost: session.remoteSshHost,
    relationship: buildCreateSessionRelationship(session),
    deepReviewRunManifest: session.deepReviewRunManifest,
    reviewTargetEvidence: session.reviewTargetEvidence,
    config: {
      modelName: session.config.modelName || 'primary',
      enableTools: true,
      safeMode: true,
      remoteConnectionId: session.remoteConnectionId,
      remoteSshHost: session.remoteSshHost,
    }
  });
}
