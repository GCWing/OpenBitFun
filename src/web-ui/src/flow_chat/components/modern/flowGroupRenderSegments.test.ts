import { expect, it } from 'vitest';
import type { FlowItem, FlowToolItem } from '../../types/flow-chat';
import { buildFlowGroupRenderSegments } from './flowGroupRenderSegments';

function read(index: number): FlowToolItem {
  return { id: `call-${index}`, type: 'tool', toolName: 'Read', timestamp: 1, status: 'completed',
    toolCall: { id: `call-${index}`, input: {} } } as FlowToolItem;
}

it('keeps thinking beside its continuation and existing segment identities stable on append', () => {
  const items: FlowItem[] = Array.from({ length: 15 }, (_, index) => read(index));
  items.push({ id: 'thought', type: 'thinking', status: 'completed' } as FlowItem);
  const before = buildFlowGroupRenderSegments(items);
  const after = buildFlowGroupRenderSegments([...items, read(16), ...Array.from({ length: 30 }, (_, index) => read(17 + index))]);
  expect(after[0].key).toBe(before[0].key);
  expect(after[0].items.at(-2)?.id).toBe('thought');
  expect(after[0].items.at(-1)?.id).toBe('call-16');
  expect(after.flatMap(segment => segment.items).map(item => item.id)).toEqual([
    ...items.map(item => item.id), ...Array.from({ length: 31 }, (_, index) => `call-${16 + index}`),
  ]);
});

it('reuses closed segment object references when appending new items', () => {
  const initialItems: FlowItem[] = Array.from({ length: 32 }, (_, index) => read(index));
  const firstPass = buildFlowGroupRenderSegments(initialItems);
  expect(firstPass.length).toBe(2);

  const updatedItems = [...initialItems, read(32), read(33)];
  const secondPass = buildFlowGroupRenderSegments(updatedItems, firstPass);
  expect(secondPass[0]).toBe(firstPass[0]);
  expect(secondPass[1]).toBe(firstPass[1]);
  expect(secondPass.length).toBe(3);
});

it.each(['append', 'replace'] as const)('preserves the previous tail snapshot on %s', update => {
  const initial = Array.from({ length: 17 }, (_, index) => read(index));
  const before = buildFlowGroupRenderSegments(initial);
  const tail = before[1];
  const originalMembers = tail.items;
  const originalHeight = tail.estimatedHeightPx;
  const updated = update === 'append'
    ? [...initial, read(17)]
    : [...initial.slice(0, -1), { ...initial[16], status: 'running' as const }];
  const after = buildFlowGroupRenderSegments(updated, before);

  expect(after[0]).toBe(before[0]);
  expect(after[1]).not.toBe(tail);
  expect(after[1].key).toBe(tail.key);
  expect(after[1].items).toEqual(updated.slice(16));
  expect(after[1].estimatedHeightPx).toBe(buildFlowGroupRenderSegments(updated)[1].estimatedHeightPx);
  expect(tail.items).toBe(originalMembers);
  expect(tail.items).toEqual(initial.slice(16));
  expect(tail.estimatedHeightPx).toBe(originalHeight);
});
