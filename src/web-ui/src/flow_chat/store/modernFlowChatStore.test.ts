import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlowTextItem, FlowThinkingItem, FlowToolItem, FlowUserSteeringItem, ModelRound, Session } from '../types/flow-chat';

vi.mock('./FlowChatStore', () => ({
  flowChatStore: {
    getState: () => ({
      activeSessionId: null,
      sessions: new Map(),
    }),
  },
}));

import { sessionToVirtualItems, type VirtualItem } from './modernFlowChatStore';
import { getVirtualItemFlowGroups } from '../grouping/selectors';
import { getVirtualItemStableKey } from '../components/modern/virtualItemIdentity';
import { getModelRoundExploreGroups, getProjectedModelRoundGroups } from '../components/modern/modelRoundItemGrouping';

type ModelRoundVirtualItem = Extract<VirtualItem, { type: 'model-round' }>;

function makeTextItem(id: string, content: string): FlowTextItem {
  return {
    id,
    type: 'text',
    content,
    isStreaming: false,
    isMarkdown: true,
    timestamp: 1000,
    status: 'completed',
  };
}

function makeTextItems(count: number, prefix = 'text'): FlowTextItem[] {
  return Array.from({ length: count }, (_, index) =>
    makeTextItem(`${prefix}-${index + 1}`, `Assistant response block ${index + 1}`)
  );
}

function makeReadTool(id: string): FlowToolItem {
  return makeTool(id, 'Read');
}

function makeTool(
  id: string,
  toolName: string,
  status: FlowToolItem['status'] = 'completed',
  endTime?: number,
): FlowToolItem {
  return {
    id,
    type: 'tool',
    toolName,
    timestamp: 1001,
    status,
    toolCall: {
      id,
      input: { file_path: 'src/main.rs' },
    },
    ...(status === 'completed'
      ? {
          toolResult: {
            result: 'file contents',
            success: true,
          },
        }
      : {}),
    ...(endTime !== undefined ? { endTime } : {}),
  };
}

function makeSteeringItem(id: string, content = 'Steer now'): FlowUserSteeringItem {
  return {
    id: `steering_${id}`,
    type: 'user-steering',
    steeringId: id,
    content,
    roundIndex: 0,
    timestamp: 1100,
    status: 'pending',
  };
}

function makeRound(overrides: Partial<ModelRound> = {}): ModelRound {
  return {
    id: overrides.id ?? 'round-1',
    index: 0,
    items: overrides.items ?? [makeReadTool('tool-1')],
    isStreaming: false,
    isComplete: true,
    status: 'completed',
    startTime: 1000,
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: overrides.sessionId ?? 'session-1',
    dialogTurns: overrides.dialogTurns ?? [{
      id: 'turn-1',
      sessionId: overrides.sessionId ?? 'session-1',
      userMessage: {
        id: 'user-1',
        content: 'Help',
        timestamp: 900,
      },
      modelRounds: [makeRound()],
      status: 'completed',
      startTime: 900,
    }],
    status: 'idle',
    config: overrides.config ?? {},
    createdAt: 800,
    lastActiveAt: 1000,
    error: null,
    ...overrides,
  };
}

describe('sessionToVirtualItems unified work grouping', () => {
  it.each([undefined, 'Minimal', 'Standard', 'agentic', 'Ultimate', 'Ultra', 'Creative', 'Claw', 'acp:codex'])(
    'collects Shell with surrounding exploration for a %s turn', agentType => {
      const session = makeSession({ mode: 'Standard', config: { agentType: 'Standard' } });
      const calls = ['ExecCommand', 'WriteStdin', 'ExecControl', 'Bash'].flatMap((name, index) => [
        makeTool(`shell-${index}`, name, index % 2 === 0 ? 'completed' : 'running'),
        { ...makeTool(`deferred-${index}`, 'CallDeferredTool'),
          toolCall: { id: `deferred-${index}`, input: { tool_name: name, args: {} } } },
      ]);
      session.dialogTurns[0] = { ...session.dialogTurns[0], agentType, modelRounds: [
        makeRound({ id: 'before', items: [makeReadTool('before-read')] }),
        makeRound({ id: 'shell', items: [makeTextItem('progress', 'Inspecting the build'), ...calls] }),
        makeRound({ id: 'after', items: [makeReadTool('after-read')] }),
      ] };
      const rows = sessionToVirtualItems(session);
      expect(rows.flatMap(getVirtualItemFlowGroups).map(group => group.allItems.map(item => item.id)))
        .toEqual([['before-read', 'progress', ...calls.map(item => item.id), 'after-read']]);
      const shellRow = rows.find((row): row is ModelRoundVirtualItem => row.type === 'model-round' && row.data.id === 'shell')!;
      expect(getProjectedModelRoundGroups(shellRow)).toEqual([]);
      expect(getModelRoundExploreGroups(shellRow.data)).toHaveLength(1);
    },
  );

  it.each(['Minimal', 'minimal', ' MINIMAL ', 'Standard', 'standard', ' STANDARD ', 'Ultimate', 'ultimate', ' ULTIMATE '])('collects Shell from a recorded %s turn across rounds', agentType => {
    const session = makeSession({ mode: 'Standard' });
    session.dialogTurns[0] = { ...session.dialogTurns[0], agentType, modelRounds: [
      makeRound({ id: 'shell', items: [makeTool('command', 'ExecCommand')] }),
      makeRound({ id: 'read', items: [makeReadTool('read'), makeTool('poll', 'WriteStdin')] }),
    ] };
    const recorded = JSON.stringify(session);
    const rows = sessionToVirtualItems(session);
    expect(rows.flatMap(getVirtualItemFlowGroups)).toMatchObject([{
      groupId: 'shell:shell:command', category: 'explore',
      allItems: [{ id: 'command' }, { id: 'read' }, { id: 'poll' }],
    }]);
    expect(rows.map(getVirtualItemStableKey)).toEqual([
      'user-message:turn-1:user-1', 'model-round:turn-1:shell', 'model-round:turn-1:read',
    ]);
    expect(sessionToVirtualItems({ ...session, mode: 'Creative' })).toBe(rows);
    expect(JSON.stringify(session)).toBe(recorded);
  });

  it('keeps completed collection membership when the recorded turn mode changes', () => {
    const session = makeSession();
    session.dialogTurns[0] = { ...session.dialogTurns[0], agentType: 'Minimal',
      modelRounds: [makeRound({ items: [makeTool('command', 'ExecCommand')] })] };
    const minimalRows = sessionToVirtualItems(session);
    const creative = { ...session, dialogTurns: [{ ...session.dialogTurns[0], agentType: 'Creative' }] };
    const creativeRows = sessionToVirtualItems(creative);
    expect(minimalRows.flatMap(getVirtualItemFlowGroups)).toHaveLength(1);
    expect(creativeRows.flatMap(getVirtualItemFlowGroups)).toEqual(minimalRows.flatMap(getVirtualItemFlowGroups));
    expect(creativeRows.map(getVirtualItemStableKey)).toEqual(minimalRows.map(getVirtualItemStableKey));
    expect(sessionToVirtualItems(session).flatMap(getVirtualItemFlowGroups)).toEqual(minimalRows.flatMap(getVirtualItemFlowGroups));
  });

  it('keeps exploration, Shell calls and intervening prose in one group when historical mode hints are missing or false', () => {
    const reads = Array.from({ length: 19 }, (_, index) => makeReadTool(`read-${index}`));
    const commands = Array.from({ length: 4 }, (_, index) => makeTool(`command-${index}`, 'ExecCommand'));
    const inspect = makeTextItem('inspect', 'Inspect the existing dist output');
    const progress = makeTextItem('progress', 'Check the preload chain');
    const answer = makeTextItem('answer', 'The build matches the source');
    const session = makeSession({ mode: 'Standard' });
    session.dialogTurns[0].modelRounds = [
      makeRound({ id: 'exploration', items: reads }),
      makeRound({ id: 'commands', items: [inspect, ...commands.slice(0, 2)],
        renderHints: JSON.parse('{"allowShellGrouping":false,"isMinimalMode":false}') }),
      makeRound({ id: 'verification', items: [progress, ...commands.slice(2), answer] }),
    ];
    const recorded = JSON.stringify(session);
    const rows = sessionToVirtualItems(session);
    const groups = rows.flatMap(getVirtualItemFlowGroups);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ category: 'explore', groupId: 'exploration:explore:read-0' });
    expect(groups[0].allItems).toEqual([...reads, inspect, ...commands.slice(0, 2), progress, ...commands.slice(2)]);
    expect(getProjectedModelRoundGroups(rows[2] as ModelRoundVirtualItem)).toEqual([]);
    expect(getProjectedModelRoundGroups(rows[3] as ModelRoundVirtualItem)).toEqual([{ type: 'critical', item: answer }]);
    expect(rows.map(getVirtualItemStableKey)).toEqual([
      'user-message:turn-1:user-1', 'model-round:turn-1:exploration',
      'model-round:turn-1:commands', 'model-round:turn-1:verification',
    ]);
    expect(JSON.stringify(session)).toBe(recorded);
  });
});

describe('sessionToVirtualItems explore grouping', () => {
  it('keeps retry controls as a boundary even when the successful attempt only explored', () => {
    const session = makeSession();
    const read = makeReadTool('retry-read');
    session.dialogTurns[0].modelRounds = [makeRound({ id: 'before' }), makeRound({ id: 'retry', items: [read], attempts: [
      { id: 'failed', index: 0, status: 'superseded', items: [], diagnostic: {
        attemptId: 'failed', attemptIndex: 0, category: 'stream_error', rawError: 'Request failed',
      } },
      { id: 'ok', index: 1, status: 'completed', items: [read] },
    ] })];
    const rows = sessionToVirtualItems(session);
    expect(rows.map(item => item.type)).toEqual(['user-message', 'model-round', 'model-round']);
    expect(rows[2]).toMatchObject({ data: { id: 'retry', attempts: session.dialogTurns[0].modelRounds[1].attempts } });
  });

  it.each(['explore', 'context', 'file-edit', 'interface'] as const)(
    'starts a new %s group after retry history and collects following rounds', category => {
      const operation = (id: string): FlowToolItem => {
        const names = { explore: 'Read', context: 'Skill', 'file-edit': 'Edit', interface: 'ComputerUse' };
        return { ...makeTool(id, names[category]),
          toolCall: { id, input: category === 'interface' ? { action: 'get_app_state' }
            : { file_path: '/workspace/src/main.rs', old_string: 'before', new_string: 'after' } },
          toolResult: { success: true, result: {} } };
      };
      const active = operation('recovered');
      const retry = makeRound({ id: 'retry', items: [active], attempts: [
        { id: 'retry:attempt:1', index: 1, status: 'superseded', items: [operation('failed')],
          diagnostic: { attemptId: 'retry:attempt:1', attemptIndex: 1, category: 'stream_error' } },
        { id: 'retry:attempt:2', index: 2, status: 'completed', items: [active] },
      ] });
      const session = makeSession();
      session.dialogTurns[0].modelRounds = [
        makeRound({ id: 'before', items: [operation('before-1'), operation('before-2')] }),
        retry, makeRound({ id: 'next', items: [operation('next-call')] }),
      ];
      const recorded = JSON.stringify(session);
      const rows = sessionToVirtualItems(session);
      const groups = rows.flatMap(getVirtualItemFlowGroups);
      expect(groups.map(group => group.category)).toEqual([category, category]);
      expect(groups.map(group => group.allItems.map(item => item.id)))
        .toEqual([['before-1', 'before-2'], ['recovered', 'next-call']]);
      expect(groups[1].groupId).toBe(`retry:${category}:recovered`);
      expect(rows.map(getVirtualItemStableKey)).toEqual([
        'user-message:turn-1:user-1', 'model-round:turn-1:before',
        'model-round:turn-1:retry', 'model-round:turn-1:next',
      ]);
      expect(JSON.stringify(session)).toBe(recorded);
    },
  );

  it.each([undefined, 'host'] as const)(
    'projects legacy native retry hints without discarding an explicit %s policy', source => {
      const active = makeReadTool('recovered');
      const retry = makeRound({ id: 'retry', items: [active],
        renderHints: { disableExploreGrouping: true, ...(source ? { disableExploreGroupingSource: source } : {}) },
        attempts: [
          { id: 'retry:attempt:1', index: 1, status: 'superseded', items: [],
            diagnostic: { attemptId: 'retry:attempt:1', attemptIndex: 1, category: 'stream_error' } },
          { id: 'retry:attempt:2', index: 2, status: 'completed', items: [active] },
        ],
      });
      const session = makeSession();
      session.dialogTurns[0].modelRounds = [retry, makeRound({ id: 'next', items: [makeReadTool('next-call')] })];
      const recorded = JSON.stringify(session);
      const groups = sessionToVirtualItems(session).flatMap(getVirtualItemFlowGroups);
      expect(groups.map(group => group.allItems.map(item => item.id)))
        .toEqual(source ? [['next-call']] : [['recovered', 'next-call']]);
      expect(JSON.stringify(session)).toBe(recorded);
    },
  );

  it('preserves older host hints with unrecognized retry identities', () => {
    const active = makeReadTool('external-read');
    const round = makeRound({ items: [active], renderHints: { disableExploreGrouping: true }, attempts: [
      { id: 'external-first', index: 1, status: 'superseded', items: [],
        diagnostic: { attemptId: 'external-first', attemptIndex: 1, category: 'stream_error' } },
      { id: 'external-next', index: 2, status: 'completed', items: [active] },
    ] });
    const session = makeSession();
    session.dialogTurns[0].modelRounds = [round];
    const rows = sessionToVirtualItems(session);
    expect(rows.flatMap(getVirtualItemFlowGroups)).toEqual([]);
    expect(getProjectedModelRoundGroups(rows[1] as ModelRoundVirtualItem))
      .toEqual([{ type: 'critical', item: active }]);
  });

  it('combines mixed and pure exploration through prose until a noncollectible card', () => {
    const session = makeSession();
    const rounds = [
      makeRound({ id: 'mixed-1', items: [makeTool('todo', 'TodoWrite'), makeTool('failed', 'Read', 'error'), makeTool('search-1', 'Glob')] }),
      makeRound({ id: 'pure-1', items: [...[1, 2, 3].map(index => makeReadTool(`read-a-${index}`)), makeTool('search-2', 'Grep')] }),
      makeRound({ id: 'mixed-2', items: [makeTextItem('analysis', 'Check crate names'), makeTool('search-3', 'Grep'), makeTool('search-4', 'Grep')] }),
      makeRound({ id: 'pure-2', items: [...[1, 2, 3, 4, 5].map(index => makeReadTool(`read-b-${index}`)), ...[5, 6, 7].map(index => makeTool(`search-${index}`, 'Grep'))] }),
      makeRound({ id: 'final', items: [makeTextItem('final-text', 'Waiting for branches'), makeTool('wait', 'AgentWait', 'cancelled')] }),
    ];
    session.dialogTurns[0].modelRounds = rounds;
    const snapshot = JSON.stringify(rounds);
    const rows = sessionToVirtualItems(session);
    expect(rows.map(item => item.type)).toEqual(['user-message', ...rounds.map(() => 'model-round')]);
    const modelRows = rows.filter((item): item is ModelRoundVirtualItem => item.type === 'model-round');
    const groups = modelRows.flatMap(item => getModelRoundExploreGroups(item.data, item.projectedGroups));
    expect(groups.map(group => group.stats)).toEqual([
      { readCount: 8, searchCount: 7, commandCount: 0 },
    ]);
    expect(modelRows.map(item => item.data.id)).toEqual(rounds.map(round => round.id));
    expect(JSON.stringify(rounds)).toBe(snapshot);
  });

  it('keeps legacy paused content visible across repeated continuations without changing saved attempts', () => {
    const session = makeSession();
    const turn = session.dialogTurns[0];
    turn.recoveryEpoch = 2;
    turn.modelRounds = [0, 1, 2].map(index => {
      const items = [makeTextItem(`text-${index}`, `Response ${index}`)];
      return makeRound({ id: `round-${index}`, index, roundGroupId: 'shared-group', items,
        status: index < 2 ? 'cancelled' : 'completed',
        attempts: [{ id: `attempt-${index}`, index: 1, items, status: index < 2 ? 'superseded' : 'completed',
          ...(index < 2 ? { diagnostic: { attemptId: `attempt-${index}`, attemptIndex: 1,
            category: 'stream_error', rawError: 'Cancelled: Stream processing cancelled' } } : {}),
        }],
      });
    });
    const rows = sessionToVirtualItems(session).filter((item): item is ModelRoundVirtualItem => item.type === 'model-round');
    expect(rows.map(row => row.data.id)).toEqual(['round-0', 'round-1', 'round-2']);
    expect(rows.map(row => !!row.data.renderHints?.continuedAfterInterruption)).toEqual([false, true, true]);
    expect(rows.every(row => row.data.attempts?.[0].diagnostic === undefined)).toBe(true);
    expect(rows.every(row => row.data.attempts?.[0].items.length === 1)).toBe(true);
    expect(turn.modelRounds[0].attempts?.[0].diagnostic).toBeDefined();
  });

  it('preserves real failures and carries a continuation over an empty cancelled round', () => {
    const session = makeSession();
    const turn = session.dialogTurns[0];
    turn.recoveryEpoch = 1;
    turn.modelRounds = [makeRound({ status: 'cancelled', items: [], attempts: [] }),
      makeRound({ id: 'resumed', items: [makeTextItem('result', 'Result')], attempts: [
        { id: 'failed', index: 1, status: 'superseded', items: [], diagnostic: {
          attemptId: 'failed', attemptIndex: 1, category: 'stream_error', rawError: 'Provider unavailable',
        } },
        { id: 'success', index: 2, status: 'completed', items: [makeTextItem('result', 'Result')] },
      ] }), makeRound({ id: 'next', items: [makeTextItem('next-text', 'Next')] })];
    const rows = sessionToVirtualItems(session).filter((item): item is ModelRoundVirtualItem => item.type === 'model-round');
    expect(rows.map(row => !!row.data.renderHints?.continuedAfterInterruption)).toEqual([true, false]);
    expect(rows[0].data.attempts?.[0].diagnostic?.rawError).toBe('Provider unavailable');
    delete turn.recoveryEpoch;
    expect(sessionToVirtualItems({ ...session, dialogTurns: [{ ...turn }] }).filter((item): item is ModelRoundVirtualItem => item.type === 'model-round')
      .every(row => !row.data.renderHints?.continuedAfterInterruption)).toBe(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('groups normal rounds containing only collapsible tools', () => {
    const session = makeSession({ sessionId: 'normal-session' });

    const items = sessionToVirtualItems(session);

    expect(items.map(item => item.type)).toEqual(['user-message', 'model-round']);
    expect(items.flatMap(getVirtualItemFlowGroups)).toHaveLength(1);
  });

  it('folds reasoning with its tools while retaining the original model-round key and records', () => {
    const session = makeSession();
    const thinking: FlowThinkingItem = {
      id: 'thinking', type: 'thinking', content: 'Inspecting the file.', timestamp: 1000,
      status: 'completed', isStreaming: false, isCollapsed: true,
    };
    const round = makeRound({ items: [thinking, makeReadTool('tool')] });
    session.dialogTurns[0].modelRounds = [round];
    const rows = sessionToVirtualItems(session);
    expect(rows.map(item => item.type)).toEqual(['user-message', 'model-round']);
    const row = rows[1] as ModelRoundVirtualItem;
    expect(row.data).toBe(round);
    expect(row.data.items[0]).toBe(thinking);
    expect(getModelRoundExploreGroups(row.data, row.projectedGroups)[0].allItems.map(item => item.id)).toEqual(['thinking', 'tool']);
  });

  it('keeps Deep Research progress visible after its exploration tool settles', () => {
    const session = makeSession({
      sessionId: 'deep-research-progress',
      dialogTurns: [{
        id: 'turn-1',
        sessionId: 'deep-research-progress',
        userMessage: {
          id: 'user-1',
          content: 'Research this topic',
          timestamp: 900,
        },
        modelRounds: [makeRound({
          items: [
            makeTextItem('phase-marker', '[[PHASE:phase-0-orient]]'),
            makeTool('orientation-search', 'WebSearch'),
          ],
        })],
        status: 'completed',
        startTime: 900,
      }],
    });

    const items = sessionToVirtualItems(session);

    expect(items.map(item => item.type)).toEqual(['user-message', 'model-round']);
    expect(items[1]).toMatchObject({
      type: 'model-round',
      data: {
        items: expect.arrayContaining([
          expect.objectContaining({ id: 'phase-marker' }),
          expect.objectContaining({ id: 'orientation-search' }),
        ]),
      },
    });
  });

  it.each([
    'Read', 'LS', 'Grep', 'Glob', 'WebSearch',
    'WebFetch',
    'view_image',
  ])('collects non-critical %s rounds into explore groups', (toolName) => {
    const session = makeSession({
      sessionId: `non-critical-${toolName}`,
      dialogTurns: [{
        id: 'turn-1',
        sessionId: `non-critical-${toolName}`,
        userMessage: {
          id: 'user-1',
          content: 'Help',
          timestamp: 900,
        },
        modelRounds: [makeRound({
          items: [makeTool(`tool-${toolName}`, toolName)],
        })],
        status: 'completed',
        startTime: 900,
      }],
    });

    expect(sessionToVirtualItems(session).map(item => item.type)).toEqual([
      'user-message',
      'model-round',
    ]);
  });

  it.each(['completed', 'cancelled', 'rejected', 'error'] as const)(
    'folds only successful rounds, preserving a settled %s boundary',
    (status) => {
      const session = makeSession({
        sessionId: `terminal-explore-${status}`,
        dialogTurns: [{
          id: 'turn-1',
          sessionId: `terminal-explore-${status}`,
          userMessage: {
            id: 'user-1',
            content: 'Help',
            timestamp: 900,
          },
          modelRounds: [makeRound({ status, isStreaming: false, isComplete: true })],
          status: 'processing',
          startTime: 900,
        }],
      });

      expect(sessionToVirtualItems(session).map(item => item.type)).toEqual([
        'user-message',
        'model-round',
      ]);
    },
  );

  it.each(['Write', 'Edit', 'Delete', 'GetFileDiff', 'ExecCommand', 'ExecControl', 'TodoWrite', 'ContextCompression', 'Skill', 'GetToolSpec', 'AgentWait', 'SessionMessage', 'SessionControl', 'ReviewSessionSummary', 'ReadCanvas', 'ControlHub', 'mcp__server__unknown'])(
    'keeps conditionally important %s rounds visible',
    (toolName) => {
      const session = makeSession({
        sessionId: `critical-${toolName}`,
        dialogTurns: [{
          id: 'turn-1',
          sessionId: `critical-${toolName}`,
          userMessage: {
            id: 'user-1',
            content: 'Help',
            timestamp: 900,
          },
          modelRounds: [makeRound({
            items: [makeTool(`tool-${toolName}`, toolName)],
          })],
          status: 'completed',
          startTime: 900,
        }],
      });

      expect(sessionToVirtualItems(session).map(item => item.type)).toEqual([
        'user-message',
        'model-round',
      ]);
    },
  );

  it('projects the absolute Turn index for a sparse history-window message', () => {
    const session = makeSession({
      sessionId: 'history-window-session',
      isPartial: true,
      loadedTurnCount: 1,
      totalTurnCount: 20,
      dialogTurns: [{
        id: 'turn-5',
        sessionId: 'history-window-session',
        backendTurnIndex: 40,
        userMessage: {
          id: 'user-5',
          content: 'Older window prompt',
          timestamp: 900,
        },
        modelRounds: [],
        status: 'error',
        startTime: 900,
      }],
      turnCatalog: {
        schemaVersion: 1,
        sessionId: 'history-window-session',
        revision: 'catalog-1',
        totalTurnCount: 20,
        complete: false,
        entries: [{
          ordinal: 4,
          storageTurnIndex: 40,
          preview: 'Older window prompt',
          previewTruncated: false,
        }],
      },
    });

    const userMessage = sessionToVirtualItems(session).find(item => item.type === 'user-message');

    expect(userMessage).toMatchObject({
      type: 'user-message',
      turnId: 'turn-5',
      absoluteTurnIndex: 5,
      turnStatus: 'error',
    });
  });

  it('invalidates a cached Turn projection when catalog ordinals are repaired', () => {
    const dialogTurns = [{
      id: 'turn-5',
      sessionId: 'catalog-repair-session',
      backendTurnIndex: 40,
      userMessage: {
        id: 'user-5',
        content: 'Older window prompt',
        timestamp: 900,
      },
      modelRounds: [],
      status: 'completed' as const,
      startTime: 900,
    }];
    const initialSession = makeSession({
      sessionId: 'catalog-repair-session',
      isPartial: true,
      loadedTurnCount: 1,
      totalTurnCount: 20,
      dialogTurns,
    });
    const repairedSession = makeSession({
      ...initialSession,
      dialogTurns,
      turnCatalog: {
        schemaVersion: 1,
        sessionId: 'catalog-repair-session',
        revision: 'catalog-2',
        totalTurnCount: 20,
        complete: false,
        entries: [{
          ordinal: 4,
          storageTurnIndex: 40,
          turnId: 'turn-5',
          preview: 'Older window prompt',
          previewTruncated: false,
        }],
      },
    });

    const initialUserMessage = sessionToVirtualItems(initialSession)
      .find(item => item.type === 'user-message');
    const repairedUserMessage = sessionToVirtualItems(repairedSession)
      .find(item => item.type === 'user-message');

    expect(initialUserMessage).toMatchObject({ absoluteTurnIndex: 20 });
    expect(repairedUserMessage).toMatchObject({ absoluteTurnIndex: 5 });
  });

  it('keeps trailing assistant text visible after collapsible tool history', () => {
    const round = makeRound({
      id: 'round-with-trailing-answer',
      items: [
        makeReadTool('tool-1'),
        makeTextItem('text-final', 'Here is the answer after inspecting the files.'),
      ],
    });
    const session = makeSession({
      sessionId: 'trailing-answer-session',
      dialogTurns: [{
        id: 'turn-1',
        sessionId: 'trailing-answer-session',
        userMessage: {
          id: 'user-1',
          content: 'Help',
          timestamp: 900,
        },
        modelRounds: [round],
        status: 'completed',
        startTime: 900,
      }],
    });

    const items = sessionToVirtualItems(session);

    expect(items.map(item => item.type)).toEqual(['user-message', 'model-round']);
  });

  it('carries turn timing and token metadata into the model round virtual item', () => {
    const session = makeSession({
      dialogTurns: [{
        id: 'turn-1',
        sessionId: 'session-1',
        userMessage: {
          id: 'user-1',
          content: 'Help',
          timestamp: 900,
        },
        modelRounds: [makeRound({
          id: 'round-with-answer',
          items: [makeTextItem('text-final', 'Here is the answer.')],
        })],
        status: 'completed',
        startTime: 900,
        endTime: 2400,
        tokenUsage: {
          inputTokens: 1200,
          outputTokens: 300,
          totalTokens: 1500,
          timestamp: 2400,
        },
      }],
    });

    const modelItem = sessionToVirtualItems(session)
      .find((item): item is ModelRoundVirtualItem => item.type === 'model-round');

    expect(modelItem).toMatchObject({
      turnStartedAt: 900,
      turnEndedAt: 2400,
      turnDurationMs: 1500,
      turnTokenUsage: {
        inputTokens: 1200,
        outputTokens: 300,
        totalTokens: 1500,
      },
    });
  });

  it.each(['completed', 'error'] as const)('preserves completed narrative and folds genuine errors in a shared round group: %s', status => {
    const firstRound = makeRound({
      id: 'finalize-round-1',
      roundGroupId: 'finalize-group-1',
      status,
      items: [makeTextItem('text-1', 'First finalize answer.')],
    });
    const secondRound = makeRound({
      id: 'finalize-round-2',
      roundGroupId: 'finalize-group-1',
      items: [makeTextItem('text-2', 'Retried finalize answer.')],
    });
    const session = makeSession({
      dialogTurns: [{
        id: 'turn-1',
        sessionId: 'session-1',
        userMessage: {
          id: 'user-1',
          content: 'Help',
          timestamp: 900,
        },
        modelRounds: [firstRound, secondRound],
        status: 'completed',
        startTime: 900,
      }],
    });

    const modelRounds = sessionToVirtualItems(session)
      .filter((item): item is ModelRoundVirtualItem => item.type === 'model-round');

    if (status === 'completed') {
      expect(modelRounds.map(row => row.data.id)).toEqual(['finalize-round-1', 'finalize-round-2']);
      expect(modelRounds[0].data).toBe(firstRound);
      expect(modelRounds[1].data).toBe(secondRound);
      expect(modelRounds.every(row => !row.data.historyRounds?.length)).toBe(true);
    } else {
      expect(modelRounds).toHaveLength(1);
      expect(modelRounds[0].data.id).toBe('finalize-round-2');
      expect(modelRounds[0].data.historyRounds?.map(round => round.id)).toEqual(['finalize-round-1']);
    }
  });

  it('does not special-case ACP rounds without explicit render hints', () => {
    const session = makeSession({
      sessionId: 'acp-session',
      config: { agentType: 'acp:opencode' },
    });

    const items = sessionToVirtualItems(session);

    expect(items.map(item => item.type)).toEqual(['user-message', 'model-round']);
  });

  it('honors explicit round render hints for non-ACP sessions', () => {
    const round = makeRound({
      id: 'round-with-hint',
      renderHints: { disableExploreGrouping: true },
    });
    const session = makeSession({
      sessionId: 'hint-session',
      dialogTurns: [{
        id: 'turn-1',
        sessionId: 'hint-session',
        userMessage: {
          id: 'user-1',
          content: 'Help',
          timestamp: 900,
        },
        modelRounds: [round],
        status: 'completed',
        startTime: 900,
      }],
    });

    const items = sessionToVirtualItems(session);

    expect(items.map(item => item.type)).toEqual(['user-message', 'model-round']);
  });

  it.each(['completed', 'cancelled', 'error'] as const)('keeps trailing thinking hints live-only when it becomes %s', status => {
    const thinkingItem = {
      id: 'thinking-1',
      type: 'thinking' as const,
      content: 'Inspecting the implementation',
      isStreaming: true,
      timestamp: 1000,
      status: 'streaming' as const,
    };
    const session = makeSession({
      sessionId: 'thinking-layout-session',
      dialogTurns: [{
        id: 'turn-1',
        sessionId: 'thinking-layout-session',
        userMessage: {
          id: 'user-1',
          content: 'Help',
          timestamp: 900,
        },
        modelRounds: [
          makeRound({
            id: 'earlier-thinking',
            items: [{ ...thinkingItem, id: 'thinking-0', isStreaming: false, status: 'completed' }],
            renderHints: { disableExploreGrouping: true },
          }),
          makeRound({
            id: 'active-thinking',
            index: 1,
            items: [thinkingItem],
            isStreaming: true,
            isComplete: false,
            status: 'streaming',
            renderHints: { disableExploreGrouping: true },
          }),
        ],
        status: 'processing',
        startTime: 900,
      }],
    });

    const modelRounds = sessionToVirtualItems(session)
      .filter((item): item is ModelRoundVirtualItem => item.type === 'model-round');

    expect(modelRounds.map(item => item.layoutHints?.expandedThinkingItemIds)).toEqual([
      [],
      ['thinking-1'],
    ]);
    const finished = sessionToVirtualItems({
      ...session,
      dialogTurns: session.dialogTurns.map(turn => ({
        ...turn,
        modelRounds: turn.modelRounds.map(round => ({
          ...round,
          items: round.items.map(item => item.id === thinkingItem.id ? { ...item, isStreaming: false, status } : item),
        })),
      })),
    }).filter((item): item is ModelRoundVirtualItem => item.type === 'model-round');
    // The turn is still processing and there is no successor yet.
    expect(finished.map(item => item.layoutHints?.expandedThinkingItemIds)).toEqual([[], []]);
  });

  it('keeps a trailing reasoning summary collapsed in layout hints', () => {
    const session = makeSession({
      sessionId: 'summary-layout-session',
      dialogTurns: [{
        id: 'turn-1',
        sessionId: 'summary-layout-session',
        userMessage: {
          id: 'user-1',
          content: 'Help',
          timestamp: 900,
        },
        modelRounds: [makeRound({
          id: 'active-summary',
          items: [{
            id: 'summary-1',
            type: 'thinking',
            content: 'Inspecting the implementation',
            reasoningKind: 'summary',
            isStreaming: true,
            isCollapsed: true,
            timestamp: 1000,
            status: 'streaming',
          }],
          isStreaming: true,
          isComplete: false,
          status: 'streaming',
          renderHints: { disableExploreGrouping: true },
        })],
        status: 'processing',
        startTime: 900,
      }],
    });

    const modelRound = sessionToVirtualItems(session)
      .find((item): item is ModelRoundVirtualItem => item.type === 'model-round');

    expect(modelRound?.layoutHints?.expandedThinkingItemIds).toEqual([]);
  });

  it('appends a completion notice for abnormal completed turns', () => {
    const session = makeSession({
      dialogTurns: [{
        id: 'turn-1',
        sessionId: 'session-1',
        userMessage: {
          id: 'user-1',
          content: 'Help',
          timestamp: 900,
        },
        modelRounds: [makeRound()],
        status: 'completed',
        startTime: 900,
        finishReason: 'interrupted',
      }],
    });

    const items = sessionToVirtualItems(session);

    expect(items.map(item => item.type)).toEqual([
      'user-message',
      'model-round',
      'turn-completion-notice',
    ]);
    expect(items[2]).toMatchObject({
      type: 'turn-completion-notice',
      data: {
        reasonCode: 'interrupted',
      },
    });
  });

  it('does not append a completion notice for normal completed turns', () => {
    const session = makeSession({
      dialogTurns: [{
        id: 'turn-1',
        sessionId: 'session-1',
        userMessage: {
          id: 'user-1',
          content: 'Help',
          timestamp: 900,
        },
        modelRounds: [makeRound()],
        status: 'completed',
        startTime: 900,
        finishReason: 'complete',
      }],
    });

    const items = sessionToVirtualItems(session);

    expect(items.map(item => item.type)).toEqual(['user-message', 'model-round']);
  });

  it('appends a terminal failure notice even when no model round was created', () => {
    const session = makeSession({
      dialogTurns: [{
        id: 'turn-1',
        sessionId: 'session-1',
        userMessage: {
          id: 'user-1',
          content: 'Help',
          timestamp: 900,
        },
        modelRounds: [],
        status: 'error',
        error: 'OpenAI Streaming API failed after 10 attempts: connection refused',
        errorDetail: {
          category: 'network',
          provider: 'openai',
        },
        startTime: 900,
        endTime: 1200,
      }],
    });

    const items = sessionToVirtualItems(session);

    expect(items.map(item => item.type)).toEqual(['user-message', 'turn-failure-notice']);
    expect(items[1]).toMatchObject({
      type: 'turn-failure-notice',
      data: {
        error: 'OpenAI Streaming API failed after 10 attempts: connection refused',
        errorDetail: {
          category: 'network',
          provider: 'openai',
        },
      },
    });
  });

  it('keeps a quiet tail group collecting until the Turn is terminal', () => {
    const session = makeSession();
    session.dialogTurns[0].status = 'processing';
    const items = sessionToVirtualItems(session);
    expect(items.map(item => item.type)).toEqual(['user-message', 'model-round']);
    expect(items.flatMap(getVirtualItemFlowGroups)[0]).toMatchObject({
      phase: 'collecting', isGroupStreaming: false,
    });
  });

  it('collects running calls before the round streaming flag catches up', () => {
    const session = makeSession();
    session.dialogTurns[0].status = 'processing';
    session.dialogTurns[0].modelRounds.push(makeRound({ id: 'round-2',
      items: [makeTool('tool-2', 'Read', 'running')], isComplete: false, isStreaming: false }));
    const items = sessionToVirtualItems(session);
    expect(items.map(item => item.type)).toEqual(['user-message', 'model-round', 'model-round']);
    expect(items.flatMap(getVirtualItemFlowGroups)[0]).toMatchObject({
      phase: 'collecting', isGroupStreaming: true,
      allItems: [expect.objectContaining({ id: 'tool-1' }), expect.objectContaining({ id: 'tool-2' })],
    });
    expect((items[2] as ModelRoundVirtualItem).projectedGroups).toEqual([]);
    expect((items[2] as ModelRoundVirtualItem).data.items[0].status).toBe('running');
  });

  it('keeps reasoning beside the possible final answer while the preceding group stays visible', () => {
    const session = makeSession();
    session.dialogTurns[0].status = 'processing';
    const thought: FlowThinkingItem = { id: 'thinking-2', type: 'thinking', content: 'Working',
      isStreaming: true, isCollapsed: false, status: 'streaming', timestamp: 1002 };
    session.dialogTurns[0].modelRounds.push(makeRound({ id: 'round-2',
      items: [thought, makeTextItem('answer', 'The answer')], isComplete: false, isStreaming: true }));
    const items = sessionToVirtualItems(session);
    expect(items.flatMap(getVirtualItemFlowGroups)[0].allItems.map(item => item.id)).toEqual(['tool-1']);
    expect((items[2] as ModelRoundVirtualItem).projectedGroups).toBeUndefined();
    expect((items[2] as ModelRoundVirtualItem).data.items.map(item => item.id)).toEqual(['thinking-2', 'answer']);
    expect((items[2] as ModelRoundVirtualItem).data.items[0]).toBe(thought);
  });

  it('does not close a quiet group on a clock or model-round completion', () => {
    const session = makeSession();
    session.dialogTurns[0].status = 'processing';
    session.dialogTurns[0].modelRounds.push(makeRound({ id: 'round-2', items: [makeReadTool('tool-2')] }));
    vi.useFakeTimers();
    vi.setSystemTime(10_200);
    const before = sessionToVirtualItems(session);
    vi.setSystemTime(999_999);
    const after = sessionToVirtualItems({ ...session, dialogTurns: [{ ...session.dialogTurns[0] }] });
    expect(after.map(getVirtualItemStableKey)).toEqual(before.map(getVirtualItemStableKey));
    expect(after.flatMap(getVirtualItemFlowGroups)[0]).toMatchObject({
      phase: 'collecting', allItems: [expect.objectContaining({ id: 'tool-1' }), expect.objectContaining({ id: 'tool-2' })],
    });
  });

  it('keeps a reasoning row key stable when reasoning and its tools are collected', () => {
    const streamingThinking = {
      id: 'thinking-1',
      type: 'thinking' as const,
      content: 'Inspecting the codebase',
      isStreaming: true,
      timestamp: 1000,
      status: 'streaming' as const,
    };
    const session = makeSession({
      sessionId: 'streaming-thinking-explore-session',
      dialogTurns: [{
        id: 'turn-1',
        sessionId: 'streaming-thinking-explore-session',
        userMessage: {
          id: 'user-1',
          content: 'Help',
          timestamp: 900,
        },
        modelRounds: [
          makeRound({
            id: 'round-1',
            items: [streamingThinking, makeReadTool('tool-1')],
            isStreaming: true,
            isComplete: false,
            status: 'streaming',
          }),
        ],
        status: 'processing',
        startTime: 900,
      }],
    });

    const streamingItems = sessionToVirtualItems(session);
    expect(streamingItems.map(item => item.type)).toEqual(['user-message', 'model-round']);
    expect(streamingItems[1]).toMatchObject({
      type: 'model-round',
      data: { id: 'round-1' },
    });

    const settledSession = makeSession({
      sessionId: 'streaming-thinking-explore-session',
      dialogTurns: [{
        ...session.dialogTurns[0],
        modelRounds: [
          makeRound({
            id: 'round-1',
            items: [
              { ...streamingThinking, isStreaming: false, status: 'completed' },
              makeReadTool('tool-1'),
            ],
            isStreaming: false,
            isComplete: true,
            status: 'completed',
          }),
        ],
        status: 'completed',
      }],
    });
    const settledItems = sessionToVirtualItems(settledSession);
    expect(settledItems.map(item => item.type)).toEqual(['user-message', 'model-round']);
    expect(settledItems[1]).toMatchObject({
      type: 'model-round',
      data: { id: 'round-1', items: [
        expect.objectContaining({ id: 'thinking-1', status: 'completed' }),
        expect.objectContaining({ id: 'tool-1' }),
      ] },
    });
    const row = settledItems[1] as ModelRoundVirtualItem;
    expect(getModelRoundExploreGroups(row.data, row.projectedGroups)[0].allItems.map(item => item.id)).toEqual(['thinking-1', 'tool-1']);
  });

  it('keeps the group id and owner row through running, completion and Turn end', () => {
    const session = makeSession();
    session.dialogTurns[0].status = 'processing';
    session.dialogTurns[0].modelRounds.push(makeRound({ id: 'round-2', items: [makeTool('tool-2', 'Read', 'running')] }));
    const active = sessionToVirtualItems(session);
    const completedTurn = { ...session.dialogTurns[0], modelRounds: [session.dialogTurns[0].modelRounds[0],
      makeRound({ id: 'round-2', items: [makeReadTool('tool-2')] })] };
    const completed = sessionToVirtualItems({ ...session, dialogTurns: [completedTurn] });
    const ended = sessionToVirtualItems({ ...session, dialogTurns: [{ ...completedTurn, status: 'completed' }] });
    const group = active.flatMap(getVirtualItemFlowGroups)[0];
    for (const rows of [completed, ended]) {
      expect(rows.map(getVirtualItemStableKey)).toEqual(active.map(getVirtualItemStableKey));
      expect(rows.flatMap(getVirtualItemFlowGroups)[0].groupId).toBe(group.groupId);
      expect(rows.flatMap(getVirtualItemFlowGroups)[0].sourceGroupIds).toContain('round-1');
      expect(rows.flatMap(getVirtualItemFlowGroups)[0].allItems.map(item => item.id)).toEqual(['tool-1', 'tool-2']);
    }
    expect(completed.flatMap(getVirtualItemFlowGroups)[0].phase).toBe('collecting');
    expect(ended.flatMap(getVirtualItemFlowGroups)[0].phase).toBe('settled');
  });

  it('settles the tail group when its Turn completes', () => {
    const items = sessionToVirtualItems(makeSession());
    expect(items.flatMap(getVirtualItemFlowGroups)[0]).toMatchObject({
      phase: 'settled', isGroupStreaming: false, isLastGroupInTurn: true,
    });
  });

  it('preserves a settled group across a new Turn without reopening it', () => {
    const session = makeSession();
    const firstTurn = session.dialogTurns[0];
    const initial = sessionToVirtualItems(session);
    const next = sessionToVirtualItems({ ...session, dialogTurns: [firstTurn, { ...firstTurn,
      id: 'turn-2', status: 'processing', modelRounds: [makeRound({ id: 'round-2', items: [makeReadTool('tool-2')] })] }] });
    expect(next.flatMap(getVirtualItemFlowGroups).map(group => group.phase)).toEqual(['settled', 'collecting']);
    expect(next.flatMap(getVirtualItemFlowGroups)[0].groupId).toBe(initial.flatMap(getVirtualItemFlowGroups)[0].groupId);
  });

  it('seals at a noncollectible card and starts a separate active run after it', () => {
    const session = makeSession();
    session.dialogTurns[0].status = 'processing';
    session.dialogTurns[0].modelRounds.push(
      makeRound({ id: 'round-2', items: [makeTool('todo', 'TodoWrite')] }),
      makeRound({ id: 'round-3', items: [makeTool('tool-3', 'Read', 'running')] }),
    );
    const items = sessionToVirtualItems(session);
    expect(items.map(item => item.type)).toEqual(['user-message', 'model-round', 'model-round', 'model-round']);
    expect(items.flatMap(getVirtualItemFlowGroups).map(group => group.phase)).toEqual(['settled', 'collecting']);
    expect((items[2] as ModelRoundVirtualItem).projectedGroups).toBeUndefined();
    expect((items[2] as ModelRoundVirtualItem).data.items[0].id).toBe('todo');
  });

  it('renders user steering as a top-level user message item', () => {
    const steeringItem = makeSteeringItem('steer-1', 'Handle this queued request now');
    const session = makeSession({
      dialogTurns: [{
        id: 'turn-1',
        sessionId: 'session-1',
        userMessage: {
          id: 'user-1',
          content: 'Initial request',
          timestamp: 900,
        },
        modelRounds: [
          makeRound({ id: 'round-1' }),
          makeRound({
            id: 'round-2',
            items: [steeringItem],
            isStreaming: true,
            isComplete: false,
            status: 'streaming',
          }),
        ],
        status: 'processing',
        startTime: 900,
      }],
    });

    const items = sessionToVirtualItems(session);

    expect(items.map(item => item.type)).toEqual([
      'user-message',
      'model-round',
      'user-steering-message',
    ]);
    expect(items[2]).toMatchObject({
      type: 'user-steering-message',
      data: {
        id: 'user_steering_steer-1',
        content: 'Handle this queued request now',
        timestamp: 1100,
      },
      turnId: 'turn-1',
      steeringId: 'steer-1',
      steeringStatus: 'pending',
    });
  });

  it('never splits a model round into segments (one round = one stable virtual item)', () => {
    const largeRound = makeRound({
      id: 'large-round',
      items: makeTextItems(25, 'large-text'),
      isStreaming: false,
      isComplete: true,
      status: 'completed',
    });
    const trailingRound = makeRound({
      id: 'tail-round',
      items: makeTextItems(2, 'tail-text'),
      isStreaming: false,
      isComplete: true,
      status: 'completed',
    });
    const session = makeSession({
      sessionId: 'large-round-session',
      dialogTurns: [{
        id: 'turn-1',
        sessionId: 'large-round-session',
        userMessage: {
          id: 'user-1',
          content: 'Summarize a large trace',
          timestamp: 900,
        },
        modelRounds: [largeRound, trailingRound],
        status: 'completed',
        startTime: 900,
      }],
    });

    const items = sessionToVirtualItems(session);
    const modelItems = items.filter((item): item is ModelRoundVirtualItem => item.type === 'model-round');

    expect(modelItems.map(item => item.data.id)).toEqual(['large-round', 'tail-round']);
    expect(modelItems[0].data.items).toHaveLength(25);
    expect(modelItems[0].isLastRound).toBe(false);
    expect(modelItems[1].isLastRound).toBe(true);
  });

  it('attaches the latest Canvas artifact card to the completed response tail', () => {
    const artifactReference = 'openbitfun-canvas://session/canvas-session/canvas/canvas_1';
    const createCanvas = makeTool('create-canvas', 'CreateCanvas');
    createCanvas.toolResult = {
      success: true,
      result: { artifactReference, canvas: { artifact: { title: 'Usage report' } } },
    };
    const patchCanvas = makeTool('patch-canvas', 'PatchCanvas');
    patchCanvas.toolResult = {
      success: true,
      result: { artifactReference, canvas: { artifact: { title: 'Usage report' } } },
    };
    const session = makeSession({
      sessionId: 'canvas-session',
      dialogTurns: [{
        id: 'turn-1',
        sessionId: 'canvas-session',
        userMessage: { id: 'user-1', content: 'Build a report', timestamp: 900 },
        modelRounds: [
          makeRound({ id: 'canvas-round', items: [createCanvas] }),
          makeRound({ id: 'answer-round', items: [patchCanvas, makeTextItem('answer', 'Done.')] }),
        ],
        status: 'completed',
        startTime: 900,
      }],
    });

    const modelItems = sessionToVirtualItems(session)
      .filter((item): item is ModelRoundVirtualItem => item.type === 'model-round');

    expect(modelItems[0].canvasArtifactItems).toBeUndefined();
    expect(modelItems[1].canvasArtifactItems).toEqual([patchCanvas]);
  });

  it('does not split the turn-tail large round (avoids completion remount flash)', () => {
    const largeRound = makeRound({
      id: 'large-tail-round',
      items: makeTextItems(25, 'large-tail-text'),
      isStreaming: false,
      isComplete: true,
      status: 'completed',
    });
    const session = makeSession({
      sessionId: 'large-tail-round-session',
      dialogTurns: [{
        id: 'turn-1',
        sessionId: 'large-tail-round-session',
        userMessage: {
          id: 'user-1',
          content: 'Summarize a large trace',
          timestamp: 900,
        },
        modelRounds: [largeRound],
        status: 'completed',
        startTime: 900,
      }],
    });

    const items = sessionToVirtualItems(session);
    const modelItems = items.filter((item): item is ModelRoundVirtualItem => item.type === 'model-round');

    expect(modelItems).toHaveLength(1);
    expect(modelItems[0]).toMatchObject({
      data: { id: 'large-tail-round' },
      isLastRound: true,
    });
    expect(modelItems[0].data.items).toHaveLength(25);
  });

  it('does not split active or streaming large model rounds', () => {
    const streamingRound = makeRound({
      id: 'streaming-large-round',
      items: makeTextItems(25, 'streaming-text'),
      isStreaming: true,
      isComplete: false,
      status: 'streaming',
    });
    const session = makeSession({
      sessionId: 'streaming-large-round-session',
      dialogTurns: [{
        id: 'turn-1',
        sessionId: 'streaming-large-round-session',
        userMessage: {
          id: 'user-1',
          content: 'Continue writing',
          timestamp: 900,
        },
        modelRounds: [streamingRound],
        status: 'processing',
        startTime: 900,
      }],
    });

    const items = sessionToVirtualItems(session);
    const modelItems = items.filter(item => item.type === 'model-round');

    expect(items.map(item => item.type)).toEqual(['user-message', 'model-round']);
    expect(modelItems).toHaveLength(1);
    expect(modelItems[0]).toMatchObject({
      type: 'model-round',
      data: {
        id: 'streaming-large-round',
        items: expect.arrayContaining([
          expect.objectContaining({ id: 'streaming-text-1' }),
          expect.objectContaining({ id: 'streaming-text-25' }),
        ]),
      },
      isLastRound: true,
      isTurnComplete: false,
    });
  });

  it('reuses the projection for completed turns when a later active turn changes', () => {
    const completedTurn = {
      id: 'completed-turn',
      sessionId: 'stable-turn-session',
      userMessage: {
        id: 'user-completed',
        content: 'Loaded prompt',
        timestamp: 900,
      },
      modelRounds: [makeRound({ id: 'completed-round' })],
      status: 'completed' as const,
      startTime: 900,
    };
    const activeTurnBase = {
      id: 'active-turn',
      sessionId: 'stable-turn-session',
      userMessage: {
        id: 'user-active',
        content: 'Continue',
        timestamp: 1000,
      },
      status: 'processing' as const,
      startTime: 1000,
    };
    const firstSession = makeSession({
      sessionId: 'stable-turn-session',
      dialogTurns: [
        completedTurn,
        {
          ...activeTurnBase,
          modelRounds: [
            makeRound({
              id: 'active-round-1',
              isStreaming: true,
              isComplete: false,
              status: 'streaming',
              items: [makeTool('active-tool-1', 'TodoWrite', 'running')],
            }),
          ],
        },
      ],
    });
    const secondSession = makeSession({
      sessionId: 'stable-turn-session',
      dialogTurns: [
        completedTurn,
        {
          ...activeTurnBase,
          modelRounds: [
            makeRound({
              id: 'active-round-2',
              isStreaming: true,
              isComplete: false,
              status: 'streaming',
              items: [makeTool('active-tool-2', 'TodoWrite', 'running')],
            }),
          ],
        },
      ],
    });

    const firstItems = sessionToVirtualItems(firstSession);
    const secondItems = sessionToVirtualItems(secondSession);

    expect(secondItems[0]).toBe(firstItems[0]);
    expect(secondItems[1]).toBe(firstItems[1]);
    expect(secondItems[2]).not.toBe(firstItems[2]);
  });
});
