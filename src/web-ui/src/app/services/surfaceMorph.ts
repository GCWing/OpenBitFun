/**
 * One surface becoming the next (a container transform): a popover's action
 * that opens a dialog hands the dialog its rectangle, and the dialog opens as
 * a window of exactly that size and curve that grows to its own. Nothing is
 * scaled, so no text or corner is ever stretched:
 *
 * - a still copy of the popover stays where it was and travels with the
 *   window's corner while it fades, so the popover never just vanishes;
 * - the dialog's own background fills the growing window from the start;
 * - its contents fade in once the window is most of the way there.
 */

interface MorphOrigin {
  key: string;
  rect: DOMRect;
  radius: number;
  ghost: HTMLElement | null;
  timer: ReturnType<typeof setTimeout>;
}

/** An origin the next surface did not claim in time (a disclaimer came first) lapses. */
const ORIGIN_TTL_MS = 1500;
const MORPH_MS = 440;
/** Emphasized easing: a quick start that settles softly, like a thrown sheet. */
const EASING = 'cubic-bezier(0.2, 0, 0, 1)';

let origin: MorphOrigin | null = null;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function discard(entry: MorphOrigin | null): void {
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.ghost?.remove();
}

/** A still, inert copy of `element` pinned where it is now. */
function pinGhost(element: HTMLElement, rect: DOMRect): HTMLElement | null {
  const body = element.ownerDocument?.body;
  if (!body) return null;
  const ghost = element.cloneNode(true) as HTMLElement;
  ghost.removeAttribute('id');
  ghost.removeAttribute('role');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.setAttribute('inert', '');
  Object.assign(ghost.style, {
    position: 'fixed',
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: '0',
    transform: 'none',
    animation: 'none',
    pointerEvents: 'none',
    // Above the dialog layer it hands over to.
    zIndex: '2147483000',
  });
  body.appendChild(ghost);
  return ghost;
}

/** Remember `element` as where the surface named `key` grows from. */
export function rememberMorphOrigin(key: string, element: HTMLElement | null): void {
  discard(origin);
  origin = null;
  // Without the Web Animations API there is no morph to hand a copy to.
  if (!element || prefersReducedMotion() || typeof element.animate !== 'function') return;
  const rect = element.getBoundingClientRect();
  const entry: MorphOrigin = {
    key,
    rect,
    radius: Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0,
    ghost: pinGhost(element, rect),
    timer: setTimeout(() => {
      if (origin === entry) origin = null;
      discard(entry);
    }, ORIGIN_TTL_MS),
  };
  origin = entry;
}

/**
 * Grow `surface` out of the remembered origin of `key`. Returns false (and the
 * surface keeps its own entrance) when there is none or motion is reduced.
 */
export function morphFromOrigin(key: string, surface: HTMLElement): boolean {
  const from = origin;
  if (!from || from.key !== key) return false;
  origin = null;
  clearTimeout(from.timer);
  if (prefersReducedMotion() || typeof surface.animate !== 'function') {
    discard(from);
    return false;
  }
  // The surface's own entrance would fight the morph.
  for (const animation of surface.getAnimations?.() ?? []) animation.cancel();
  const to = surface.getBoundingClientRect();
  if (to.width === 0 || to.height === 0) {
    discard(from);
    return false;
  }
  const dx = from.rect.left - to.left;
  const dy = from.rect.top - to.top;
  const right = Math.max(0, to.width - from.rect.width);
  const bottom = Math.max(0, to.height - from.rect.height);
  const radius = Number.parseFloat(getComputedStyle(surface).borderTopLeftRadius) || 0;
  const timing = { duration: MORPH_MS, easing: EASING };

  // The window: the dialog clipped to the popover's box, moved onto it, then
  // released to its own box. Position and size interpolate together.
  surface.animate([
    { transform: `translate(${dx}px, ${dy}px)`, clipPath: `inset(0 ${right}px ${bottom}px 0 round ${from.radius}px)` },
    { transform: 'translate(0, 0)', clipPath: `inset(0 0 0 0 round ${radius}px)` },
  ], timing);

  // The popover rides the window's corner while it hands over.
  const ghost = from.ghost;
  if (ghost && typeof ghost.animate !== 'function') ghost.remove();
  else if (ghost) {
    const fade = ghost.animate([
      { transform: 'translate(0, 0)', opacity: 1 },
      { transform: `translate(${-dx * 0.4}px, ${-dy * 0.4}px)`, opacity: 0, offset: 0.4 },
      { transform: `translate(${-dx}px, ${-dy}px)`, opacity: 0 },
    ], timing);
    fade.onfinish = () => ghost.remove();
    fade.oncancel = () => ghost.remove();
  }

  // The dialog's contents arrive once the window is most of the way there.
  for (const child of Array.from(surface.children)) {
    (child as HTMLElement).animate?.([
      { opacity: 0 },
      { opacity: 0, offset: 0.3 },
      { opacity: 1, offset: 0.75 },
      { opacity: 1 },
    ], { duration: MORPH_MS, easing: 'linear' });
  }
  return true;
}
