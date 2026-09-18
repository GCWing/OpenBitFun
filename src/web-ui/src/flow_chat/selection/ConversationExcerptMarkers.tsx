import { useLayoutEffect, useRef, useState } from 'react';
import type { ConversationExcerptContext } from '@/shared/types/context';
import { excerptNumber } from '@/shared/utils/conversationExcerpt';
import { findExcerptSource, resolveExcerptRange } from './flowChatSelection';
import { useConversationExcerptSources } from './conversationExcerptSourceContext';
import { ConversationExcerptPreview } from './ConversationExcerptAttachments';
import { measureExcerptMarkerPosition, type ExcerptMarkerPosition } from './conversationExcerptMarkerPosition';
import { createExcerptHighlights } from './conversationExcerptHighlights';

interface MarkerGroup {
  key: string;
  element: HTMLElement;
  range: Range;
  excerpts: readonly ConversationExcerptContext[];
}

/** Row-local overlays: annotation marks never modify transcript text or row height. */
export function ConversationExcerptMarkers({ wrapper, turnId }: { wrapper: HTMLElement | null; turnId: string }) {
  const excerpts = useConversationExcerptSources(turnId);
  const [groups, setGroups] = useState<MarkerGroup[]>([]);
  const markerRefs = useRef(new Map<string, HTMLElement>());
  const [positions, setPositions] = useState(new Map<string, ExcerptMarkerPosition>());
  useLayoutEffect(() => {
    if (!wrapper || !excerpts.length) { setGroups(previous => previous.length ? [] : previous); return; }
    const view = wrapper.ownerDocument.defaultView;
    if (!view) return;
    const highlights = createExcerptHighlights(wrapper.ownerDocument);
    let frame: number | null = null;
    const refresh = () => {
      frame = null;
      const next = new Map<string, MarkerGroup>();
      const ranges: Range[] = [];
      for (const excerpt of excerpts) {
        for (const fragment of excerpt.fragments) {
          if (fragment.turnId !== turnId) continue;
          const element = findExcerptSource(wrapper, fragment);
          const range = element && resolveExcerptRange(element, fragment);
          if (range) ranges.push(range);
          if (!excerptNumber(excerpt)) continue;
          if (!element || !range) continue;
          // Separate selections in one text block keep their own superscripts.
          const key = JSON.stringify([fragment.flowItemId ?? null, fragment.start, fragment.end]);
          const previous = next.get(key);
          if (previous) {
            if (!previous.excerpts.some(item => item.id === excerpt.id)) previous.excerpts = [...previous.excerpts, excerpt];
          } else next.set(key, {
            key, element, range, excerpts: [excerpt],
          });
        }
      }
      highlights.update(ranges);
      setGroups([...next.values()]);
    };
    const schedule = () => { if (frame === null) frame = view.requestAnimationFrame(refresh); };
    const mutation = new MutationObserver(records => {
      if (records.some(record => {
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        return !target?.closest('[data-openbitfun-product-part="markers"]');
      })) schedule();
    });
    mutation.observe(wrapper, { childList: true, characterData: true, subtree: true, attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'open', 'data-expanded'] });
    const resize = new ResizeObserver(schedule);
    resize.observe(wrapper);
    wrapper.ownerDocument.addEventListener('scroll', schedule, { capture: true, passive: true });
    wrapper.ownerDocument.fonts?.addEventListener('loadingdone', schedule);
    refresh();
    return () => {
      highlights.dispose();
      if (frame !== null) view.cancelAnimationFrame(frame);
      mutation.disconnect(); resize.disconnect();
      wrapper.ownerDocument.removeEventListener('scroll', schedule, true);
      wrapper.ownerDocument.fonts?.removeEventListener('loadingdone', schedule);
    };
  }, [wrapper, excerpts, turnId]);

  useLayoutEffect(() => {
    if (!wrapper) return;
    const update = () => {
      const next = new Map<string, ExcerptMarkerPosition>();
      for (const group of groups) {
        const marker = markerRefs.current.get(group.key);
        if (!marker) continue;
        const size = marker.getBoundingClientRect();
        const position = measureExcerptMarkerPosition(wrapper, group.element, group.range, size);
        if (!position) continue;
        next.set(group.key, position);
      }
      setPositions(previous => previous.size === next.size && [...next].every(([key, value]) =>
        previous.get(key)?.left === value.left && previous.get(key)?.top === value.top) ? previous : next);
    };
    update();
    const resize = new ResizeObserver(update);
    markerRefs.current.forEach(marker => resize.observe(marker));
    return () => resize.disconnect();
  }, [wrapper, groups]);

  return <>{groups.map(group => (
    <sup key={group.key}
      ref={element => { if (element) markerRefs.current.set(group.key, element); else markerRefs.current.delete(group.key); }}
      data-openbitfun-product-component="conversation-excerpt" data-openbitfun-product-part="markers"
      className="conversation-excerpt__markers" data-flowchat-selection-ignore="true"
      style={{ left: positions.get(group.key)?.left ?? 0, top: positions.get(group.key)?.top ?? 0,
        visibility: positions.has(group.key) ? 'visible' : 'hidden' }}>
      {group.excerpts.map(excerpt => <ConversationExcerptPreview key={excerpt.id} excerpt={excerpt} superscript origin="source" />)}
    </sup>
  ))}</>;
}
