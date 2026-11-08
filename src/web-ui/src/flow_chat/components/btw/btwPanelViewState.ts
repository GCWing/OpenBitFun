import type { Session } from '../../types/flow-chat';
import type { VirtualItem } from '../../types/flow-chat-projection';

/** Tab-owned UI state only: never retain sessions, virtual items, or DOM nodes.
 * `projectSession` is the one deliberate exception: it is this tab's own warm
 * projection cache, kept so re-activating the tab does not rebuild the
 * transcript. It belongs to exactly one panel and must never be shared. */
export interface BtwPanelViewState {
  followTail: boolean;
  anchor: { key: string; offsetPx: number } | null;
  exploreGroupStates: Map<string, boolean>;
  expandedToolCapsules?: ReadonlySet<string>;
  restoredReviewLocation?: string;
  restoring: boolean;
  projectSession?: (session: Session | null) => VirtualItem[];
}

export function createBtwPanelViewState(): BtwPanelViewState {
  return { followTail: true, anchor: null, exploreGroupStates: new Map(), restoring: false };
}
