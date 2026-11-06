import type { FlowItem, FlowTextItem, FlowToolItem } from '../types/flow-chat';
import type { FlowGroupBase } from './types';
import { isShellActivity, shellActivityStats } from './activityClassification';

const terminal = new Set(['completed', 'cancelled', 'rejected', 'error']);

export function isFlowGroupMemberActive(item: FlowItem): boolean {
  return !terminal.has(item.status)
    || (item.type === 'tool' && (item as FlowToolItem).isParamsStreaming === true)
    || ((item.type === 'thinking' || item.type === 'text') && (item as FlowTextItem).isStreaming);
}

const lifecycleCache = new WeakMap<readonly FlowItem[], {
  sealedTrue?: Pick<FlowGroupBase, 'phase' | 'isGroupStreaming' | 'needsAttention'>;
  sealedFalse?: Pick<FlowGroupBase, 'phase' | 'isGroupStreaming' | 'needsAttention'>;
}>();

/** Boundary and execution are independent: a sealed run can still be draining. */
export function flowGroupLifecycle(items: readonly FlowItem[], sealed: boolean): Pick<FlowGroupBase, 'phase' | 'isGroupStreaming' | 'needsAttention'> {
  let entry = lifecycleCache.get(items);
  if (entry) {
    const cached = sealed ? entry.sealedTrue : entry.sealedFalse;
    if (cached) return cached;
  } else {
    entry = {};
    lifecycleCache.set(items, entry);
  }
  const active = items.some(isFlowGroupMemberActive);
  const shell = shellActivityStats(items.filter((item): item is FlowToolItem => item.type === 'tool' && isShellActivity(item as FlowToolItem)));
  const result: Pick<FlowGroupBase, 'phase' | 'isGroupStreaming' | 'needsAttention'> = {
    phase: !sealed ? 'collecting' : active ? 'settling' : 'settled',
    isGroupStreaming: active,
    needsAttention: shell.failed > 0 || shell.stopped > 0 || items.some(item => ['error', 'pending_confirmation', 'cancelled', 'rejected'].includes(item.status)
      || (item.type === 'tool' && (item as FlowToolItem).toolResult?.success === false)),
  };
  if (sealed) entry.sealedTrue = result;
  else entry.sealedFalse = result;
  return result;
}
