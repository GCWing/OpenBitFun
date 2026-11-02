export interface CompanionWindowSize {
  width: number;
  height: number;
}

export interface CompanionWindowResizer {
  /** Requests a size; while a request is in flight only the latest one is kept. */
  request: (size: CompanionWindowSize) => void;
  /** The size the dock last asked for, or null before the first request. */
  target: () => CompanionWindowSize | null;
}

/**
 * Serializes pet window resize IPC.
 *
 * Every invoke of an async Tauri command runs as its own task, so two requests
 * sent back to back can reach the host in either order. A stale smaller size
 * landing last leaves the window narrower than the bottom-right anchored dock,
 * which clips the bubbles on the left. Keeping a single request in flight and
 * coalescing the rest to the latest size makes the last request always win.
 */
export function createCompanionWindowResizer(
  send: (size: CompanionWindowSize) => Promise<unknown>,
  onError: (error: unknown) => void,
): CompanionWindowResizer {
  let target: CompanionWindowSize | null = null;
  let pending: CompanionWindowSize | null = null;
  let inFlight = false;

  const drain = async () => {
    inFlight = true;
    try {
      while (pending) {
        const next = pending;
        pending = null;
        try {
          await send(next);
        } catch (error) {
          onError(error);
        }
      }
    } finally {
      inFlight = false;
    }
  };

  return {
    request: size => {
      target = size;
      pending = size;
      if (!inFlight) void drain();
    },
    target: () => target,
  };
}

/**
 * True when the viewport is smaller than the requested size by more than the
 * sub-pixel rounding fractional display scales introduce.
 */
export function isCompanionViewportShort(
  viewport: CompanionWindowSize,
  target: CompanionWindowSize,
): boolean {
  return viewport.width + 1 < target.width || viewport.height + 1 < target.height;
}
