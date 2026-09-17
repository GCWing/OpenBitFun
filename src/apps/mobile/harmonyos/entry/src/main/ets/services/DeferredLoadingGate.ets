/**
 * Holds a loading state back until waiting for it is something the user can
 * actually perceive.
 *
 * Opening a session that is already cached needs one short read off disk, and
 * announcing that with a full-pane skeleton costs more than it explains: the
 * transcript is replaced by a placeholder and then by itself again, which reads
 * as a stall rather than as speed. Below the grace period nothing is shown at
 * all; past it the read is slow enough — a fetch over the relay, say — that
 * silence would be the worse answer.
 *
 * Each `arm` supersedes the one before it, so a second tap while the first open
 * is still settling cannot have its skeleton dismissed by the first one
 * finishing. The token is what enforces that.
 *
 * `maxVisibleMs` bounds how long the wait may be announced. What ends a wait is
 * usually the content arriving, and content that never arrives would otherwise
 * leave a skeleton standing for the rest of the session — a placeholder that
 * outlives its subject reads as a hang. Past the cap the gate gives up saying
 * "loading" and lets whatever the pane does have speak for itself.
 */
export class DeferredLoadingGate {
  private readonly delayMs: number;
  private readonly maxVisibleMs: number;
  private readonly onVisible: (visible: boolean) => void;
  private timerId: number = 0;
  private holdTimerId: number = 0;
  private token: number = 0;

  constructor(delayMs: number, onVisible: (visible: boolean) => void, maxVisibleMs: number = 0) {
    this.delayMs = delayMs;
    this.onVisible = onVisible;
    this.maxVisibleMs = maxVisibleMs;
  }

  /** Starts a wait. The returned token is what `release` has to be given. */
  arm(): number {
    this.cancelTimer();
    this.cancelHoldTimer();
    this.token += 1;
    const armed = this.token;
    this.timerId = setTimeout(() => {
      this.timerId = 0;
      if (armed !== this.token) {
        return;
      }
      this.onVisible(true);
      this.startHoldTimer(armed);
    }, this.delayMs);
    return armed;
  }

  /** The token of the most recent `arm`, for callers keeping state beside it. */
  currentToken(): number {
    return this.token;
  }

  /** Ends the wait started by `token`, if it is still the current one. */
  release(token: number): void {
    if (token !== this.token) {
      return;
    }
    this.settle();
  }

  /**
   * Ends whatever wait is open because the thing waited for has arrived.
   *
   * Unlike `release` this takes no token: the arrival is reported by whatever
   * carries the content — a transcript snapshot, an error — and that path has
   * no memory of which tap asked for it. It is already fenced by the active
   * session, so a signal that reaches here is about the wait that is open.
   */
  settle(): void {
    this.cancelTimer();
    this.cancelHoldTimer();
    this.onVisible(false);
  }

  /** Ends whatever wait is open, for teardown. */
  reset(): void {
    this.token += 1;
    this.settle();
  }

  private startHoldTimer(armed: number): void {
    if (this.maxVisibleMs <= 0) {
      return;
    }
    this.holdTimerId = setTimeout(() => {
      this.holdTimerId = 0;
      if (armed !== this.token) {
        return;
      }
      this.onVisible(false);
    }, this.maxVisibleMs);
  }

  private cancelTimer(): void {
    if (this.timerId !== 0) {
      clearTimeout(this.timerId);
      this.timerId = 0;
    }
  }

  private cancelHoldTimer(): void {
    if (this.holdTimerId !== 0) {
      clearTimeout(this.holdTimerId);
      this.holdTimerId = 0;
    }
  }
}
