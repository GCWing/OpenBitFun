/**
 * Child-session hydration bookkeeping for the auxiliary pane.
 *
 * A canvas tab can outlive the session record it points at: session removal
 * (delete, archive, rollback, workspace reset) drops the record from the
 * flow-chat store while the tab stays in the agent canvas. The pane used to
 * render its generic "nothing is open" copy forever, with no retry and no close
 * action, so the tab became a dead end.
 *
 * This module owns the pure part of the recovery: a mounted child tab with no
 * usable record attempts exactly one load, and a failing backend must not turn
 * that into a retry loop. The tracker is keyed by the child session id, re-arms
 * when the id changes or the record comes back, and re-arms deliberately for an
 * explicit user retry.
 *
 * Not every pane can load: the MiniApp customize chat renders the panel with a
 * child id only, and a record cannot be recreated without its parent. Such a
 * pane reports that it cannot start an attempt, and the tracker explains the
 * absence instead of arming a load nothing would run.
 */

/**
 * What the pane may render for a child tab: `idle` once a record is present and
 * nothing has to be recovered, `loading` while an attempt is in flight, and
 * `unavailable` once an attempt has finished without making the child usable —
 * either it failed, or it left the record absent.
 */
export type BtwSessionHydrationStatus = 'idle' | 'loading' | 'unavailable';

/** How an attempt ended; `loaded` still has to make the record usable. */
export type BtwSessionHydrationOutcome = 'loaded' | 'failed';

export interface BtwSessionHydrationObservation {
  childSessionId?: string;
  /** The flow-chat store currently holds a record for the child session. */
  hasRecord: boolean;
  /**
   * Whether this pane can start a load at all. A pane that only knows the child
   * id cannot recreate its record, so it must never arm an attempt: that would
   * leave the pane on a load nothing runs.
   */
  canStartAttempt: boolean;
}

export interface BtwSessionHydrationDecision {
  /** Status the pane renders for the observed child tab. */
  status: BtwSessionHydrationStatus;
  /** True exactly once per absence: the caller starts one load attempt now. */
  shouldAttempt: boolean;
}

export interface BtwSessionHydrationTracker {
  observe(observation: BtwSessionHydrationObservation): BtwSessionHydrationDecision;
  /** The attempt started by `observe` finished, successfully or not. */
  settle(childSessionId: string, outcome: BtwSessionHydrationOutcome): void;
  /** Allow one new attempt for the child tab, after an explicit user retry. */
  rearm(childSessionId: string): void;
}

export function createBtwSessionHydrationTracker(): BtwSessionHydrationTracker {
  let trackedSessionId: string | undefined;
  let attempted = false;
  let inFlight = false;
  let failed = false;
  let retryRequested = false;

  const reset = (childSessionId: string | undefined) => {
    trackedSessionId = childSessionId;
    attempted = false;
    inFlight = false;
    failed = false;
    retryRequested = false;
  };

  const arm = (): BtwSessionHydrationDecision => {
    attempted = true;
    inFlight = true;
    failed = false;
    retryRequested = false;
    return { status: 'loading', shouldAttempt: true };
  };

  return {
    observe({ childSessionId, hasRecord, canStartAttempt }) {
      if (!childSessionId) {
        reset(undefined);
        return { status: 'idle', shouldAttempt: false };
      }
      if (childSessionId !== trackedSessionId) {
        reset(childSessionId);
      }
      if (!canStartAttempt) {
        // Nothing may be armed here, and nothing may stay in flight either: the
        // caller could never settle an attempt it was asked to start, which would
        // leave the pane on a load forever.
        reset(childSessionId);
        return hasRecord
          ? { status: 'idle', shouldAttempt: false }
          : { status: 'unavailable', shouldAttempt: false };
      }
      if (attempted) {
        if (inFlight) return { status: 'loading', shouldAttempt: false };
        // A failed attempt keeps the recovery offered even when it left a shell
        // record behind: a record with no turns is not a healed pane. So does an
        // attempt that finished with the record still absent, including one that
        // resolved — nothing observable came back, and only a retry can change it.
        if (failed || !hasRecord) return { status: 'unavailable', shouldAttempt: false };
      }
      // No record needs a load, and so does an explicit retry of a record that a
      // failed attempt left behind. Anything else with a record is the ordinary
      // path: nothing to recover, nothing to load.
      if (retryRequested || !hasRecord) {
        return arm();
      }
      reset(childSessionId);
      return { status: 'idle', shouldAttempt: false };
    },

    settle(childSessionId, outcome) {
      if (childSessionId !== trackedSessionId) return;
      inFlight = false;
      failed = outcome === 'failed';
    },

    rearm(childSessionId) {
      reset(childSessionId);
      retryRequested = true;
    },
  };
}
