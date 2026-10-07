import { DEFAULT_POPOVER_VIEWPORT_PADDING, type FixedPopoverPlacement } from '@/shared/utils/fixedPopoverViewport';
import { selectionElement, sourceTextNodes, type CapturedFlowChatSelection } from './flowChatSelection';

type Rect = Pick<DOMRectReadOnly, 'left' | 'right' | 'top' | 'bottom'>;
type SelectionEndpoints = Pick<Selection, 'anchorNode' | 'anchorOffset' | 'focusNode' | 'focusOffset'>;
export interface SelectionBarAnchor {
  x: number;
  top: number;
  bottom: number;
  preferredPlacement: FixedPopoverPlacement;
}
export interface SelectionBarGeometry {
  anchor: SelectionBarAnchor;
  bounds: Rect;
  textRects: readonly Rect[];
}
export interface SelectionBarPosition {
  left: number;
  top: number;
  placement: FixedPopoverPlacement;
}

const GAP = 8;
const overlaps = (a: Rect, b: Rect) => a.left < b.right && a.right > b.left
  && a.top < b.bottom && a.bottom > b.top;
const sameLine = (a: Rect, b: Rect) => a.top < b.bottom && a.bottom > b.top;

export function sameFlowChatSelection(a: SelectionEndpoints | null, b: SelectionEndpoints | null): boolean {
  return !!a && !!b && a.anchorNode === b.anchorNode && a.anchorOffset === b.anchorOffset
    && a.focusNode === b.focusNode && a.focusOffset === b.focusOffset;
}

/** A toolbar may flip once when opening, but never cover the quote or detach to a viewport edge. */
export function computeSelectionBarPosition({ anchor, bounds, textRects }: SelectionBarGeometry,
  size: { width: number; height: number }, lockedPlacement?: FixedPopoverPlacement): SelectionBarPosition | null {
  const padding = DEFAULT_POPOVER_VIEWPORT_PADDING;
  if (size.width <= 0 || size.height <= 0 || size.width > bounds.right - bounds.left - padding * 2
    || anchor.top < bounds.top || anchor.bottom > bounds.bottom) return null;
  const left = Math.max(bounds.left + padding,
    Math.min(anchor.x - size.width / 2, bounds.right - padding - size.width));
  const placements = lockedPlacement ? [lockedPlacement]
    : [anchor.preferredPlacement, anchor.preferredPlacement === 'top' ? 'bottom' : 'top'] as const;
  for (const placement of placements) {
    const top = placement === 'top' ? anchor.top - GAP - size.height : anchor.bottom + GAP;
    const rect = { left, top, right: left + size.width, bottom: top + size.height };
    if (top >= bounds.top + padding && rect.bottom <= bounds.bottom - padding
      && !textRects.some(text => overlaps(rect, text))) return { left, top, placement };
  }
  return null;
}

/** Text runs exclude the full-width element boxes returned by Range.getClientRects(). */
function selectedTextRects(range: Range): DOMRect[] {
  const element = selectionElement(range.commonAncestorContainer);
  if (!(element instanceof HTMLElement)) return [];
  return sourceTextNodes(element).flatMap(node => {
    if (!range.intersectsNode(node)) return [];
    const text = node.ownerDocument.createRange();
    text.selectNodeContents(node);
    if (range.compareBoundaryPoints(Range.START_TO_START, text) > 0) {
      text.setStart(range.startContainer, range.startOffset);
    }
    if (range.compareBoundaryPoints(Range.END_TO_END, text) < 0) {
      text.setEnd(range.endContainer, range.endOffset);
    }
    return [...text.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
  });
}

/** The primary transcript declares its input occlusion; embedded transcripts use their own root. */
function getSelectionViewport(root: HTMLElement, node: Node): HTMLElement {
  const scroller = selectionElement(node)?.closest<HTMLElement>('[data-flowchat-scroller]');
  return scroller && root.contains(scroller) ? scroller : root;
}

function clipToAncestors(bounds: Rect, element: Element | null, view: Window, stop?: Element): Rect | null {
  const visible = { ...bounds };
  for (let parent = element; parent && parent !== stop; parent = parent.parentElement) {
    const style = view.getComputedStyle(parent);
    if (style.visibility === 'hidden' || style.display === 'none') return null;
    const rect = parent.getBoundingClientRect();
    if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
      visible.left = Math.max(visible.left, rect.left);
      visible.right = Math.min(visible.right, rect.right);
    }
    if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
      visible.top = Math.max(visible.top, rect.top);
      visible.bottom = Math.min(visible.bottom, rect.bottom);
    }
  }
  return visible.right > visible.left && visible.bottom > visible.top ? visible : null;
}

export function measureSelectionBarGeometry(root: HTMLElement, selection: CapturedFlowChatSelection): SelectionBarGeometry | null {
  const { range, focusNode, focusOffset, anchorNode } = selection;
  const view = root.ownerDocument.defaultView;
  if (!view || !root.contains(focusNode) || !root.contains(anchorNode)) return null;
  const textRects = selectedTextRects(range);
  if (!textRects.length) return null;

  // Selection keeps gesture direction; Range always normalizes it to document order.
  const caret = root.ownerDocument.createRange();
  const focusLength = focusNode.nodeType === Node.TEXT_NODE ? focusNode.textContent!.length : focusNode.childNodes.length;
  if (focusOffset > focusLength) return null;
  caret.setStart(focusNode, focusOffset);
  caret.collapse(true);
  const backward = caret.compareBoundaryPoints(Range.START_TO_START, range) === 0;
  const endpoint = backward ? textRects[0] : textRects[textRects.length - 1];
  // At a soft wrap the caret may report two lines. Keep the line containing selected text.
  const caretRect = [...caret.getClientRects()].find(rect => rect.height > 0 && sameLine(rect, endpoint));
  const rtl = view.getComputedStyle(selectionElement(focusNode)!).direction === 'rtl';
  const x = caretRect?.left ?? (backward !== rtl ? endpoint.left : endpoint.right);
  const line = textRects.filter(rect => sameLine(rect, endpoint));
  const top = Math.min(...line.map(rect => rect.top));
  const bottom = Math.max(...line.map(rect => rect.bottom));
  const multiline = textRects.some(rect => !sameLine(rect, endpoint));
  const anchor: SelectionBarAnchor = { x, top, bottom, preferredPlacement: multiline && !backward ? 'bottom' : 'top' };

  const viewport = getSelectionViewport(root, focusNode);
  const pane = viewport.getBoundingClientRect();
  const visual = view.visualViewport;
  const inset = Math.max(0, Number(viewport.dataset.openbitfunViewportInsetBottom) || 0);
  const bounds = clipToAncestors({
    left: Math.max(pane.left, visual?.offsetLeft ?? 0),
    right: Math.min(pane.right, (visual?.offsetLeft ?? 0) + (visual?.width ?? view.innerWidth)),
    top: Math.max(pane.top, visual?.offsetTop ?? 0),
    bottom: Math.min(pane.bottom - inset, (visual?.offsetTop ?? 0) + (visual?.height ?? view.innerHeight)),
  }, viewport, view);
  // The selected line owns visibility, not the caret's horizontal position: a
  // drag may finish in either reading-column gutter while its text stays visible.
  const visible = bounds && clipToAncestors(bounds, selectionElement(focusNode), view, viewport);
  if (!bounds || !visible || top < visible.top || bottom > visible.bottom
    || !line.some(rect => rect.left < visible.right && rect.right > visible.left)) return null;
  anchor.x = Math.max(visible.left, Math.min(x, visible.right));
  return { anchor, bounds, textRects };
}

/** Layout changes retire a transient toolbar instead of moving the target under the pointer. */
export function sameSelectionBarAnchor(a: SelectionBarGeometry, b: SelectionBarGeometry): boolean {
  return a.anchor.x === b.anchor.x && a.anchor.top === b.anchor.top && a.anchor.bottom === b.anchor.bottom
    && a.bounds.left === b.bounds.left && a.bounds.right === b.bounds.right
    && a.bounds.top === b.bounds.top && a.bounds.bottom === b.bounds.bottom;
}
