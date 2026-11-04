import { FlowChatStore } from '../store/FlowChatStore';
import { stateMachineManager } from '../state-machine/SessionStateMachineManager';
import { ProcessingPhase, type SessionStateMachine } from '../state-machine/types';
import { deriveAgentCompanionMood, type AgentCompanionMood } from './agentCompanionMood';
import type { DialogTurn, FlowToolItem, FlowTextItem, FlowThinkingItem, Session } from '../types/flow-chat';
import { resolveSessionRelationship } from './sessionMetadata';
import { toWellFormedText } from '@/shared/utils/wellFormedText';
import {
  findPendingAskUserQuestion,
  TRANSIENT_TURN_STATUSES,
} from './askUserQuestionState';
import { effectiveToolInvocation } from './toolInvocationIdentity';
import { resolvePersistedSessionTitle } from './sessionTitle';
import { i18nService } from '@/infrastructure/i18n';
import { resolveDeviceName, useDeviceDirectory } from '@/infrastructure/account/deviceDirectory';
import { isLocalSurface } from '@/infrastructure/peer-device/deviceSurface';
import {
  listBackgroundDeviceSessions,
  subscribeCrossDeviceSessions,
  type CrossDeviceSession,
} from '../services/crossDeviceSessions';

export type AgentCompanionTaskState =
  | 'running'
  | 'waiting'
  | 'attention'
  | 'completed'
  | 'error'
  | 'interrupted';

export interface AgentCompanionTaskStatus {
  sessionId: string;
  title: string;
  mood: AgentCompanionMood;
  state: AgentCompanionTaskState;
  labelKey: string;
  defaultLabel: string;
  latestOutput?: string;
  startedAt: number;
  updatedAt: number;
  /**
   * Whether the desktop pet may send a plain message straight into this
   * session. Only normal sessions qualify; /btw and review threads need the
   * parent turn context that only the main window composer can supply.
   */
  canReply?: boolean;
  /**
   * Set for a session on a device this window is not rendering. Opening it
   * renders that device first; replying from the pet is not offered there.
   */
  surfaceId?: string;
  workspaceId?: string;
  deviceName?: string;
}

export interface AgentCompanionActivityPayload {
  mood: AgentCompanionMood;
  tasks: AgentCompanionTaskStatus[];
  sequence?: number;
  emittedAt?: number;
}

const EMPTY_ACTIVITY: AgentCompanionActivityPayload = {
  mood: 'rest',
  tasks: [],
};

const taskOrderBySessionId = new Map<string, number>();
let nextTaskOrder = 0;
const LATEST_OUTPUT_MAX_CHARS = 512;

function ensureTaskOrder(sessionId: string): number {
  const existingOrder = taskOrderBySessionId.get(sessionId);
  if (existingOrder !== undefined) {
    return existingOrder;
  }

  const order = nextTaskOrder;
  nextTaskOrder += 1;
  taskOrderBySessionId.set(sessionId, order);
  return order;
}

function pruneTaskOrder(activeTasks: AgentCompanionTaskStatus[]): void {
  const activeSessionIds = new Set(activeTasks.map(task => task.sessionId));
  Array.from(taskOrderBySessionId.keys()).forEach(sessionId => {
    if (!activeSessionIds.has(sessionId)) {
      taskOrderBySessionId.delete(sessionId);
    }
  });
}

function sessionTitle(session: Session): string {
  return toWellFormedText(session.title?.trim() || 'Session');
}

function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, match => match.replace(/```[^\n]*\n?|```/g, ' '))
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateLatestOutput(text: string): string {
  const wellFormedText = toWellFormedText(text);
  if (wellFormedText.length <= LATEST_OUTPUT_MAX_CHARS) {
    return wellFormedText;
  }

  return toWellFormedText(wellFormedText.slice(-LATEST_OUTPUT_MAX_CHARS));
}

function latestAssistantSnippet(turn: DialogTurn | undefined): string | undefined {
  if (!turn) {
    return undefined;
  }

  for (let roundIndex = turn.modelRounds.length - 1; roundIndex >= 0; roundIndex -= 1) {
    const round = turn.modelRounds[roundIndex];
    for (let itemIndex = round.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = round.items[itemIndex];
      const plainText = item.type === 'thinking'
        ? markdownToPlainText((item as FlowThinkingItem).content)
        : item.type === 'text'
          ? (item as FlowTextItem).isMarkdown === false
            ? (item as FlowTextItem).content.replace(/\s+/g, ' ').trim()
            : markdownToPlainText((item as FlowTextItem).content)
          : '';
      if (plainText) {
        return truncateLatestOutput(plainText);
      }
    }
  }

  return undefined;
}

function extractAskUserQuestionText(tool: FlowToolItem): string | undefined {
  const input = effectiveToolInvocation(tool.toolName, tool.toolCall?.input).input;
  if (!input || typeof input !== 'object') {
    return undefined;
  }

  const questions = (input as Record<string, unknown>).questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    return undefined;
  }

  const firstQuestion = questions[0]?.question;
  if (typeof firstQuestion === 'string' && firstQuestion.trim()) {
    return truncateLatestOutput(firstQuestion);
  }

  return undefined;
}

function askUserQuestionAttentionTask(
  session: Session,
  snapshot: SessionStateMachine | null,
): AgentCompanionTaskStatus | null {
  const turn = trackedDialogTurn(session, snapshot);
  const pendingTool = findPendingAskUserQuestion(turn);
  if (!pendingTool) {
    return null;
  }

  return {
    sessionId: session.sessionId,
    title: sessionTitle(session),
    mood: 'waiting',
    state: 'attention',
    labelKey: 'agentCompanion.activity.needsInput',
    defaultLabel: 'Needs input',
    latestOutput: extractAskUserQuestionText(pendingTool) ?? latestAssistantSnippet(turn),
    startedAt: snapshot?.context.stats.startTime || session.lastActiveAt || session.updatedAt || session.createdAt,
    updatedAt: snapshot?.context.lastUpdateTime || session.updatedAt || session.lastActiveAt || session.createdAt,
  };
}

function trackedDialogTurn(
  session: Session,
  snapshot: SessionStateMachine | null,
): DialogTurn | undefined {
  const trackedTurnId = snapshot?.context.currentDialogTurnId;
  if (trackedTurnId) {
    return session.dialogTurns.find(turn => turn.id === trackedTurnId);
  }

  return session.dialogTurns[session.dialogTurns.length - 1];
}

function hasActiveTrackedTurn(
  session: Session,
  snapshot: SessionStateMachine | null,
): boolean {
  if (!snapshot) {
    return false;
  }

  const turn = trackedDialogTurn(session, snapshot);
  return !!turn && TRANSIENT_TURN_STATUSES.has(turn.status);
}

function runningLabel(snapshot: SessionStateMachine | null): {
  state: AgentCompanionTaskState;
  labelKey: string;
  defaultLabel: string;
} {
  switch (snapshot?.context.processingPhase) {
    case ProcessingPhase.THINKING:
      return {
        state: 'running',
        labelKey: 'agentCompanion.activity.thinking',
        defaultLabel: 'Thinking',
      };
    case ProcessingPhase.TOOL_CALLING:
      return {
        state: 'waiting',
        labelKey: 'agentCompanion.activity.usingTools',
        defaultLabel: 'Using tools',
      };
    case ProcessingPhase.TOOL_CONFIRMING:
      return {
        state: 'attention',
        labelKey: 'agentCompanion.activity.waitingApproval',
        defaultLabel: 'Waiting for approval',
      };
    case ProcessingPhase.STREAMING:
      return {
        state: 'running',
        labelKey: 'agentCompanion.activity.writing',
        defaultLabel: 'Writing',
      };
    case ProcessingPhase.COMPACTING:
      return {
        state: 'running',
        labelKey: 'agentCompanion.activity.compacting',
        defaultLabel: 'Compacting context',
      };
    case ProcessingPhase.FINALIZING:
      return {
        state: 'running',
        labelKey: 'agentCompanion.activity.finishing',
        defaultLabel: 'Finishing',
      };
    case ProcessingPhase.STARTING:
      return {
        state: 'running',
        labelKey: 'agentCompanion.activity.starting',
        defaultLabel: 'Starting',
      };
    default:
      return {
        state: 'running',
        labelKey: 'agentCompanion.activity.working',
        defaultLabel: 'Working',
      };
  }
}

function attentionTask(
  session: Session,
  snapshot: SessionStateMachine | null,
): AgentCompanionTaskStatus | null {
  const latestOutput = latestAssistantSnippet(trackedDialogTurn(session, snapshot));

  if (session.needsUserAttention === 'ask_user') {
    return {
      sessionId: session.sessionId,
      title: sessionTitle(session),
      mood: 'waiting',
      state: 'attention',
      labelKey: 'agentCompanion.activity.needsInput',
      defaultLabel: 'Needs input',
      latestOutput,
      startedAt: session.lastActiveAt || session.updatedAt || session.createdAt,
      updatedAt: session.updatedAt || session.lastActiveAt || session.createdAt,
    };
  }

  if (session.needsUserAttention === 'tool_confirm') {
    return {
      sessionId: session.sessionId,
      title: sessionTitle(session),
      mood: 'waiting',
      state: 'attention',
      labelKey: 'agentCompanion.activity.needsApproval',
      defaultLabel: 'Needs approval',
      latestOutput,
      startedAt: session.lastActiveAt || session.updatedAt || session.createdAt,
      updatedAt: session.updatedAt || session.lastActiveAt || session.createdAt,
    };
  }

  return null;
}

function resolveAttentionTask(
  session: Session,
  snapshot: SessionStateMachine | null,
): AgentCompanionTaskStatus | null {
  return attentionTask(session, snapshot) ?? askUserQuestionAttentionTask(session, snapshot);
}

function completionTask(session: Session): AgentCompanionTaskStatus | null {
  if (!session.hasUnreadCompletion) {
    return null;
  }

  const base = {
    sessionId: session.sessionId,
    title: sessionTitle(session),
    mood: 'rest' as AgentCompanionMood,
    latestOutput: latestAssistantSnippet(session.dialogTurns[session.dialogTurns.length - 1]),
    startedAt: session.lastFinishedAt || session.updatedAt || session.lastActiveAt || session.createdAt,
    updatedAt: session.lastFinishedAt || session.updatedAt || session.lastActiveAt || session.createdAt,
  };

  if (session.hasUnreadCompletion === 'completed') {
    return {
      ...base,
      state: 'completed',
      labelKey: 'agentCompanion.activity.completed',
      defaultLabel: 'Completed',
    };
  }

  if (session.hasUnreadCompletion === 'interrupted') {
    return {
      ...base,
      state: 'interrupted',
      labelKey: 'agentCompanion.activity.interrupted',
      defaultLabel: 'Interrupted',
    };
  }

  return {
    ...base,
    state: 'error',
    labelKey: 'agentCompanion.activity.failed',
    defaultLabel: 'Failed',
  };
}

function taskStableOrder(task: AgentCompanionTaskStatus): number {
  return ensureTaskOrder(task.sessionId);
}

function aggregateMood(tasks: AgentCompanionTaskStatus[]): AgentCompanionMood {
  if (tasks.some(task => task.mood === 'waiting')) {
    return 'waiting';
  }
  if (tasks.some(task => task.mood === 'analyzing')) {
    return 'analyzing';
  }
  if (tasks.some(task => task.mood === 'working')) {
    return 'working';
  }
  return 'rest';
}

function isIndependentCompanionSession(session: Session): boolean {
  if (session.isTransient) {
    return false;
  }

  return !resolveSessionRelationship(session).isSubagent;
}

function deviceLabel(surfaceId: string): string {
  if (!isLocalSurface(surfaceId)) return resolveDeviceName(surfaceId);
  const localId = useDeviceDirectory.getState().localId;
  return localId ? resolveDeviceName(localId) : i18nService.t('common:nav.devices.thisDevice');
}

/** A session on a background device, known only through its host summary. */
function backgroundDeviceTask(row: CrossDeviceSession): AgentCompanionTaskStatus | null {
  const activity = row.activity;
  if (!activity) return null;
  const at = row.session.lastActiveAt || row.session.createdAt;
  const base = {
    sessionId: row.session.sessionId,
    title: toWellFormedText(resolvePersistedSessionTitle(row.session, key => i18nService.t(key))),
    startedAt: at,
    updatedAt: at,
    canReply: false,
    surfaceId: row.surfaceId,
    workspaceId: row.workspaceId,
    deviceName: toWellFormedText(deviceLabel(row.surfaceId)),
  };
  if (activity.pendingApprovals > 0) {
    return { ...base, mood: 'waiting', state: 'attention', labelKey: 'agentCompanion.activity.waitingApproval', defaultLabel: 'Waiting for approval' };
  }
  if (activity.pendingQuestions > 0) {
    return { ...base, mood: 'waiting', state: 'attention', labelKey: 'agentCompanion.activity.needsInput', defaultLabel: 'Needs input' };
  }
  if (activity.execution === 'running' || activity.execution === 'queued') {
    return { ...base, mood: 'working', state: 'running', labelKey: 'agentCompanion.activity.working', defaultLabel: 'Working' };
  }
  if (activity.unreadCompletion === 'completed') {
    return { ...base, mood: 'rest', state: 'completed', labelKey: 'agentCompanion.activity.completed', defaultLabel: 'Completed' };
  }
  if (activity.unreadCompletion === 'interrupted') {
    return { ...base, mood: 'rest', state: 'interrupted', labelKey: 'agentCompanion.activity.interrupted', defaultLabel: 'Interrupted' };
  }
  if (activity.unreadCompletion === 'error' || activity.execution === 'error') {
    return { ...base, mood: 'rest', state: 'error', labelKey: 'agentCompanion.activity.failed', defaultLabel: 'Failed' };
  }
  return null;
}

export function buildAgentCompanionActivity(): AgentCompanionActivityPayload {
  const sessions = Array.from(FlowChatStore.getInstance().getState().sessions.values())
    .filter(isIndependentCompanionSession);
  const tasks: AgentCompanionTaskStatus[] = [];

  sessions.forEach(session => {
    const snapshot = stateMachineManager.getSnapshot(session.sessionId);
    const mood = hasActiveTrackedTurn(session, snapshot)
      ? deriveAgentCompanionMood(snapshot)
      : 'rest';
    const canReply = resolveSessionRelationship(session).kind === 'normal';

    const attention = resolveAttentionTask(session, snapshot);
    if (attention) {
      tasks.push({ ...attention, canReply });
      return;
    }

    if (mood !== 'rest') {
      const label = runningLabel(snapshot);
      const turn = trackedDialogTurn(session, snapshot);
      tasks.push({
        sessionId: session.sessionId,
        title: sessionTitle(session),
        mood,
        state: label.state,
        labelKey: label.labelKey,
        defaultLabel: label.defaultLabel,
        latestOutput: latestAssistantSnippet(turn),
        startedAt: snapshot?.context.stats.startTime || session.lastActiveAt || session.updatedAt || session.createdAt,
        updatedAt: snapshot?.context.lastUpdateTime || session.updatedAt || session.lastActiveAt || session.createdAt,
        canReply,
      });
      return;
    }

    const completion = completionTask(session);
    if (completion) {
      tasks.push({ ...completion, canReply });
    }
  });

  // Other devices' sessions coexist with this one's in the companion.
  const listed = new Set(tasks.map(task => task.sessionId));
  for (const row of listBackgroundDeviceSessions()) {
    if (listed.has(row.session.sessionId)) continue;
    const task = backgroundDeviceTask(row);
    if (task) {
      tasks.push(task);
      listed.add(task.sessionId);
    }
  }

  if (!tasks.length) {
    pruneTaskOrder(tasks);
    return EMPTY_ACTIVITY;
  }

  [...tasks]
    .sort((a, b) => a.startedAt - b.startedAt)
    .forEach(task => {
      ensureTaskOrder(task.sessionId);
    });
  pruneTaskOrder(tasks);

  const sortedTasks = tasks
    .sort((a, b) => taskStableOrder(a) - taskStableOrder(b))
    .slice(0, 4);

  return {
    mood: aggregateMood(sortedTasks),
    tasks: sortedTasks,
  };
}

export function subscribeAgentCompanionActivity(
  listener: (payload: AgentCompanionActivityPayload) => void,
): () => void {
  // Stores notify far more often than the companion's facts change (streaming
  // tokens, catalog page reads); only a changed payload crosses to its window.
  let last = '';
  const emitCurrent = () => {
    const activity = buildAgentCompanionActivity();
    const key = JSON.stringify(activity);
    if (key === last) return;
    last = key;
    listener(activity);
  };

  const unsubscribeStore = FlowChatStore.getInstance().subscribe(emitCurrent);
  const unsubscribeMachines = stateMachineManager.subscribeGlobal(emitCurrent);
  const unsubscribeDevices = subscribeCrossDeviceSessions(emitCurrent);

  emitCurrent();

  return () => {
    unsubscribeStore();
    unsubscribeMachines();
    unsubscribeDevices();
  };
}
