import { create } from 'zustand';
import { subscribeNativeWindowResizeEnd } from '@/infrastructure/runtime/windowResize';

export const useWindowResizeLayout = create(() => ({ measurementSuspended: false }));

// Only full transcript estimation and terminal reflow are merged. CSS layout,
// viewport height and mounted row measurements keep following the window.
const BURST_GAP_MS = 80;
const QUIET_MS = 32;
const MAX_BATCH_MS = 48;

/** One lifecycle per main shell; no overlay, native cover or paint handshake. */
export function startWindowResizeLayout(): () => void {
  let disposed = false;
  let previousWidth = window.innerWidth;
  let previousHeight = window.innerHeight;
  let lastResizeAt = -Infinity;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let batchTimer: ReturnType<typeof setTimeout> | undefined;
  let resumeFrame: number | undefined;

  const publish = (measurementSuspended: boolean) => {
    if (useWindowResizeLayout.getState().measurementSuspended !== measurementSuspended) {
      useWindowResizeLayout.setState({ measurementSuspended });
    }
  };
  const clearTimers = () => {
    clearTimeout(quietTimer); quietTimer = undefined;
    clearTimeout(batchTimer); batchTimer = undefined;
  };
  const release = () => {
    clearTimers();
    publish(false);
    // Leave a layout opportunity after each bounded batch, even when native
    // dragging continues. A trailing debounce alone would freeze wide resizes.
    if (resumeFrame === undefined) {
      resumeFrame = requestAnimationFrame(() => { resumeFrame = undefined; });
    }
  };
  const finish = () => {
    clearTimers();
    if (resumeFrame !== undefined) cancelAnimationFrame(resumeFrame);
    resumeFrame = undefined;
    lastResizeAt = -Infinity;
    publish(false);
  };
  const resized = () => {
    if (document.visibilityState === 'hidden' || window.innerWidth <= 0 || window.innerHeight <= 0) return;
    if (previousWidth === window.innerWidth && previousHeight === window.innerHeight) return;
    previousWidth = window.innerWidth; previousHeight = window.innerHeight;
    const now = performance.now();
    const continuous = now - lastResizeAt < BURST_GAP_MS;
    lastResizeAt = now;
    // Single adjustments and the first maximize frame use ordinary live layout.
    if (!continuous || resumeFrame !== undefined) return;
    publish(true);
    clearTimeout(quietTimer);
    quietTimer = setTimeout(release, QUIET_MS);
    // Deliberately not restarted by subsequent resize events.
    batchTimer ??= setTimeout(release, MAX_BATCH_MS);
  };
  const visibilityChanged = () => {
    if (document.visibilityState === 'hidden') finish();
  };
  const stopNative = subscribeNativeWindowResizeEnd(() => { if (!disposed) finish(); });
  window.addEventListener('resize', resized);
  document.addEventListener('visibilitychange', visibilityChanged);
  return () => {
    disposed = true;
    stopNative();
    window.removeEventListener('resize', resized);
    document.removeEventListener('visibilitychange', visibilityChanged);
    finish();
  };
}
