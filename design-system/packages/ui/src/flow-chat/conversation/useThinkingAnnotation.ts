import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
const LEAVE_DELAY_MS = 120;
const CARD_HEADER = '[data-openbitfun-component="flow-chat-tool-card"][data-openbitfun-part="surface"]';

function textEdge(root: HTMLElement, end = false): { anchor: HTMLElement; bounds: DOMRect } | null {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = root.ownerDocument.createRange();
  for (let node = end ? walker.lastChild() : walker.nextNode(); node;
    node = end ? walker.previousNode() : walker.nextNode()) {
    const text = node.textContent ?? '';
    const anchor = node.parentElement;
    const match = end ? /\S\s*$/.exec(text) : /\S/.exec(text);
    if (!match || !anchor) continue;
    const hidden = anchor.closest('[hidden], [aria-hidden="true"], button, script, style, [data-flowchat-selection-ignore="true"]');
    if (hidden && root.contains(hidden)) continue;
    let start = match.index;
    // The last non-space UTF-16 unit can be the low half of a code point.
    if (end && start > 0 && /[\uDC00-\uDFFF]/.test(text.charAt(start))) start--;
    range.setStart(node, start);
    range.setEnd(node, start + (text.codePointAt(start)! > 0xffff ? 2 : 1));
    const bounds = range.getBoundingClientRect?.();
    if (bounds && bounds.width > 0 && bounds.height > 0) return { anchor, bounds };
  }
  return null;
}

/** Intersect every clipping ancestor, including nested cards and host-owned chrome. */
function visibleBounds(element: HTMLElement, bounds: DOMRect) {
  const view = element.ownerDocument.defaultView!;
  const viewport = view.visualViewport;
  let top = Math.max(bounds.top, viewport?.offsetTop ?? 0);
  let bottom = Math.min(bounds.top + bounds.height, (viewport?.offsetTop ?? 0) + (viewport?.height ?? view.innerHeight));
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = view.getComputedStyle(parent);
    if (parent.hidden || style.display === 'none' || style.visibility === 'hidden') return { top, bottom: top };
    if (!/auto|scroll|hidden|clip/.test(style.overflowY || style.overflow)) continue;
    const rect = parent.getBoundingClientRect();
    const clientTop = rect.top + parent.clientTop;
    const height = parent.clientHeight || rect.height;
    const insetTop = Number(parent.getAttribute('data-openbitfun-viewport-inset-top')) || 0;
    const insetBottom = Number(parent.getAttribute('data-openbitfun-viewport-inset-bottom')) || 0;
    top = Math.max(top, clientTop + insetTop);
    bottom = Math.min(bottom, clientTop + height - insetBottom);
  }
  return { top, bottom };
}

/** Reads layout; writes only the detached control. Never owns transcript scrolling. */
export function useThinkingAnnotation(
  rootRef: RefObject<HTMLDivElement>,
  toggleRef: RefObject<HTMLButtonElement>,
  docked: boolean,
) {
  const blockedRef = useRef(false);
  const [tooltip, setTooltip] = useState({ blocked: false, active: false });
  const canShowTooltip = useCallback(() => !blockedRef.current
    && rootRef.current?.dataset.thinkingInView !== 'false', [rootRef]);

  useIsomorphicLayoutEffect(() => {
    const root = rootRef.current;
    const button = toggleRef.current;
    const parent = root?.parentElement;
    const view = root?.ownerDocument.defaultView;
    if (!docked || !root || !button || !parent || !view) return;

    let successor: HTMLElement | null = null;
    let observedAnchor: HTMLElement | null = null;
    let hovered = false;
    let focused = false;
    let watching = false;
    let leaveTimer: ReturnType<typeof setTimeout> | undefined;
    let frame: number | null = null;
    let lastPointer: { x: number; y: number } | null = null;
    blockedRef.current = false;
    setTooltip(current => current.blocked || current.active ? { blocked: false, active: false } : current);

    const write = (name: string, value: string) => {
      if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
    };
    const blockTooltip = () => {
      blockedRef.current = true;
      setTooltip(current => current.blocked && !current.active ? current : { blocked: true, active: false });
    };
    const update = () => {
      if (!successor) return;
      const header = successor.querySelector<HTMLElement>(CARD_HEADER);
      const first = header ? null : textEdge(successor);
      const anchor = header ?? first?.anchor ?? null;
      if (anchor !== observedAnchor) {
        if (observedAnchor && observedAnchor !== successor) resizeObserver.unobserve(observedAnchor);
        observedAnchor = anchor;
        if (anchor && anchor !== successor) resizeObserver.observe(anchor);
      }
      const bounds = header?.getBoundingClientRect() ?? first?.bounds;
      if (!bounds || bounds.height === 0) {
        root.style.removeProperty('--_thinking-continuation-center');
        delete root.dataset.thinkingAnnotation;
        return;
      }
      const rect = successor.getBoundingClientRect();
      const last = first ? textEdge(successor, true) : null;
      const multiline = Boolean(first && last && last.bounds.top > first.bounds.top + first.bounds.height / 2);
      root.dataset.thinkingAnnotation = multiline ? 'text' : 'compact';
      const contentBounds = multiline ? rect : bounds;
      // Resting controls are hidden. Walk clipping ancestors only for the one
      // being read or focused, not for every retained transcript item on resize.
      const visible = hovered || focused ? visibleBounds(successor, contentBounds)
        : { top: contentBounds.top, bottom: contentBounds.top + contentBounds.height };
      const buttonSize = button.getBoundingClientRect().height || bounds.height;
      const available = Math.max(0, visible.bottom - visible.top);
      // A short line retains optical glyph centering. Only clipped content fades
      // when the full control no longer fits in its scrollport.
      const inView = multiline ? available >= buttonSize : available >= Math.min(bounds.height, buttonSize);
      root.dataset.thinkingInView = inView ? 'true' : 'false';
      // Fully visible text uses its own midpoint; longer or clipped text uses
      // the visible portion's midpoint. Pointer position never moves the control.
      const center = multiline ? (visible.top + visible.bottom) / 2 : bounds.top + bounds.height / 2;
      write('--_thinking-continuation-center', `${center - rect.top}px`);
      // Use the first/last glyph bounds, excluding paragraph padding. Clamp
      // internally scrolled text to its content box; CSS gives both tips an inset.
      write('--_thinking-text-start', `${Math.max(0, (first?.bounds.top ?? rect.top) - rect.top)}px`);
      write('--_thinking-text-end', `${Math.min(rect.height, last ? last.bounds.top + last.bounds.height - rect.top : rect.height)}px`);
      if (!inView) blockTooltip();
    };
    const scheduleUpdate = () => {
      if (frame !== null) return;
      frame = view.requestAnimationFrame(() => { frame = null; update(); });
    };
    const onScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof view.Node && target !== root.ownerDocument
        && !target.contains(root) && !successor?.contains(target)) return;
      blockTooltip();
      scheduleUpdate();
    };
    const geometryObserver = new ResizeObserver(scheduleUpdate);
    const insetObserver = new MutationObserver(scheduleUpdate);
    const watch = (enabled: boolean) => {
      if (watching === enabled) return;
      watching = enabled;
      if (enabled) {
        view.addEventListener('scroll', onScroll, { capture: true, passive: true });
        view.addEventListener('resize', scheduleUpdate, { passive: true });
        view.visualViewport?.addEventListener('scroll', onScroll, { passive: true });
        view.visualViewport?.addEventListener('resize', scheduleUpdate, { passive: true });
        for (let ancestor = successor?.parentElement; ancestor; ancestor = ancestor.parentElement) {
          geometryObserver.observe(ancestor);
          insetObserver.observe(ancestor, { attributes: true,
            attributeFilter: ['data-openbitfun-viewport-inset-top', 'data-openbitfun-viewport-inset-bottom'] });
        }
      } else {
        view.removeEventListener('scroll', onScroll, true);
        view.removeEventListener('resize', scheduleUpdate);
        view.visualViewport?.removeEventListener('scroll', onScroll);
        view.visualViewport?.removeEventListener('resize', scheduleUpdate);
        geometryObserver.disconnect();
        insetObserver.disconnect();
        if (frame !== null) view.cancelAnimationFrame(frame);
        frame = null;
      }
    };
    const syncActive = () => {
      const active = hovered || focused;
      if (active) root.dataset.thinkingActive = 'true';
      else delete root.dataset.thinkingActive;
      watch(active);
    };
    const onEnter = () => {
      clearTimeout(leaveTimer);
      hovered = true;
      update();
      syncActive();
    };
    const onLeave = (event: MouseEvent) => {
      const target = event.relatedTarget;
      if (target instanceof view.Node && (root.contains(target) || successor?.contains(target))) return;
      clearTimeout(leaveTimer);
      leaveTimer = setTimeout(() => {
        hovered = false;
        syncActive();
      }, LEAVE_DELAY_MS);
    };
    const onMove = (event: MouseEvent) => {
      clearTimeout(leaveTimer);
      if (!hovered) { hovered = true; update(); syncActive(); }
      const changed = !lastPointer || lastPointer.x !== event.clientX || lastPointer.y !== event.clientY;
      lastPointer = { x: event.clientX, y: event.clientY };
      if (!changed) return;
      // Scroll-generated enter events never rearm a dismissed tooltip. A real
      // pointer move onto its button can start a fresh delayed hover.
      if (blockedRef.current && event.target instanceof view.Node && button.contains(event.target)) {
        blockedRef.current = false;
        setTooltip({ blocked: false, active: true });
      }
    };
    const onButtonLeave = () => setTooltip(current => current.active ? { ...current, active: false } : current);
    const onFocus = () => { focused = button.matches(':focus-visible'); update(); syncActive(); };
    const onBlur = () => { focused = false; syncActive(); };
    const resizeObserver = new ResizeObserver(update);
    const unbindSuccessor = () => {
      successor?.removeEventListener('mouseenter', onEnter);
      successor?.removeEventListener('mouseleave', onLeave);
      successor?.removeEventListener('mousemove', onMove);
    };
    const updateSuccessor = () => {
      const sibling = root.nextElementSibling;
      const next = sibling instanceof view.HTMLElement && sibling.hasAttribute('data-thinking-continuation') ? sibling : null;
      if (next !== successor) {
        watch(false);
        unbindSuccessor();
        clearTimeout(leaveTimer);
        hovered = false;
        resizeObserver.disconnect();
        observedAnchor = null;
        successor = next;
        mutationObserver.disconnect();
        mutationObserver.observe(parent, { childList: true });
        root.style.removeProperty('--_thinking-continuation-center');
        delete root.dataset.thinkingAnnotation;
        delete root.dataset.thinkingInView;
        if (successor) {
          resizeObserver.observe(successor);
          mutationObserver.observe(successor, { childList: true, characterData: true, subtree: true });
          successor.addEventListener('mouseenter', onEnter);
          successor.addEventListener('mouseleave', onLeave);
          successor.addEventListener('mousemove', onMove);
        }
        syncActive();
      }
      update();
    };
    const mutationObserver = new MutationObserver(updateSuccessor);
    mutationObserver.observe(parent, { childList: true });
    updateSuccessor();
    root.addEventListener('mouseenter', onEnter);
    root.addEventListener('mouseleave', onLeave);
    root.addEventListener('mousemove', onMove);
    button.addEventListener('mouseleave', onButtonLeave);
    button.addEventListener('focus', onFocus);
    button.addEventListener('blur', onBlur);
    button.addEventListener('click', blockTooltip);
    return () => {
      clearTimeout(leaveTimer);
      watch(false);
      unbindSuccessor();
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      root.removeEventListener('mouseenter', onEnter);
      root.removeEventListener('mouseleave', onLeave);
      root.removeEventListener('mousemove', onMove);
      button.removeEventListener('mouseleave', onButtonLeave);
      button.removeEventListener('focus', onFocus);
      button.removeEventListener('blur', onBlur);
      button.removeEventListener('click', blockTooltip);
      delete root.dataset.thinkingActive;
      delete root.dataset.thinkingAnnotation;
      delete root.dataset.thinkingInView;
      root.style.removeProperty('--_thinking-continuation-center');
      root.style.removeProperty('--_thinking-text-start');
      root.style.removeProperty('--_thinking-text-end');
    };
  }, [docked, rootRef, toggleRef]);

  return { tooltipBlocked: tooltip.blocked, tooltipActive: tooltip.active, canShowTooltip };
}
