import { useCallback, useEffect, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from 'react';

export type AgentDetailView = 'preview' | 'transitioning' | 'details';

const staticMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
  || window.matchMedia('(forced-colors: active)').matches;

function motionDuration(element: HTMLElement, token: string, fallback: number) {
  const value = window.getComputedStyle(element).getPropertyValue(token).trim();
  const duration = Number.parseFloat(value) * (value.endsWith('ms') ? 1 : 1000);
  return Number.isFinite(duration) ? duration : fallback;
}

/** Keep the Dialog and its focus scope mounted while its contents and actual size change. */
export function useHarnessDialogTransition(
  open: boolean,
  view: AgentDetailView,
  setView: Dispatch<SetStateAction<AgentDetailView>>,
  page: string,
) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const previousSize = useRef<DOMRect | null>(null);

  const captureSize = useCallback(() => {
    previousSize.current = surfaceRef.current?.getBoundingClientRect() ?? null;
  }, []);

  const manage = useCallback(() => {
    if (!open || view !== 'preview') return;
    captureSize();
    setView(staticMotion() ? 'details' : 'transitioning');
  }, [captureSize, open, setView, view]);

  useEffect(() => {
    if (!open || view !== 'transitioning') return;
    const surface = surfaceRef.current;
    if (!surface) return;
    const timer = window.setTimeout(() => setView('details'),
      motionDuration(surface, '--openbitfun-motion-duration-fast', 150));
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const forced = window.matchMedia('(forced-colors: active)');
    const finish = () => { if (reduced.matches || forced.matches) setView('details'); };
    finish();
    reduced.addEventListener('change', finish);
    forced.addEventListener('change', finish);
    return () => {
      window.clearTimeout(timer);
      reduced.removeEventListener('change', finish);
      forced.removeEventListener('change', finish);
    };
  }, [open, setView, view]);

  useLayoutEffect(() => {
    if (!open || view === 'preview') { previousSize.current = null; return; }
    if (view !== 'details' || !previousSize.current) return;
    const before = previousSize.current;
    previousSize.current = null;
    const surface = surfaceRef.current;
    if (!surface) return;
    // Keep focus inside the retained surface while its page's controls are replaced.
    surface.querySelector<HTMLButtonElement>('[data-openbitfun-part="close"]')?.focus({ preventScroll: true });
    if (staticMotion() || typeof surface.animate !== 'function') return;
    const after = surface.getBoundingClientRect();
    if (!before.width || !before.height || !after.width || !after.height) return;
    const style = window.getComputedStyle(surface);
    const easing = style.getPropertyValue('--openbitfun-motion-easing-enter').trim() || 'cubic-bezier(0.22, 1, 0.36, 1)';
    const duration = motionDuration(surface, '--openbitfun-motion-duration-slow', 350);
    const distance = style.getPropertyValue('--openbitfun-motion-distance-sm').trim() || '6px';
    // Animate geometry rather than scaling the window so its text and controls stay crisp.
    const animations = [surface.animate([
      { width: `${before.width}px`, height: `${before.height}px` },
      { width: `${after.width}px`, height: `${after.height}px` },
    ], { duration, easing })];
    surface.querySelectorAll<HTMLElement>(':scope > [data-openbitfun-part="body"], :scope > [data-openbitfun-part="footer"], :scope > .agent-detail-dialog__toolbar')
      .forEach(element => animations.push(element.animate([
        { opacity: 0, transform: `translateY(${distance})` },
        { opacity: 1, transform: 'translateY(0)' },
      ], { duration, easing, fill: 'backwards' })));
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const forced = window.matchMedia('(forced-colors: active)');
    const cancel = () => animations.forEach(animation => animation.cancel());
    const sync = () => { if (reduced.matches || forced.matches) cancel(); };
    reduced.addEventListener('change', sync);
    forced.addEventListener('change', sync);
    return () => {
      cancel();
      reduced.removeEventListener('change', sync);
      forced.removeEventListener('change', sync);
    };
  }, [open, page, view]);

  return { surfaceRef, manage, captureSize };
}
