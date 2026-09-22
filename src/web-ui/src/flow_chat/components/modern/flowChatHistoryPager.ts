import type { SessionHistoryWindowDirection } from '../../store/FlowChatStore';

type Direction = SessionHistoryWindowDirection;
export type HistoryPageResult = 'applied' | 'exhausted' | 'not-ready' | 'cancelled';
type Phase = 'ready' | 'requesting' | 'awaiting-layout' | 'waiting-for-reader' | 'exhausted';

export interface HistoryPageTicket {
  readonly id: number;
  readonly direction: Direction;
  readonly window: string;
  readonly boundary: string | null;
}

interface DirectionState {
  phase: Phase;
  demand: boolean;
  ticket: HistoryPageTicket | null;
  prepared: boolean;
  layoutObserved: boolean;
}

const directions = ['before', 'after'] as const;
const initialState = (): DirectionState => ({
  phase: 'ready', demand: false, ticket: null, prepared: false, layoutObserved: false,
});

/**
 * Request completion and React's layout commit can arrive in either order.
 * Neither grants another page: only fresh reader demand does. In particular,
 * prepend compensation and repeated geometry observations cannot page a whole
 * transcript while the reader is still. A demand is coalesced, not counted.
 *
 * The former armed/reached pair lost its true -> false edge on tail -> history
 * transitions (confirmed by paging probes). It also required a prefetch to have
 * reached the physical boundary. This controller needs neither assumption.
 */
export class FlowChatHistoryPager {
  private states: Record<Direction, DirectionState> = { before: initialState(), after: initialState() };
  private window = '';
  private boundaries: Record<Direction, string | null> = { before: null, after: null };
  private nextId = 0;

  reset(): void {
    this.states = { before: initialState(), after: initialState() };
  }

  readerIntent(direction: Direction): void {
    this.states[direction].demand = true;
    // Reversing direction supersedes a queued request from an earlier gesture.
    this.states[direction === 'before' ? 'after' : 'before'].demand = false;
  }

  observeProximity(asking: ReadonlySet<Direction>): void {
    for (const direction of directions) {
      if (!asking.has(direction)) this.states[direction].demand = false;
    }
  }

  /** Called after the list's measurement/prepend compensation layout effects. */
  commitLayout(window: string, boundaries: Record<Direction, string | null>): void {
    for (const direction of directions) {
      const state = this.states[direction];
      const boundaryMoved = this.boundaries[direction] !== boundaries[direction];
      const moved = this.window !== window || boundaryMoved;
      if (moved && state.phase === 'exhausted') this.states[direction] = initialState();
      if (state.ticket && boundaryMoved && !state.prepared) {
        // A different presentation won while the request was still fetching.
        // Movement at the opposite end (e.g. live output) cannot cancel this
        // direction's fetch while its rendered boundary is unchanged.
        this.states[direction] = initialState();
      } else if (state.ticket && state.prepared && (
        this.boundaries[direction] !== boundaries[direction] || state.phase === 'awaiting-layout'
      )) {
        state.layoutObserved = true;
        if (state.phase === 'awaiting-layout') {
          state.phase = 'waiting-for-reader';
          state.ticket = null;
        }
      }
    }
    this.window = window;
    this.boundaries = boundaries;
  }

  snapshot(direction: Direction): { phase: Phase; demand: boolean; requestId: number | null } {
    const state = this.states[direction];
    return { phase: state.phase, demand: state.demand, requestId: state.ticket?.id ?? null };
  }

  begin(direction: Direction): HistoryPageTicket | null {
    const state = this.states[direction];
    if (state.phase !== 'ready' && !(state.phase === 'waiting-for-reader' && state.demand)) return null;
    const ticket: HistoryPageTicket = {
      id: ++this.nextId, direction, window: this.window, boundary: this.boundaries[direction],
    };
    this.states[direction] = {
      phase: 'requesting', demand: false, ticket, prepared: false, layoutObserved: false,
    };
    return ticket;
  }

  isCurrent(ticket: HistoryPageTicket): boolean {
    return this.states[ticket.direction].ticket === ticket;
  }

  prepareCommit(ticket: HistoryPageTicket): boolean {
    if (!this.isCurrent(ticket)) return false;
    this.states[ticket.direction].prepared = true;
    return true;
  }

  finish(ticket: HistoryPageTicket, result: HistoryPageResult): boolean {
    if (!this.isCurrent(ticket)) return false;
    const state = this.states[ticket.direction];
    if (result === 'applied') {
      // Legacy handlers can return an already-projected page without needing
      // the optional pre-commit hook. The following acknowledgement commit is
      // still required before another request is eligible.
      state.prepared = true;
      state.phase = state.layoutObserved ? 'waiting-for-reader' : 'awaiting-layout';
      if (state.layoutObserved) state.ticket = null;
    } else {
      const sameBoundary = ticket.window === this.window && ticket.boundary === this.boundaries[ticket.direction];
      state.phase = result === 'exhausted' && sameBoundary ? 'exhausted' : 'waiting-for-reader';
      state.ticket = null;
      // Errors/cancellation need a new reader action; rendering an error must
      // not turn a failed load into a self-sustaining retry loop.
      state.demand = false;
    }
    return true;
  }
}
