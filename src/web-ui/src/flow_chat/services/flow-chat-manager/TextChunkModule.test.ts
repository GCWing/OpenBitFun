import { describe, expect, it } from 'vitest';
import type { AnyFlowItem, DialogTurn, FlowToolItem, ModelRound, Session } from '../../types/flow-chat';
import { normalizeStreamContent, processNormalTextChunkInternal, processThinkingChunkInternal } from './TextChunkModule';

function makeContext(session: Session): any {
  return {
    flowChatStore: {
      getState: () => ({
        sessions: new Map([[session.sessionId, session]]),
      }),
      addModelRoundItemSilent: (
        _sessionId: string,
        _turnId: string,
        item: AnyFlowItem,
        roundId: string,
      ) => {
        const round = session.dialogTurns[0].modelRounds.find(candidate => candidate.id === roundId);
        round?.items.push(item);
      },
      updateModelRoundItemSilent: (
        _sessionId: string,
        _turnId: string,
        itemId: string,
        updates: Partial<AnyFlowItem>,
      ) => {
        for (const round of session.dialogTurns[0].modelRounds) {
          const item = round.items.find(candidate => candidate.id === itemId);
          if (item) {
            Object.assign(item, updates);
            return;
          }
        }
      },
      batchUpdateModelRoundItems: () => {},
      updateDialogTurn: (
        _sessionId: string,
        _turnId: string,
        updater: (turn: any) => any,
      ) => {
        const turn = session.dialogTurns[0];
        const updated = updater(turn);
        if (updated) {
          Object.assign(turn, updated);
        }
      },
    },
    contentBuffers: new Map(),
    activeTextItems: new Map(),
    eventBatcher: { getBufferSize: () => 0, clear: () => {} },
    pendingTurnCompletions: new Map(),
    saveDebouncers: new Map(),
    lastSaveTimestamps: new Map(),
    lastSaveHashes: new Map(),
    turnSaveInFlight: new Map(),
    turnSavePending: new Set(),
    runtimeStatusTimers: new Map(),
    userCancelledSessionIds: new Set(),
    currentWorkspacePath: null,
  };
}

function makeSession(): Session {
  const round: ModelRound = {
    id: 'round-1',
    index: 0,
    items: [],
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
      content: 'Help',
      timestamp: 900,
    },
    modelRounds: [round],
    status: 'processing',
    startTime: 900,
  };
  return {
    sessionId: 'session-1',
    dialogTurns: [turn],
    status: 'active',
    config: {},
    createdAt: 800,
    lastActiveAt: 1000,
    error: null,
    sessionKind: 'normal',
  };
}

function insertTool(session: Session): void {
  const tool: FlowToolItem = {
    id: 'tool-1',
    type: 'tool',
    toolName: 'Read',
    timestamp: 1001,
    status: 'completed',
    toolCall: {
      id: 'tool-1',
      input: { file_path: 'src/main.rs' },
    },
    toolResult: {
      result: 'contents',
      success: true,
    },
  };
  session.dialogTurns[0].modelRounds[0].items.push(tool);
}

describe('processNormalTextChunkInternal', () => {
  it('continues a streaming text item restored by a mid-turn Peer snapshot', () => {
    const session = makeSession();
    session.dialogTurns[0].modelRounds[0].items.push({
      id: 'restored-text',
      type: 'text',
      content: 'Restored partial',
      isStreaming: true,
      isMarkdown: true,
      timestamp: 1001,
      status: 'streaming',
    });
    const context = makeContext(session);

    processNormalTextChunkInternal(
      context,
      'session-1',
      'turn-1',
      'round-1',
      ' plus live chunk',
    );

    const textItems = session.dialogTurns[0].modelRounds[0].items
      .filter(item => item.type === 'text');
    expect(textItems).toHaveLength(1);
    expect((textItems[0] as any).content).toBe('Restored partial plus live chunk');
  });

  it('normalizes recovered stream content before incremental appends use it', () => {
    expect(normalizeStreamContent('Before\n\n\nAfter')).toBe('Before\n\nAfter');
  });

  it('continues a streaming thinking item restored by a mid-turn Peer snapshot', () => {
    const session = makeSession();
    session.dialogTurns[0].modelRounds[0].items.push({
      id: 'restored-thinking',
      type: 'thinking',
      content: 'Restored reasoning',
      isStreaming: true,
      isCollapsed: false,
      timestamp: 1001,
      status: 'streaming',
    });
    const context = makeContext(session);

    processThinkingChunkInternal(
      context,
      'session-1',
      'turn-1',
      'round-1',
      ' plus live reasoning',
    );

    const thinkingItems = session.dialogTurns[0].modelRounds[0].items
      .filter(item => item.type === 'thinking');
    expect(thinkingItems).toHaveLength(1);
    expect((thinkingItems[0] as any).content).toBe('Restored reasoning plus live reasoning');
  });

  it('keeps using the existing active text item after tools in the same round', () => {
    const session = makeSession();
    const context = makeContext(session);

    processNormalTextChunkInternal(context, 'session-1', 'turn-1', 'round-1', 'Before tools.');
    insertTool(session);
    processNormalTextChunkInternal(context, 'session-1', 'turn-1', 'round-1', ' After tools.');

    const items = session.dialogTurns[0].modelRounds[0].items;
    const textItems = items.filter(item => item.type === 'text');
    expect(textItems).toHaveLength(1);
    expect((textItems[0] as any).content).toBe('Before tools. After tools.');
  });

  it('uses a separate text item when later text arrives in a separate round', () => {
    const session = makeSession();
    session.dialogTurns[0].modelRounds.push({
      id: 'round-2',
      index: 1,
      items: [],
      isStreaming: true,
      isComplete: false,
      status: 'streaming',
      startTime: 1002,
    });
    const context = makeContext(session);

    processNormalTextChunkInternal(context, 'session-1', 'turn-1', 'round-1', 'Before tools.');
    insertTool(session);
    processNormalTextChunkInternal(context, 'session-1', 'turn-1', 'round-2', 'After tools.');

    const [firstRound, secondRound] = session.dialogTurns[0].modelRounds;
    expect(firstRound.items.map(item => item.type)).toEqual(['text', 'tool']);
    expect(secondRound.items.map(item => item.type)).toEqual(['text']);
    expect((firstRound.items[0] as any).content).toBe('Before tools.');
    expect((secondRound.items[0] as any).content).toBe('After tools.');
  });

  it('reuses the completed text item when a late chunk arrives after the next round has started', () => {
    const session = makeSession();
    session.dialogTurns[0].modelRounds.push({
      id: 'round-2',
      index: 1,
      items: [],
      isStreaming: true,
      isComplete: false,
      status: 'streaming',
      startTime: 1002,
    });
    const context = makeContext(session);

    processNormalTextChunkInternal(context, 'session-1', 'turn-1', 'round-1', 'First answer');

    const firstRound = session.dialogTurns[0].modelRounds[0];
    firstRound.isStreaming = false;
    firstRound.isComplete = true;
    firstRound.status = 'completed';
    firstRound.items.push({
      id: 'steering-1',
      type: 'user-steering',
      timestamp: 1003,
      status: 'completed',
      content: 'background result',
      steeringId: 'steering-1',
      roundIndex: 0,
    } as any);

    context.activeTextItems.get('session-1')?.clear();

    processNormalTextChunkInternal(context, 'session-1', 'turn-1', 'round-1', ' plus late chunk');

    const textItems = firstRound.items.filter(item => item.type === 'text');
    expect(textItems).toHaveLength(1);
    expect((textItems[0] as any).content).toBe('First answer plus late chunk');
  });

  it('reuses the completed thinking item when a late thinking chunk arrives after the next round has started', () => {
    const session = makeSession();
    session.dialogTurns[0].modelRounds.push({
      id: 'round-2',
      index: 1,
      items: [],
      isStreaming: true,
      isComplete: false,
      status: 'streaming',
      startTime: 1002,
    });
    const context = makeContext(session);

    processThinkingChunkInternal(context, 'session-1', 'turn-1', 'round-1', 'Initial reasoning');

    const firstRound = session.dialogTurns[0].modelRounds[0];
    firstRound.isStreaming = false;
    firstRound.isComplete = true;
    firstRound.status = 'completed';

    context.activeTextItems.get('session-1')?.clear();

    processThinkingChunkInternal(context, 'session-1', 'turn-1', 'round-1', ' plus late reasoning');
    processThinkingChunkInternal(context, 'session-1', 'turn-1', 'round-1', '', true);

    const thinkingItems = firstRound.items.filter(item => item.type === 'thinking');
    expect(thinkingItems).toHaveLength(1);
    expect((thinkingItems[0] as any).content).toBe('Initial reasoning plus late reasoning');
    expect((thinkingItems[0] as any).status).toBe('completed');
  });

  it('keeps raw reasoning and its display summary in separate thinking items', () => {
    const session = makeSession();
    const context = makeContext(session);

    processThinkingChunkInternal(
      context,
      'session-1',
      'turn-1',
      'round-1',
      'private chain',
      false,
      undefined,
      undefined,
      'reasoning',
    );
    processThinkingChunkInternal(
      context,
      'session-1',
      'turn-1',
      'round-1',
      'display summary',
      false,
      undefined,
      undefined,
      'summary',
    );

    const thinkingItems = session.dialogTurns[0].modelRounds[0].items
      .filter(item => item.type === 'thinking');
    expect(thinkingItems).toHaveLength(2);
    expect(thinkingItems.map(item => (item as any).reasoningKind)).toEqual([
      'reasoning',
      'summary',
    ]);
  });
});
