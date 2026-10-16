export { backgroundDeliveryFromMetadata, readBackgroundDelivery, shouldDeliverBackgroundCompletion } from '../../../../shared/background-delivery';
import { backgroundDeliveryFromMetadata } from '../../../../shared/background-delivery';
import type { DialogTurn } from '../types/flow-chat';

/** Collapse presentation only. The original turn, catalog position and interaction cards survive. */
export function isSuppressedBackgroundTurn(turn: DialogTurn): boolean {
  const delivery = backgroundDeliveryFromMetadata(turn.userMessage.metadata, turn.id);
  if (!delivery || delivery.policy === 'always' || ['error', 'cancelled', 'cancelling'].includes(turn.status)) return false;
  if ((delivery.executionGeneration ?? 0) !== (turn.recovery?.executionGeneration ?? turn.recoveryEpoch ?? 0)) return false;
  const pendingInteraction = turn.modelRounds.some(round => round.items.some(item =>
    item.type === 'tool' && (item.status === 'pending_confirmation'
      || (item.toolName === 'AskUserQuestion' && !['completed', 'error', 'cancelled'].includes(item.status)))));
  if (pendingInteraction) return false;
  if (delivery.disposition === 'quiet') return ['completed', 'finishing'].includes(turn.status);
  return delivery.disposition === 'pending' && !['completed', 'finishing'].includes(turn.status);
}
