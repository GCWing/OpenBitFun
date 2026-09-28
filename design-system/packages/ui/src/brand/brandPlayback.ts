/** Own only decorative playback; applications own the state that enables it. */
export function startBrandPlayback(element: Element, createAnimations: () => Animation[]): () => void {
  const document = element.ownerDocument;
  const window = document.defaultView;
  if (!window?.matchMedia || typeof element.animate !== "function") return () => {};
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let animations: Animation[] = [];
  let visible = true;

  const synchronize = () => {
    if (reducedMotion.matches) {
      animations.forEach(animation => animation.cancel());
      animations = [];
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
    animations.forEach(animation => animation.cancel());
    observer?.disconnect();
    reducedMotion.removeEventListener("change", synchronize);
    document.removeEventListener("visibilitychange", synchronize);
  };
}
