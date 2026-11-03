import type { GenUIVerification } from './genUIVerification';
import type { GenUIAppEnvelope } from './genUITypes';

/**
 * User-visible GenUI lifecycle. This is deliberately separate from the
 * FlowChat tool status: OpenUI completes when its source stream completes;
 * only explicit Harmony delivery can wait for owner acceptance.
 */
export type GenUIInteractionState =
  | 'starting'
  | 'streaming'
  | 'data-pending'
  | 'interactive'
  | 'complete'
  | 'delivery-pending'
  | 'degraded'
  | 'failed';

export interface GenUIInteractionStateInput {
  app?: GenUIAppEnvelope;
  /** FlowChat may add tool statuses; this resolver only consumes terminal facts. */
  toolStatus?: string;
  isStreaming?: boolean;
  isFailed?: boolean;
  isCancelled?: boolean;
  isRejected?: boolean;
  verification?: GenUIVerification;
  ownerReady?: boolean;
  ownerError?: string;
  deliveryUnavailable?: boolean;
  dataPending?: boolean;
  /** Final tool evidence may arrive before the local verification panel. */
  deliveryAccepted?: boolean;
  /** Whether this application opted into the durable Harmony delivery path. */
  requiresDelivery?: boolean;
}

function deliveryAccepted(verification: GenUIVerification | undefined): boolean {
  if (!verification) return false;
  return verification.preflight === 'passed'
    && verification.checks === 'passed'
    && verification.render === 'passed'
    && verification.persistence === 'saved'
    && verification.reopen === 'restored';
}

/** Resolve the product state without making the renderer or owner depend on
 * each other's implementation details. */
export function resolveGenUIInteractionState(input: GenUIInteractionStateInput): GenUIInteractionState {
  const hasApp = Boolean(input.app);
  const terminal = input.toolStatus === 'completed'
    || input.toolStatus === 'error'
    || input.toolStatus === 'cancelled'
    || input.toolStatus === 'rejected';

  if (!hasApp) return input.isFailed || input.isCancelled || input.isRejected || terminal ? 'failed' : 'starting';
  if (input.isFailed || input.isCancelled || input.isRejected) return 'degraded';
  if (input.verification?.preflight === 'failed'
    || input.verification?.checks === 'failed'
    || input.verification?.render === 'failed'
    || input.verification?.persistence === 'failed'
    || input.ownerError
    || input.deliveryUnavailable) return 'degraded';
  if (input.dataPending) return 'data-pending';
  if (input.isStreaming) return 'streaming';
  if (!terminal) return 'interactive';
  // OpenUI answers are complete as soon as their source has finished
  // streaming. They deliberately have no owner/CAS/checker lifecycle to
  // wait for. Only an explicit Harmony delivery can enter the pending and
  // complete states below.
  if (!input.requiresDelivery) return 'interactive';
  if (input.deliveryAccepted || deliveryAccepted(input.verification)) return 'complete';
  // A completed Harmony call has usable source, but delivery is still a
  // background concern until persistence/checker/reopen evidence arrives.
  if (input.verification?.persistence === 'saving' || !input.ownerReady) return 'delivery-pending';
  return 'interactive';
}
