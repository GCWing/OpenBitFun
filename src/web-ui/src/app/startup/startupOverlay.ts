import { isReducedMotionPreferred } from '@/shared/utils/motionPreference';
import { STARTUP_OVERLAY_HIDDEN_EVENT } from './startupSignals';

const STARTUP_OVERLAY_ID = 'openbitfun-startup-overlay';
const EXIT_CLASS = 'openbitfun-startup-overlay--exiting';
const HANDOFF_CLASS = 'openbitfun-startup-overlay--handoff';
const EXIT_FALLBACK_MS = 350;
const LOGO_HANDOFF_MS = 420;
const pendingExits = new WeakMap<HTMLElement, Promise<void>>();

declare global {
  interface Window {
    __OPENBITFUN_STARTUP_OVERLAY_STARTED_AT__?: number;
  }
}

function getOverlay(): HTMLElement | null {
  return document.getElementById(STARTUP_OVERLAY_ID);
}

export function getStartupOverlayElapsedMs(): number {
  const startedAt = window.__OPENBITFUN_STARTUP_OVERLAY_STARTED_AT__;
  if (typeof startedAt !== 'number') {
    return 0;
  }
  return Math.max(0, performance.now() - startedAt);
}

export function isStartupOverlayPresent(): boolean {
  return getOverlay() !== null;
}

interface LogoHandoff {
  mark: HTMLElement;
  target: HTMLElement;
  destination: DOMRect;
  animation: Animation;
}

function isActiveTarget(target: HTMLElement): boolean {
  // The mark itself is decorative (aria-hidden), but its scene must be active.
  return target.isConnected && !target.parentElement?.closest('[hidden], [inert], [aria-hidden="true"]');
}

function hasArea(rect: DOMRect): boolean {
  return [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    && rect.width > 0 && rect.height > 0;
}

function startLogoHandoff(overlay: HTMLElement): LogoHandoff | null {
  if (isReducedMotionPreferred() || document.hidden || document.fonts?.status === 'loading') return null;
  const mark = overlay.querySelector<HTMLElement>('.openbitfun-preload__logo');
  const target = Array.from(document.querySelectorAll<HTMLElement>('#root [data-startup-logo-target]'))
    .find(isActiveTarget);
  if (!mark?.animate || !target) return null;

  // Measure the breathing mark before detaching it: its current scale becomes
  // the flight's starting size instead of snapping back to the CSS base size.
  const origin = mark.getBoundingClientRect();
  const destination = target.getBoundingClientRect();
  if (!hasArea(origin) || !hasArea(destination)) return null;
  const initialColor = getComputedStyle(mark).backgroundColor;
  const targetColor = getComputedStyle(target).color;
  const parent = mark.parentNode!;
  const next = mark.nextSibling;
  const originalStyle = mark.getAttribute('style');

  try {
    // Move the actual static mark outside the dissolving backdrop. No duplicate
    // SVG or second visible logo is introduced during the handoff.
    overlay.appendChild(mark);
    Object.assign(mark.style, {
      position: 'fixed', left: `${origin.left}px`, top: `${origin.top}px`,
      width: `${origin.width}px`, height: `${origin.height}px`,
      transform: 'none', transformOrigin: '0 0',
    });
    const animation = mark.animate([
      { transform: 'translate(0px, 0px) scale(1, 1)', backgroundColor: initialColor },
      {
        transform: `translate(${destination.left - origin.left}px, ${destination.top - origin.top}px) scale(${destination.width / origin.width}, ${destination.height / origin.height})`,
        backgroundColor: targetColor,
      },
    ], { duration: LOGO_HANDOFF_MS, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' });
    overlay.classList.add(HANDOFF_CLASS);
    return { mark, target, destination, animation };
  } catch {
    // A WebView without usable animation support still gets the short dissolve.
    parent.insertBefore(mark, next);
    if (originalStyle === null) mark.removeAttribute('style');
    else mark.setAttribute('style', originalStyle);
    return null;
  }
}

function waitForOverlayExitAnimation(overlay: HTMLElement, handoff: LogoHandoff | null): Promise<void> {
  return new Promise(resolve => {
    let done = false;
    let activeHandoff = handoff;
    let frame: number | undefined;
    let fallbackTimer: number | undefined;

    function finish() {
      if (done) {
        return;
      }
      done = true;
      overlay.removeEventListener('animationend', handleAnimationEnd);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (fallbackTimer !== undefined) window.clearTimeout(fallbackTimer);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      // Remove first so cancelling a filled animation cannot flash its origin.
      overlay.remove();
      document.getElementById('root')?.removeAttribute('data-startup-stage');
      activeHandoff?.animation.cancel();
      resolve();
    }

    function handleAnimationEnd(event: AnimationEvent) {
      if (activeHandoff || event.target !== overlay) {
        return;
      }
      finish();
    }

    function handleVisibilityChange() {
      if (document.hidden) finish();
    }

    function dissolveInstead() {
      if (!activeHandoff || done) return;
      const { mark, animation } = activeHandoff;
      // Resize, font/layout changes or navigation may invalidate the destination.
      // Freeze the current pixels and dissolve instead of flying to a stale slot.
      const current = getComputedStyle(mark);
      mark.style.transform = current.transform;
      mark.style.backgroundColor = current.backgroundColor;
      activeHandoff = null;
      animation.cancel();
      // Keep the handoff styles: removing them would restore the already-faded
      // backdrop and replay the welcome text entrance underneath it.
      overlay.classList.add('openbitfun-startup-overlay--interrupted');
      window.clearTimeout(fallbackTimer);
      fallbackTimer = window.setTimeout(finish, EXIT_FALLBACK_MS);
    }

    function checkDestination() {
      if (!activeHandoff || done) return;
      const { target, destination } = activeHandoff;
      const current = target.getBoundingClientRect();
      if (!isActiveTarget(target) || isReducedMotionPreferred()
        || (['x', 'y', 'width', 'height'] as const).some(key => Math.abs(current[key] - destination[key]) > 0.5)) {
        dissolveInstead();
        return;
      }
      frame = window.requestAnimationFrame(checkDestination);
    }

    overlay.addEventListener('animationend', handleAnimationEnd);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    fallbackTimer = window.setTimeout(finish, handoff ? LOGO_HANDOFF_MS + 100 : EXIT_FALLBACK_MS);
    if (handoff) {
      // A cancelled animation must never strand the startup overlay.
      void handoff.animation.finished.then(() => {
        if (activeHandoff) finish();
      }, dissolveInstead);
      frame = window.requestAnimationFrame(checkDestination);
    }
  });
}

export function hideStartupOverlay(): Promise<void> {
  const overlay = getOverlay();
  if (!overlay) {
    document.getElementById('root')?.removeAttribute('data-startup-stage');
    return Promise.resolve();
  }

  const pending = pendingExits.get(overlay);
  if (pending) return pending;

  const handoff = startLogoHandoff(overlay);
  const exited = waitForOverlayExitAnimation(overlay, handoff).then(() => {
    pendingExits.delete(overlay);
    window.dispatchEvent(new CustomEvent(STARTUP_OVERLAY_HIDDEN_EVENT));
  });
  pendingExits.set(overlay, exited);
  overlay.classList.add(EXIT_CLASS);
  // Startup owns this state directly; a root :has() would invalidate unrelated
  // transcript descendants whenever virtualized or streaming DOM changes.
  document.getElementById('root')?.setAttribute('data-startup-stage', handoff ? 'handoff' : 'exiting');
  // Static startup window controls can still own focus when the React shell
  // becomes ready. Release that focus before hiding the overlay from the
  // accessibility tree, then make the exiting surface non-interactive so it
  // cannot reclaim focus during its final animation.
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement && overlay.contains(activeElement)) {
    activeElement.blur();
  }
  overlay.setAttribute('inert', '');
  overlay.setAttribute('aria-hidden', 'true');
  return exited;
}
