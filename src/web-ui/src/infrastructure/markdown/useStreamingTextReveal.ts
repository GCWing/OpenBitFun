import { useLayoutEffect, useRef, type RefObject } from 'react';

export const STREAMING_TEXT_REVEAL_MS = 160;
const LEVELS = 32;
const NAME = 'openbitfun-stream-reveal-';
const ACTIVE_ATTRIBUTE = 'data-stream-reveal-active';
// Several renderer owners may share a text parent; only the last releases it.
const activeElementOwners = new WeakMap<Element, number>();
type TextHighlight = Set<Range>;
type HighlightAPI = {
  CSS?: { highlights?: Map<string, TextHighlight> };
  Highlight?: new (...ranges: Range[]) => TextHighlight;
};
interface Arrival { start: number; end: number; at: number }
interface TextRun { node: Text; start: number; end: number }
interface OwnedRange {
  registry: Map<string, TextHighlight>;
  name: string;
  highlight: TextHighlight;
  range: Range;
}

function pruneEmptyBuckets(entries: OwnedRange[]): void {
  for (const { registry, name, highlight } of entries) {
    if (highlight.size === 0 && registry.get(name) === highlight) registry.delete(name);
  }
}

function readRuns(root: HTMLElement): { runs: TextRun[]; text: string } {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: node => node.parentElement?.closest('button, [aria-hidden="true"], .katex-mathml')
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const runs: TextRun[] = [];
  let text = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const start = text.length;
    text += node.textContent ?? '';
    runs.push({ node: node as Text, start, end: text.length });
  }
  return { runs, text };
}

/**
 * Paint-only arrival treatment, shared by every streaming Markdown surface.
 * Ranges leave React's text nodes, selection, wrapping and virtualizer geometry
 * untouched. Each owner removes only its own ranges from the shared buckets.
 * Existing text on mount (including virtualized remounts) is already settled.
 */
export function useStreamingTextReveal(
  rootRef: RefObject<HTMLDivElement>, source: string, streaming: boolean,
): void {
  const previous = useRef<{ source: string; text: string } | null>(null);
  const arrivals = useRef<Arrival[]>([]);
  const owned = useRef<OwnedRange[]>([]);
  const activeElements = useRef(new Set<Element>());
  const frame = useRef<number | null>(null);
  const frameView = useRef<Window | null>(null);
  const cancelFrame = () => {
    if (frame.current !== null) frameView.current?.cancelAnimationFrame(frame.current);
    frame.current = null;
  };
  const releaseRanges = () => {
    const released = owned.current;
    for (const { highlight, range } of released) highlight.delete(range);
    owned.current = [];
    return released;
  };
  const updateActiveElements = (next: Set<Element>) => {
    for (const element of activeElements.current) {
      if (next.has(element)) continue;
      const owners = (activeElementOwners.get(element) ?? 1) - 1;
      if (owners > 0) activeElementOwners.set(element, owners);
      else {
        activeElementOwners.delete(element);
        element.removeAttribute(ACTIVE_ATTRIBUTE);
      }
    }
    for (const element of next) {
      if (activeElements.current.has(element)) continue;
      const owners = activeElementOwners.get(element) ?? 0;
      activeElementOwners.set(element, owners + 1);
      if (owners === 0) element.setAttribute(ACTIVE_ATTRIBUTE, '');
    }
    activeElements.current = next;
  };
  const stop = () => {
    cancelFrame();
    pruneEmptyBuckets(releaseRanges());
    updateActiveElements(new Set());
  };

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const view = root.ownerDocument.defaultView;
    frameView.current = view;
    const api = view as (Window & HighlightAPI) | null;
    const registry = api?.CSS?.highlights;
    const Highlight = api?.Highlight;
    const before = previous.current;
    // Do not traverse settled history on unrelated renderer updates.
    if (before?.source === source && arrivals.current.length === 0) return;
    const current = readRuns(root);
    previous.current = { source, text: current.text };
    const reduced = view?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!view || !registry || !Highlight || reduced || root.ownerDocument.hidden) {
      stop();
      arrivals.current = [];
      return;
    }
    const appended = before && source.startsWith(before.source) && source.length > before.source.length;
    if (before && (!source.startsWith(before.source) || !current.text.startsWith(before.text))) arrivals.current = [];
    // Reinterpreting Markdown may replace earlier nodes. Never replay those
    // letters; only a genuinely appended visible suffix gets a new arrival.
    if (streaming && appended && current.text.startsWith(before.text)) {
      arrivals.current.push({ start: before.text.length, end: current.text.length, at: view.performance.now() });
    }
    cancelFrame();
    // Resolve ranges once per content commit. Animation frames only move those
    // ranges between paint buckets; they do not walk a long transcript again.
    const resolved = arrivals.current.map(arrival => {
      const ranges: Range[] = [];
      let low = 0;
      let high = current.runs.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (current.runs[middle].end <= arrival.start) low = middle + 1;
        else high = middle;
      }
      for (let index = low; index < current.runs.length; index++) {
        const run = current.runs[index];
        if (run.start >= arrival.end) break;
        const start = Math.max(arrival.start, run.start);
        const end = Math.min(arrival.end, run.end);
        if (start >= end) continue;
        const range = root.ownerDocument.createRange();
        range.setStart(run.node, start - run.start);
        range.setEnd(run.node, end - run.start);
        ranges.push(range);
      }
      return { arrival, ranges };
    });
    const paint = (now: number) => {
      cancelFrame();
      if (!root.isConnected || root.ownerDocument.hidden) {
        stop();
        arrivals.current = [];
        return;
      }
      const released = releaseRanges();
      const nextElements = new Set<Element>();
      arrivals.current = arrivals.current.filter(arrival => now - arrival.at < STREAMING_TEXT_REVEAL_MS);
      for (const { arrival, ranges } of resolved) {
        if (now - arrival.at >= STREAMING_TEXT_REVEAL_MS) continue;
        const progress = Math.max(0, (now - arrival.at) / STREAMING_TEXT_REVEAL_MS);
        const level = Math.min(LEVELS - 1, Math.floor((1 - (1 - progress) ** 2) * LEVELS));
        const name = `${NAME}${level}`;
        let highlight = registry.get(name);
        if (!highlight) {
          highlight = new Highlight();
          registry.set(name, highlight);
        }
        for (const range of ranges) {
          const parent = range.startContainer.parentElement;
          if (!parent || !root.contains(parent)) continue;
          highlight.add(range);
          owned.current.push({ registry, name, highlight, range });
          nextElements.add(parent);
        }
        if (highlight.size === 0 && registry.get(name) === highlight) registry.delete(name);
      }
      // Keep scope stable across frames/batches. Only actual arriving text
      // parents get the 32 pseudo styles, never the whole transcript. Global
      // Local desktop trace: this scope reduced two opening style updates from
      // 128.3/223.3 ms to 45.4/61.4 ms, and pre-reveal style work from 451.5 ms
      // to 172.4 ms. Overall opening latency still includes other work.
      updateActiveElements(nextElements);
      // Prune after adding the new frame, preserving shared buckets still in use.
      pruneEmptyBuckets(released);
      if (arrivals.current.length) frame.current = view.requestAnimationFrame(paint);
    };
    // Layout timing styles newly committed glyphs before their first paint.
    paint(view.performance.now());
  }, [source, streaming, rootRef]);

  useLayoutEffect(() => {
    const document = rootRef.current?.ownerDocument;
    const media = document?.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)');
    const clear = () => { stop(); arrivals.current = []; };
    const onPreference = () => { if (media?.matches) clear(); };
    const onVisibility = () => { if (document?.hidden) clear(); };
    media?.addEventListener?.('change', onPreference);
    document?.addEventListener('visibilitychange', onVisibility);
    return () => {
      clear();
      media?.removeEventListener?.('change', onPreference);
      document?.removeEventListener('visibilitychange', onVisibility);
    };
  }, [rootRef]);
}
