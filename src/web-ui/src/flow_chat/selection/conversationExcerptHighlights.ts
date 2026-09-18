type ExcerptHighlight = Set<Range>;
interface HighlightView {
  CSS?: { highlights?: Map<string, ExcerptHighlight> };
  Highlight?: new (...ranges: Range[]) => ExcerptHighlight;
}

const documents = new WeakMap<Document, Map<symbol, readonly Range[]>>();
const name = 'openbitfun-flowchat-annotations';

/** Each mounted transcript row owns only its ranges, including in sibling panes. */
export function createExcerptHighlights(document: Document) {
  const owner = Symbol();
  let owners = documents.get(document);
  if (!owners) { owners = new Map(); documents.set(document, owners); }
  const publish = () => {
    const view = document.defaultView as unknown as HighlightView | null;
    if (!view?.CSS?.highlights || !view.Highlight) return;
    const ranges = [...owners.values()].flat();
    if (ranges.length) view.CSS.highlights.set(name, new view.Highlight(...ranges));
    else view.CSS.highlights.delete(name);
  };
  return {
    update(ranges: readonly Range[]) { owners.set(owner, ranges); publish(); },
    dispose() { owners.delete(owner); publish(); },
  };
}
