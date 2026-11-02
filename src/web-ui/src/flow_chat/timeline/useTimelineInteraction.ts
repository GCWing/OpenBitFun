import { useEffect, useRef, useState, type RefObject } from 'react';
import type { FlowChatReaderState } from './readerState';

const DISCLOSURE_SELECTOR = '[aria-expanded], summary, [data-openbitfun-expandable="true"]';
const FIELD_SELECTOR = 'input, select, textarea, [contenteditable]:not([contenteditable="false"])';
export type TimelineReaderInteraction = 'disclosure' | 'field' | 'selection';

/** Temporary interaction leases, separate from disclosure and execution state. */
export function useTimelineInteraction(
  scrollerRef: RefObject<HTMLElement | null>, reader: FlowChatReaderState,
  isFollowing: () => boolean,
  rowSelector = '.virtual-item-wrapper[data-virtual-item-key]',
  onReaderInteraction?: (kind: TimelineReaderInteraction) => void,
) {
  const [pinnedKeys, setPinnedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const followingRef = useRef(isFollowing);
  followingRef.current = isFollowing;
  const readerInteractionRef = useRef(onReaderInteraction);
  readerInteractionRef.current = onReaderInteraction;
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const holds = new Map<string, () => void>();
    let lastSelection: { anchor: Node | null; focus: Node | null; start: number; end: number } | null = null;
    const activate = (event: Event) => {
      if (event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      // Stop at the actual control: an action inside an expandable card is
      // not an activation of its ancestor's disclosure.
      const control = target?.closest(`button, [role="button"], a[href], ${DISCLOSURE_SELECTOR}, ${FIELD_SELECTOR}`);
      if (!control?.closest(rowSelector) || !scroller.contains(control)) return;
      // Runtime responses continue the live conversation. They keep whichever
      // intent the viewport already had; submitting must not reclaim a reader.
      // Disclosure is still reading, even inside an active response card.
      if (control.matches(FIELD_SELECTOR)) {
        if (!control.closest('[data-flowchat-interaction="response"]')) readerInteractionRef.current?.('field');
      } else if (control.matches(DISCLOSURE_SELECTOR)
        && (!control.hasAttribute('aria-haspopup') || control.getAttribute('aria-haspopup') === 'false')) {
        readerInteractionRef.current?.('disclosure');
      }
    };
    const keyActivation = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const field = event.target instanceof Element && event.target.closest(FIELD_SELECTOR);
      if (event.key === 'Enter' || event.key === ' '
        || (field && !['Tab', 'Shift', 'Control', 'Alt', 'Meta', 'Escape'].includes(event.key))) activate(event);
    };
    const update = () => {
      if (!scroller.clientHeight || !scroller.clientWidth) return;
      const pinned = new Set<string>();
      const rowFor = (node: Node | null) => {
        const element = node instanceof Element ? node : node?.parentElement;
        const row = element?.closest<HTMLElement>(rowSelector);
        if (row && scroller.contains(row)) pinned.add(row.dataset.virtualItemKey!);
      };
      rowFor(document.activeElement);
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) {
        rowFor(selection.anchorNode); rowFor(selection.focusNode);
        const range = selection.rangeCount ? selection.getRangeAt(0) : undefined;
        // Keep the selected interior as well as its endpoints. Retained rows
        // stay in natural DOM order, so native multi-card copy remains exact.
        if (range) scroller.querySelectorAll<HTMLElement>(rowSelector).forEach(row => {
          if (range.intersectsNode(row)) rowFor(row);
        });
      }
      // Embedded applications keep their live instance after actual interaction.
      // Mere visibility does not acquire an instance lease.
      scroller.querySelectorAll<HTMLElement>('[data-flowchat-retain-instance="true"]').forEach(rowFor);
      setPinnedKeys(previous => previous.size === pinned.size && [...pinned].every(key => previous.has(key)) ? previous : pinned);
      const groups = new Set<string>();
      const bounds = scroller.getBoundingClientRect();
      scroller.querySelectorAll<HTMLElement>('.virtual-item-wrapper[data-timeline-kind="group-members"]').forEach(row => {
        const rect = row.getBoundingClientRect();
        if (pinned.has(row.dataset.virtualItemKey!) || (!followingRef.current() && rect.bottom > bounds.top && rect.top < bounds.bottom)) {
          groups.add(row.dataset.timelineGroupId!);
        }
      });
      for (const [group, release] of holds) if (!groups.has(group)) { release(); holds.delete(group); }
      for (const group of groups) if (!holds.has(group)) holds.set(group, reader.holdGroup(group, 'reader'));
    };
    const selectionChanged = () => {
      const selection = window.getSelection();
      const anchor = selection?.anchorNode;
      const anchorElement = anchor instanceof Element ? anchor : anchor?.parentElement;
      if (selection && !selection.isCollapsed && selection.toString().trim()
        && anchor && scroller.contains(anchor) && !anchorElement?.closest(FIELD_SELECTOR)) {
        if (!lastSelection || lastSelection.anchor !== anchor || lastSelection.focus !== selection.focusNode
          || lastSelection.start !== selection.anchorOffset || lastSelection.end !== selection.focusOffset) {
          readerInteractionRef.current?.('selection');
        }
        lastSelection = { anchor, focus: selection.focusNode, start: selection.anchorOffset, end: selection.focusOffset };
      } else lastSelection = null;
      update();
    };
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      if (scroller.clientHeight && scroller.clientWidth) frame = requestAnimationFrame(update);
    };
    scroller.addEventListener('scroll', schedule, { passive: true });
    // Capture before React changes geometry. Programmatic completion/reveal has
    // no activation event and therefore keeps its existing follow ownership.
    scroller.addEventListener('click', activate, true);
    scroller.addEventListener('keydown', keyActivation, true);
    scroller.addEventListener('input', activate, true);
    scroller.addEventListener('change', activate, true);
    // Autofocus, restoration and keyboard focus all need residency, but focus
    // alone proves no request to stop following. Activation/editing does.
    scroller.addEventListener('focusin', update);
    scroller.addEventListener('focusout', schedule);
    scroller.addEventListener('pointerup', update);
    document.addEventListener('selectionchange', selectionChanged);
    window.addEventListener('resize', schedule);
    const mutations = new MutationObserver(schedule);
    mutations.observe(scroller, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-flowchat-retain-instance'] });
    update();
    return () => {
      cancelAnimationFrame(frame); window.removeEventListener('resize', schedule); mutations.disconnect();
      scroller.removeEventListener('scroll', schedule); scroller.removeEventListener('focusin', update);
      scroller.removeEventListener('click', activate, true); scroller.removeEventListener('keydown', keyActivation, true);
      scroller.removeEventListener('input', activate, true); scroller.removeEventListener('change', activate, true);
      scroller.removeEventListener('focusout', schedule); scroller.removeEventListener('pointerup', update);
      document.removeEventListener('selectionchange', selectionChanged);
      holds.forEach(release => release());
    };
  }, [reader, scrollerRef, rowSelector]);
  return pinnedKeys;
}
