import { splitFilePathAndContent } from '@/shared/utils/partialJsonParser';
import type { FlowItem, FlowToolItem } from '../types/flow-chat';
import { projectEffectiveToolItem } from '../utils/toolInvocationIdentity';
import { awaitsApproval } from './activityClassification';

const pathKeys = ['file_path', 'filePath', 'filepath', 'target_file', 'targetFile', 'path', 'filename'] as const;
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function pathIn(value: Record<string, unknown> | undefined): string | undefined {
  for (const key of pathKeys) {
    if (typeof value?.[key] === 'string' && value[key].trim()) return value[key];
  }
  return undefined;
}

/** A completed target, never a filename guessed from a streaming JSON prefix. */
export function fileEditTarget(item: FlowItem | undefined): string | undefined {
  if (item?.type !== 'tool') return undefined;
  const tool = projectEffectiveToolItem(item as FlowToolItem);
  if (!['Edit', 'Write'].includes(tool.toolName) || tool.isParamsStreaming || awaitsApproval(tool)) return undefined;
  const input = object(tool.toolCall?.input);
  const result = object(tool.toolResult?.result);
  // External providers may represent a multi-file edit with the same tool name.
  for (const source of [input, result]) {
    if (['locations', 'files', 'changes'].some(key => Array.isArray(source?.[key]) && source[key].length > 1)) return undefined;
  }
  const locations = Array.isArray(result?.locations) ? result.locations : undefined;
  const target = pathIn(input) || splitFilePathAndContent(input?.payload)?.filePath
    || pathIn(result) || pathIn(object(locations?.[0]));
  if (!target || target.toLowerCase().endsWith('.plan.md')) return undefined;
  // Windows separators are interchangeable. Preserve case and POSIX backslashes;
  // neither the controller OS nor a basename proves remote file identity.
  return /^[a-z]:[\\/]|^\\\\/i.test(target) ? target.replace(/\\/g, '/') : target;
}

export function sameFileEditRun(previous: readonly FlowItem[], next: readonly FlowItem[]): boolean {
  const target = fileEditTarget(previous.find(item => item.type === 'tool'));
  return target !== undefined && target === fileEditTarget(next.find(item => item.type === 'tool'));
}

export function fileEditGroupStatus(items: readonly FlowItem[]) {
  const tools = items.filter((item): item is FlowToolItem => item.type === 'tool');
  const failed = tools.filter(item => item.status === 'error' || item.toolResult?.success === false).length;
  const stopped = tools.filter(item => item.status === 'cancelled' || item.status === 'rejected').length;
  const running = tools.some(item => !['completed', 'error', 'cancelled', 'rejected'].includes(item.status));
  return { failed, stopped, running };
}
