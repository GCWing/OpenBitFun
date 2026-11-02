/**
 * Crop the existing edge-fade mask to the client box when nothing can scroll.
 * Native WebViews can paint a disabled track despite transparent scrollbar
 * styles. Masking its pixels keeps the gutter, row widths and scroll range.
 */
export function syncFlowChatScrollbarMask(scroller: HTMLElement, canScroll: boolean): void {
  const width = canScroll ? 0 : scroller.clientWidth;
  const crop = width > 0 && scroller.clientHeight > 0;
  const size = crop ? `${width}px 100%` : '';
  // clientLeft includes the leading gutter, including a left-side scrollbar.
  const position = crop ? `${scroller.clientLeft}px 0px` : '';

  for (const [property, value] of [
    ['mask-size', size],
    ['-webkit-mask-size', size],
    ['mask-position', position],
    ['-webkit-mask-position', position],
  ]) {
    if (scroller.style.getPropertyValue(property) === value) continue;
    if (value) scroller.style.setProperty(property, value);
    else scroller.style.removeProperty(property);
  }
}
