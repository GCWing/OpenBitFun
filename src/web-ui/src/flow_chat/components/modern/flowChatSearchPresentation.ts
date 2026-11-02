import {
  findFlowChatFocusTextRange,
  findFlowChatSearchTextRanges,
  getFlowChatSearchTextRoot,
} from './flowChatSearchDom';
import type { SearchMatch } from './useFlowChatSearch';

export interface FlowChatSearchLineBox {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface FlowChatFocusBox extends FlowChatSearchLineBox {
  markerTop: number;
  markerLeft: number;
  markerHeight: number;
}

/** Item navigation covers the whole item; its short marker follows the leading icon. */
export function measureFlowChatFocusItem(wrapper: HTMLElement, source: HTMLElement): FlowChatFocusBox | null {
  const item = source.closest<HTMLElement>('[data-flow-item-id], [data-tool-card-id], .user-message-item') ?? source;
  if (!wrapper.contains(item)) return null;
  const itemRect = item.getBoundingClientRect();
  if (itemRect.width <= 0 || itemRect.height <= 0) return null;
  const icon = item.querySelector<HTMLElement>('[data-openbitfun-component="flow-chat-tool-card"][data-openbitfun-part="icon"]');
  const iconRect = icon?.getBoundingClientRect();
  const visibleIcon = iconRect && iconRect.width > 0 && iconRect.height > 0 ? iconRect : undefined;
  const leading = visibleIcon ?? Array.from(findFlowChatFocusTextRange(source)?.getClientRects() ?? [])
    .find(rect => rect.width > 0 && rect.height > 0) ?? itemRect;
  const wrapperRect = wrapper.getBoundingClientRect();
  // Tool icons can sit in the reading gutter, outside the item's text bounds.
  const left = Math.min(itemRect.left, leading.left);
  const right = Math.max(itemRect.right, leading.right);
  const top = Math.min(itemRect.top, leading.top);
  const bottom = Math.max(itemRect.bottom, leading.bottom);
  return {
    top: top - wrapperRect.top, left: left - wrapperRect.left, width: right - left, height: bottom - top,
    markerTop: leading.top - top, markerLeft: visibleIcon ? leading.left - left : 0, markerHeight: leading.height,
  };
}

type Rect = Pick<DOMRectReadOnly, 'top' | 'bottom' | 'left' | 'right' | 'width' | 'height'>;

interface SearchPresentation {
  currentRange: Range | null;
  currentRoot: HTMLElement | null;
  otherRanges: Range[];
}

/** Match sources come from search state; rendered controls are not new sources. */
export function resolveFlowChatSearchPresentation(
  wrapper: HTMLElement,
  query: string,
  matches: readonly SearchMatch[],
  currentMatch?: SearchMatch,
): SearchPresentation {
  const visited = new Set<string | undefined>();
  const otherRanges: Range[] = [];
  let currentRange: Range | null = null;
  let currentRoot: HTMLElement | null = null;

  for (const match of matches) {
    if (visited.has(match.flowItemId)) continue;
    visited.add(match.flowItemId);
    const root = getFlowChatSearchTextRoot(wrapper, match.flowItemId);
    if (!root) continue;

    const ranges = findFlowChatSearchTextRanges(root, query);
    const currentIndex = currentMatch && currentMatch.flowItemId === match.flowItemId
      ? Math.min(currentMatch.occurrenceIndex, ranges.length - 1)
      : -1;
    ranges.forEach((range, index) => {
      if (index === currentIndex) {
        currentRange = range;
        currentRoot = root;
      } else {
        otherRanges.push(range);
      }
    });
  }

  return { currentRange, currentRoot, otherRanges };
}

/** A single line in row-local coordinates; clipping never grows into a block. */
export function computeFlowChatSearchLineBox(
  wrapper: Rect,
  source: Rect,
  fragments: readonly Rect[],
  lineHeight: number,
): FlowChatSearchLineBox | null {
  const firstFragment = fragments.find(rect => rect.width > 0 && rect.height > 0);
  if (!firstFragment || firstFragment.bottom <= source.top || firstFragment.top >= source.bottom
    || firstFragment.right <= source.left || firstFragment.left >= source.right) return null;

  const height = Math.max(firstFragment.height, Number.isFinite(lineHeight) ? lineHeight : 0);
  const lineTop = firstFragment.top - (height - firstFragment.height) / 2;
  const top = Math.max(wrapper.top, source.top, lineTop);
  const bottom = Math.min(wrapper.bottom, source.bottom, lineTop + height);
  const left = Math.max(wrapper.left, source.left);
  const right = Math.min(wrapper.right, source.right);
  if (bottom <= top || right <= left) return null;

  return { top: top - wrapper.top, left: left - wrapper.left, width: right - left, height: bottom - top };
}

export function measureFlowChatSearchLine(
  wrapper: HTMLElement,
  source: HTMLElement,
  range: Range,
): FlowChatSearchLineBox | null {
  const fragments = Array.from(range.getClientRects());
  const parent = range.startContainer.parentElement;
  const view = wrapper.ownerDocument.defaultView;
  if (!fragments.length || !parent || !view) return null;

  // Nested code/thinking scroll areas and collapsed messages may clip a hit.
  const sourceRect = source.getBoundingClientRect();
  const visible = {
    top: sourceRect.top,
    bottom: sourceRect.bottom,
    left: sourceRect.left,
    right: sourceRect.right,
    width: sourceRect.width,
    height: sourceRect.height,
  };
  for (let element: HTMLElement | null = parent; element && element !== wrapper; element = element.parentElement) {
    const style = view.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
      visible.top = Math.max(visible.top, rect.top);
      visible.bottom = Math.min(visible.bottom, rect.bottom);
    }
    if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
      visible.left = Math.max(visible.left, rect.left);
      visible.right = Math.min(visible.right, rect.right);
    }
  }

  return computeFlowChatSearchLineBox(
    wrapper.getBoundingClientRect(),
    visible,
    fragments,
    Number.parseFloat(view.getComputedStyle(parent).lineHeight),
  );
}
