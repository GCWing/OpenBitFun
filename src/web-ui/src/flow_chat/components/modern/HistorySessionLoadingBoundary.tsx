import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { FlowChatOpeningBoundary } from './FlowChatOpeningBoundary';
import { SESSION_LOADING_DELAY_MS } from '../../services/sessionOpenIntent';
import './HistorySessionLoadingBoundary.scss';

interface Props {
  identity: string;
  loading: boolean;
  hasTranscript: boolean;
  disabled: boolean;
  intent: boolean;
  label: string;
  onPresentationChange?: (identity: string, ready: boolean) => void;
  children: ReactNode;
}

type Phase = 'idle' | 'loading' | 'exiting' | 'revealing';
// Readiness already includes the viewport's layout commit. Keep the handoff
// brief: decoration must not add nearly half a second to a complete read.
const EXIT_DURATION = 80;
const REVEAL_DURATION = 100;

/** Presentation only. The existing viewport owner decides when the transcript is settled. */
export function HistorySessionLoadingBoundary({
  identity, loading, hasTranscript, disabled, intent, label, onPresentationChange, children,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const coverStartedAt = useRef<{ identity: string; at: number } | null>(null);
  const [state, setState] = useState<{ identity: string; phase: Phase }>({
    identity, phase: loading ? 'loading' : 'idle',
  });
  if (state.identity !== identity) {
    setState({ identity, phase: loading ? 'loading' : 'idle' });
  }
  const phase = state.identity === identity ? state.phase : loading ? 'loading' : 'idle';
  const covering = !disabled && (loading || phase !== 'idle');
  if (covering && coverStartedAt.current?.identity !== identity) {
    coverStartedAt.current = { identity, at: performance.now() };
  } else if (!covering) {
    coverStartedAt.current = null;
  }

  useLayoutEffect(() => {
    onPresentationChange?.(identity, !covering);
  }, [identity, covering, onPresentationChange]);

  useLayoutEffect(() => {
    const setPhase = (next: Phase) => setState(previous => (
      previous.identity === identity && previous.phase !== next
        ? { identity, phase: next }
        : previous
    ));
    if (disabled) { setPhase('idle'); return; }
    if (loading) { setPhase('loading'); return; }
    if (phase === 'idle') return;

    const root = rootRef.current;
    const content = root?.querySelector<HTMLElement>('.history-session-loading__content');
    const view = root?.ownerDocument.defaultView;
    if (!root || !content || !view) { setPhase('idle'); return; }
    const media = view.matchMedia?.('(prefers-reduced-motion: reduce)');
    const animations: Animation[] = [];
    let cancelled = false;
    let started = false;
    const observer = new MutationObserver(checkReady);
    const cleanup = () => {
      cancelled = true;
      observer.disconnect();
      media?.removeEventListener('change', settle);
      root.ownerDocument.removeEventListener('visibilitychange', onVisibility);
      animations.forEach(animation => animation.cancel());
      content.style.removeProperty('mask-image');
      content.style.removeProperty('mask-size');
      content.style.removeProperty('mask-repeat');
    };
    function settle() {
      // Keep the completed reveal visible until React commits the idle phase.
      content!.style.removeProperty('opacity');
      cleanup();
      setPhase('idle');
    }
    function onVisibility() { if (root!.ownerDocument.hidden) settle(); }
    function animate(element: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) {
      const animation = element.animate(frames, options);
      animations.push(animation);
      // Also handle cancellation if a subsequent animation fails to start.
      void animation.finished.catch(() => {});
      return animation;
    }

    function checkReady() {
      if (cancelled || started || !root || !content || !view) return;
      const transcript = content.querySelector<HTMLElement>('.virtual-message-list');
      if (hasTranscript && !transcript) return;
      if (transcript?.dataset.openViewportSettled === 'false') {
        observer.observe(transcript, { attributes: true, attributeFilter: ['data-open-viewport-settled'] });
        return;
      }
      started = true;
      observer.disconnect();
      if (media?.matches || root.ownerDocument.hidden || !content.animate) { settle(); return; }

      void transition().catch(() => { if (!cancelled) settle(); });
    }

    async function transition() {
      if (!root || !content || !view) return;
      const skeleton = root.querySelector<HTMLElement>('.history-session-skeleton');
      if (!skeleton) { settle(); return; }
      const shownFor = coverStartedAt.current?.identity === identity
        ? performance.now() - coverStartedAt.current.at : Infinity;
      if (shownFor < SESSION_LOADING_DELAY_MS) {
        settle();
        return;
      }
      const viewport = content.getBoundingClientRect();
      // Read only the bounded rendered window, once, after its opening placement.
      // Animate the decorative overlay, never the measured rows or their geometry.
      const regions = Array.from(content.querySelectorAll<HTMLElement>('.virtual-item-wrapper'))
        .map(element => element.getBoundingClientRect())
        .filter(rect => rect.width > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom);
      setPhase('exiting');
      for (const bar of skeleton.querySelectorAll<HTMLElement>('[data-history-loading-line]')) {
        const rect = bar.getBoundingClientRect();
        const region = regions.find(candidate => rect.top >= candidate.top && rect.top < candidate.bottom);
        const transform = region && rect.width > 0
          ? `translateX(${Math.max(viewport.left, region.left) - rect.left}px) scaleX(${Math.min(region.width * 0.8, viewport.width) / rect.width})`
          : 'none';
        animate(bar, [
          { opacity: view.getComputedStyle(bar).opacity, transform: 'none' },
          { opacity: 0.5, transform, offset: 0.58 },
          { opacity: 0, transform },
        ], { duration: EXIT_DURATION, easing: 'ease-out', fill: 'forwards' });
      }
      const bubble = skeleton.querySelector<HTMLElement>('.history-session-skeleton__user');
      if (bubble) animate(bubble, [{ opacity: 1 }, { opacity: 0 }], {
        duration: EXIT_DURATION * 0.85, fill: 'forwards',
      });

      await Promise.all(animations.map(animation => animation.finished));
      if (cancelled) return;
      // Remove the entire opaque shield before revealing text. No skeleton/text overlap.
      setPhase('revealing');
      content.style.maskImage = 'linear-gradient(to bottom, var(--openbitfun-color-content-on-light) 46%, transparent 54%)';
      content.style.maskSize = '100% 220%';
      content.style.maskRepeat = 'no-repeat';
      const reveal = animate(content, [
        { opacity: 0, maskPosition: '0% 100%' },
        { opacity: 1, maskPosition: '0% 0%' },
      ], { duration: REVEAL_DURATION, easing: 'ease-out', fill: 'forwards' });
      await reveal.finished;
      if (!cancelled) settle();
    }

    media?.addEventListener('change', settle);
    root.ownerDocument.addEventListener('visibilitychange', onVisibility);
    // Watch root attachment and its readiness attribute, never streamed row mutations.
    observer.observe(content, { childList: true });
    checkReady();
    return cleanup;
    // Phase changes belong to this one transition, not a new request to run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, loading, hasTranscript, disabled]);

  const skeleton = <HistorySessionSkeleton key={identity} />;
  const overlayProps = {
    className: 'history-session-loading__overlay',
    hidden: !loading && phase === 'revealing',
    role: 'status',
    'aria-label': label,
  };

  return (
    <div ref={rootRef} className="history-session-loading" data-history-loading-phase={covering ? phase : 'idle'}>
      <FlowChatOpeningBoundary
        opening={covering}
        className="history-session-loading__content"
        style={{ opacity: covering ? 0 : undefined }}
        data-openbitfun-component="modern-flow-chat"
        data-openbitfun-part="historyContent"
      >
        {children}
      </FlowChatOpeningBoundary>
      {covering && (intent ? (
        <div {...overlayProps} data-openbitfun-component="modern-flow-chat" data-openbitfun-part="historyOpenIntent">
          {skeleton}
          {/* Keep saved appearance packages readable after retiring the visible spinner. */}
          <span hidden data-openbitfun-component="modern-flow-chat" data-openbitfun-part="historyOpenIntentSpinner" />
        </div>
      ) : (
        <div {...overlayProps} data-openbitfun-component="modern-flow-chat" data-openbitfun-part="historyOverlay">
          {skeleton}
        </div>
      ))}
    </div>
  );
}

/** The history loading skeleton, shared with presentations that precede a session (a device switch). */
export function HistorySessionSkeleton() {
  return (
    <div className="history-session-skeleton" style={{ animationDelay: `${SESSION_LOADING_DELAY_MS}ms` }}
      aria-hidden="true" data-openbitfun-component="modern-flow-chat" data-openbitfun-part="historySkeleton">
      <div className="history-session-skeleton__column">
        <div className="history-session-skeleton__user"><span /><span /></div>
        <div className="history-session-skeleton__group history-session-skeleton__group--first">
          <span className="history-session-skeleton__bar" data-history-loading-line />
          <span className="history-session-skeleton__bar" data-history-loading-line />
          <span className="history-session-skeleton__bar" data-history-loading-line />
        </div>
        <div className="history-session-skeleton__group history-session-skeleton__group--second">
          <span className="history-session-skeleton__bar" data-history-loading-line />
          <span className="history-session-skeleton__bar" data-history-loading-line />
        </div>
        <div className="history-session-skeleton__group history-session-skeleton__group--third">
          <span className="history-session-skeleton__bar" data-history-loading-line />
          <span className="history-session-skeleton__bar" data-history-loading-line />
        </div>
      </div>
    </div>
  );
}
