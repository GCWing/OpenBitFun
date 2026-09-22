import { createFlowChatHighlightOwner } from '../../selection/flowChatHighlights';

interface FoldedTextOffset {
  start: number;
  end: number;
}

function isSearchableTextNode(node: Node): node is Text {
  if (node.nodeType !== Node.TEXT_NODE || !node.textContent) {
    return false;
  }

  const parent = node.parentElement;
  if (!parent) {
    return false;
  }

  return !parent.closest('script, style, button, input, textarea, [contenteditable="true"], [hidden], [aria-hidden="true"]');
}

function foldTextWithOriginalOffsets(text: string): {
  text: string;
  offsets: FoldedTextOffset[];
} {
  // Built from the same per-character foldings the offsets are built from.
  // Lowercasing the whole string separately is not guaranteed to produce the
  // same length as concatenating per-character results, and any divergence
  // leaves holes in `offsets` — the lookup then returns undefined and a real
  // match is silently dropped.
  const foldedParts: string[] = [];
  const offsets: FoldedTextOffset[] = [];
  let originalOffset = 0;
  let foldedOffset = 0;

  for (const character of text) {
    const start = originalOffset;
    originalOffset += character.length;
    const folded = character.toLowerCase();
    foldedParts.push(folded);

    for (let index = 0; index < folded.length; index += 1) {
      offsets[foldedOffset + index] = {
        start,
        end: originalOffset,
      };
    }
    foldedOffset += folded.length;
  }

  return {
    text: foldedParts.join(''),
    offsets,
  };
}

/**
 * Finds every non-overlapping case-insensitive occurrence of the query, even
 * when Markdown splits it across adjacent text nodes (for example, around
 * inline emphasis or code spans). Ranges are returned in document order.
 */
export function findFlowChatSearchTextRanges(root: HTMLElement, query: string): Range[] {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return [];
  }

  const ownerDocument = root.ownerDocument;
  const walker = ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Array<{ node: Text; start: number; end: number }> = [];
  let combinedText = '';
  let currentNode = walker.nextNode();

  while (currentNode) {
    if (isSearchableTextNode(currentNode)) {
      const start = combinedText.length;
      combinedText += currentNode.textContent;
      textNodes.push({
        node: currentNode,
        start,
        end: combinedText.length,
      });
    }
    currentNode = walker.nextNode();
  }

  const folded = foldTextWithOriginalOffsets(combinedText);
  const foldedQuery = trimmedQuery.toLowerCase();
  const ranges: Range[] = [];
  let searchFrom = 0;

  for (;;) {
    const foldedMatchStart = folded.text.indexOf(foldedQuery, searchFrom);
    if (foldedMatchStart < 0) {
      return ranges;
    }
    searchFrom = foldedMatchStart + foldedQuery.length;

    const foldedMatchEnd = foldedMatchStart + foldedQuery.length;
    const matchStart = folded.offsets[foldedMatchStart]?.start;
    const matchEnd = folded.offsets[foldedMatchEnd - 1]?.end;
    if (matchStart === undefined || matchEnd === undefined) {
      continue;
    }

    const startEntry = textNodes.find(entry => matchStart >= entry.start && matchStart < entry.end);
    const endEntry = textNodes.find(entry => matchEnd > entry.start && matchEnd <= entry.end);
    if (!startEntry || !endEntry) {
      continue;
    }

    const range = ownerDocument.createRange();
    range.setStart(startEntry.node, matchStart - startEntry.start);
    range.setEnd(endEntry.node, matchEnd - endEntry.start);
    ranges.push(range);
  }
}

export function findFlowChatSearchTextRange(root: HTMLElement, query: string): Range | null {
  return findFlowChatSearchTextRanges(root, query)[0] ?? null;
}

/** Each mounted row releases only its own ranges, including across chat panes. */
export function createFlowChatSearchHighlightOwner(ownerDocument: Document) {
  const currentOwner = createFlowChatHighlightOwner(ownerDocument, 'search-current');
  const matchOwner = createFlowChatHighlightOwner(ownerDocument, 'search-match');
  return {
    update(current: Range | null, matches: readonly Range[]) {
      matchOwner.update(matches);
      currentOwner.update(current ? [current] : []);
    },
    dispose() {
      currentOwner.dispose();
      matchOwner.dispose();
    },
  };
}

export function findElementWithDataValue(
  root: HTMLElement,
  attributeName: 'data-flow-item-id' | 'data-tool-card-id',
  value: string,
): HTMLElement | null {
  return Array.from(root.querySelectorAll<HTMLElement>(`[${attributeName}]`))
    .find(element => element.getAttribute(attributeName) === value) ?? null;
}

export function getFlowChatSearchTextRoot(
  wrapper: HTMLElement,
  flowItemId?: string,
): HTMLElement | null {
  if (flowItemId) {
    const flowItem = findElementWithDataValue(wrapper, 'data-flow-item-id', flowItemId);
    if (flowItem) {
      return flowItem;
    }

    const thinkingItem = findElementWithDataValue(wrapper, 'data-tool-card-id', flowItemId);
    const thinkingText = thinkingItem?.querySelector<HTMLElement>('.thinking-markdown');
    if (thinkingText) {
      return thinkingText;
    }

    // A collapsed or unmounted source must not highlight unrelated card labels.
    return null;
  }

  return wrapper.querySelector<HTMLElement>('.user-message-item__content') ?? wrapper;
}
