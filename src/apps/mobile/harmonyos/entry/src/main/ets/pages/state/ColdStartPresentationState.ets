/** Launch-only presentation state; no account credentials or transport ownership. */
@ObservedV2
export class ColdStartPresentationState {
  private static processClaimed: boolean = false;

  static claimProcess(): boolean {
    if (ColdStartPresentationState.processClaimed) return false;
    ColdStartPresentationState.processClaimed = true;
    return true;
  }
  @Trace targetX: number = 0;
  @Trace targetY: number = 0;
  @Trace targetSize: number = 0;
  @Trace originX: number = 0;
  @Trace originY: number = 0;
}
