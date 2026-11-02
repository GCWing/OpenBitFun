/** One automatic page per deliberate drag; layout and bounce cannot re-arm it. */
export class HistoryPageArrivalTracker {
  private consumed: boolean = true;
  beginGesture(): void { this.consumed = false; }
  arrived(atStart: boolean): boolean {
    if (!atStart || this.consumed) return false;
    this.consumed = true;
    return true;
  }
  cancelArrival(): void { this.consumed = true; }
}
