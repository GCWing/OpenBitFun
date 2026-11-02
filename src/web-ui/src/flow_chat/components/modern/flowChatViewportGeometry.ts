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
    scrollTop: scroller.scrollTop, height: scroller.clientHeight,
    rows: Array.from(scroller.querySelectorAll<HTMLElement>('.virtual-item-wrapper')).map(element => {
      const bounds = element.getBoundingClientRect();
      return { element, key: element.dataset.virtualItemKey, turnId: element.dataset.turnId ?? null,
        itemType: element.dataset.itemType ?? null, top: bounds.top, bottom: bounds.bottom };
    }),
  };
}
