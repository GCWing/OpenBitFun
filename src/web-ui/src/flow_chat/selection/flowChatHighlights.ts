const definitions = {
  excerpt: { name: 'openbitfun-flowchat-excerpt', attribute: 'data-flowchat-highlight-excerpt' },
  annotations: { name: 'openbitfun-flowchat-annotations', attribute: 'data-flowchat-highlight-annotations' },
  'search-match': { name: 'openbitfun-flowchat-search-match', attribute: 'data-flowchat-highlight-search-match' },
  'search-current': { name: 'openbitfun-flowchat-search-current', attribute: 'data-flowchat-highlight-search-current' },
} as const;

type Kind = keyof typeof definitions;
type TextHighlight = Set<Range>;
interface HighlightView {
  CSS?: { highlights?: Map<string, TextHighlight> };
  Highlight?: new (...ranges: Range[]) => TextHighlight;
}
interface State {
  owners: Map<object, readonly Range[]>;
  elements: Map<Element, number>;
  highlight?: TextHighlight;
}
const documents = new WeakMap<Document, Map<Kind, State>>();

function textParents(document: Document, range: Range, parents: Set<Element>): void {
  const add = (node: Node) => {
    const text = node as Text;
    if (!text.length || !range.intersectsNode(text)) return;
    // A boundary at the very edge of a Text node paints no glyphs in that node.
    if (range.startContainer === text && range.startOffset === text.length) return;
    if (range.endContainer === text && range.endOffset === 0) return;
    if (text.parentElement) parents.add(text.parentElement);
  };
  const root = range.commonAncestorContainer;
  if (root.nodeType === Node.TEXT_NODE) add(root);
  else {
    // Walk only the range's common subtree, never the full transcript per frame.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) add(node);
  }
}

/** Own both paint ranges and their exact text-parent scope, separately per document. */
export function createFlowChatHighlightOwner(document: Document, kind: Kind) {
  const owner = {};
  let ownedElements = new Set<Element>();
  let disposed = false;
  let states = documents.get(document);
  if (!states) { states = new Map(); documents.set(document, states); }
  let state = states.get(kind);
  if (!state) { state = { owners: new Map(), elements: new Map() }; states.set(kind, state); }
  const shared = state;
  const { name, attribute } = definitions[kind];
  const publish = () => {
    const view = document.defaultView as (Window & HighlightView) | null;
    const registry = view?.CSS?.highlights;
    const Highlight = view?.Highlight;
    const ranges = registry && Highlight ? [...shared.owners.values()].flat().filter(range => (
      !range.collapsed && range.startContainer.isConnected && range.endContainer.isConnected
      && range.startContainer.ownerDocument === document && range.endContainer.ownerDocument === document
    )) : [];
    if (registry && Highlight && ranges.length) {
      const highlight = new Highlight(...ranges);
      // Preserve the existing search paint order, including engines without priority.
      if (kind === 'search-current') registry.delete(name);
      registry.set(name, highlight);
      shared.highlight = highlight;
    } else {
      if (registry?.get(name) === shared.highlight) registry?.delete(name);
      shared.highlight = undefined;
    }
  };
  const updateElements = (next: Set<Element>) => {
    for (const element of ownedElements) {
      if (next.has(element)) continue;
      const count = (shared.elements.get(element) ?? 1) - 1;
      if (count) shared.elements.set(element, count);
      else { shared.elements.delete(element); element.removeAttribute(attribute); }
    }
    for (const element of next) {
      if (ownedElements.has(element)) continue;
      const count = shared.elements.get(element) ?? 0;
      shared.elements.set(element, count + 1);
      if (!count) element.setAttribute(attribute, '');
    }
    ownedElements = next;
  };
  return {
    update(ranges: readonly Range[]) {
      if (disposed) return;
      const view = document.defaultView as (Window & HighlightView) | null;
      const active = view?.CSS?.highlights && view.Highlight ? ranges.filter(range => (
        !range.collapsed && range.startContainer.isConnected && range.endContainer.isConnected
        && range.startContainer.ownerDocument === document && range.endContainer.ownerDocument === document
      )) : [];
      const elements = new Set<Element>();
      // Only this owner's changed content is walked; other rows keep their scope.
      for (const range of active) textParents(document, range, elements);
      updateElements(elements);
      shared.owners.set(owner, active);
      publish();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      updateElements(new Set());
      shared.owners.delete(owner);
      publish();
    },
  };
}
