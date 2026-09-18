import { flowChatSessionConfigForWorkspace } from '@/app/utils/projectSessionWorkspace';
import { FlowChatManager } from '@/flow_chat/services/FlowChatManager';
import { openMainSession } from '@/flow_chat/services/sessionActivation';
import { stateMachineManager } from '@/flow_chat/state-machine';
import { SessionExecutionState } from '@/flow_chat/state-machine/types';
import { pendingQueueManager } from '@/flow_chat/services/flow-chat-manager/PendingQueueModule';
import type { DialogTurn, FlowTextItem, Session } from '@/flow_chat/types/flow-chat';
import {
  subscribeAgentCompanionActivity,
  type AgentCompanionTaskStatus,
} from '@/flow_chat/utils/agentCompanionActivity';
import type { WorkspaceInfo } from '@/shared/types';
import { getActiveSurfaceScope, type SurfaceScope } from '@/infrastructure/peer-device/deviceSurface';

const TASK_TIMEOUT_MS = 30 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 20_000;
const TEXT_PROGRESS_INTERVAL_MS = 8_000;
const MAX_RESULT_CHARS = 6_000;
const MAX_PROGRESS_CHARS = 90;
const MAX_CONCLUSION_CHARS = 320;
const MAX_CONCLUSION_SENTENCES = 5;

type SentenceSegmenter = {
  segment: (input: string) => Iterable<{ segment: string }>;
};

type SentenceSegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity: 'sentence' },
) => SentenceSegmenter;

let cachedSentenceSegmenter: SentenceSegmenter | null | undefined;

export type VoiceTaskProgressPhase =
  | 'starting'
  | 'working'
  | 'using_tools'
  | 'waiting_approval'
  | 'needs_input'
  | 'finishing'
  | 'stopping';

export interface VoiceTaskProgress {
  sessionId: string;
  phase: VoiceTaskProgressPhase;
}

export interface VoiceTaskResult {
  sessionId: string;
  summary: string;
  conclusion: string;
}

interface ObserveVoiceTaskOptions {
  signal?: AbortSignal;
  onSessionCreated?: (sessionId: string) => void;
  onProgress?: (progress: VoiceTaskProgress) => void;
  onTextProgress?: (text: string) => void;
}

interface RunVoiceTaskOptions extends ObserveVoiceTaskOptions {
  workspace: WorkspaceInfo;
  showSession?: boolean;
}

interface RunMiniAppVoiceTaskOptions extends ObserveVoiceTaskOptions {
  sessionId: string;
  submit: (signal?: AbortSignal) => Promise<void>;
}

export class VoiceTaskCancelledError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super('OpenBitFun task was cancelled');
    this.name = 'VoiceTaskCancelledError';
    this.sessionId = sessionId;
  }
}

function progressPhase(task: AgentCompanionTaskStatus | undefined): VoiceTaskProgressPhase {
  if (!task) return 'working';
  if (task.state === 'attention') {
    return task.labelKey.endsWith('needsInput') ? 'needs_input' : 'waiting_approval';
  }
  if (task.labelKey.endsWith('usingTools')) return 'using_tools';
  if (task.labelKey.endsWith('finishing')) return 'finishing';
  return 'working';
}

function normalizeAssistantText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*(?:[-+\u2022]|\d+[.)\u3001])\s+/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeConclusionText(text: string): string {
  const lines = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .split(/\r?\n+/)
    .map(line => {
      const heading = /^\s{0,3}#{1,6}\s+/.test(line);
      const value = line
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s{0,3}>\s?/, '')
        .replace(/^\s*(?:[-+\u2022]|\d+[.)\u3001])\s+/, '')
        .replace(/[*_~]{1,3}/g, '')
        .replace(/[()\uFF08\uFF09]/g, '')
        .trim();
      return { heading, value };
    })
    .filter(line => line.value && !/^[-=]{3,}$/.test(line.value));

  const contentLines = lines.some(line => !line.heading)
    ? lines.filter(line => !line.heading)
    : lines;

  return contentLines.reduce((result, line) => {
    if (!result) return line.value;
    if (/[:\uFF1A]$/.test(result)) return `${result} ${line.value}`;
    if (/[\u3002\uFF01\uFF1F.!?\uFF1B;]$/.test(result)) return `${result} ${line.value}`;
    return /[\u3400-\u9fff]/.test(`${result}${line.value}`)
      ? `${result}\u3002${line.value}`
      : `${result}. ${line.value}`;
  }, '').replace(/\s+/g, ' ').trim();
}

function latestTurn(session: Session): DialogTurn | undefined {
  return session.dialogTurns[session.dialogTurns.length - 1];
}

export function selectVoiceTaskTurn(
  session: Session,
  baselineTurnIds: ReadonlySet<string>,
  taskId?: string,
): DialogTurn | undefined {
  return session.dialogTurns.find(turn => !baselineTurnIds.has(turn.id)
    && (!taskId || turn.userMessage.metadata?.voiceTaskId === taskId));
}

function truncateBriefText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const candidate = text.slice(0, maxChars);
  const boundaries = ['。', '！', '？', '. ', '! ', '? ', '；', '; ']
    .map(mark => candidate.lastIndexOf(mark))
    .filter(index => index >= Math.floor(maxChars * 0.45));
  const boundary = boundaries.length ? Math.max(...boundaries) + 1 : -1;
  return `${candidate.slice(0, boundary > 0 ? boundary : maxChars - 1).trim()}…`;
}

function progressSentences(text: string): string[] {
  if (cachedSentenceSegmenter === undefined) {
    const Segmenter = (Intl as typeof Intl & {
      Segmenter?: SentenceSegmenterConstructor;
    }).Segmenter;
    cachedSentenceSegmenter = Segmenter
      ? new Segmenter(undefined, { granularity: 'sentence' })
      : null;
  }
  if (cachedSentenceSegmenter) {
    return Array.from(cachedSentenceSegmenter.segment(text), part => part.segment.trim())
      .filter(Boolean);
  }
  return text
    .match(/[^\u3002\uFF01\uFF1F!?\uFF1B;]+(?:[\u3002\uFF01\uFF1F!?\uFF1B;]|\.(?=\s|$))?/g)
    ?.map(sentence => sentence.trim())
    .filter(Boolean) ?? [];
}

function cleanConclusionSentence(sentence: string): string {
  const value = sentence
    .replace(/[()\uFF08\uFF09]/g, '')
    .replace(
      /^(?:\u4E0B\u9762|\u4EE5\u4E0B|\u8FD9\u91CC)(?:\u662F|\u4E3A|\u7ED9\u51FA|\u6574\u7406|\u63D0\u4F9B)(?:\u6574\u7406\u597D\u7684|\u7B80\u8981\u7684|\u7B80\u8981)?(?:\u4ECB\u7ECD|\u7ED3\u8BBA|\u603B\u7ED3|\u56DE\u7B54|\u7ED3\u679C)?\s*[:\uFF1A,\uFF0C]?\s*/,
      '',
    )
    .replace(
      /^(?:below|here|the following)\s+(?:is|are)\s+(?:the\s+)?(?:brief\s+|concise\s+)?(?:introduction|conclusion|summary|answer|result)\s*[:,-]?\s*/i,
      '',
    )
    .trim();
  if (!value) return '';

  const withoutPunctuation = value.replace(/[\u3002\uFF01\uFF1F.!?\uFF1B;:\uFF1A]+$/g, '').trim();
  if (
    /^(?:(?:\u6211|\u6211\u4EEC)(?:\u5DF2\u7ECF|\u5DF2)?|(?:\u5DF2\u7ECF|\u5DF2))(?:\u901A\u8BFB|\u9605\u8BFB|\u67E5\u9605|\u6D4F\u89C8|\u67E5\u770B|\u770B\u8FC7|\u7814\u7A76)/.test(withoutPunctuation)
    || /^(?:I|we)(?:'ve| have)?\s+(?:read|reviewed|consulted|looked through|studied)\b/i.test(withoutPunctuation)
    || /^(?:[\w.-]+\s*)?(?:\u9879\u76EE)?(?:\u4ECB\u7ECD|\u6982\u89C8|\u603B\u7ED3|\u7ED3\u8BBA|\u6700\u7EC8\u7ED3\u679C|\u56DE\u7B54)$/i.test(withoutPunctuation)
  ) {
    return '';
  }
  return value;
}

function rewriteProgressSentence(sentence: string): string {
  const punctuation = sentence.match(/[\u3002.\uFF01\uFF1F!?\uFF1B;]$/)?.[0] ?? '';
  let value = punctuation ? sentence.slice(0, -1).trim() : sentence.trim();
  value = value
    .replace(/^(?:progress|update|status)\s*[:\uFF1A-]?\s*/i, '')
    .replace(/^(?:\u8FDB\u5C55|\u66F4\u65B0|\u72B6\u6001)\s*[:\uFF1A-]?\s*/, '')
    .replace(/^(?:\u6211|\u6211\u4EEC|OpenBitFun)\s*/, '');

  const completedChinese = value.match(
    /^(?:\u5DF2\u7ECF|\u5DF2)\u5B8C\u6210\u4E86?(.+?)(?:\uFF0C(.+))?$/,
  );
  if (completedChinese) {
    value = `${completedChinese[1]}\u5DF2\u5B8C\u6210${completedChinese[2] ? `\uFF0C${completedChinese[2]}` : ''}`;
  }
  value = value
    .replace(
      /^(?:\u63A5\u4E0B\u6765|\u4E0B\u4E00\u6B65)(?:\u6211)?(?:\u4F1A|\u5C06|\u51C6\u5907)?\s*/,
      '\u4E0B\u4E00\u6B65',
    )
    .replace(
      /^(?:\u76EE\u524D|\u73B0\u5728)?(?:\u6B63\u5728|\u5728)\s*/,
      '\u6B63\u5728',
    );

  value = value
    .replace(/^(?:I|we)(?:'ve| have) (?:finished|completed) (.+)$/i, 'Completed $1')
    .replace(/^(?:I am|I'm|we are|we're) (.+)$/i, 'Now $1')
    .replace(/^Next,?\s+(?:I|we) (?:will|'ll)\s+/i, 'Next, ')
    .replace(/^Finished (.+?) and (?:I )?am (.+)$/i, 'Finished $1. Now $2');

  if (!value) return '';
  return `${value}${punctuation || (/[\u3400-\u9fff]/.test(value) ? '\u3002' : '.')}`;
}

export function summarizeVoiceTaskProgress(text: string): string {
  const normalized = normalizeAssistantText(text);
  if (!normalized) return '';

  const rewritten = progressSentences(normalized)
    .map(rewriteProgressSentence)
    .filter(Boolean)
    .join(/[\u3400-\u9fff]/.test(normalized) ? '' : ' ');
  const candidates = progressSentences(rewritten);
  if (!candidates.length) return '';

  const selected = [candidates[0]];
  if (candidates.length > 1) {
    const nextStep = candidates.slice(1).find(sentence =>
      /(?:\u4E0B\u4E00\u6B65|\u63A5\u4E0B\u6765|\u6B63\u5728|\u7EE7\u7EED|now|next|checking|running|testing)/i.test(sentence));
    selected.push(nextStep ?? candidates[1]);
  }
  const separator = /[\u3400-\u9fff]/.test(normalized) ? '' : ' ';
  return truncateBriefText(selected.join(separator), MAX_PROGRESS_CHARS);
}

export function summarizeVoiceTaskConclusion(text: string): string {
  const normalized = normalizeConclusionText(text)
    .replace(
      /^(?:(?:\u6700\u7EC8)?(?:\u7ED3\u8BBA|\u7ED3\u679C|\u603B\u7ED3)|(?:final\s+)?(?:conclusion|result|summary))\s*[:\uFF1A-]?\s*/i,
      '',
    )
    .replace(/^(?:\u4EFB\u52A1)?(?:\u5DF2\u5B8C\u6210|\u5B8C\u6210)[\u3002\uFF01!:\uFF1A-]*\s*/, '')
    .replace(/^(?:(?:the\s+)?task\s+)?(?:is\s+|was\s+)?completed?[.!:\s-]*/i, '')
    .replace(/^(?:done|finished)[.!:\s-]*/i, '')
    .trim();
  if (!normalized) return '';

  const candidates = progressSentences(normalized);
  if (!candidates.length) return '';
  const separator = /[\u3400-\u9fff]/.test(normalized) ? '' : ' ';
  const seen = new Set<string>();
  const selected: string[] = [];
  for (const candidate of candidates) {
    const cleaned = cleanConclusionSentence(candidate);
    if (!cleaned) continue;
    const key = cleaned.toLocaleLowerCase().replace(/[\s\u3002\uFF01\uFF1F.!?\uFF1B;:\uFF1A]/g, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    selected.push(cleaned);
    if (selected.length >= MAX_CONCLUSION_SENTENCES) break;
  }
  if (!selected.length) return '';
  return truncateBriefText(
    selected.join(separator),
    MAX_CONCLUSION_CHARS,
  );
}

export function extractVoiceTaskProgressTexts(session: Session): Array<{ id: string; text: string }> {
  const turn = latestTurn(session);
  if (!turn || !['processing', 'finishing'].includes(turn.status)) return [];

  const updates: Array<{ id: string; text: string }> = [];
  turn.modelRounds.forEach(round => {
    round.items.forEach(item => {
      if (item.type !== 'text') return;
      const textItem = item as FlowTextItem;
      if (textItem.isStreaming || textItem.status !== 'completed') return;
      const text = summarizeVoiceTaskProgress(textItem.content);
      if (!text) return;
      updates.push({ id: `${round.id}:${textItem.id}:${text}`, text });
    });
  });
  return updates;
}

export function extractVoiceTaskSummary(session: Session): string {
  const turn = latestTurn(session);
  if (!turn) {
    return 'OpenBitFun completed the task without a text response.';
  }
  const parts: string[] = [];
  turn.modelRounds.forEach(round => {
    round.items.forEach(item => {
      if (item.type !== 'text') return;
      const text = normalizeAssistantText((item as FlowTextItem).content);
      if (text) parts.push(text);
    });
  });
  const summary = parts.join(' ').trim();
  if (new TextEncoder().encode(summary).length <= MAX_RESULT_CHARS) {
    return summary || 'OpenBitFun completed the task without a text response.';
  }
  // UTF-8 tool-result limits also apply to CJK and emoji responses.
  let result = '';
  let bytes = 3;
  for (const point of summary) {
    bytes += new TextEncoder().encode(point).length;
    if (bytes > MAX_RESULT_CHARS) break;
    result += point;
  }
  return `${result}…`;
}

export function extractVoiceTaskConclusion(session: Session): string {
  const turn = latestTurn(session);
  if (!turn) return '';

  let finalText = '';
  turn.modelRounds.forEach(round => {
    round.items.forEach(item => {
      if (item.type !== 'text') return;
      const textItem = item as FlowTextItem;
      if (textItem.isStreaming || textItem.status !== 'completed') return;
      if (textItem.content.trim()) finalText = textItem.content;
    });
  });
  return summarizeVoiceTaskConclusion(finalText);
}

async function waitForSettledSession(
  sessionId: string,
  baselineTurnIds: ReadonlySet<string>,
  scope: SurfaceScope,
  taskId?: string,
): Promise<void> {
  scope.assertCurrent('observe voice task');
  const isSettled = () => {
    if (!scope.isCurrent()) return false;
    const state = stateMachineManager.getCurrentState(sessionId);
    if (!taskId && state !== SessionExecutionState.IDLE && state !== SessionExecutionState.ERROR) {
      return false;
    }
    const session = FlowChatManager.getInstance().getFlowChatState().sessions.get(sessionId);
    const turn = session ? selectVoiceTaskTurn(session, baselineTurnIds, taskId) : undefined;
    return Boolean(turn && !['pending', 'processing', 'finishing', 'cancelling'].includes(turn.status));
  };

  if (isSettled()) return;
  await new Promise<void>((resolve, reject) => {
    const stateSubscription = { dispose: () => undefined as void };
    const flowSubscription = { dispose: () => undefined as void };
    let finished = false;
    const finish = (activeTimeoutId: number) => {
      if (finished) return;
      finished = true;
      window.clearTimeout(activeTimeoutId);
      stateSubscription.dispose();
      flowSubscription.dispose();
      scope.signal.removeEventListener('abort', disconnected);
      resolve();
    };
    const timeoutId = window.setTimeout(() => {
      if (finished) return;
      finished = true;
      stateSubscription.dispose();
      flowSubscription.dispose();
      scope.signal.removeEventListener('abort', disconnected);
      reject(new Error('OpenBitFun task timed out after 30 minutes'));
    }, TASK_TIMEOUT_MS);
    function disconnected() {
      if (finished) return;
      finished = true;
      window.clearTimeout(timeoutId);
      stateSubscription.dispose();
      flowSubscription.dispose();
      try { scope.assertCurrent('observe voice task'); } catch (error) { reject(error); }
    }
    scope.signal.addEventListener('abort', disconnected, { once: true });
    stateSubscription.dispose = stateMachineManager.subscribeGlobal((changedSessionId) => {
      if (changedSessionId !== sessionId || !isSettled()) return;
      finish(timeoutId);
    });
    flowSubscription.dispose = FlowChatManager.getInstance().onFlowChatStateChange(() => {
      if (isSettled()) finish(timeoutId);
    });
    // Close the check/subscribe race: a very short task or cancellation can
    // settle after the first check and before the global listener is attached.
    if (finished) {
      stateSubscription.dispose();
      flowSubscription.dispose();
    } else if (isSettled()) finish(timeoutId);
  });
}

async function observeVoiceTaskSession(
  sessionId: string,
  baselineTurnIds: ReadonlySet<string>,
  options: ObserveVoiceTaskOptions,
  startTask: () => Promise<void>,
  scope: SurfaceScope = getActiveSurfaceScope(),
  taskId?: string,
): Promise<VoiceTaskResult> {
  scope.assertCurrent('start voice task');
  const manager = FlowChatManager.getInstance();

  let lastUserUpdateAt = Date.now();
  const emitProgress = (phase: VoiceTaskProgressPhase) => {
    if (!scope.isCurrent()) return;
    lastUserUpdateAt = Date.now();
    options.onProgress?.({ sessionId, phase });
  };
  emitProgress('starting');

  let latestPhase: VoiceTaskProgressPhase = 'starting';
  const emitFromActivity = (taskStatus?: AgentCompanionTaskStatus) => {
    const phase = progressPhase(taskStatus);
    if (phase === latestPhase) return;
    latestPhase = phase;
    emitProgress(phase);
  };
  const unsubscribeActivity = subscribeAgentCompanionActivity(payload => {
    emitFromActivity(payload.tasks.find(item => item.sessionId === sessionId));
  });

  const seenTextProgress = new Set<string>();
  let lastTextProgress = '';
  let pendingTextProgress = '';
  let textProgressTimer: number | null = null;
  const publishTextProgress = () => {
    textProgressTimer = null;
    const text = pendingTextProgress;
    pendingTextProgress = '';
    if (!scope.isCurrent() || !text || text === lastTextProgress) return;
    lastTextProgress = text;
    lastUserUpdateAt = Date.now();
    options.onTextProgress?.(text);
  };
  const queueTextProgress = (text: string) => {
    if (!options.onTextProgress || text === lastTextProgress) return;
    pendingTextProgress = text;
    const delay = Math.max(0, TEXT_PROGRESS_INTERVAL_MS - (Date.now() - lastUserUpdateAt));
    if (delay === 0) {
      if (textProgressTimer !== null) window.clearTimeout(textProgressTimer);
      publishTextProgress();
    } else if (textProgressTimer === null) {
      textProgressTimer = window.setTimeout(publishTextProgress, delay);
    }
  };
  const unsubscribeState = manager.onFlowChatStateChange(state => {
    if (!scope.isCurrent()) return;
    const session = state.sessions.get(sessionId) as Session | undefined;
    const turn = session && selectVoiceTaskTurn(session, baselineTurnIds, taskId);
    if (!session || !turn) return;
    extractVoiceTaskProgressTexts({ ...session, dialogTurns: [turn] }).forEach(update => {
      if (seenTextProgress.has(update.id)) return;
      seenTextProgress.add(update.id);
      queueTextProgress(update.text);
    });
  });

  const heartbeatId = window.setInterval(() => {
    if (Date.now() - lastUserUpdateAt < HEARTBEAT_INTERVAL_MS) return;
    emitProgress(latestPhase === 'starting' ? 'working' : latestPhase);
  }, HEARTBEAT_INTERVAL_MS);

  let cancellationInFlight: Promise<boolean> | null = null;
  const requestCancellation = (): Promise<boolean> => {
    // A detached observer must never cancel the same id on the next device.
    if (!scope.isCurrent()) return Promise.resolve(false);
    if (taskId) {
      const session = manager.getFlowChatState().sessions.get(sessionId);
      const turn = session && selectVoiceTaskTurn(session, baselineTurnIds, taskId);
      if (!turn || !['pending', 'processing', 'finishing', 'cancelling'].includes(turn.status)) return Promise.resolve(false);
    }
    if (cancellationInFlight) return cancellationInFlight;
    cancellationInFlight = manager.cancelSessionTask(sessionId).finally(() => {
      cancellationInFlight = null;
    });
    return cancellationInFlight;
  };
  const handleAbort = () => {
    void requestCancellation();
  };
  options.signal?.addEventListener('abort', handleAbort);

  try {
    if (options.signal?.aborted) {
      throw new VoiceTaskCancelledError(sessionId);
    }
    try {
      await startTask();
      scope.assertCurrent('submit voice task');
    } catch (error) {
      if (!options.signal?.aborted) throw error;
      await requestCancellation().catch(() => false);
      throw new VoiceTaskCancelledError(sessionId);
    }
    if (options.signal?.aborted) {
      await requestCancellation();
    }
    await waitForSettledSession(sessionId, baselineTurnIds, scope, taskId);
    scope.assertCurrent('complete voice task');
    const session = manager.getFlowChatState().sessions.get(sessionId);
    if (!session) {
      throw new Error('OpenBitFun task session disappeared before completion');
    }
    const turn = selectVoiceTaskTurn(session, baselineTurnIds, taskId);
    if (!turn || turn.status === 'error') {
      throw new Error(turn?.error || session.error || 'OpenBitFun task failed');
    }
    if (turn.status === 'cancelled') {
      throw new VoiceTaskCancelledError(sessionId);
    }
    const taskSession = { ...session, dialogTurns: [turn] };
    return {
      sessionId,
      summary: extractVoiceTaskSummary(taskSession),
      conclusion: extractVoiceTaskConclusion(taskSession),
    };
  } finally {
    options.signal?.removeEventListener('abort', handleAbort);
    window.clearInterval(heartbeatId);
    if (textProgressTimer !== null) window.clearTimeout(textProgressTimer);
    unsubscribeState();
    unsubscribeActivity();
  }
}

/**
 * Delegation boundary between client-level Voice and workspace execution.
 *
 * This creates a regular FlowChat session using the user's default Harness. It follows the
 * same product assembly, workspace adapters, tool registry, plugin/MCP setup,
 * and permission flow as a task started from the normal UI. Voice supplies only
 * the complete task intent and target workspace, then observes progress,
 * cancellation, and the final public result.
 *
 * Do not copy the workspace Agent's tools into the Voice provider session and
 * do not proxy individual Agent tool calls through this bridge. If a new
 * workspace capability should be usable from Voice, implement it in the normal
 * Agent execution path; delegated sessions will inherit it automatically. Only
 * direct client-control operations need a new Voice function command.
 */
export async function runOpenBitFunVoiceTask(
  task: string,
  options: RunVoiceTaskOptions,
): Promise<VoiceTaskResult> {
  const normalizedTask = task.trim();
  if (!normalizedTask) {
    throw new Error('OpenBitFun task description is empty');
  }

  const scope = getActiveSurfaceScope();
  const manager = FlowChatManager.getInstance();
  const sessionId = await manager.createChatSession(
    flowChatSessionConfigForWorkspace(options.workspace),
  );
  scope.assertCurrent('create voice task session');
  options.onSessionCreated?.(sessionId);
  if (options.showSession !== false) {
    await openMainSession(sessionId);
  }

  return observeVoiceTaskSession(sessionId, new Set(), options, () => (
    manager.sendMessage(
      normalizedTask,
      sessionId,
      normalizedTask,
      'Standard',
      undefined,
      { userMessageMetadata: { source: 'realtime_voice' } },
    )
  ), scope);
}

/**
 * Reuses an Agentic MiniApp's already-bound topic session. Voice submits via
 * the MiniApp chat contract rather than bypassing its domain prompt and file
 * workflow, then observes only turns created after this request began.
 */
export async function runMiniAppVoiceTask(
  task: string,
  options: RunMiniAppVoiceTaskOptions,
): Promise<VoiceTaskResult> {
  const normalizedTask = task.trim();
  if (!normalizedTask) {
    throw new Error('OpenBitFun task description is empty');
  }

  const session = FlowChatManager.getInstance()
    .getFlowChatState()
    .sessions
    .get(options.sessionId);
  if (!session) {
    throw new Error('MiniApp task session is no longer available');
  }
  assertVoiceTaskAdmission(session);
  const baselineTurnIds = new Set(session.dialogTurns.map(turn => turn.id));
  options.onSessionCreated?.(options.sessionId);
  return observeVoiceTaskSession(
    options.sessionId,
    baselineTurnIds,
    options,
    () => options.submit(options.signal),
  );
}

/** Text and voice share admission, permissions, cancellation and the same Agent. */
function assertVoiceTaskAdmission(session: Session) {
  if (session.dialogTurns.some(turn => ['pending', 'processing', 'finishing', 'cancelling', 'image_analyzing'].includes(turn.status))
    || pendingQueueManager.list(session.sessionId).length > 0) {
    throw new Error('This conversation already has a running or queued task. Wait for it to finish before starting another voice task.');
  }
}

export async function runBoundVoiceTask(task: string, options: Omit<RunMiniAppVoiceTaskOptions, 'submit'> & { exchangeId?: string }): Promise<VoiceTaskResult> {
  const manager = FlowChatManager.getInstance();
  const session = manager.getFlowChatState().sessions.get(options.sessionId);
  if (!session) throw new Error('The bound voice conversation is unavailable');
  assertVoiceTaskAdmission(session);
  const taskId = options.exchangeId ?? crypto.randomUUID();
  const baseline = new Set(session.dialogTurns.map(turn => turn.id));
  options.onSessionCreated?.(options.sessionId);
  return observeVoiceTaskSession(options.sessionId, baseline, options, () => manager.sendMessage(
    task, options.sessionId, task, session.mode, undefined,
    { userMessageMetadata: { source: 'realtime_voice', voiceTaskId: taskId } },
  ), getActiveSurfaceScope(), taskId);
}
