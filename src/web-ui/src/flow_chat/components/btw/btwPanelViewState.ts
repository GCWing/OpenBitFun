/** Tab-owned UI state only: never retain sessions, virtual items, or DOM nodes. */
export interface BtwPanelViewState {
  followTail: boolean;
  anchor: { key: string; offsetPx: number } | null;
  exploreGroupStates: Map<string, boolean>;
  expandedToolCapsules?: ReadonlySet<string>;
  restoredReviewLocation?: string;
  restoring: boolean;
}

export function createBtwPanelViewState(): BtwPanelViewState {
  return { followTail: true, anchor: null, exploreGroupStates: new Map(), restoring: false };
}
