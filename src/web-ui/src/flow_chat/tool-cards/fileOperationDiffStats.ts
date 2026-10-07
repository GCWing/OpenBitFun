import { diffLines } from 'diff';
import { splitFilePathAndContent } from '@/shared/utils/partialJsonParser';
import type { FlowToolItem } from '../types/flow-chat';
import { projectEffectiveToolItem } from '../utils/toolInvocationIdentity';
import { getToolCardStatus } from './toolCardStatus';

export interface FileOperationDiffStats {
  additions: number;
  deletions: number;
}

export const EMPTY_FILE_DIFF_STATS: FileOperationDiffStats = { additions: 0, deletions: 0 };

export function fileOperationPreview(item: FlowToolItem) {
  const tool = projectEffectiveToolItem(item);
  const params = tool.partialParams || tool.toolCall?.input;
  const string = (value: unknown) => typeof value === 'string' ? value : '';
  return {
    oldStringContent: string(params?.old_string),
    newStringContent: string(params?.new_string),
    contentPreview: splitFilePathAndContent(params?.payload)?.content
      ?? (typeof params?.payload === 'string' ? params.payload : string(params?.content) || string(params?.contents)),
  };
}

/** The same per-operation fallback used by a native card and its collection. */
export function localFileOperationDiffStats(item: FlowToolItem): FileOperationDiffStats {
  const tool = projectEffectiveToolItem(item);
  if (getToolCardStatus(tool) === 'error') return EMPTY_FILE_DIFF_STATS;
  const { oldStringContent, newStringContent, contentPreview } = fileOperationPreview(tool);
  if (tool.toolName === 'Write' && contentPreview) {
    const lines = contentPreview.split('\n');
    return { additions: lines.length - (lines.at(-1) === '' ? 1 : 0), deletions: 0 };
  }
  if (tool.toolName === 'Edit' && (oldStringContent || newStringContent)) {
    const stats = { additions: 0, deletions: 0 };
    for (const change of diffLines(oldStringContent, newStringContent)) {
      if (change.added) stats.additions += change.count ?? 0;
      else if (change.removed) stats.deletions += change.count ?? 0;
    }
    return stats;
  }
  return EMPTY_FILE_DIFF_STATS;
}

export function sumFileOperationDiffStats(stats: Iterable<FileOperationDiffStats>): FileOperationDiffStats {
  const total = { additions: 0, deletions: 0 };
  for (const item of stats) {
    total.additions += item.additions;
    total.deletions += item.deletions;
  }
  return total;
}
