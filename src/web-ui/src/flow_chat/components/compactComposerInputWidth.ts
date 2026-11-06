/** Read the existing compact track; expanded composers still need a compact-layout probe. */
export function readCompactComposerInputWidth(container: HTMLElement): number | null {
  if (!container.classList.contains('openbitfun-chat-input--capsule')) return null;
  const surface = container.querySelector<HTMLElement>(
    '[data-openbitfun-component="chat-composer"] [data-openbitfun-part="surface"]',
  );
  if (surface?.dataset.openbitfunLayout !== 'compact') return null;
  const area = surface.querySelector<HTMLElement>('.openbitfun-chat-input__input-area');
  const width = area?.getBoundingClientRect().width;
  // Hidden/detached layouts are not a usable measurement. Keep the existing
  // off-screen fallback until the live compact track has real geometry.
  return width !== undefined && Number.isFinite(width) && width > 0
    ? Math.max(80, Math.floor(width)) : null;
}
