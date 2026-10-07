import type { ConversationExcerptContext } from '@/shared/types/context';

export const SELECTION_ROOT = '[data-flowchat-selection-root]';
const EXCLUDED = 'button, input, textarea, select, [role="button"], [contenteditable="true"], .monaco-editor, .xterm, [hidden], [inert], [aria-hidden="true"], [data-flowchat-selection-ignore]';
const TEXT_SOURCE = '.user-message-item__content, [data-flow-item-id], [data-tool-card-id]';
const BLOCK = /^(P|DIV|LI|PRE|BLOCKQUOTE|H[1-6]|TR)$/;

export function selectionElement(node: Node | null): Element | null {
  return node?.nodeType === 1 ? node as Element : node?.parentElement ?? null;
}

export function sourceTextNodes(root: HTMLElement): Text[] {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.parentElement?.closest(EXCLUDED)) nodes.push(node);
  }
  return nodes;
}

/** A stable rendered-text coordinate space, including Markdown block boundaries. */
function sourceTextIndex(root: HTMLElement) {
  const entries: { node: Text; start: number }[] = [];
  let text = '';
  let lineBreak = false;
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (!node.textContent) return;
      if (lineBreak && text && !text.endsWith('\n')) text += '\n';
      lineBreak = false;
      entries.push({ node: node as Text, start: text.length });
      text += node.textContent;
    } else if (node instanceof HTMLElement) {
      if (node.matches(EXCLUDED)) return;
      const block = BLOCK.test(node.tagName);
      if (block || node.tagName === 'BR') lineBreak = true;
      node.childNodes.forEach(visit);
      if (block) lineBreak = true;
    }
  };
  root.childNodes.forEach(visit);
  return { entries, text };
}

export function findExcerptSource(root: HTMLElement, fragment: ConversationExcerptContext['fragments'][number]): HTMLElement | null {
  const selector = fragment.flowItemId ? '[data-flow-item-id], [data-tool-card-id]' : '.user-message-item__content';
  const candidates = [...(root.matches(selector) ? [root] : []), ...root.querySelectorAll<HTMLElement>(selector)];
  return candidates.find(node => node.closest('[data-turn-id]')?.getAttribute('data-turn-id') === fragment.turnId
    && (!fragment.flowItemId || node.dataset.flowItemId === fragment.flowItemId || node.dataset.toolCardId === fragment.flowItemId)) ?? null;
}

export interface CapturedFlowChatSelection {
  excerpt: ConversationExcerptContext;
  range: Range;
  anchorNode: Node;
  anchorOffset: number;
  focusNode: Node;
  focusOffset: number;
}

/** Captures rendered text, preserving whitespace and offsets across Markdown inline nodes. */
export function captureFlowChatSelection(
  root: HTMLElement,
  selection: Selection | null,
  source: ConversationExcerptContext['source'],
): CapturedFlowChatSelection | null {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1
    || !selection.anchorNode || !selection.focusNode) return null;
  const range = selection.getRangeAt(0);
  const startElement = selectionElement(range.startContainer);
  const endElement = selectionElement(range.endContainer);
  if (startElement?.closest(SELECTION_ROOT) !== root || endElement?.closest(SELECTION_ROOT) !== root
    || startElement.closest(EXCLUDED) || endElement.closest(EXCLUDED)) return null;

  const sources = new Map<HTMLElement, { index: ReturnType<typeof sourceTextIndex>; start: number; end: number }>();
  for (const node of sourceTextNodes(root)) {
    if (!range.intersectsNode(node) || !node.textContent?.length) continue;
    const owner = node.parentElement?.closest<HTMLElement>(TEXT_SOURCE);
    if (!owner || owner.closest(SELECTION_ROOT) !== root) {
      if (node.textContent.trim()) return null;
      continue;
    }
    const index = sources.get(owner)?.index ?? sourceTextIndex(owner);
    const offset = index.entries.find(entry => entry.node === node)?.start;
    if (offset === undefined) continue;
    if (node !== range.startContainer && range.comparePoint(node, 0) < 0) continue;
    if (node !== range.endContainer && range.comparePoint(node, node.length) > 0) continue;
    const start = offset + (node === range.startContainer ? range.startOffset : 0);
    const end = offset + (node === range.endContainer ? range.endOffset : node.length);
    if (start >= end) continue;
    const previous = sources.get(owner);
    sources.set(owner, { index, start: previous?.start ?? start, end });
  }
  const fragments: ConversationExcerptContext['fragments'] = [];
  for (const [owner, { index, start, end }] of sources) {
    const turnId = owner.closest<HTMLElement>('[data-turn-id]')?.dataset.turnId;
    const text = index.text;
    const selected = text.slice(start, end);
    if (!selected.trim()) continue;
    if (!turnId) return null;
    fragments.push({ turnId,
      flowItemId: owner.dataset.flowItemId || owner.dataset.toolCardId,
      text: selected, start, end,
      prefix: text.slice(Math.max(0, start - 48), start), suffix: text.slice(end, end + 48),
    });
  }
  if (!fragments.length) return null;
  const id = globalThis.crypto?.randomUUID?.() ?? `excerpt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return { excerpt: { id, timestamp: Date.now(), type: 'conversation-excerpt',
    source, fragments }, range: range.cloneRange(),
    anchorNode: selection.anchorNode, anchorOffset: selection.anchorOffset,
    focusNode: selection.focusNode, focusOffset: selection.focusOffset };
}

/** Offset first, then an unambiguous text/context match after a source revision. */
export function resolveExcerptRange(root: HTMLElement, fragment: ConversationExcerptContext['fragments'][number]): Range | null {
  const { entries, text } = sourceTextIndex(root);
  let start = fragment.start;
  if (text.slice(start, fragment.end) !== fragment.text
    || !text.slice(0, start).endsWith(fragment.prefix)
    || !text.slice(fragment.end).startsWith(fragment.suffix)) {
    const needle = fragment.prefix + fragment.text + fragment.suffix;
    const full = text.indexOf(needle);
    if (full >= 0 && text.indexOf(needle, full + 1) < 0) start = full + fragment.prefix.length;
    else {
      start = text.indexOf(fragment.text);
      if (start < 0 || text.indexOf(fragment.text, start + 1) >= 0) return null;
    }
  }
  const end = start + fragment.text.length;
  const range = root.ownerDocument.createRange();
  let began = false;
  for (const { node, start: offset } of entries) {
    if (!began && start < offset + node.length) {
      range.setStart(node, Math.max(0, start - offset));
      began = true;
    }
    if (began && end <= offset + node.length) {
      range.setEnd(node, Math.max(0, end - offset));
      return range;
    }
  }
  return null;
}
