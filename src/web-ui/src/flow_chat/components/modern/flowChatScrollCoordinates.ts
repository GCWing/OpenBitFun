/**
 * History has a native bottom scroll origin (column-reverse). Its scrollTop is
 * zero at the latest content and negative toward older content. Keep that
 * physical coordinate inside the adapter; navigation still speaks top offsets.
 */
export function hasFlowChatEndOrigin(scroller: HTMLElement): boolean {
  return scroller.dataset.flowchatScrollOrigin === 'end';
}

export function flowChatScrollRange(scroller: HTMLElement): number {
  return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
}

export function readFlowChatScrollTop(scroller: HTMLElement): number {
  return hasFlowChatEndOrigin(scroller)
    ? flowChatScrollRange(scroller) + scroller.scrollTop
    : scroller.scrollTop;
}

export function toFlowChatNativeScrollTop(scroller: HTMLElement, top: number): number {
  return hasFlowChatEndOrigin(scroller) ? top - flowChatScrollRange(scroller) : top;
}
