/**
 * Which staged-rollback outcome a refused `rollback_session_to_turn` is.
 *
 * The transport hands back the host's own error text and nothing else, and the
 * staged rollback reacts to the two cases differently: a target the host no
 * longer holds means this client's view moved on, which is repaired by resyncing
 * quietly, while every other refusal is a failure the user has to be told about.
 *
 * The markers below are the host's own words for the first case, taken from the
 * rollback handler that answers the command
 * (`src/crates/assembly/core/src/agentic/coordination/coordinator.rs`):
 *   8760  "Session rollback target is stale"
 *   8768  "Session rollback target was not found"
 *   8773  "Session rollback target storage identity is stale"
 * Everything unmatched — an unsupported remote workspace, an unfinished revert,
 * a busy session, a broken link — stays a failure, because a classification that
 * guesses "stale" would swallow a real error behind a silent retry.
 */
export enum RollbackFailureKind {
  /** The host does not hold the turn the client addressed; resync and drop. */
  StaleView = 'stale_view',
  /** Everything else: resync and say so. */
  Failed = 'failed'
}

const STALE_TARGET_MARKERS: string[] = [
  'session rollback target is stale',
  'session rollback target storage identity is stale',
  'session rollback target was not found'
];

export class RollbackOutcomePolicy {
  /** Classify one thrown refusal from the rollback command. */
  static failureKind(err: Object): RollbackFailureKind {
    const text = RollbackOutcomePolicy.messageOf(err).toLowerCase();
    for (const marker of STALE_TARGET_MARKERS) {
      if (text.indexOf(marker) >= 0) {
        return RollbackFailureKind.StaleView;
      }
    }
    return RollbackFailureKind.Failed;
  }

  /** The host's message, kept as it arrived. */
  static messageOf(err: Object): string {
    if (err instanceof Error) {
      return err.message;
    }
    return JSON.stringify(err);
  }
}
