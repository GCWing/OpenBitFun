import { useLayoutEffect, useRef, type HTMLAttributes, type SyntheticEvent } from 'react';
import { isTabbable } from 'tabbable';

type Props = HTMLAttributes<HTMLDivElement> & { opening: boolean };

/** Keeps the measurable transcript unavailable without changing inherited DOM state. */
export function FlowChatOpeningBoundary({ opening, children, ...props }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const beforeRef = useRef<HTMLSpanElement>(null);
  const afterRef = useRef<HTMLSpanElement>(null);
  const outsideFocusRef = useRef<Element | null>(null);
  const directionRef = useRef<1 | -1 | null>(null);
  const redirectingRef = useRef(false);

  const skipTranscript = (direction: 1 | -1) => {
    const boundary = direction === 1 ? afterRef.current : beforeRef.current;
    if (!boundary) return;
    const doc = boundary.ownerDocument;
    const candidates: HTMLElement[] = [];
    // Prune opening transcripts before checking visibility. Never measure their
    // descendants while finding a destination for a real keyboard interaction.
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        const element = node as HTMLElement;
        if (element.matches('[data-flowchat-opening="true"], [inert], [hidden], [aria-hidden="true"]')) {
          return NodeFilter.FILTER_REJECT;
        }
        if (element !== boundary && element.hasAttribute('data-flowchat-opening-guard')) {
          return NodeFilter.FILTER_REJECT;
        }
        return isTabbable(element) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    while (walker.nextNode()) candidates.push(walker.currentNode as HTMLElement);
    candidates.sort((a, b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity));
    const index = candidates.indexOf(boundary);
    const target = index < 0 ? undefined : candidates[index + direction];
    if (target && !target.hasAttribute('data-flowchat-opening-guard')) {
      target.focus({ preventScroll: true });
    } else {
      // At the document edge, leave the browser's next Tab free to reach chrome.
      boundary.focus({ preventScroll: true });
    }
  };

  const redirectFocus = (target: EventTarget | null, previous: EventTarget | null) => {
    if (redirectingRef.current) return;
    redirectingRef.current = true;
    try {
      if (directionRef.current) {
        skipTranscript(directionRef.current);
      } else {
        const root = rootRef.current;
        const candidate = previous instanceof HTMLElement ? previous : outsideFocusRef.current;
        if (candidate instanceof HTMLElement && candidate.isConnected
          && candidate !== target && !root?.contains(candidate)
          && !candidate.closest('[inert], [hidden], [aria-hidden="true"]')) {
          candidate.focus({ preventScroll: true });
        }
        if (target instanceof HTMLElement && target.ownerDocument.activeElement === target) {
          target.blur();
        }
      }
    } finally {
      directionRef.current = null;
      redirectingRef.current = false;
    }
  };

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!opening || !root) return;
    const doc = root.ownerDocument;
    const rememberFocus = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && !root.contains(target)
        && !target.hasAttribute('data-flowchat-opening-guard')) outsideFocusRef.current = target;
    };
    const rememberDirection = (event: KeyboardEvent) => {
      directionRef.current = event.key === 'Tab' ? (event.shiftKey ? -1 : 1) : null;
    };
    const clearDirection = () => { directionRef.current = null; };
    const block = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
    // A native, non-passive listener is needed to cancel wheel/touch scrolling.
    root.addEventListener('wheel', block, { capture: true, passive: false });
    root.addEventListener('touchmove', block, { capture: true, passive: false });
    root.addEventListener('selectstart', block, true);
    doc.addEventListener('focusin', rememberFocus);
    doc.addEventListener('keydown', rememberDirection, true);
    doc.addEventListener('keyup', clearDirection, true);
    doc.addEventListener('pointerdown', clearDirection, true);
    if (root.contains(doc.activeElement)) redirectFocus(doc.activeElement, null);
    else outsideFocusRef.current = doc.activeElement;
    return () => {
      root.removeEventListener('wheel', block, true);
      root.removeEventListener('touchmove', block, true);
      root.removeEventListener('selectstart', block, true);
      doc.removeEventListener('focusin', rememberFocus);
      doc.removeEventListener('keydown', rememberDirection, true);
      doc.removeEventListener('keyup', clearDirection, true);
      doc.removeEventListener('pointerdown', clearDirection, true);
    };
    // The boundary is installed once per opening; handlers only read live refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opening]);

  const block = (event: SyntheticEvent) => {
    if (!opening) return;
    event.preventDefault();
    event.stopPropagation();
  };
  // Removing either guard invalidated transcript styles and cost about 177ms in
  // staged traces. Keep both siblings mounted, then only leave the Tab order
  // at reveal so the browser retains the stable style tree.
  const guard = (side: 'before' | 'after') => (
    <span
      ref={side === 'before' ? beforeRef : afterRef}
      className="virtual-message-list__opening-guard"
      data-flowchat-opening-guard={side}
      tabIndex={opening ? 0 : -1}
      onFocus={() => {
        if (!opening || redirectingRef.current) return;
        redirectingRef.current = true;
        try { skipTranscript(directionRef.current ?? (side === 'before' ? 1 : -1)); }
        finally { redirectingRef.current = false; directionRef.current = null; }
      }}
    />
  );

  return <>
    {guard('before')}
    <div {...props} ref={rootRef} data-flowchat-opening={opening ? 'true' : undefined}
      aria-hidden={opening ? true : undefined}
      onFocusCapture={event => {
        if (!opening) return;
        event.stopPropagation();
        redirectFocus(event.target, event.relatedTarget);
      }}
      onPointerDownCapture={block} onPointerOverCapture={block}
      onMouseDownCapture={block} onMouseOverCapture={block}
      onClickCapture={block} onDoubleClickCapture={block} onContextMenuCapture={block}
      onKeyDownCapture={block} onKeyUpCapture={block} onDragStartCapture={block}
    >
      {children}
      {opening && <div className="virtual-message-list__opening-shield" />}
    </div>
    {guard('after')}
  </>;
}
