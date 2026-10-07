import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { ThinkingContinuationResolver } from './useThinkingAnnotation';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
const PRIORITY = '[data-thinking-handoff-priority="immediate"], [data-openbitfun-status="error"], [data-openbitfun-status="pending_confirmation"], [role="alert"], [role="alertdialog"]';
type Phase = 'holding' | 'closing' | 'released';

interface Options {
  identity?: string;
  enabled: boolean;
  expanded: boolean;
  visuallyStreaming: boolean;
  resolveContinuation?: ThinkingContinuationResolver;
  onReadyChange?: (ready: boolean, immediate: boolean, pending: boolean) => void;
}

/** A live predecessor owns one handoff. The real successor stays mounted and
 * updating, but cannot paint below a row that is about to disappear. Nothing
 * here writes transcript scrolling or infers a live arrival from mounting. */
export function useThinkingSuccessor(rootRef: RefObject<HTMLDivElement>, options: Options) {
  const latest = useRef(options);
  const syncRef = useRef<() => void>();
  const [phase, setPhase] = useState<Phase>();
  useIsomorphicLayoutEffect(() => { latest.current = options; });

  useIsomorphicLayoutEffect(() => {
    const root = rootRef.current;
    const parent = root?.parentElement;
    const view = root?.ownerDocument.defaultView;
    if (!root || !parent || !view || !options.enabled) {
      setPhase(undefined);
      options.onReadyChange?.(false, false, false);
      return;
    }
    const media = view.matchMedia?.('(prefers-reduced-motion: reduce)');
    let alive = true;
    let armed = false;
    let first = true;
    let target: HTMLElement | null = null;
    let held: { element: HTMLElement; inert: string | null; ariaHidden: string | null } | undefined;
    let closing = false;
    let bypass = false;
    let generation = 0;
    let frame: number | undefined;
    let reveal: Animation | undefined;
    let reported = '';
    let availability = { ready: false, immediate: false };
    setPhase(undefined);
    const seen = new WeakSet<HTMLElement>();
    const changePhase = (next?: Phase) => {
      if (next) root.dataset.thinkingExchange = next;
      else delete root.dataset.thinkingExchange;
      setPhase(next);
    };
    const restore = () => {
      if (!held) return;
      const { element, inert, ariaHidden } = held;
      delete element.dataset.thinkingSuccessor;
      if (inert === null) element.removeAttribute('inert'); else element.setAttribute('inert', inert);
      if (ariaHidden === null) element.removeAttribute('aria-hidden'); else element.setAttribute('aria-hidden', ariaHidden);
      held = undefined;
    };
    const report = (ready = availability.ready, immediate = availability.immediate) => {
      availability = { ready, immediate };
      const pending = Boolean(held);
      const value = `${ready}:${immediate}:${pending}`;
      if (reported === value) return;
      reported = value;
      latest.current.onReadyChange?.(ready, immediate, pending);
    };
    const release = (fade: boolean, fold = true) => {
      generation++;
      closing = false;
      const element = held?.element;
      restore();
      changePhase(fold ? 'released' : undefined);
      report();
      // Layout is committed at its final position before the opacity-only
      // reveal. No measured reservation, translation, or mount CSS animation.
      if (!fade || !element?.animate || media?.matches || root.ownerDocument.hidden) return;
      const style = view.getComputedStyle(root);
      const token = style.getPropertyValue('--openbitfun-motion-duration-fast').trim();
      const duration = parseFloat(token) * (token.endsWith('ms') ? 1 : 1000);
      if (!Number.isFinite(duration) || duration <= 0) return;
      reveal = element.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration, easing: style.getPropertyValue('--openbitfun-motion-easing-standard').trim() || 'ease',
      });
      const animation = reveal;
      void animation.finished.then(() => { if (reveal === animation) reveal = undefined; }, () => {});
    };
    const settle = () => {
      reveal?.cancel();
      reveal = undefined;
      if (held) { bypass = true; report(true, true); release(false, !root.closest('[hidden], [inert]')); }
    };
    const unavailable = () => media?.matches || root.ownerDocument.hidden
      || Boolean(root.closest('[hidden], [inert]'));
    const sync = () => {
      if (!alive) return;
      const sibling = root.nextElementSibling;
      const direct = sibling instanceof HTMLElement && sibling.hasAttribute('data-thinking-continuation') ? sibling : null;
      const resolved = direct ? null : latest.current.resolveContinuation?.(root);
      const candidate = direct ?? resolved?.element ?? null;
      // A backward annotation (consecutive thoughts across rounds) is not an arrival.
      const next = candidate && !candidate.hidden && candidate.querySelector(':scope > :not(:empty)')
        && Boolean(root.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING) ? candidate : null;
      observer.disconnect();
      if (latest.current.visuallyStreaming || armed || held) {
        observer.observe(parent, { childList: true, subtree: true, attributes: true,
          attributeFilter: ['hidden', 'inert', 'data-thinking-handoff-priority', 'data-openbitfun-status', 'role'] });
        // A collection can close above a memoized member without rendering it.
        for (let ancestor = parent.parentElement; ancestor; ancestor = ancestor.parentElement) {
          observer.observe(ancestor, { attributes: true, attributeFilter: ['hidden', 'inert'] });
        }
        if (resolved?.observeRoot && resolved.observeRoot !== parent) {
          observer.observe(resolved.observeRoot, { childList: true });
        }
        if (resolved?.observeSubtree && resolved.observeSubtree !== parent) {
          observer.observe(resolved.observeSubtree, { childList: true, subtree: true, attributes: true,
            attributeFilter: ['hidden', 'data-thinking-handoff-priority', 'data-openbitfun-status', 'role'] });
        }
      }
      if (next !== target) bypass = false;
      // A burst that already has more output should commit as one layout,
      // rather than let later cards overtake a held first card.
      let following = next?.nextElementSibling;
      while (following instanceof HTMLElement && (following.hidden || following.getAttribute('aria-hidden') === 'true')) {
        following = following.nextElementSibling;
      }
      const burst = following instanceof HTMLElement && !following.hidden
        && following.matches('[data-thinking-continuation], .flow-thinking-item')
        && following.querySelector(':scope > :not(:empty)');
      const immediate = Boolean(next && (bypass || next.matches(PRIORITY) || next.querySelector(PRIORITY)
        || next.contains(root.ownerDocument.activeElement) || burst));
      if (next !== target) {
        generation++;
        closing = false;
        restore();
        reveal?.cancel();
        reveal = undefined;
        target = next;
        changePhase(undefined);
        // Only a successor arriving after this live row has painted can claim
        // motion. History, StrictMode rehearsal and virtual remounts settle.
        if (next && !seen.has(next)) {
          seen.add(next);
          if (!first && armed && !immediate && !unavailable()) {
            held = { element: next, inert: next.getAttribute('inert'), ariaHidden: next.getAttribute('aria-hidden') };
            next.dataset.thinkingSuccessor = 'held';
            next.setAttribute('inert', '');
            next.setAttribute('aria-hidden', 'true');
            changePhase('holding');
          } else if (!first && armed && !root.closest('[hidden], [inert]')) {
            changePhase('released');
          }
          armed = false;
        }
      }
      first = false;
      if (!target && !armed && frame === undefined && latest.current.visuallyStreaming) {
        frame = view.requestAnimationFrame(() => {
          frame = undefined;
          armed = latest.current.visuallyStreaming && !target && !unavailable();
        });
      }
      report(Boolean(next), immediate);
      if (!held) return;
      if (immediate || unavailable()) { release(false, !root.closest('[hidden], [inert]')); return; }
      if (latest.current.expanded || latest.current.visuallyStreaming) {
        if (closing) { generation++; closing = false; changePhase('holding'); }
        return;
      }
      if (closing) return;
      closing = true;
      changePhase('closing');
      const ticket = ++generation;
      // Querying actual transitions flushes the new fold styles. Compact rows
      // retain one line until the fade; expanded rows fold down to that line.
      const parts: [Element | null, string[]][] = [
        [root.querySelector('.thinking-collapsed-header'), ['opacity']],
        [root.querySelector('.thinking-expand-container'), ['opacity', 'grid-template-rows']],
        [root.querySelector('.thinking-header-slot'), ['height', 'block-size']],
      ];
      const transitions = parts.flatMap(([element, properties]) => element?.getAnimations?.().filter(animation => (
        'transitionProperty' in animation && properties.includes(String(animation.transitionProperty))
      )) ?? []);
      const finish = () => { if (alive && ticket === generation && held) release(true); };
      if (transitions.length) void Promise.allSettled(transitions.map(animation => animation.finished)).then(finish);
      else finish();
    };
    const observer = new MutationObserver(sync);
    syncRef.current = sync;
    sync();
    const onVisibility = () => { if (unavailable()) settle(); };
    const onFocus = () => { if (target?.contains(root.ownerDocument.activeElement)) settle(); };
    media?.addEventListener?.('change', onVisibility);
    root.ownerDocument.addEventListener('visibilitychange', onVisibility);
    parent.addEventListener('focusin', onFocus);
    return () => {
      alive = false;
      generation++;
      observer.disconnect();
      if (frame !== undefined) view.cancelAnimationFrame(frame);
      media?.removeEventListener?.('change', onVisibility);
      root.ownerDocument.removeEventListener('visibilitychange', onVisibility);
      parent.removeEventListener('focusin', onFocus);
      reveal?.cancel();
      restore();
      delete root.dataset.thinkingExchange;
      syncRef.current = undefined;
    };
  }, [rootRef, options.identity, options.enabled, options.resolveContinuation]);

  // React updates can change an existing empty successor without a new sibling.
  useIsomorphicLayoutEffect(() => { syncRef.current?.(); });
  return phase;
}
