interface DownloadOrigin {
  card: HTMLElement;
  rect: DOMRect;
  version: string;
  keyboard: boolean;
}

// Geometry belongs to this mounted surface, never to updater state or persisted preferences.
let pendingOrigin: DownloadOrigin | null = null;

export function getUpdateDownloadOrigin(version: string | null): HTMLElement | null {
  return pendingOrigin?.version === version ? pendingOrigin.card : null;
}

export function prepareUpdateDownloadHandoff(button: HTMLButtonElement, card: HTMLElement, version: string, keyboard: boolean): () => void {
  const origin = { card, rect: button.getBoundingClientRect(), version, keyboard };
  pendingOrigin = origin;
  return () => { if (pendingOrigin === origin) pendingOrigin = null; };
}

function milliseconds(value: string): number {
  const duration = Number.parseFloat(value);
  return Number.isFinite(duration) ? duration * (value.trim().endsWith('ms') ? 1 : 1000) : 0;
}

/** Called only after a real download state has mounted the navigation destination. */
export function runUpdateDownloadHandoff(
  version: string,
  target: HTMLButtonElement,
  vessel: HTMLElement,
  transfer: HTMLElement,
  onArrive: () => void,
): (() => void) | undefined {
  const origin = pendingOrigin;
  if (!origin || origin.version !== version) return;
  pendingOrigin = null;
  const document = target.ownerDocument;
  const view = document.defaultView;
  const destination = target.getBoundingClientRect();
  if (!view || !origin.card.isConnected || document.visibilityState === 'hidden'
      || origin.rect.width <= 0 || origin.rect.height <= 0 || destination.width <= 0 || destination.height <= 0) return;

  const style = view.getComputedStyle(target);
  const duration = milliseconds(style.getPropertyValue('--openbitfun-motion-duration-slow'));
  const easing = style.getPropertyValue('--openbitfun-motion-easing-smooth').trim() || 'ease-in-out';
  const media = view.matchMedia?.('(prefers-reduced-motion: reduce)');
  const animations: Animation[] = [];
  const previousVisibility = target.style.visibility;
  const revealTarget = () => { target.style.visibility = previousVisibility; };
  let cancelled = false;
  let arrived = false;

  const arrive = () => {
    if (cancelled || arrived || !target.isConnected) return;
    arrived = true;
    revealTarget();
    if (origin.keyboard && (document.activeElement === document.body || origin.card.contains(document.activeElement))) {
      target.focus({ preventScroll: true });
    }
    onArrive();
  };
  const stop = () => animations.forEach(animation => animation.cancel());
  const finishImmediately = () => { stop(); arrive(); };
  const onPreference = () => { if (media?.matches) finishImmediately(); };
  const cleanup = () => {
    cancelled = true;
    stop();
    revealTarget();
    media?.removeEventListener('change', onPreference);
    view.removeEventListener('resize', finishImmediately);
  };

  if (origin.keyboard || media?.matches || !transfer.animate || !origin.card.animate || !vessel.animate || duration <= 0) {
    arrive();
    return cleanup;
  }

  const from = { x: origin.rect.left + origin.rect.width / 2, y: origin.rect.top + origin.rect.height / 2 };
  const to = { x: destination.left + destination.width / 2, y: destination.top + destination.height / 2 };
  // Reserve the destination's layout, but reveal it only when the travelling dot arrives.
  // The caller runs in a layout effect, so the control cannot flash before it is hidden.
  target.style.visibility = 'hidden';
  // A quadratic arc leaves the button vertically, then settles into the navigation circle.
  const path = Array.from({ length: 17 }, (_, index) => {
    const t = index / 16;
    const x = from.x + (to.x - from.x) * t * t;
    const y = from.y + (to.y - from.y) * (2 * t - t * t);
    return { offset: t, opacity: 1,
      transform: `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${0.6 + 0.4 * t})` };
  });
  const flight = transfer.animate(path, { duration, easing, fill: 'forwards' });
  const fade = origin.card.animate([
    { opacity: 1, transform: 'translate(0, 0) scale(1)' },
    { opacity: 0, transform: `translate(${(to.x - from.x) * 0.08}px, ${(to.y - from.y) * 0.08}px) scale(0.97)` },
  ], { duration: duration * 0.65, easing, fill: 'forwards' });
  animations.push(flight, fade);
  void Promise.all(animations.map(animation => animation.finished)).then(() => {
    if (cancelled || arrived || !target.isConnected) return;
    flight.cancel();
    const landing = vessel.animate([
      { transform: 'scale(1)' },
      { transform: 'scale(1.12)', offset: 0.4 },
      { transform: 'scale(1)' },
    ], { duration: milliseconds(style.getPropertyValue('--openbitfun-motion-duration-base')), easing });
    animations.push(landing);
    void landing.finished.catch(() => {});
    arrive();
  }, () => { if (!cancelled) finishImmediately(); });
  media?.addEventListener('change', onPreference);
  view.addEventListener('resize', finishImmediately);
  return cleanup;
}
