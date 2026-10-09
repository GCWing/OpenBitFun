import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FlowItem, FlowToolItem } from '../types/flow-chat';
import { CAPSULE_TOOL_NAMES } from './toolCardMetadata';
import { getConcurrentCapsuleRows } from './toolCapsuleLayout';

const fixtureCapsule = 'TestCapsule';
beforeAll(() => CAPSULE_TOOL_NAMES.add(fixtureCapsule));
afterAll(() => CAPSULE_TOOL_NAMES.delete(fixtureCapsule));

function tool(id: string, start: number, end: number, overrides: Partial<FlowToolItem> = {}): FlowToolItem {
  return {
    id, type: 'tool', toolName: fixtureCapsule, status: 'completed', timestamp: start,
    toolCall: { id, input: { agent_ids: [id] } },
    startTime: start, endTime: end, executionMs: end - start,
    ...overrides,
  };
}

describe('concurrent capsule rows', () => {
  it('keeps adjacent serial calls separate, including touching execution intervals', () => {
    expect(getConcurrentCapsuleRows([tool('a', 0, 100), tool('b', 100, 200), tool('c', 250, 350)])).toHaveProperty('size', 0);
  });

  it('preserves shared rows for adjacent eligible capsules with a common execution interval', () => {
    const items = [tool('a', 0, 100), tool('b', 20, 120), tool('c', 40, 150)];
    const snapshot = JSON.stringify(items);
    expect([...getConcurrentCapsuleRows(items)]).toEqual([['a', 'member'], ['b', 'member'], ['c', 'end']]);
    expect(JSON.stringify(items)).toBe(snapshot);
  });

  it.each(['Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch', 'view_image', 'Skill', 'GetToolSpec'])('%s keeps native rows even when calls overlap', toolName => {
    expect(getConcurrentCapsuleRows([
      tool('a', 0, 100, { toolName }), tool('b', 0, 100, { toolName }),
    ])).toHaveProperty('size', 0);
    expect(getConcurrentCapsuleRows([
      tool('wait-a', 0, 100), tool('native', 0, 100, { toolName }), tool('wait-b', 0, 100),
    ])).toHaveProperty('size', 0);
  });

  it('does not mistake early detection or queue time for execution overlap', () => {
    expect(getConcurrentCapsuleRows([
      tool('a', 0, 100), tool('b', 0, 200, { executionMs: 100 }),
    ])).toHaveProperty('size', 0);
  });

  it('keeps batched completion receipts separate when the observed lifetime still fits serial execution', () => {
    expect(getConcurrentCapsuleRows([
      tool('a', 0, 200, { executionMs: 100 }), tool('b', 0, 201, { executionMs: 100 }),
    ])).toHaveProperty('size', 0);
  });

  it.each<Partial<FlowToolItem>>([
    { startTime: undefined }, { endTime: undefined }, { executionMs: undefined },
    { executionMs: 0 }, { executionMs: -1 }, { executionMs: 101 },
    { executionMs: Number.NaN }, { startTime: Number.POSITIVE_INFINITY }, { endTime: 0 },
  ])('keeps absent or inconsistent execution timing on separate rows: %j', overrides => {
    expect(getConcurrentCapsuleRows([tool('a', 0, 100), tool('b', 0, 100, overrides)])).toHaveProperty('size', 0);
  });

  it('does not join a transitive chain whose first and last calls are serial', () => {
    expect([...getConcurrentCapsuleRows([
      tool('a', 0, 100), tool('b', 50, 150), tool('c', 100, 200),
    ])]).toEqual([['a', 'member'], ['b', 'end']]);
  });

  it('ends each independent concurrent batch even when batches are adjacent', () => {
    expect([...getConcurrentCapsuleRows([
      tool('a', 0, 100), tool('b', 0, 100), tool('c', 100, 200), tool('d', 100, 200),
    ])]).toEqual([['a', 'member'], ['b', 'end'], ['c', 'member'], ['d', 'end']]);
  });

  it.each<FlowItem | null>([
    null,
    { id: 'text', type: 'text', timestamp: 1, status: 'completed' },
    { id: 'thinking', type: 'thinking', timestamp: 1, status: 'completed' },
    tool('edit', 0, 100, { toolName: 'Edit' }),
    tool('failure', 0, 100, { toolResult: { success: false, result: null } }),
    tool('error', 0, 100, { status: 'error' }),
    tool('permission', 0, 100, { status: 'pending_confirmation' }),
    tool('running', 0, 100, { status: 'running' }),
    tool('cancelled', 0, 100, { status: 'cancelled' }),
    tool('streaming', 0, 100, { isParamsStreaming: true }),
  ])('never groups across a narrative, critical or unsettled boundary: %j', boundary => {
    expect(getConcurrentCapsuleRows([tool('a', 0, 100), boundary, tool('b', 0, 100)])).toHaveProperty('size', 0);
  });

  it('resolves deferred identity before deciding whether a tool can share a row', () => {
    const deferred = tool('b', 0, 100, {
      toolName: 'CallDeferredTool', toolCall: { id: 'b', input: { tool_name: fixtureCapsule, args: { agent_ids: ['agent'] } } },
    });
    expect([...getConcurrentCapsuleRows([tool('a', 0, 100), deferred])]).toEqual([['a', 'member'], ['b', 'end']]);
    expect(getConcurrentCapsuleRows([
      tool('a', 0, 100), { ...deferred, toolCall: { ...deferred.toolCall, input: { tool_name: 'Edit' } } },
    ])).toHaveProperty('size', 0);
    expect(getConcurrentCapsuleRows([
      tool('a', 0, 100), { ...deferred, toolCall: { ...deferred.toolCall, input: { tool_name: 'Grep', args: { pattern: 'test' } } } },
    ])).toHaveProperty('size', 0);
  });
});
