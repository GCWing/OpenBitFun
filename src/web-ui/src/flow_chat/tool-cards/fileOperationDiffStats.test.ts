import { describe, expect, it } from 'vitest';
import type { FlowToolItem } from '../types/flow-chat';
import { localFileOperationDiffStats, sumFileOperationDiffStats } from './fileOperationDiffStats';

function operation(toolName: string, input: Record<string, unknown>, result?: FlowToolItem['toolResult']): FlowToolItem {
  return { id: 'edit', type: 'tool', timestamp: 1, toolName, status: 'completed',
    toolCall: { id: 'edit', input }, toolResult: result } as FlowToolItem;
}

describe('file operation totals', () => {
  it('counts repeated and reversed edits cumulatively, even when the final file is unchanged', () => {
    const edits = [
      operation('Edit', { old_string: 'before\n', new_string: 'after\n' }),
      operation('Edit', { old_string: 'after\n', new_string: 'before\n' }),
    ];
    expect(sumFileOperationDiffStats(edits.map(localFileOperationDiffStats))).toEqual({ additions: 2, deletions: 2 });
  });

  it.each(['first\nsecond', 'first\nsecond\n', '+++ /remote/file.ts\nfirst\nsecond\n'])(
    'uses the card Write line count for %j', payload => {
      expect(localFileOperationDiffStats(operation('Write', { payload }))).toEqual({ additions: 2, deletions: 0 });
    },
  );

  it('uses deferred tool inputs and omits failed changes despite transport completion', () => {
    const input = { old_string: 'before\n', new_string: 'after\nmore\n' };
    expect(localFileOperationDiffStats(operation('CallDeferredTool', { tool_name: 'Edit', args: input })))
      .toEqual({ additions: 2, deletions: 1 });
    expect(localFileOperationDiffStats(operation('Edit', input, { success: false, result: {} })))
      .toEqual({ additions: 0, deletions: 0 });
  });
});
