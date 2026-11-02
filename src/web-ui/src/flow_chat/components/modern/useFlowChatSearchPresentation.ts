import { useLayoutEffect, useState } from 'react';
import { createFlowChatSearchHighlightOwner } from './flowChatSearchDom';
import {
  measureFlowChatFocusItem,
  measureFlowChatSearchLine,
  resolveFlowChatSearchPresentation,
  type FlowChatSearchLineBox,
  type FlowChatFocusBox,
} from './flowChatSearchPresentation';
import type { SearchMatch } from './useFlowChatSearch';

const FOCUS_LINE_EVENT = 'flowchat:focus-line';
interface FocusLineRequest { element: HTMLElement; active: boolean; id: symbol }
type PresentationBox = FlowChatSearchLineBox | FlowChatFocusBox;

/** Passive item navigation feedback; never changes the measured row geometry. */
export function highlightFlowChatFocusTarget(element: HTMLElement): () => void {
  const wrapper = element.closest<HTMLElement>('.virtual-item-wrapper');
  if (!wrapper) return () => {};
  const id = Symbol('item-focus');
  const publish = (active: boolean) => wrapper.dispatchEvent(new CustomEvent<FocusLineRequest>(
    FOCUS_LINE_EVENT, { detail: { element, active, id } },
  ));
  publish(true);
  const timer = window.setTimeout(() => publish(false), 1600);
  const clear = () => { window.clearTimeout(timer); publish(false); };
  return clear;
}

function sameLine(a: PresentationBox | null, b: PresentationBox | null): boolean {
  return a === b || Boolean(a && b
    && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height
    && ('markerTop' in a ? 'markerTop' in b && a.markerTop === b.markerTop
      && a.markerLeft === b.markerLeft && a.markerHeight === b.markerHeight : !('markerTop' in b)));
}

/** Passive row presentation. It never scrolls, expands content, or reserves space. */
export function useFlowChatSearchPresentation(
  wrapper: HTMLElement | null,
  query: string | undefined,
  matches: readonly SearchMatch[] | undefined,
  currentMatch: SearchMatch | undefined,
): PresentationBox | null {
  const [line, setLine] = useState<PresentationBox | null>(null);
  const [focus, setFocus] = useState<FocusLineRequest | null>(null);
  const focusSource = focus?.element;

  useLayoutEffect(() => {
    if (!wrapper) return;
    const handleFocus = (event: Event) => {
      const request = (event as CustomEvent<FocusLineRequest>).detail;
      const { element, active, id } = request;
      if (active && !wrapper.contains(element)) return;
      setFocus(previous => active ? request : previous?.id === id ? null : previous);
    };
    wrapper.addEventListener(FOCUS_LINE_EVENT, handleFocus);
    return () => wrapper.removeEventListener(FOCUS_LINE_EVENT, handleFocus);
  }, [wrapper]);

  useLayoutEffect(() => {
    const hasSearch = Boolean(query?.trim() && matches?.length);
    if (!wrapper || (!hasSearch && !focusSource)) {
      setLine(previous => previous === null ? previous : null);
      return;
    }
    const view = wrapper.ownerDocument.defaultView;
    if (!view) return;
    const owner = createFlowChatSearchHighlightOwner(wrapper.ownerDocument);
    let frame: number | null = null;
    const refresh = () => {
      frame = null;
      const { currentRange, currentRoot, otherRanges } = resolveFlowChatSearchPresentation(
        wrapper, query ?? '', matches ?? [], currentMatch,
      );
      owner.update(currentRange, otherRanges);
      const next = focusSource && wrapper.contains(focusSource)
        ? measureFlowChatFocusItem(wrapper, focusSource)
        : currentRange && currentRoot ? measureFlowChatSearchLine(wrapper, currentRoot, currentRange) : null;
      setLine(previous => sameLine(previous, next) ? previous : next);
    };
    const scheduleRefresh = () => {
      if (frame === null) frame = view.requestAnimationFrame(refresh);
    };
    const observer = new MutationObserver(records => {
      // Our marker's geometry must not trigger another presentation update.
      if (records.some(record => !(record.target instanceof Element)
        || !record.target.closest('[data-openbitfun-part="searchLine"]'))) scheduleRefresh();
    });
    observer.observe(wrapper, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'open', 'data-expanded'],
    });
    const resize = new ResizeObserver(scheduleRefresh);
    resize.observe(wrapper);
    wrapper.addEventListener('scroll', scheduleRefresh, { capture: true, passive: true });
    wrapper.ownerDocument.fonts?.addEventListener('loadingdone', scheduleRefresh);
    refresh();

    return () => {
      if (frame !== null) view.cancelAnimationFrame(frame);
      observer.disconnect();
      resize.disconnect();
      wrapper.removeEventListener('scroll', scheduleRefresh, true);
      wrapper.ownerDocument.fonts?.removeEventListener('loadingdone', scheduleRefresh);
      owner.dispose();
    };
  }, [wrapper, query, matches, currentMatch, focusSource]);

  return currentMatch || focusSource ? line : null;
}
