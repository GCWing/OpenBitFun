import { describe, expect, it } from 'vitest';
import { mergeTrajectoryNodes, projectTrajectoryTurn, trajectoryNodeKey, trajectoryValueMatches } from './trajectoryModel';
import { resolveTrajectoryRange, summarizeTrajectoryRange } from './trajectoryRange';
import type { DialogTurn } from '../types/flow-chat';

export const turn = (): DialogTurn => ({
  id: 'turn', sessionId: 'session', userMessage: { id: 'user', content: 'Find Needle', timestamp: 1 },
  modelRounds: [{ id: 'round', index: 0, startTime: 2, status: 'completed', isComplete: true, isStreaming: false,
    items: [{ id: 'text', type: 'text', content: 'A needle', isStreaming: false, timestamp: 2, status: 'completed' },
      { id: 'tool', type: 'tool', toolName: 'Read', timestamp: 3, status: 'completed',
        toolCall: { id: 'call', input: { path: '/NEEDLE' } }, toolResult: { success: true, result: { content: 'Found it' } } }] }],
  startTime: 1, status: 'completed',
} as DialogTurn);

describe('trajectory projection and range identity', () => {
  it('searches concrete model text, tool arguments and nested output without copying bodies into nodes', () => {
    const nodes = projectTrajectoryTurn(turn(), 4, 'NEEDLE');
    expect(nodes.map(node => node.matched)).toEqual([true, true, true]);
    expect(nodes[1].focusItemId).toBe('text');
    expect(nodes[2].matchField).toBe('parameters');
    expect(JSON.stringify(nodes)).not.toContain('/NEEDLE');
    expect(projectTrajectoryTurn(turn(), 4, 'found')[2].matchField).toBe('result');
    expect(trajectoryValueMatches({ count: 0 }, '0')).toBe(true);
  });
  it('replaces a loaded turn as a unit so removed retry tools do not survive in history summaries', () => {
    const historical = projectTrajectoryTurn(turn(), 4);
    const edited = turn(); edited.modelRounds[0].items.pop();
    const live = projectTrajectoryTurn(edited, 4);
    expect(mergeTrajectoryNodes(historical, live)).toEqual(live);
    expect(trajectoryNodeKey(live[1])).toBe(trajectoryNodeKey(historical[1]));
  });
  it('retains range endpoints across prepends and rejects missing identities after a rollback', () => {
    const nodes = projectTrajectoryTurn(turn(), 4);
    const range = { anchor: trajectoryNodeKey(nodes[2]), focus: trajectoryNodeKey(nodes[1]) };
    expect(resolveTrajectoryRange(nodes, range)).toEqual([1, 2]);
    const older = turn(); older.id = 'older';
    expect(resolveTrajectoryRange([...projectTrajectoryTurn(older, 0), ...nodes], range)).toEqual([4, 5]);
    expect(resolveTrajectoryRange(nodes.slice(0, 2), range)).toBeNull();
  });
  it('keeps missing durations distinct from measured zero and sums parallel calls explicitly', () => {
    const nodes = projectTrajectoryTurn(turn(), 4);
    expect(summarizeTrajectoryRange(nodes, [0, 2]).toolMs).toBeUndefined();
    nodes[2].durationMs = 0; nodes[1].durationMs = 15;
    const summary = summarizeTrajectoryRange(nodes, [0, 2]);
    expect(summary).toMatchObject({ counts: { user: 1, model: 1, tool: 1, errors: 0 }, toolMs: 0, modelMs: 15 });
  });
  it('uses host ordinals when a partial peer replica numbers the same turn differently', () => {
    const historical = projectTrajectoryTurn(turn(), 50);
    const live = projectTrajectoryTurn(turn(), 0);
    expect(mergeTrajectoryNodes(historical, live).every(node => node.turnOrdinal === 50)).toBe(true);
  });
  it('anchors a model to visible prose before collapsed reasoning when there is no search hit', () => {
    const value = turn();
    value.modelRounds[0].items.unshift({ id: 'thinking', type: 'thinking', content: 'Reasoning', timestamp: 1, status: 'completed', isStreaming: false });
    expect(projectTrajectoryTurn(value, 0)[1].focusItemId).toBe('text');
    expect(projectTrajectoryTurn(value, 0, 'Reasoning')[1].focusItemId).toBe('thinking');
  });
});
