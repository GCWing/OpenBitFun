import { FLOWCHAT_TURN_TOP_GAP_PX } from './flowChatTailFollow';

export interface LeadingExtentAnchor {
  key: string;
  offsetPx: number;
  heightPx: number;
  groupHeaderKey?: string;
  groupHeaderOffsetPx?: number;
}

/**
 * Preserve the leading edge, not the shrinking trailing edge. This is one
 * semantic anchor, never a sum of heights removed by previous collapses.
 */
export function leadingExtentFloor(input: {
  anchor: LeadingExtentAnchor;
  startPx: number;
  endPx: number;
  usesGroupHeader: boolean;
}): { floorPx: number; offsetPx: number } {
  const { anchor, startPx, endPx, usesGroupHeader } = input;
  const height = endPx - startPx;
  // Do not move a still-visible shrinking card down the screen. Only recover
  // its top when the part the reader was looking at has disappeared entirely.
  const compactedAbove = height < anchor.heightPx - 0.5
    && height + anchor.offsetPx <= FLOWCHAT_TURN_TOP_GAP_PX
    && anchor.offsetPx < FLOWCHAT_TURN_TOP_GAP_PX;
  const offsetPx = usesGroupHeader
    ? Math.max(FLOWCHAT_TURN_TOP_GAP_PX, anchor.groupHeaderOffsetPx ?? FLOWCHAT_TURN_TOP_GAP_PX)
    : compactedAbove ? FLOWCHAT_TURN_TOP_GAP_PX : anchor.offsetPx;
  return {
    floorPx: Math.max(0, startPx - offsetPx),
    offsetPx,
  };
}
