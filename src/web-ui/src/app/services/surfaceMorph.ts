/**
 * One surface growing into the next: a popover's action that opens a dialog
 * hands the dialog its own rectangle, and the dialog starts there instead of
 * fading in at the centre. The popover closes in the same moment, so the user
 * sees one surface change shape, not one closing and another opening.
 */

interface MorphOrigin {
  key: string;
  rect: DOMRect;
  radius: number;
  at: number;
}

/** An origin the next surface did not claim in time (a disclaimer came first) lapses. */
const ORIGIN_TTL_MS = 1500;
const MORPH_MS = 380;
const EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';

let origin: MorphOrigin | null = null;

/** Remember `element` as where the surface named `key` grows from. */
export function rememberMorphOrigin(key: string, element: HTMLElement | null): void {
  if (!element) return;
  origin = {
    key,
    rect: element.getBoundingClientRect(),
    radius: Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0,
    at: Date.now(),
  };
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Grow `surface` from the remembered origin of `key`. Returns false (and the
 * surface keeps its own entrance) when there is none or motion is reduced.
 */
export function morphFromOrigin(key: string, surface: HTMLElement): boolean {
  const from = origin;
  origin = null;
  if (!from || from.key !== key || Date.now() - from.at > ORIGIN_TTL_MS) return false;
  if (prefersReducedMotion() || typeof surface.animate !== 'function') return false;
  // The surface's own entrance would fight the morph.
  for (const animation of surface.getAnimations?.() ?? []) animation.cancel();
  const to = surface.getBoundingClientRect();
  if (to.width === 0 || to.height === 0) return false;
  const scaleX = from.rect.width / to.width;
  const scaleY = from.rect.height / to.height;
  const dx = from.rect.left - to.left;
  const dy = from.rect.top - to.top;
  const radius = Number.parseFloat(getComputedStyle(surface).borderTopLeftRadius) || 0;
  surface.animate([
    {
      transformOrigin: '0 0',
      transform: `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})`,
      // Counter the scale so the corners keep the popover's curve.
      borderRadius: `${from.radius / scaleX}px / ${from.radius / scaleY}px`,
    },
    { transformOrigin: '0 0', transform: 'none', borderRadius: `${radius}px` },
  ], { duration: MORPH_MS, easing: EASING });
  // The content arrives once the surface is nearly its size, so the stretch is
  // never seen on text.
  for (const child of Array.from(surface.children)) {
    (child as HTMLElement).animate?.([{ opacity: 0 }, { opacity: 0, offset: 0.35 }, { opacity: 1 }],
      { duration: MORPH_MS, easing: 'ease-out' });
  }
  return true;
}
