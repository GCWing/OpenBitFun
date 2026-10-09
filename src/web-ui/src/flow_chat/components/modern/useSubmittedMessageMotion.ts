import { useLayoutEffect, useRef, type RefObject } from 'react';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import {
  consumeSubmittedMessageArrival,
  consumeSubmittedMessageFailure,
  type SubmittedMessageArrival,
} from '../../services/submittedMessagePresentation';

const PARTS = [
  { selector: '.user-message-item__surface', fallbackSelector: '.user-message-item',
    from: { opacity: 0.76, transform: 'translateY(1px) scale(0.985, 0.94)' },
    to: { opacity: 1, transform: 'translateY(0) scale(1)' }, delay: 0, duration: 220 },
  { selector: '.user-message-item__content',
    from: { opacity: 0, transform: 'translateY(1px)' },
    to: { opacity: 1, transform: 'translateY(0)' }, delay: 55, duration: 160 },
  { selector: '.user-message-item__images',
    from: { opacity: 0 }, to: { opacity: 1 }, delay: 55, duration: 160 },
] as const;

/** Explicit send feedback, never a row-mount animation or a viewport writer. */
export function useSubmittedMessageMotion(
  shellRef: RefObject<HTMLDivElement>,
  sessionId: string | undefined,
  turnId: string,
  messageId: string | undefined,
  disabled: boolean,
  submissionPhase?: 'forming' | 'failed',
): void {
  const scope = getActiveSurfaceScope();
  const key = scope.key('submitted-message-motion', scope.epoch, sessionId, turnId, messageId);
  // Retain the claim across StrictMode's effect rehearsal, not across real remounts.
  const claim = useRef<{ key: string; arrival?: SubmittedMessageArrival }>();

  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell || !sessionId || !messageId) return;
    if (claim.current?.key !== key) {
      claim.current = { key, arrival: consumeSubmittedMessageArrival(sessionId, turnId, messageId) };
    }
    const owner = claim.current;
    const arrival = owner.arrival;
    if (!arrival) return;

    const view = shell.ownerDocument.defaultView;
    const media = view?.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (disabled || !view || media?.matches || shell.ownerDocument.hidden
      || !arrival.scope.isCurrent() || view.getComputedStyle(shell).visibility !== 'visible'
      || shell.contains(shell.ownerDocument.activeElement)) {
      owner.arrival = undefined;
      return;
    }

    const elapsed = Math.max(0, performance.now() - arrival.startedAt);
    const animations: Animation[] = [];
    for (const part of PARTS) {
      const element = shell.querySelector<HTMLElement>(part.selector)
        ?? ('fallbackSelector' in part ? shell.querySelector<HTMLElement>(part.fallbackSelector) : null);
      if (!element?.animate || elapsed >= part.delay + part.duration) continue;
      const animation = element.animate([part.from, part.to], {
        delay: part.delay,
        duration: part.duration,
        easing: 'cubic-bezier(0.23, 1, 0.32, 1)',
        fill: 'backwards',
      });
      animation.currentTime = elapsed;
      animations.push(animation);
    }
    if (!animations.length) {
      owner.arrival = undefined;
      return;
    }

    const listeners = new AbortController();
    const cleanup = () => {
      for (const animation of animations) animation.cancel();
      listeners.abort();
    };
    const settle = () => {
      owner.arrival = undefined;
      cleanup();
    };
    const onPreference = () => { if (media?.matches) settle(); };
    const onVisibility = () => { if (shell.ownerDocument.hidden) settle(); };
    const options = { signal: listeners.signal };
    shell.addEventListener('focusin', settle, options);
    shell.addEventListener('pointerdown', settle, options);
    media?.addEventListener('change', onPreference, options);
    shell.ownerDocument.addEventListener('visibilitychange', onVisibility, options);
    arrival.scope.signal.addEventListener('abort', settle, options);
    // Cancelling during unmount rejects finished; it must not consume a StrictMode rehearsal.
    void Promise.all(animations.map(animation => animation.finished)).then(settle, () => {});
    return cleanup;
  }, [shellRef, sessionId, turnId, messageId, key, disabled]);

  useLayoutEffect(() => {
    if (submissionPhase !== 'failed' || !sessionId || !messageId) return;
    const failure = consumeSubmittedMessageFailure(sessionId, turnId, messageId);
    const shell = shellRef.current;
    const bubble = shell?.querySelector<HTMLElement>('.user-message-item__surface');
    const view = shell?.ownerDocument.defaultView;
    const media = view?.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!failure || !bubble?.animate || !view || media?.matches || shell?.ownerDocument.hidden
      || !failure.scope.isCurrent() || shell.contains(shell.ownerDocument.activeElement)) return;
    const elapsed = Math.max(0, performance.now() - failure.failedAt!);
    if (elapsed >= 220) return;
    const animations = [bubble.animate([
      { transform: 'translateX(0) scale(1)' },
      { transform: 'translateX(1px) scale(0.995, 0.97)', offset: 0.5 },
      { transform: 'translateX(0) scale(1)' },
    ], { duration: 190, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' })];
    const feedback = shell.querySelector<HTMLElement>('.user-message-item__submission-error');
    if (feedback?.animate) animations.push(feedback.animate([
      { opacity: 0, transform: 'translateY(-2px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ], { duration: 150, easing: 'ease-out', fill: 'backwards' }));
    for (const animation of animations) {
      animation.currentTime = elapsed;
    }
    const listeners = new AbortController();
    const settle = () => {
      listeners.abort();
      animations.forEach(animation => animation.cancel());
    };
    const options = { signal: listeners.signal };
    shell.addEventListener('focusin', settle, options);
    shell.addEventListener('pointerdown', settle, options);
    failure.scope.signal.addEventListener('abort', settle, options);
    media?.addEventListener('change', settle, options);
    const onVisibility = () => { if (shell.ownerDocument.hidden) settle(); };
    shell.ownerDocument.addEventListener('visibilitychange', onVisibility, options);
    void Promise.all(animations.map(animation => animation.finished)).then(() => listeners.abort(), () => {});
    return () => { listeners.abort(); settle(); };
  }, [shellRef, sessionId, turnId, messageId, submissionPhase]);
}
