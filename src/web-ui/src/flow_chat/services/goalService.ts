import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import { worktreeAPI } from '@/infrastructure/api/service-api/WorktreeAPI';
import { notificationService } from '@/shared/notification-system';
import type { Session } from '../types/flow-chat';
import { flowChatStore } from '../store/FlowChatStore';
import { pendingQueueManager } from './flow-chat-manager/PendingQueueModule';
import type { GoalCommandAction } from './goalCommandParser';
import { sessionProjectWorkspacePath, sessionWorkspaceId } from '../utils/sessionWorkspace';
import { sessionWorktreeMaterializationPlan } from '../utils/sessionWorktree';

export { isGoalSlashCommand, parseGoalCommand } from './goalCommandParser';
export type { GoalCommandAction } from './goalCommandParser';

export interface ThreadGoalSnapshot {
  goalId?: string;
  objective: string;
  status: string;
  tokensUsed?: number;
  tokenBudget?: number | null;
  timeUsedSeconds?: number;
  updatedAt?: number;
}

export interface GoalCommandParams {
  session: Session;
  action: GoalCommandAction;
  usageMessage: string;
  failedTitle: string;
  unknownErrorMessage: string;
  activatedTitle: string;
  clearedTitle: string;
  pausedTitle: string;
  resumedTitle: string;
  editedTitle: string;
  replaceConfirmTitle?: string;
  replaceConfirmMessage?: string;
  /** Open goal menu UI instead of a toast when /goal has no args. */
  onOpenMenu?: (goal: ThreadGoalSnapshot | null) => void;
  /** When replacing an existing non-complete goal via /goal <objective>. */
  confirmReplaceGoal?: (params: {
    existingObjective: string;
    newObjective: string;
  }) => Promise<boolean>;
  /** Open goal edit UI (/goal edit or set with no existing goal). */
  onOpenEdit?: (initialObjective: string, mode: 'create' | 'update') => void;
}

function mapGoal(goal: {
  goalId: string;
  objective: string;
  status: string;
  tokensUsed?: number;
  tokenBudget?: number | null;
  timeUsedSeconds?: number;
  updatedAt?: number;
}): ThreadGoalSnapshot {
  return {
    goalId: goal.goalId,
    objective: goal.objective,
    status: goal.status,
    tokensUsed: goal.tokensUsed,
    tokenBudget: goal.tokenBudget,
    timeUsedSeconds: goal.timeUsedSeconds,
    updatedAt: goal.updatedAt,
  };
}

const GOAL_KICKOFF_CONTENT_PREFIX = 'Continue working toward the thread goal:';

function isRedundantGoalKickoffPendingItem(
  displayMessage: string | undefined,
  content: string
): boolean {
  const display = displayMessage?.trim() ?? '';
  if (/^\/goal\b/i.test(display)) {
    return true;
  }
  return (
    content.startsWith(GOAL_KICKOFF_CONTENT_PREFIX) ||
    /^\/goal\b/i.test(content.trim())
  );
}

/** Drop legacy frontend kickoff rows; backend already steers via objective_updated. */
function clearRedundantGoalKickoffPendingItems(sessionId: string): void {
  for (const item of pendingQueueManager.list(sessionId)) {
    if (isRedundantGoalKickoffPendingItem(item.displayMessage, item.content)) {
      pendingQueueManager.remove(sessionId, item.id);
    }
  }
}

function syncGoalToStore(sessionId: string, goal: ThreadGoalSnapshot | null): void {
  if (!goal) {
    flowChatStore.setThreadGoal(sessionId, null);
    return;
  }
  flowChatStore.setThreadGoal(sessionId, {
    goalId: goal.goalId ?? `${sessionId}-goal`,
    objective: goal.objective,
    status: goal.status,
    tokensUsed: goal.tokensUsed,
    tokenBudget: goal.tokenBudget,
    timeUsedSeconds: goal.timeUsedSeconds,
    updatedAt: goal.updatedAt,
  });
}

async function sessionRequestBase(session: Session) {
  return {
    sessionId: session.sessionId,
    workspaceId: sessionWorkspaceId(session),
    workspacePath: sessionProjectWorkspacePath(session),
    remoteConnectionId: session.remoteConnectionId,
    remoteSshHost: session.remoteSshHost,
  };
}

/**
 * `/goal` can start backend work without passing through the normal first-message
 * driver. Materialize the composer's pending worktree choice before any goal
 * action that can start or steer a turn. For an older session with a stale
 * pending flag, the plan is intentionally empty and we only clear that flag.
 */
async function prepareSessionForGoalTurn(session: Session): Promise<Session> {
  const sessionId = session.sessionId;
  const latest = flowChatStore.getState().sessions.get(sessionId) ?? session;
  if (latest.config.worktreeIsolationRequested === undefined) {
    return latest;
  }

  const materialization = sessionWorktreeMaterializationPlan(latest);
  if (materialization) {
    const result = await worktreeAPI.bindSession(
      sessionId,
      materialization.enabled,
      globalThis.crypto?.randomUUID?.() ?? `goal-worktree-${Date.now()}`,
      materialization,
    );
    flowChatStore.updateSessionExecutionTarget(sessionId, {
      workspacePath: result.workspacePath,
      projectWorkspacePath: result.projectWorkspacePath,
      workspaceId: result.workspaceId,
      executionTarget: result.executionTarget,
    });
  }

  flowChatStore.setSessionWorktreeIsolationRequested(sessionId, undefined);
  return flowChatStore.getState().sessions.get(sessionId) ?? latest;
}

export async function fetchSessionThreadGoal(
  session: Session
): Promise<ThreadGoalSnapshot | null> {
  if (!session.workspacePath) {
    return null;
  }
  const base = await sessionRequestBase(session);
  const response = await agentAPI.getSessionThreadGoal(base);
  if (!response.goal) {
    syncGoalToStore(session.sessionId, null);
    return null;
  }
  const snapshot = mapGoal(response.goal);
  syncGoalToStore(session.sessionId, snapshot);
  return snapshot;
}

export async function runGoalCommand(params: GoalCommandParams): Promise<ThreadGoalSnapshot | null> {
  if (!params.session.workspacePath) {
    throw new Error('A workspace is required to use /goal.');
  }

  const base = await sessionRequestBase(params.session);

  switch (params.action.kind) {
    case 'menu': {
      const response = await agentAPI.getSessionThreadGoal(base);
      const goal = response.goal ? mapGoal(response.goal) : null;
      syncGoalToStore(params.session.sessionId, goal);
      if (params.onOpenMenu) {
        params.onOpenMenu(goal);
        return goal;
      }
      if (!goal) {
        notificationService.info(params.usageMessage, { duration: 5000 });
        return null;
      }
      notificationService.info(goal.objective, {
        title: goal.status,
        duration: 6000,
      });
      return goal;
    }
    case 'edit': {
      const response = await agentAPI.getSessionThreadGoal(base);
      const goal = response.goal ? mapGoal(response.goal) : null;
      syncGoalToStore(params.session.sessionId, goal);
      if (params.onOpenEdit) {
        params.onOpenEdit(goal?.objective ?? '', goal ? 'update' : 'create');
        return goal;
      }
      if (!goal) {
        notificationService.info(params.usageMessage, { duration: 5000 });
      }
      return goal;
    }
    case 'clear': {
      await agentAPI.clearSessionThreadGoal(base);
      syncGoalToStore(params.session.sessionId, null);
      notificationService.success(params.clearedTitle, { duration: 4000 });
      return null;
    }
    case 'pause': {
      const goal = await agentAPI.setSessionThreadGoalStatus({ ...base, status: 'paused' });
      const snapshot = mapGoal(goal);
      syncGoalToStore(params.session.sessionId, snapshot);
      notificationService.info(goal.objective, {
        title: params.pausedTitle,
        duration: 5000,
      });
      return snapshot;
    }
    case 'resume': {
      const preparedSession = await prepareSessionForGoalTurn(params.session);
      const preparedBase = await sessionRequestBase(preparedSession);
      const goal = await agentAPI.setSessionThreadGoalStatus({
        ...preparedBase,
        status: 'active',
      });
      const snapshot = mapGoal(goal);
      syncGoalToStore(params.session.sessionId, snapshot);
      notificationService.success(goal.objective, {
        title: params.resumedTitle,
        duration: 5000,
      });
      return snapshot;
    }
    case 'set': {
      const existingResponse = await agentAPI.getSessionThreadGoal(base);
      const existing = existingResponse.goal ? mapGoal(existingResponse.goal) : null;
      if (
        existing &&
        existing.status !== 'complete' &&
        params.confirmReplaceGoal
      ) {
        const confirmed = await params.confirmReplaceGoal({
          existingObjective: existing.objective,
          newObjective: params.action.objective,
        });
        if (!confirmed) {
          return null;
        }
      }

      const preparedSession = await prepareSessionForGoalTurn(params.session);
      const preparedBase = await sessionRequestBase(preparedSession);
      const activation = await agentAPI.activateSessionGoal({
        ...preparedBase,
        userHint: params.action.objective,
      });

      const snapshot = mapGoal(activation.goal);
      syncGoalToStore(params.session.sessionId, snapshot);

      // Backend `set_thread_goal_objective` already delivers objective-updated steering
      // (inject into the running turn or start a follow-up when idle). A second
      // frontend sendMessage would duplicate the user-visible turn and, while busy,
      // enqueue the same `/goal …` text in the pending panel.
      clearRedundantGoalKickoffPendingItems(params.session.sessionId);

      notificationService.success(activation.goal.objective, {
        title: params.activatedTitle,
        duration: 6000,
      });

      return snapshot;
    }
    default:
      return null;
  }
}

export async function runThreadGoalUiAction(
  session: Session,
  action: 'clear' | 'pause' | 'resume',
  titles: Pick<
    GoalCommandParams,
    | 'clearedTitle'
    | 'pausedTitle'
    | 'resumedTitle'
    | 'failedTitle'
    | 'unknownErrorMessage'
    | 'replaceConfirmTitle'
    | 'replaceConfirmMessage'
  >
): Promise<ThreadGoalSnapshot | null> {
  return runGoalCommand({
    session,
    action: { kind: action },
    usageMessage: '',
    failedTitle: titles.failedTitle,
    unknownErrorMessage: titles.unknownErrorMessage,
    activatedTitle: '',
    clearedTitle: titles.clearedTitle,
    pausedTitle: titles.pausedTitle,
    resumedTitle: titles.resumedTitle,
    editedTitle: '',
  });
}

export async function saveThreadGoalObjective(
  session: Session,
  objective: string,
  mode: 'create' | 'update',
  titles: Pick<
    GoalCommandParams,
    | 'activatedTitle'
    | 'editedTitle'
    | 'failedTitle'
    | 'unknownErrorMessage'
    | 'replaceConfirmTitle'
    | 'replaceConfirmMessage'
  >,
  options?: Pick<GoalCommandParams, 'confirmReplaceGoal'>
): Promise<ThreadGoalSnapshot | null> {
  const trimmed = objective.trim();
  if (!trimmed) {
    throw new Error('Objective is required.');
  }
  if (!session.workspacePath) {
    throw new Error('A workspace is required to use /goal.');
  }

  if (mode === 'create') {
    return runGoalCommand({
      session,
      action: { kind: 'set', objective: trimmed },
      usageMessage: '',
      failedTitle: titles.failedTitle,
      unknownErrorMessage: titles.unknownErrorMessage,
      activatedTitle: titles.activatedTitle,
      clearedTitle: '',
      pausedTitle: '',
      resumedTitle: '',
      editedTitle: titles.editedTitle,
      replaceConfirmTitle: titles.replaceConfirmTitle,
      replaceConfirmMessage: titles.replaceConfirmMessage,
      confirmReplaceGoal: options?.confirmReplaceGoal,
    });
  }

  const preparedSession = await prepareSessionForGoalTurn(session);
  const preparedBase = await sessionRequestBase(preparedSession);
  const goal = await agentAPI.updateSessionThreadGoalObjective({
    ...preparedBase,
    objective: trimmed,
  });
  const snapshot = mapGoal(goal);
  syncGoalToStore(session.sessionId, snapshot);
  notificationService.success(goal.objective, {
    title: titles.editedTitle,
    duration: 5000,
  });
  return snapshot;
}

function resolveGoalCommandError(error: unknown, params: GoalCommandParams): string {
  if (!(error instanceof Error)) {
    return params.unknownErrorMessage;
  }
  const message = error.message.trim();
  return message || params.unknownErrorMessage;
}

export async function runGoalCommandSafely(
  params: GoalCommandParams
): Promise<ThreadGoalSnapshot | null> {
  try {
    return await runGoalCommand(params);
  } catch (error) {
    notificationService.error(resolveGoalCommandError(error, params), {
      title: params.failedTitle,
      duration: 5000,
    });
    return null;
  }
}
