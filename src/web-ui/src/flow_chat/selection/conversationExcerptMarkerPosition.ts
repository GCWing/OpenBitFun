import { sourceTextNodes } from './flowChatSelection';

type Rect = Pick<DOMRectReadOnly, 'top' | 'bottom' | 'left' | 'right' | 'width' | 'height'>;
export interface ExcerptMarkerPosition { left: number; top: number }
export interface ExcerptMarkerSize { width: number; height: number }
const CORNER_OVERLAP = 6;

/** Keep the badge attached to the selection's upper-right corner. */
export function computeExcerptMarkerPosition(wrapper: Rect, selection: Rect, visible: Rect,
  size: ExcerptMarkerSize): ExcerptMarkerPosition | null {
  if (selection.width <= 0 || selection.height <= 0 || size.width <= 0 || size.height <= 0
    || selection.bottom <= visible.top || selection.top >= visible.bottom
    || selection.right <= visible.left || selection.left >= visible.right) return null;
  const maxLeft = visible.right - size.width;
  const maxTop = visible.bottom - size.height;
  if (maxLeft < visible.left || maxTop < visible.top) return null;
  const left = Math.max(visible.left, Math.min(selection.right - CORNER_OVERLAP, maxLeft));
  const top = Math.max(visible.top, Math.min(selection.top - size.height + CORNER_OVERLAP, maxTop));
  return { left: left - wrapper.left, top: top - wrapper.top };
}

export function measureExcerptMarkerPosition(wrapper: HTMLElement, source: HTMLElement, range: Range,
  size: ExcerptMarkerSize): ExcerptMarkerPosition | null {
  const view = wrapper.ownerDocument.defaultView;
  if (!view) return null;
  // Range rectangles can include full-width list/block boxes. Measure selected
  // text runs only so whitespace after a wrapped line cannot push the badge away.
  const rects = sourceTextNodes(source).flatMap(node => {
    if (!range.intersectsNode(node)) return [];
    const text = source.ownerDocument.createRange();
    text.setStart(node, node === range.startContainer ? range.startOffset : 0);
    text.setEnd(node, node === range.endContainer ? range.endOffset : node.length);
    return [...text.getClientRects()];
  }).filter(rect => rect.width > 0 && rect.height > 0);
  if (!rects.length) return null;
  const selection = {
    left: Math.min(...rects.map(rect => rect.left)), right: Math.max(...rects.map(rect => rect.right)),
    top: Math.min(...rects.map(rect => rect.top)), bottom: Math.max(...rects.map(rect => rect.bottom)),
  };
  const bounds = wrapper.getBoundingClientRect();
  const visible = { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom,
    width: bounds.width, height: bounds.height };
  // Clipping belongs to ancestors, not the text block's box (the badge sits outside it).
  for (let element: HTMLElement | null = source; element; element = element.parentElement) {
    const style = view.getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none') return null;
    const rect = element.getBoundingClientRect();
    if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
      visible.top = Math.max(visible.top, rect.top); visible.bottom = Math.min(visible.bottom, rect.bottom);
    }
    if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
      visible.left = Math.max(visible.left, rect.left); visible.right = Math.min(visible.right, rect.right);
    }
  }
  return computeExcerptMarkerPosition(bounds,
    { ...selection, width: selection.right - selection.left, height: selection.bottom - selection.top }, visible, size);
}
