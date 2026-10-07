import { describe, expect, it } from 'vitest';
import type { FlowToolItem } from '../types/flow-chat';
import type { VirtualItem } from '../types/flow-chat-projection';
import { projectAdjacentFlowGroups } from './groupProjection';
import { captureFlowGroupFeedbackSnapshot, collectFlowGroupReceiveFeedback } from './receiveFeedback';
import { indexFlowGroups } from './selectors';

function tool(id: string, status: FlowToolItem['status'] = 'completed', toolName = 'Read'): FlowToolItem {
  return { id, type: 'tool', toolName, status, timestamp: 1,
    toolCall: { id, input: {} }, toolResult: status === 'completed' ? { success: true, result: {} } : undefined };
}
function row(id: string, items: FlowToolItem[], isTurnComplete = false): VirtualItem {
  return { type: 'model-round', turnId: 'turn', isLastRound: false, isTurnComplete,
    data: { id, index: 0, startTime: 1, status: isTurnComplete ? 'completed' : 'running', isStreaming: !isTurnComplete, items } };
}
const project = (items: FlowToolItem[], complete = false) => projectAdjacentFlowGroups([row('round', items, complete)]);

describe('group arrival feedback', () => {
  it('does not mistake initial history or newly loaded settled records for arrivals', () => {
    const history = project([tool('old')], true);
    expect(collectFlowGroupReceiveFeedback(undefined, history, 'session').size).toBe(0);
    const before = captureFlowGroupFeedbackSnapshot(history, 'session');
    expect(collectFlowGroupReceiveFeedback(before, project([tool('older'), tool('old')], true), 'session').size).toBe(0);
  });

  it.each(['Read', 'GetToolSpec'])('does not pulse when a live %s finishes inside its existing group', toolName => {
    const before = captureFlowGroupFeedbackSnapshot(project([tool('one', 'completed', toolName), tool('two', 'running', toolName)]), 'session');
    const after = project([tool('one', 'completed', toolName), tool('two', 'completed', toolName)], true);
    const receipts = collectFlowGroupReceiveFeedback(before, after, 'session');
    expect(receipts.size).toBe(0);
    expect(collectFlowGroupReceiveFeedback(captureFlowGroupFeedbackSnapshot(after, 'session'), after, 'session').size).toBe(0);
  });

  it('retains single-use feedback for legacy projections without a live lifecycle', () => {
    const running = tool('one', 'running');
    const before = captureFlowGroupFeedbackSnapshot([{ ...row('round', [running]),
      projectedGroups: [{ type: 'critical', item: running }] } as VirtualItem], 'session');
    const after: VirtualItem[] = [{ type: 'explore-group', turnId: 'turn', data: {
      groupId: 'legacy', rounds: [], allItems: [tool('one')], stats: { readCount: 1, searchCount: 0, commandCount: 0 },
      isGroupStreaming: false, isLastGroupInTurn: true, wasCutByCritical: false,
    } }];
    const receipts = collectFlowGroupReceiveFeedback(before, after, 'session');
    expect(receipts.size).toBe(1);
    const receipt = receipts.get('legacy')!;
    expect(receipt.claim()).toBe(true);
    expect(receipt.claim()).toBe(false);
    expect(collectFlowGroupReceiveFeedback(captureFlowGroupFeedbackSnapshot(after, 'session'), after, 'session').size).toBe(0);
  });

  it('does not cross a session/device scope or collect failed and unavailable calls', () => {
    const before = captureFlowGroupFeedbackSnapshot(project([tool('one'), tool('two', 'running')]), 'device-a:session');
    expect(collectFlowGroupReceiveFeedback(before, project([tool('one'), tool('two')]), 'device-b:session').size).toBe(0);
    expect(collectFlowGroupReceiveFeedback(before, project([tool('one'), tool('two', 'error')]), 'device-a:session').size).toBe(0);
  });

  it('keeps one owner without completion feedback across adjacent model rounds and replay', () => {
    const before = captureFlowGroupFeedbackSnapshot(projectAdjacentFlowGroups([
      row('first', [tool('one')]), row('second', [tool('two', 'running')]),
    ]), 'session');
    const recorded = [row('first', [tool('one')]), row('second', [tool('two')])];
    const serialized = JSON.stringify(recorded);
    const after = projectAdjacentFlowGroups(recorded);
    const index = indexFlowGroups(after);
    expect(index.byMemberId.get('one')).toBe(index.byMemberId.get('two'));
    expect(collectFlowGroupReceiveFeedback(before, after, 'session').size).toBe(0);
    expect(projectAdjacentFlowGroups(JSON.parse(serialized))).toEqual(after);
    expect(projectAdjacentFlowGroups(after)).toEqual(after);
    expect(JSON.stringify(recorded)).toBe(serialized);
  });
});
