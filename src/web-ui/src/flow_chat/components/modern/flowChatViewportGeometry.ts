import { readFlowChatScrollTop } from './flowChatScrollCoordinates';

/** WebKit omits the leading stable scrollbar gutter from a reverse flex
 * child's origin. Centre the actual extent on the panel axis in either layout;
 * do not infer gutter width from clientWidth (WebKit reports only one gutter). */
export function centerFlowChatExtent(scroller: HTMLElement, extent: HTMLElement): void {
  const viewport = scroller.getBoundingClientRect();
  const content = extent.getBoundingClientRect();
  if (viewport.width <= 0 || content.width <= 0) return;
  const correction = viewport.left + (viewport.width - content.width) / 2 - content.left;
  if (Math.abs(correction) < 0.01) return;
  const current = Number.parseFloat(extent.style.left) || 0;
  extent.style.left = `${current + correction}px`;
}
/** One read phase for the consumers of a native transcript scroll event. */
export interface FlowChatViewportGeometry {
  scroller: HTMLElement;
  top: number;
  bottom: number;
  scrollTop: number;
  height: number;
  rows: Array<{
    element: HTMLElement;
    key: string | undefined;
    turnId: string | null;
    itemType: string | null;
    top: number;
    bottom: number;
  }>;
}

/** Do not retain across events/commits: rows can reflow without a scroll. */
export function readFlowChatViewportGeometry(scroller: HTMLElement): FlowChatViewportGeometry {
  const rect = scroller.getBoundingClientRect();
  return {
    scroller, top: rect.top, bottom: rect.bottom,
    scrollTop: readFlowChatScrollTop(scroller), height: scroller.clientHeight,
    rows: Array.from(scroller.querySelectorAll<HTMLElement>('.virtual-item-wrapper')).map(element => {
      const bounds = element.getBoundingClientRect();
      return { element, key: element.dataset.virtualItemKey, turnId: element.dataset.turnId ?? null,
        itemType: element.dataset.itemType ?? null, top: bounds.top, bottom: bounds.bottom };
    }),
  };
}
