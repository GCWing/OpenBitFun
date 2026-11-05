/** Own only decorative playback; applications own the state that enables it. */
export function startBrandPlayback(element: Element, createAnimations: () => Animation[]): () => void {
  const document = element.ownerDocument;
  const window = document.defaultView;
  if (!window?.matchMedia || typeof element.animate !== "function") return () => {};
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let animations: Animation[] = [];
  let visible = true;
  const disposeAnimations = () => {
    animations.forEach(animation => {
      animation.cancel();
      // Cancellation stops playback, but the effect still owns its target and
      // keyframes. Release that graph when this playback lifetime ends.
      animation.effect = null;
    });
    animations = [];
  };

  const synchronize = () => {
    if (reducedMotion.matches) {
      disposeAnimations();
    } else if (document.hidden || !visible) {
      animations.forEach(animation => animation.pause());
    } else if (animations.length === 0) {
      animations = createAnimations();
    } else {
      animations.forEach(animation => animation.play());
    }
  };
  const observer = typeof IntersectionObserver === "undefined" ? undefined : new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false;
    synchronize();
  });
  observer?.observe(element);
  synchronize();
  reducedMotion.addEventListener("change", synchronize);
  document.addEventListener("visibilitychange", synchronize);
  return () => {
    disposeAnimations();
    observer?.disconnect();
    reducedMotion.removeEventListener("change", synchronize);
    document.removeEventListener("visibilitychange", synchronize);
  };
}
