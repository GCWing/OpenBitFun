import { afterEach, describe, expect, it, vi } from 'vitest';
import { flowChatStore } from '../store/FlowChatStore';
import { stateMachineManager } from '../state-machine/SessionStateMachineManager';
import { ProcessingPhase, SessionExecutionEvent, SessionExecutionState } from '../state-machine/types';
import type { DialogTurn, Session } from '../types/flow-chat';
import { buildAgentCompanionActivity } from './agentCompanionActivity';

const background = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('../services/crossDeviceSessions', () => ({
  listBackgroundDeviceSessions: () => background.rows,
  subscribeCrossDeviceSessions: () => () => undefined,
}));
vi.mock('@/infrastructure/account/deviceDirectory', () => ({
  resolveDeviceName: (id: string) => (id === 'peer-a' ? 'Studio Mac' : id),
  useDeviceDirectory: { getState: () => ({ localId: null }) },
}));

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }

  return false;
}

function resetState(): void {
  flowChatStore.setState(() => ({
    sessions: new Map(),
    activeSessionId: null,
  }));
  stateMachineManager.clear();
}

function createTurn(status: DialogTurn['status']): DialogTurn {
  return {
    id: 'turn-1',
    sessionId: 'session-1',
    userMessage: {
      id: 'user-1',
      content: 'Help me',
      timestamp: 1000,
    },
    modelRounds: [],
    status,
    startTime: 1000,
    endTime: status === 'completed' ? 2000 : undefined,
  };
}

function createSession(turnStatus: DialogTurn['status']): Session {
  return {
    sessionId: 'session-1',
    title: 'Remote Task',
    dialogTurns: [createTurn(turnStatus)],
    status: 'idle',
    config: { agentType: 'Standard' },
    createdAt: 900,
    lastActiveAt: 2000,
    updatedAt: 2000,
    error: null,
    isTransient: false,
  };
}

function createStreamingSessionWithText(content: string): Session {
  const turn = createTurn('processing');
  turn.modelRounds = [{
    id: 'round-1',
    index: 0,
    items: [{
      id: 'text-1',
      type: 'text',
      timestamp: 1500,
      status: 'streaming',
      content,
      isStreaming: true,
    }],
    isStreaming: true,
    isComplete: false,
    status: 'streaming',
    startTime: 1500,
  }];

  return {
    ...createSession('processing'),
    dialogTurns: [turn],
  };
}

function createCompletedSessionWithText(content: string): Session {
  const turn = createTurn('completed');
  turn.modelRounds = [{
    id: 'round-1',
    index: 0,
    items: [{
      id: 'text-1',
      type: 'text',
      timestamp: 1500,
      status: 'completed',
      content,
      isStreaming: false,
    }],
    isStreaming: false,
    isComplete: true,
    status: 'completed',
    startTime: 1500,
    endTime: 2000,
  }];

  return {
    ...createSession('completed'),
    dialogTurns: [turn],
    hasUnreadCompletion: 'completed',
    lastFinishedAt: 2100,
  };
}

async function putStateMachineInFinishing(): Promise<void> {
  await stateMachineManager.transition('session-1', SessionExecutionEvent.START, {
    taskId: 'session-1',
    dialogTurnId: 'turn-1',
  });
  await stateMachineManager.transition('session-1', SessionExecutionEvent.BACKEND_STREAM_COMPLETED);
}

async function putStateMachineInStreaming(): Promise<void> {
  await stateMachineManager.transition('session-1', SessionExecutionEvent.START, {
    taskId: 'session-1',
    dialogTurnId: 'turn-1',
  });
  await stateMachineManager.transition('session-1', SessionExecutionEvent.TEXT_CHUNK_RECEIVED);
}

function createAskUserQuestionSession(): Session {
  const turn = createTurn('processing');
  turn.modelRounds = [{
    id: 'round-1',
    index: 0,
    items: [{
      id: 'tool-1',
      type: 'tool',
      toolName: 'AskUserQuestion',
      timestamp: 1500,
      status: 'running',
      toolCall: {
        id: 'tool-call-1',
        input: {
          questions: [{
            header: 'Auth method',
            question: 'Which library should we use for date formatting?',
            options: [
              { label: 'date-fns', description: 'Lightweight modular utilities' },
              { label: 'moment', description: 'Legacy but well-known' },
            ],
          }],
        },
      },
      requiresConfirmation: false,
      isParamsStreaming: false,
    }],
    isStreaming: false,
    isComplete: false,
    status: 'running',
    startTime: 1500,
  }];

  return {
    ...createSession('processing'),
    dialogTurns: [turn],
  };
}

function createAskUserQuestionSessionWithTrailingText(): Session {
  const session = createAskUserQuestionSession();
  const turn = session.dialogTurns[0];
  turn.modelRounds[0].items.push({
    id: 'text-1',
    type: 'text',
    timestamp: 1600,
    status: 'streaming',
    content: '让我用 AskUserQuestion 工具问几个有用的问题，了解用户的需求和意图。',
    isStreaming: true,
  });
  return session;
}

describe('buildAgentCompanionActivity', () => {
  afterEach(() => {
    resetState();
  });

  it('keeps showing finishing while the tracked turn is still finishing', async () => {
    flowChatStore.setState(() => ({
      sessions: new Map([['session-1', createSession('finishing')]]),
      activeSessionId: 'session-1',
    }));
    await putStateMachineInFinishing();

    const activity = buildAgentCompanionActivity();

    expect(activity.tasks).toHaveLength(1);
    expect(activity.tasks[0]).toMatchObject({
      sessionId: 'session-1',
      labelKey: 'agentCompanion.activity.finishing',
    });
  });

  it('drops a stale finishing machine once the tracked turn is completed', async () => {
    flowChatStore.setState(() => ({
      sessions: new Map([['session-1', createSession('completed')]]),
      activeSessionId: 'session-1',
    }));
    await putStateMachineInFinishing();

    const snapshot = stateMachineManager.getSnapshot('session-1');
    expect(snapshot?.currentState).toBe(SessionExecutionState.FINISHING);
    expect(snapshot?.context.processingPhase).toBe(ProcessingPhase.FINALIZING);

    expect(buildAgentCompanionActivity()).toEqual({
      mood: 'rest',
      tasks: [],
    });
  });

  it('keeps the latest output source anchored to the newest text', async () => {
    const oldText = 'Older context that should not stay visible in the companion bubble. ';
    const latestText = 'Newest streaming words should keep appearing normally at the end';
    flowChatStore.setState(() => ({
      sessions: new Map([['session-1', createStreamingSessionWithText(oldText.repeat(4) + latestText)]]),
      activeSessionId: 'session-1',
    }));
    await putStateMachineInStreaming();

    const activity = buildAgentCompanionActivity();

    expect(activity.tasks[0].latestOutput).toContain(latestText);
    expect(activity.tasks[0].latestOutput?.endsWith('...')).toBe(false);
  });

  it('cleans only a bounded tail of a long reply with the same visible result', async () => {
    // Oracle: the whole-text cleanup the companion applied before windowing.
    const wholeText = (markdown: string) => markdown
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
      .trim()
      .slice(-512);
    const block = (index: number) => `## Part ${index}\n\nSome **bold** and \`code\` with a [link](https://example.com/${index}).\n\n- item _${index}_\n> quoted\n\n`;
    const longFence = '```ts\n' + 'const value = `x` * 2; // **not bold**\n'.repeat(200) + '```\n';
    const documents = [
      Array.from({ length: 300 }, (_, index) => block(index)).join(''),
      // The window starts inside a fence that opened long before it.
      Array.from({ length: 40 }, (_, index) => block(index)).join('') + longFence + 'Closing words.',
      Array.from({ length: 40 }, (_, index) => block(index)).join('') + '```ts\n' + 'still streaming code\n'.repeat(400),
      // Mostly link targets: the window cleans below the visible budget.
      Array.from({ length: 400 }, (_, index) => `[x](https://example.com/${'p'.repeat(60)}/${index}) `).join(''),
    ];
    await putStateMachineInStreaming();
    for (const content of documents) {
      flowChatStore.setState(() => ({
        sessions: new Map([['session-1', createStreamingSessionWithText(content)]]),
        activeSessionId: 'session-1',
      }));
      expect(buildAgentCompanionActivity().tasks[0].latestOutput).toBe(wholeText(content));
    }
  });

  it('keeps truncated latest output well-formed for desktop pet events', async () => {
    const content = '\uD83D\uDE00' + 'a'.repeat(511);
    flowChatStore.setState(() => ({
      sessions: new Map([['session-1', createStreamingSessionWithText(content)]]),
      activeSessionId: 'session-1',
    }));
    await putStateMachineInStreaming();

    const latestOutput = buildAgentCompanionActivity().tasks[0].latestOutput;

    expect(latestOutput).toBeDefined();
    expect(hasLoneSurrogate(latestOutput!)).toBe(false);
  });

  it('keeps the final assistant output visible after completion', () => {
    const finalText = 'Final analysis summary remains visible in the companion bubble.';
    flowChatStore.setState(() => ({
      sessions: new Map([['session-1', createCompletedSessionWithText(finalText)]]),
      activeSessionId: 'session-1',
    }));

    const activity = buildAgentCompanionActivity();

    expect(activity.tasks[0]).toMatchObject({
      state: 'completed',
      latestOutput: finalText,
    });
  });

  it('does not show hidden subagent sessions as companion bubbles', async () => {
    const parentSession = createSession('processing');
    const subagentSession: Session = {
      ...createSession('completed'),
      sessionId: 'subagent-1',
      title: 'Explore: Find ppt',
      sessionKind: 'subagent',
      parentSessionId: 'session-1',
      parentToolCallId: 'task-call-1',
      subagentType: 'Explore',
      hasUnreadCompletion: 'completed',
      lastFinishedAt: 2200,
    };

    flowChatStore.setState(() => ({
      sessions: new Map([
        ['session-1', parentSession],
        ['subagent-1', subagentSession],
      ]),
      activeSessionId: 'session-1',
    }));
    await putStateMachineInStreaming();

    const activity = buildAgentCompanionActivity();

    expect(activity.tasks).toHaveLength(1);
    expect(activity.tasks[0]?.sessionId).toBe('session-1');
  });

  it('shows attention state when the active turn is waiting on AskUserQuestion', async () => {
    flowChatStore.setState(() => ({
      sessions: new Map([['session-1', createAskUserQuestionSession()]]),
      activeSessionId: 'session-1',
    }));
    await putStateMachineInStreaming();

    const activity = buildAgentCompanionActivity();

    expect(activity.tasks).toHaveLength(1);
    expect(activity.tasks[0]).toMatchObject({
      sessionId: 'session-1',
      state: 'attention',
      labelKey: 'agentCompanion.activity.needsInput',
      latestOutput: 'Which library should we use for date formatting?',
    });
  });

  it('shows attention state even when trailing assistant text is still streaming', async () => {
    flowChatStore.setState(() => ({
      sessions: new Map([['session-1', createAskUserQuestionSessionWithTrailingText()]]),
      activeSessionId: 'session-1',
    }));
    await putStateMachineInStreaming();

    const activity = buildAgentCompanionActivity();

    expect(activity.tasks).toHaveLength(1);
    expect(activity.tasks[0]).toMatchObject({
      sessionId: 'session-1',
      state: 'attention',
      labelKey: 'agentCompanion.activity.needsInput',
      latestOutput: 'Which library should we use for date formatting?',
    });
  });

  it('gives needsUserAttention priority over an active running task', async () => {
    flowChatStore.setState(() => ({
      sessions: new Map([['session-1', createStreamingSessionWithText('Still thinking...')]]),
      activeSessionId: 'session-1',
    }));
    await putStateMachineInStreaming();

    flowChatStore.setSessionNeedsAttention('session-1', 'ask_user');

    const activity = buildAgentCompanionActivity();

    expect(activity.tasks).toHaveLength(1);
    expect(activity.tasks[0]).toMatchObject({
      sessionId: 'session-1',
      state: 'attention',
      labelKey: 'agentCompanion.activity.needsInput',
    });
  });

  it('does not show attention for a completed AskUserQuestion tool', async () => {
    const session = createAskUserQuestionSession();
    session.dialogTurns[0].modelRounds[0].items[0].status = 'completed';

    flowChatStore.setState(() => ({
      sessions: new Map([['session-1', session]]),
      activeSessionId: 'session-1',
    }));
    await putStateMachineInStreaming();

    const activity = buildAgentCompanionActivity();

    expect(activity.tasks).toHaveLength(1);
    expect(activity.tasks[0].state).not.toBe('attention');
  });

  it('does not show attention while AskUserQuestion params are still streaming', async () => {
    const session = createAskUserQuestionSession();
    const tool = session.dialogTurns[0].modelRounds[0].items[0];
    tool.status = 'streaming';
    tool.isParamsStreaming = true;

    flowChatStore.setState(() => ({
      sessions: new Map([['session-1', session]]),
      activeSessionId: 'session-1',
    }));
    await putStateMachineInStreaming();

    const activity = buildAgentCompanionActivity();

    expect(activity.tasks).toHaveLength(1);
    expect(activity.tasks[0].state).not.toBe('attention');
  });

  it('adds other devices sessions that need attention, run, or finished unread', () => {
    const row = (sessionId: string, activity: Record<string, unknown> | undefined) => ({
      surfaceId: 'peer-a',
      workspaceId: 'ws-1',
      session: { sessionId, sessionName: `Remote ${sessionId}`, turnCount: 1, createdAt: 1, lastActiveAt: 2 },
      activity: activity && { sessionId, execution: 'idle', pendingApprovals: 0, pendingQuestions: 0, ...activity },
    });
    background.rows = [
      row('r-approval', { execution: 'running', pendingApprovals: 1 }),
      row('r-running', { execution: 'running' }),
      row('r-done', { unreadCompletion: 'completed' }),
      row('r-idle', {}),
      row('r-unknown', undefined),
    ];
    try {
      const activity = buildAgentCompanionActivity();
      expect(activity.tasks.map(task => [task.sessionId, task.state])).toEqual([
        ['r-approval', 'attention'],
        ['r-running', 'running'],
        ['r-done', 'completed'],
      ]);
      expect(activity.tasks.every(task => task.surfaceId === 'peer-a' && task.workspaceId === 'ws-1'
        && task.deviceName === 'Studio Mac' && task.canReply === false)).toBe(true);
      expect(activity.mood).toBe('waiting');
    } finally {
      background.rows = [];
    }
  });
});
