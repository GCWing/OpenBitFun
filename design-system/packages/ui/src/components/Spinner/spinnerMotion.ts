const CYCLE_MS = 1800;
const FRAME_COUNT = 120;

// One shared clock couples the approved rotation, defocus and subtle scale pulse.
// Sixty degrees closes the sixfold silhouette while preserving the 30-degree
// offset between its two contours throughout the loop.
const keyframes: Keyframe[] = Array.from({ length: FRAME_COUNT + 1 }, (_, index) => {
  const progress = index / FRAME_COUNT;
  const pace = progress + 0.42 * (1 - Math.cos(progress * Math.PI * 2)) / (Math.PI * 2);
  const phase = pace * Math.PI * 2;
  const breath = (1 - Math.cos(phase)) / 2;
  const softness = breath + (2 / 3) * breath * (1 - breath);
  const turn = pace
    - 0.6 * Math.sin(phase) / (Math.PI * 2)
    - 0.1 * Math.sin(phase * 2) / (Math.PI * 4);
  const scale = 1 + 0.026 * Math.cos(phase - 0.35);
  return {
    offset: progress,
    transform: `rotate(${turn * 60}deg) scale(${scale})`,
    opacity: 0.96 - 0.62 * softness,
    // The CSS transform also scales the filtered layer. Compensate so softness
    // remains proportional to the allocated icon size, as in the preview.
    filter: `blur(${0.035 * softness / scale}em)`,
  };
});

export function createSpinnerAnimations(element: HTMLElement): Animation[] {
  return [element.animate(keyframes, {
    duration: CYCLE_MS,
    iterations: Infinity,
    easing: "linear",
  })];
}
