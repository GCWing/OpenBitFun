import { handleUserQuestionWaiting } from './EventHandlerModule';
import { afterEach, describe, expect, it } from 'vitest';
import { FlowChatStore } from '../../store/FlowChatStore';
import type { DialogTurn, FlowToolItem, ModelRound, Session } from '../../types/flow-chat';
import { processToolEvent, processToolParamsPartialInternal } from './ToolEventModule';
import { convertDialogTurnToBackendFormat } from './PersistenceModule';
import { projectEffectiveToolItem } from '../../utils/toolInvocationIdentity';

function resetStore(): void {
  FlowChatStore.getInstance().setState(() => ({
    sessions: new Map(),
    activeSessionId: null,
  }));
}

function createSessionWithTool(tool: FlowToolItem): Session {
  const round: ModelRound = {
    id: 'round-1',
    index: 0,
    items: [tool],
    isStreaming: true,
    isComplete: false,
    status: 'streaming',
    startTime: 1000,
  };
  const turn: DialogTurn = {
    id: 'turn-1',
    sessionId: 'session-1',
    userMessage: {
      id: 'user-1',
      content: 'Inspect this file',
      timestamp: 900,
    },
    modelRounds: [round],
    status: 'processing',
    startTime: 900,
  };

  return {
    sessionId: 'session-1',
    title: 'Session 1',
    dialogTurns: [turn],
    status: 'active',
    config: { agentType: 'Standard' },
    createdAt: 800,
    lastActiveAt: 1000,
    error: null,
    sessionKind: 'normal',
  };
}

function makeToolContext(): any {
  return {
    flowChatStore: FlowChatStore.getInstance(),
    eventBatcher: {
      getBufferSize: () => 0,
      flushNow: () => {},
    },
    saveDebouncers: new Map(),
    lastSaveTimestamps: new Map(),
    lastSaveHashes: new Map(),
    turnSaveInFlight: new Map(),
    turnSavePending: new Set(),
  };
}

function makeAskUserQuestionTool(
  id: string,
  status: FlowToolItem['status'],
  error?: string,
): FlowToolItem {
  return {
    id,
    type: 'tool',
    toolName: 'AskUserQuestion',
    timestamp: 1000,
    status,
    toolCall: {
      id,
      input: {},
    },
    toolResult: error
      ? {
          result: null,
          success: false,
          error,
        }
      : undefined,
  };
}

describe('processToolParamsPartialInternal', () => {
  afterEach(() => {
    resetStore();
  });

  it('drops malformed non-string params fragments without replacing existing preview state', () => {
    const existingParams = { file_path: 'src/main.rs' };
    const tool: FlowToolItem = {
      id: 'tool-1',
      type: 'tool',
      toolName: 'Read',
      timestamp: 1001,
      status: 'streaming',
      toolCall: {
        id: 'tool-1',
        input: existingParams,
      },
      isParamsStreaming: true,
      partialParams: existingParams,
      _paramsBuffer: '{"file_path":"src/main.rs"}',
    };

    FlowChatStore.getInstance().setState(() => ({
      sessions: new Map([['session-1', createSessionWithTool(tool)]]),
      activeSessionId: 'session-1',
    }));

    expect(() => {
      processToolParamsPartialInternal('session-1', 'turn-1', {
        event_type: 'ParamsPartial',
        tool_id: 'tool-1',
        tool_name: 'Read',
        params: { file_path: 'src/lib.rs' } as any,
      });
    }).not.toThrow();

    const updatedTool = FlowChatStore.getInstance()
      .findToolItem('session-1', 'turn-1', 'tool-1') as FlowToolItem;

    expect(updatedTool._paramsBuffer).toBe('{"file_path":"src/main.rs"}');
    expect(updatedTool.partialParams).toEqual(existingParams);
    expect(updatedTool.toolCall.input).toEqual(existingParams);
  });

  it('derives path and content from the combined Write parameter while streaming', () => {
    const tool: FlowToolItem = {
      id: 'tool-1',
      type: 'tool',
      toolName: 'Write',
      timestamp: 1001,
      status: 'preparing',
      toolCall: {
        id: 'tool-1',
        input: {},
      },
      isParamsStreaming: true,
      partialParams: {},
      _paramsBuffer: '',
    };

    FlowChatStore.getInstance().setState(() => ({
      sessions: new Map([['session-1', createSessionWithTool(tool)]]),
      activeSessionId: 'session-1',
    }));

    processToolParamsPartialInternal('session-1', 'turn-1', {
      event_type: 'ParamsPartial',
      tool_id: 'tool-1',
      tool_name: 'Write',
      params: '{"payload":"+++ src/app.ts\\nconst value = 1;',
    });

    const updatedTool = FlowChatStore.getInstance()
      .findToolItem('session-1', 'turn-1', 'tool-1') as FlowToolItem;

    expect(updatedTool.partialParams?.file_path).toBe('src/app.ts');
    expect(updatedTool.partialParams?.content).toBe('const value = 1;');
    expect(updatedTool.status).toBe('receiving');
    expect(updatedTool._contentSize).toBe('const value = 1;'.length);
  });

  it('injects file_path from write params buffer when content streams first', () => {
    const tool: FlowToolItem = {
      id: 'tool-1',
      type: 'tool',
      toolName: 'Write',
      timestamp: 1001,
      status: 'preparing',
      toolCall: {
        id: 'tool-1',
        input: {},
      },
      isParamsStreaming: true,
      partialParams: {},
      _paramsBuffer: '',
    };

    FlowChatStore.getInstance().setState(() => ({
      sessions: new Map([['session-1', createSessionWithTool(tool)]]),
      activeSessionId: 'session-1',
    }));

    processToolParamsPartialInternal('session-1', 'turn-1', {
      event_type: 'ParamsPartial',
      tool_id: 'tool-1',
      tool_name: 'Write',
      params: '{"file_path":"src/app.ts","content":"const value = 1;',
    });

    const updatedTool = FlowChatStore.getInstance()
      .findToolItem('session-1', 'turn-1', 'tool-1') as FlowToolItem;

    expect(updatedTool.partialParams?.file_path).toBe('src/app.ts');
    expect(updatedTool.partialParams?.content).toBe('const value = 1;');
    expect(updatedTool.status).toBe('receiving');
  });
});

describe('processToolEvent late Started event behavior', () => {
  afterEach(() => {
    resetStore();
  });

  it('attaches a late Started event back to its original round when roundId is provided', () => {
    const round1: ModelRound = {
      id: 'round-1',
      index: 0,
      items: [
        {
          id: 'text-1',
          type: 'text',
          content: 'First round response',
          timestamp: 1000,
          status: 'completed',
          isStreaming: false,
          isMarkdown: true,
        } as any,
        {
          id: 'steering-1',
          type: 'user-steering',
          timestamp: 1001,
          status: 'completed',
          content: 'background result',
          steeringId: 'steering-1',
          roundIndex: 0,
        } as any,
      ],
      isStreaming: false,
      isComplete: true,
      status: 'completed',
      startTime: 900,
      endTime: 1100,
    };

    const round2: ModelRound = {
      id: 'round-2',
      index: 1,
      items: [],
      isStreaming: true,
      isComplete: false,
      status: 'streaming',
      startTime: 1200,
    };

    const turn: DialogTurn = {
      id: 'turn-1',
      sessionId: 'session-1',
      userMessage: {
        id: 'user-1',
        content: 'Test steering timing',
        timestamp: 800,
      },
      modelRounds: [round1, round2],
      status: 'processing',
      startTime: 800,
    };

    const session: Session = {
      sessionId: 'session-1',
      title: 'Session 1',
      dialogTurns: [turn],
      status: 'active',
      config: { agentType: 'Standard' },
      createdAt: 700,
      lastActiveAt: 1200,
      error: null,
      sessionKind: 'normal',
    };

    FlowChatStore.getInstance().setState(() => ({
      sessions: new Map([['session-1', session]]),
      activeSessionId: 'session-1',
    }));

    processToolEvent(
      makeToolContext(),
      'session-1',
      'turn-1',
      'round-1',
      {
        event_type: 'Started',
        tool_id: 'tool-late-1',
        tool_name: 'Read',
        params: { file_path: 'src/main.rs' },
      },
    );

    const state = FlowChatStore.getInstance().getState();
    const updatedTurn = state.sessions.get('session-1')?.dialogTurns[0];
    const updatedRound1 = updatedTurn?.modelRounds[0];
    const updatedRound2 = updatedTurn?.modelRounds[1];

    expect(updatedRound1?.items.some(item => item.id === 'tool-late-1')).toBe(true);
    expect(updatedRound2?.items.some(item => item.id === 'tool-late-1')).toBe(false);
  });

  it('does not downgrade a completed tool when a late Started event arrives', () => {
    const session = createSessionWithTool({
      id: 'tool-1',
      type: 'tool',
      toolName: 'Read',
      timestamp: 1000,
      status: 'completed',
      toolCall: { id: 'tool-1', input: { file_path: 'README.md' } },
      toolResult: { result: 'ok', success: true },
    });
    FlowChatStore.getInstance().setState(prev => ({
      ...prev,
      sessions: new Map([['session-1', session]]),
      activeSessionId: 'session-1',
    }));

    processToolEvent(
      makeToolContext(),
      'session-1',
      'turn-1',
      'round-1',
      {
        event_type: 'Started',
        tool_id: 'tool-1',
        tool_name: 'Read',
        params: { file_path: 'README.md' },
      },
    );

    const tool = FlowChatStore.getInstance()
      .findToolItem('session-1', 'turn-1', 'tool-1') as FlowToolItem;
    expect(tool.status).toBe('completed');
    expect(tool.toolResult).toMatchObject({ success: true });
  });

  it('creates the journal round when a Started event references a missing round', () => {
    const turn: DialogTurn = {
      id: 'turn-1',
      sessionId: 'session-1',
      userMessage: {
        id: 'user-1',
        content: 'Test steering timing',
        timestamp: 800,
      },
      modelRounds: [{
        id: 'round-1',
        index: 0,
        items: [],
        isStreaming: true,
        isComplete: false,
        status: 'streaming',
        startTime: 900,
      }],
      status: 'processing',
      startTime: 800,
    };

    const session: Session = {
      sessionId: 'session-1',
      title: 'Session 1',
      dialogTurns: [turn],
      status: 'active',
      config: { agentType: 'Standard' },
      createdAt: 700,
      lastActiveAt: 1200,
      error: null,
      sessionKind: 'normal',
    };

    FlowChatStore.getInstance().setState(() => ({
      sessions: new Map([['session-1', session]]),
      activeSessionId: 'session-1',
    }));

    processToolEvent(
      makeToolContext(),
      'session-1',
      'turn-1',
      'round-missing',
      {
        event_type: 'Started',
        tool_id: 'tool-late-1',
        tool_name: 'Read',
        params: { file_path: 'src/main.rs' },
      },
    );

    const updatedTurn = FlowChatStore.getInstance().getState().sessions.get('session-1')?.dialogTurns[0];
    expect(updatedTurn?.modelRounds.some(round => round.id === 'round-missing')).toBe(true);
    expect(
      updatedTurn?.modelRounds
        .find(round => round.id === 'round-missing')
        ?.items.some(item => item.id === 'tool-late-1'),
    ).toBe(true);
  });

  it('upserts a Completed card when Started never created one', () => {
    const session = createSessionWithTool({
      id: 'placeholder',
      type: 'tool',
      toolName: 'Read',
      timestamp: 1000,
      status: 'running',
      toolCall: { id: 'placeholder', input: {} },
    });
    session.dialogTurns[0].modelRounds[0].items = [];
    FlowChatStore.getInstance().setState(prev => ({
      ...prev,
      sessions: new Map([['session-1', session]]),
      activeSessionId: 'session-1',
    }));

    processToolEvent(
      makeToolContext(),
      'session-1',
      'turn-1',
      'round-1',
      {
        event_type: 'Completed',
        tool_id: 'read-1',
        tool_name: 'Read',
        result: 'file contents',
        result_for_assistant: 'file contents',
      } as any,
    );

    const tool = FlowChatStore.getInstance()
      .findToolItem('session-1', 'turn-1', 'read-1') as FlowToolItem;
    expect(tool).toMatchObject({
      id: 'read-1',
      status: 'completed',
      toolName: 'Read',
    });
  });
});

describe('deferred tool wire identity', () => {
  afterEach(() => {
    resetStore();
  });

  it('keeps one wire invocation through streaming and Started while selecting the effective card', () => {
    const session = createSessionWithTool({
      id: 'placeholder',
      type: 'tool',
      toolName: 'Read',
      timestamp: 1000,
      status: 'completed',
      toolCall: { id: 'placeholder', input: {} },
    });
    session.dialogTurns[0].modelRounds[0].items = [];
    FlowChatStore.getInstance().setState(() => ({
      sessions: new Map([['session-1', session]]),
      activeSessionId: 'session-1',
    }));

    const context = makeToolContext();
    processToolEvent(context, 'session-1', 'turn-1', 'round-1', {
      event_type: 'EarlyDetected',
      tool_id: 'tool-deferred',
      tool_name: 'CallDeferredTool',
    });
    processToolParamsPartialInternal('session-1', 'turn-1', {
      event_type: 'ParamsPartial',
      tool_id: 'tool-deferred',
      tool_name: 'CallDeferredTool',
      params: JSON.stringify({
        tool_name: 'CreatePlan',
        args: { name: 'Plan', overview: 'Overview', plan: '# Plan' },
      }),
    });

    const wireInput = {
      tool_name: 'CreatePlan',
      args: { name: 'Plan', overview: 'Overview', plan: '# Plan' },
    };
    processToolEvent(context, 'session-1', 'turn-1', 'round-1', {
      event_type: 'Started',
      tool_id: 'tool-deferred',
      tool_name: 'CallDeferredTool',
      effective_tool_name: 'CreatePlan',
      params: wireInput,
    });

    const tool = FlowChatStore.getInstance()
      .findToolItem('session-1', 'turn-1', 'tool-deferred') as FlowToolItem;
    expect(tool).toMatchObject({
      toolName: 'CallDeferredTool',
      toolCall: { id: 'tool-deferred', input: wireInput },
      status: 'running',
    });

    const effective = projectEffectiveToolItem(tool);
    expect(effective).toMatchObject({
      toolName: 'CreatePlan',
      toolCall: { input: wireInput.args },
    });

    const turn = FlowChatStore.getInstance().getState().sessions
      .get('session-1')!.dialogTurns[0];
    const persisted = convertDialogTurnToBackendFormat(turn, 0);
    expect(persisted.modelRounds[0].toolItems[0]).toMatchObject({
      toolName: 'CallDeferredTool',
      toolCall: { input: wireInput },
    });
  });

  it('uses wire input for deferred confirmation and derives the Write view', () => {
    const wireInput = {
      tool_name: 'Write',
      args: { file_path: 'README.md', content: 'updated' },
    };
    const tool: FlowToolItem = {
      id: 'tool-write',
      type: 'tool',
      toolName: 'CallDeferredTool',
      timestamp: 1001,
      status: 'queued',
      toolCall: { id: 'tool-write', input: wireInput },
    };
    FlowChatStore.getInstance().setState(() => ({
      sessions: new Map([['session-1', createSessionWithTool(tool)]]),
      activeSessionId: 'session-1',
    }));

    processToolEvent(makeToolContext(), 'session-1', 'turn-1', 'round-1', {
      event_type: 'ConfirmationNeeded',
      tool_id: 'tool-write',
      tool_name: 'CallDeferredTool',
      effective_tool_name: 'Write',
      params: wireInput,
    });

    const updated = FlowChatStore.getInstance()
      .findToolItem('session-1', 'turn-1', 'tool-write') as FlowToolItem;
    expect(updated).toMatchObject({
      toolName: 'CallDeferredTool',
      toolCall: { input: wireInput },
      status: 'pending_confirmation',
      requiresConfirmation: true,
    });
    expect(projectEffectiveToolItem(updated)).toMatchObject({
      toolName: 'Write',
      toolCall: { input: wireInput.args },
    });
  });

  it('keeps effective identity for Streaming even when no Started event arrives', () => {
    const wireInput = {
      tool_name: 'mcp__docs__search',
      args: { query: 'identity' },
    };
    const tool: FlowToolItem = {
      id: 'tool-streaming',
      type: 'tool',
      toolName: 'CallDeferredTool',
      timestamp: 1001,
      status: 'queued',
      toolCall: { id: 'tool-streaming', input: wireInput },
    };
    FlowChatStore.getInstance().setState(() => ({
      sessions: new Map([['session-1', createSessionWithTool(tool)]]),
      activeSessionId: 'session-1',
    }));

    processToolEvent(makeToolContext(), 'session-1', 'turn-1', 'round-1', {
      event_type: 'Streaming',
      tool_id: 'tool-streaming',
      tool_name: 'CallDeferredTool',
      effective_tool_name: 'mcp__docs__search',
      chunks_received: 1,
    });

    const updated = FlowChatStore.getInstance()
      .findToolItem('session-1', 'turn-1', 'tool-streaming') as FlowToolItem;
    expect(updated.status).toBe('streaming');
    expect(projectEffectiveToolItem(updated).toolName).toBe('mcp__docs__search');
  });
});

describe('processToolEvent rejected event behavior', () => {
  afterEach(() => {
    resetStore();
  });

  it('marks a rejected tool as rejected and clears pending confirmation state', () => {
    const tool: FlowToolItem = {
      id: 'tool-1',
      type: 'tool',
      toolName: 'ExecCommand',
      timestamp: 1001,
      status: 'pending_confirmation',
      requiresConfirmation: true,
      userConfirmed: undefined,
      isParamsStreaming: true,
      acpPermission: {
        permissionId: 'permission-1',
        requestedAt: 1001,
      },
      toolCall: {
        id: 'tool-1',
        input: { cmd: 'npm test' },
      },
    };

    FlowChatStore.getInstance().setState(() => ({
      sessions: new Map([['session-1', createSessionWithTool(tool)]]),
      activeSessionId: 'session-1',
    }));

    processToolEvent(
      makeToolContext(),
      'session-1',
      'turn-1',
      'round-1',
      {
        event_type: 'Rejected',
        tool_id: 'tool-1',
        tool_name: 'ExecCommand',
      },
    );

    const updatedTool = FlowChatStore.getInstance()
      .findToolItem('session-1', 'turn-1', 'tool-1') as FlowToolItem;

    expect(updatedTool).toMatchObject({
      status: 'rejected',
      userConfirmed: false,
      requiresConfirmation: false,
      isParamsStreaming: false,
      toolResult: {
        result: null,
        success: false,
        error: 'User rejected operation',
      },
    });
    expect(updatedTool.acpPermission).toBeUndefined();
    expect(typeof updatedTool.endTime).toBe('number');
  });
});

describe('processToolEvent completed image behavior', () => {
  afterEach(() => {
    resetStore();
  });

  it('preserves image attachments on the completed tool item', () => {
    const tool: FlowToolItem = {
      id: 'tool-image-1',
      type: 'tool',
      toolName: 'view_image',
      timestamp: 1001,
      status: 'running',
      toolCall: {
        id: 'tool-image-1',
        input: { path: 'screenshots/preview.png' },
      },
    };

    FlowChatStore.getInstance().setState(() => ({
      sessions: new Map([['session-1', createSessionWithTool(tool)]]),
      activeSessionId: 'session-1',
    }));

    processToolEvent(
      makeToolContext(),
      'session-1',
      'turn-1',
      'round-1',
      {
        event_type: 'Completed',
        tool_id: 'tool-image-1',
        tool_name: 'view_image',
        result: { path: 'screenshots/preview.png', width: 80, height: 60 },
        image_attachments: [{ mime_type: 'image/png', data_base64: 'AAAA' }],
        duration_ms: 12,
      },
    );

    const updatedTool = FlowChatStore.getInstance()
      .findToolItem('session-1', 'turn-1', 'tool-image-1') as FlowToolItem;

    expect(updatedTool.status).toBe('completed');
    expect(updatedTool.toolResult?.imageAttachments).toEqual([
      { mime_type: 'image/png', data_base64: 'AAAA' },
    ]);
  });
});

describe('processToolEvent AskUserQuestion retry superseded handling', () => {
  afterEach(() => {
    resetStore();
  });

  it('keeps the previous card in history but closes it when a retry attempt starts', () => {
    const staleTool = {
      ...makeAskUserQuestionTool('ask-stale', 'preparing'),
      attemptId: 'round-1:attempt:1',
      attemptIndex: 1,
      isParamsStreaming: true,
      startTime: 1000,
    } as FlowToolItem;

    const turn: DialogTurn = {
      id: 'turn-1',
      sessionId: 'session-1',
      userMessage: {
        id: 'user-1',
        content: 'Ask me if needed',
        timestamp: 800,
      },
      modelRounds: [
        {
          id: 'round-1',
          index: 0,
          items: [staleTool],
          isStreaming: true,
          isComplete: false,
          status: 'streaming',
          startTime: 900,
        },
      ],
      status: 'processing',
      startTime: 800,
    };

    const session: Session = {
      sessionId: 'session-1',
      title: 'Session 1',
      dialogTurns: [turn],
      status: 'active',
      config: { agentType: 'Standard' },
      createdAt: 700,
      lastActiveAt: 1200,
      error: null,
      sessionKind: 'normal',
    };

    FlowChatStore.getInstance().setState(() => ({
      sessions: new Map([['session-1', session]]),
      activeSessionId: 'session-1',
    }));

    processToolEvent(
      makeToolContext(),
      'session-1',
      'turn-1',
      'round-1',
      {
        event_type: 'EarlyDetected',
        tool_id: 'ask-retry',
        tool_name: 'AskUserQuestion',
      },
      'round-1:attempt:2',
      2,
    );

    const updatedRound = FlowChatStore.getInstance().getState().sessions.get('session-1')?.dialogTurns[0]?.modelRounds[0];
    expect(updatedRound?.attempts?.map(attempt => attempt.status)).toEqual(['superseded', 'streaming']);

    const previousAttemptTool = updatedRound?.attempts?.[0]?.items[0] as FlowToolItem | undefined;
    const retryAttemptTool = updatedRound?.attempts?.[1]?.items[0] as FlowToolItem | undefined;

    expect(previousAttemptTool).toMatchObject({
      id: 'ask-stale',
      status: 'cancelled',
      interruptionReason: 'retry_superseded',
    });
    expect(retryAttemptTool).toMatchObject({
      id: 'ask-retry',
      status: 'preparing',
      attemptId: 'round-1:attempt:2',
      attemptIndex: 2,
    });
  });
});


describe('host-owned question timing', () => {
  afterEach(resetStore);
  it.each([123456, null])('keeps deadline %s across later original-argument events', (deadline) => {
    const store = FlowChatStore.getInstance();
    store.setState(() => ({ sessions: new Map([['session-1', createSessionWithTool(makeAskUserQuestionTool('ask-live', 'running'))]]), activeSessionId: 'session-1' }));
    const context = makeToolContext();
    handleUserQuestionWaiting(context, { session_id: 'session-1', tool_id: 'ask-live', questions: { responseDeadlineMs: deadline } });
    processToolEvent(context, 'session-1', 'turn-1', 'round-1', {
      event_type: 'Started', tool_id: 'ask-live', tool_name: 'AskUserQuestion', params: { questions: [] },
    });
    expect(store.findToolItem('session-1', 'turn-1', 'ask-live')?.userQuestionWait)
      .toEqual(expect.objectContaining({ deadlineMs: deadline, interactionStarted: false }));
    store.reconcilePendingUserQuestions('session-1', { revision: 100, questions: [{
      toolId: 'ask-live', sessionId: 'session-1', dialogTurnId: 'turn-1', registeredAtMs: 1,
      questions: { questions: [], responseDeadlineMs: null }, interactionStarted: true,
    }] });
    handleUserQuestionWaiting(context, { session_id: 'session-1', tool_id: 'ask-live', questions: { responseDeadlineMs: deadline } });
    expect(store.findToolItem('session-1', 'turn-1', 'ask-live')?.userQuestionWait)
      .toEqual({ deadlineMs: null, interactionStarted: true });
  });
  it('does not revive a terminal question from a late waiting event', () => {
    const store = FlowChatStore.getInstance();
    store.setState(() => ({ sessions: new Map([['session-1', createSessionWithTool(makeAskUserQuestionTool('ask-ended', 'completed'))]]), activeSessionId: 'session-1' }));
    handleUserQuestionWaiting(makeToolContext(), { session_id: 'session-1', tool_id: 'ask-ended', questions: { responseDeadlineMs: 123456 } });
    expect(store.findToolItem('session-1', 'turn-1', 'ask-ended')?.userQuestionWait).toBeUndefined();
  });
});

describe('classified tool failure persistence', () => {
  afterEach(resetStore);
  it('retains failure details from live events in serialized history', () => {
    const tool: FlowToolItem = { id: 'edit-1', type: 'tool', toolName: 'Edit', timestamp: 1000, status: 'running', toolCall: { id: 'edit-1', input: {} } };
    const store = FlowChatStore.getInstance();
    store.setState(() => ({ sessions: new Map([['session-1', createSessionWithTool(tool)]]), activeSessionId: 'session-1' }));
    const detail = { code: 'edit_no_change', kind: 'guidance' };
    processToolEvent(makeToolContext(), 'session-1', 'turn-1', 'round-1', {
      event_type: 'Failed', tool_id: 'edit-1', tool_name: 'Edit', error: 'Inputs are equal', error_detail: detail,
    });
    const updated = store.findToolItem('session-1', 'turn-1', 'edit-1') as FlowToolItem;
    expect(updated.status).toBe('error');
    expect(updated.toolResult).toMatchObject({ success: false, result: { error_detail: detail } });
    const session = store.getState().sessions.get('session-1')!;
    const persisted = JSON.parse(JSON.stringify(convertDialogTurnToBackendFormat(session.dialogTurns[0])));
    expect(persisted.modelRounds[0].toolItems[0].toolResult.result.error_detail).toEqual(detail);
  });
});
