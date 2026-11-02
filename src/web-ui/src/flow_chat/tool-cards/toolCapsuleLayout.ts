import type { FlowItem, FlowToolItem } from '../types/flow-chat';
import { getEffectiveToolName } from '../utils/toolInvocationIdentity';
import { isToolCapsule } from './toolCardMetadata';

export type ConcurrentCapsuleRow = 'member' | 'end';

function executionWindow(item: FlowItem | null): { start: number; end: number; detected: number; duration: number } | undefined {
  if (!item || item.type !== 'tool') return;
  const tool = item as FlowToolItem;
  if (!isToolCapsule(getEffectiveToolName(tool)) || tool.status !== 'completed'
    || tool.isParamsStreaming || tool.interruptionReason || tool.toolResult?.success === false) return;
  const { startTime, endTime, executionMs } = tool;
  // Detection/queue timestamps and a common model round do not prove parallel
  // execution. Older records without execution timing keep separate rows.
  if (typeof startTime !== 'number' || typeof endTime !== 'number' || typeof executionMs !== 'number'
    || !Number.isFinite(startTime) || !Number.isFinite(endTime) || !Number.isFinite(executionMs)
    || executionMs <= 0 || endTime <= startTime || executionMs > endTime - startTime) return;
  return { start: endTime - executionMs, end: endTime, detected: startTime, duration: executionMs };
}

/** Preserve recorded order; every member of one row shares an execution interval. */
export function getConcurrentCapsuleRows(items: readonly (FlowItem | null)[]): Map<string, ConcurrentCapsuleRow> {
  const rows = new Map<string, ConcurrentCapsuleRow>();
  let pending: string[] = [];
  let commonStart = 0;
  let commonEnd = 0;
  let earliestDetection = 0;
  let latestEnd = 0;
  let executionTotal = 0;
  const flush = () => {
    // Completion receipts may be batched. A shared inferred interval alone is
    // insufficient: serial execution must also be unable to fit in the whole
    // observed lifetime. Ambiguous or old timing stays on separate rows.
    if (pending.length > 1 && executionTotal > latestEnd - earliestDetection) {
      pending.forEach((id, index) => rows.set(id, index === pending.length - 1 ? 'end' : 'member'));
    }
    pending = [];
  };
  for (const item of items) {
    const interval = executionWindow(item);
    if (!interval || !item) { flush(); continue; }
    if (pending.length && Math.max(commonStart, interval.start) >= Math.min(commonEnd, interval.end)) flush();
    commonStart = pending.length ? Math.max(commonStart, interval.start) : interval.start;
    commonEnd = pending.length ? Math.min(commonEnd, interval.end) : interval.end;
    earliestDetection = pending.length ? Math.min(earliestDetection, interval.detected) : interval.detected;
    latestEnd = pending.length ? Math.max(latestEnd, interval.end) : interval.end;
    executionTotal = (pending.length ? executionTotal : 0) + interval.duration;
    pending.push(item.id);
  }
  flush();
  return rows;
}
