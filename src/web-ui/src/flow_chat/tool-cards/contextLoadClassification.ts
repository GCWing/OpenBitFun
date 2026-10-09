import type { FlowToolItem } from '../types/flow-chat';
import { projectEffectiveToolItem } from '../utils/toolInvocationIdentity';
import { controlRecord, getOpenBitFunControlInput, isOpenBitFunControlDiscovery } from './openBitFunControlCardModel';

export type ContextLoadKind = 'skill' | 'tool-spec' | 'discovery';

/** Recorded identity and action own classification, independently of card density. */
export function getContextLoadKind(item: FlowToolItem): ContextLoadKind | undefined {
  const effective = projectEffectiveToolItem(item);
  if (effective.toolName === 'Skill') return 'skill';
  if (effective.toolName === 'GetToolSpec') return 'tool-spec';
  if (effective.toolName === 'OpenBitFunControl'
    && isOpenBitFunControlDiscovery(getOpenBitFunControlInput(effective))) return 'discovery';
  return undefined;
}

export function isSettledContextLoad(item: FlowToolItem): boolean {
  if (item.status !== 'completed' || item.isParamsStreaming || item.toolResult?.success === false) return false;
  const kind = getContextLoadKind(item);
  if (!kind) return false;
  const result = controlRecord(item.toolResult?.result);
  if (result.success === false || result.error) return false;
  if (kind === 'discovery') {
    const availability = controlRecord(result.controlAvailability).status;
    // A returned contract can still describe an unavailable remote capability.
    if (typeof availability === 'string' && availability !== 'available') return false;
  }
  return true;
}
