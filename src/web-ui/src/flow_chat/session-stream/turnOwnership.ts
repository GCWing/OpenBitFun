/**
 * Which writer owns a Turn.
 *
 * Contract 2 of [`docs/architecture/session-projection.md`](../../../../../docs/architecture/session-projection.md):
 * an executing Turn is owned by the runtime stream, a settled Turn by the
 * persisted record, and ownership transfers exactly once on the terminal
 * event.
 *
 * This is what lets history and live events share one projection without
 * racing: they are never both authoritative for the same Turn, so there is
 * nothing to reconcile between them.
 */

/** Frontend event names that settle the Turn they name. */
const TERMINAL_TURN_EVENTS = new Set([
  'agentic://dialog-turn-completed',
  'agentic://dialog-turn-cancelled',
  'agentic://dialog-turn-failed',
]);

/** Frontend event name that opens a Turn. */
const TURN_STARTED_EVENT = 'agentic://dialog-turn-started';

export type TurnOwner =
  /** The runtime stream. Persisted content for this Turn is identity only. */
  | 'runtime'
  /** The persisted record. Live events for this Turn are stale and dropped. */
  | 'persisted';

export function isTurnStartedEvent(eventName: string): boolean {
  return eventName === TURN_STARTED_EVENT;
}

export function isTerminalTurnEvent(eventName: string): boolean {
  return TERMINAL_TURN_EVENTS.has(eventName);
}

/**
 * Read the Turn an event belongs to.
 *
 * An event with no Turn is Session-scoped (title, state, history changed) and
 * is not subject to Turn ownership.
 */
export function eventTurnId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const turnId = (payload as Record<string, unknown>).turnId;
  return typeof turnId === 'string' && turnId ? turnId : null;
}

/**
 * Ownership of every Turn this stream has observed.
 *
 * Deliberately not derived from the projection: asking "does this Turn look
 * finished on screen" is the inspection this contract removes. Ownership is
 * decided by the ordered events themselves.
 */
export class TurnOwnership {
  private readonly settled = new Set<string>();
  private readonly executing = new Set<string>();

  /** Record what an event does to its Turn's ownership. */
  observe(eventName: string, turnId: string | null): void {
    if (!turnId) {
      return;
    }
    if (isTurnStartedEvent(eventName)) {
      // A Turn can only be reopened by a new Runtime stream, which resets this
      // whole object; within one stream, started-then-settled is one-way.
      if (!this.settled.has(turnId)) {
        this.executing.add(turnId);
      }
      return;
    }
    if (isTerminalTurnEvent(eventName)) {
      this.executing.delete(turnId);
      this.settled.add(turnId);
    }
  }

  /** A Turn this stream never saw start is history, and history is persisted. */
  ownerOf(turnId: string): TurnOwner {
    return this.executing.has(turnId) ? 'runtime' : 'persisted';
  }

  /**
   * Whether the persisted record may write this Turn.
   *
   * False exactly while the runtime stream owns it — which is what stops a
   * lagging checkpoint from painting an in-progress Turn as interrupted
   * history.
   */
  persistedMayWrite(turnId: string): boolean {
    return !this.executing.has(turnId);
  }

  /**
   * The Host reported this Turn settled by other means than an event this
   * stream applied — its terminal event was never delivered here.
   */
  settle(turnId: string): void {
    this.executing.delete(turnId);
    this.settled.add(turnId);
  }

  /** Whether a live event may still write this Turn. */
  runtimeMayWrite(turnId: string): boolean {
    return !this.settled.has(turnId);
  }

  executingTurnIds(): string[] {
    return [...this.executing];
  }

  /** A new Runtime process invalidates every ownership fact from the old one. */
  reset(): void {
    this.settled.clear();
    this.executing.clear();
  }
}
