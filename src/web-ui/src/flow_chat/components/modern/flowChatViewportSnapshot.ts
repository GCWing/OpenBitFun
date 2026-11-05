import type { ActiveTurnRenderRange } from '../../types/flow-chat';

export interface FlowChatViewportSnapshot {
  sessionId: string;
  presentationMode: 'tail' | 'history-window';
  viewportMode: 'live-tail' | 'history-reading';
  historyWindow: ActiveTurnRenderRange | null;
  /** Optional for snapshots produced before exact row identity was added. */
  anchorItemKey?: string | null;
  anchorItemType?: string | null;
  /** Absent on legacy snapshots and whole/live text rows. */
  anchorMarkdownStart?: number;
  anchorTurnId: string | null;
  anchorOffsetPx: number | null;
  scrollTopPx: number;
  isAtTail: boolean;
  capturedAtMs: number;
}
