import { describe, expect, it } from 'vitest';
import { areModelRoundItemPropsEqual, type ModelRoundItemProps } from './modelRoundItemMemo';
import type { FlowToolItem } from '../../types/flow-chat';
import { buildInlineExploreGroupData } from './modelRoundItemGrouping';

describe('model round memoization', () => {
  const props: ModelRoundItemProps = {
    turnId: 'turn',
    round: { id: 'round', index: 1, startTime: 1, status: 'completed',
      isStreaming: false, isComplete: true, items: [] },
  };

  it('updates a settled row when recovery metadata adds or removes the continuation label', () => {
    const recovered = { ...props, round: { ...props.round,
      renderHints: { continuedAfterInterruption: true } } };
    expect(areModelRoundItemPropsEqual(props, recovered)).toBe(false);
    expect(areModelRoundItemPropsEqual(recovered, props)).toBe(false);
    expect(areModelRoundItemPropsEqual(recovered, { ...recovered, round: { ...recovered.round,
      renderHints: { continuedAfterInterruption: true } } })).toBe(true);
  });

  it('still updates streaming output and tool grouping while reusing unchanged settled content', () => {
    expect(areModelRoundItemPropsEqual(props, { ...props })).toBe(true);
    expect(areModelRoundItemPropsEqual(props, { ...props, round: { ...props.round, isStreaming: true } })).toBe(false);
    expect(areModelRoundItemPropsEqual(props, { ...props, round: { ...props.round,
      renderHints: { disableExploreGrouping: true } } })).toBe(false);
  });

  it('updates when another round contributes exploration while reusing identical projected contents', () => {
    const read: FlowToolItem = { id: 'read', type: 'tool', toolName: 'Read', status: 'completed', timestamp: 1,
      toolCall: { id: 'read', input: {} } };
    const group = { type: 'explore' as const, items: [read], isLast: true };
    const before = { ...props, projectedGroups: [{ ...group, projection: buildInlineExploreGroupData('round', group) }] };
    expect(areModelRoundItemPropsEqual(before, { ...before, projectedGroups: [{ ...before.projectedGroups[0], items: [read] }] })).toBe(true);
    const appended = { ...group, items: [read, { ...read, id: 'next' }] };
    const after = { ...props, projectedGroups: [{ ...appended, projection: buildInlineExploreGroupData('round', appended) }] };
    expect(areModelRoundItemPropsEqual(before, after)).toBe(false);
    expect(areModelRoundItemPropsEqual(before, { ...before, projectedGroups: [] })).toBe(false);
  });
});
