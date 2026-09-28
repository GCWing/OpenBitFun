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

it('keeps native AgentWait segment boundaries stable as calls complete', () => {
  const items = Array.from({ length: 20 }, (_, index) => read(index));
  items[15] = { ...items[15], toolName: 'AgentWait', status: 'running' };
  items[16] = { ...items[16], toolName: 'AgentWait', status: 'running' };
  const before = buildFlowGroupRenderSegments(items);
  const after = buildFlowGroupRenderSegments(items.map(item => ({ ...item, status: 'completed' })));
  expect(before[0].items.at(-1)?.id).toBe('call-15');
  expect(after.map(segment => segment.key)).toEqual(before.map(segment => segment.key));
});
