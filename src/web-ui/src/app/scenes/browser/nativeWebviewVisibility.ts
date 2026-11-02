// Native child views are outside the document's CSS stacking contexts.
// Keep legacy selectors while shared and custom floating surfaces adopt the marker.
export const NATIVE_WEBVIEW_OCCLUSION_SELECTOR = [
  '[data-openbitfun-native-webview-occlusion]',
  "[data-openbitfun-component='dialog'][data-openbitfun-part='overlay']",
  "[data-openbitfun-component='sheet'][data-openbitfun-part='overlay']",
  '.canvas-mission-control',
  "[data-openbitfun-product-component='context-menu'][data-openbitfun-product-part='root']",
].join(', ');

type Rectangle = Pick<DOMRectReadOnly, 'left' | 'top' | 'right' | 'bottom'>;

export function rectanglesIntersect(first: Rectangle, second: Rectangle): boolean {
  return second.right > first.left && second.left < first.right
    && second.bottom > first.top && second.top < first.bottom;
}

export function hasNativeWebviewOccluder(viewport: HTMLElement, bounds: Rectangle, previousBounds?: Rectangle): boolean {
  const doc = viewport.ownerDocument;
  return Array.from(doc.querySelectorAll<HTMLElement>(NATIVE_WEBVIEW_OCCLUSION_SELECTOR)).some(overlay => {
    // A browser hosted inside a dialog must not be hidden by its own host.
    if (overlay.contains(viewport)) return false;
    const rect = overlay.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 ||
      (!rectanglesIntersect(bounds, rect) && (!previousBounds || !rectanglesIntersect(previousBounds, rect)))) return false;
    const style = doc.defaultView!.getComputedStyle(overlay);
    // Opacity can be zero on the first frame of an entering floating surface.
    // Reserve its bounds through the animation until it is hidden or unmounted.
    return style.display !== 'none' && style.visibility !== 'hidden'
      && style.visibility !== 'collapse';
  });
}

interface NativeView {
  show(): Promise<void>;
  hide(): Promise<void>;
  setFocus(): Promise<void>;
}

/** Serialize native calls and re-read current state after every async boundary. */
export function createNativeWebviewVisibility(
  shouldShow: (view: NativeView) => boolean,
  onVisibilityChanged?: (view: NativeView, visible: boolean) => void,
) {
  const pending = new WeakMap<NativeView, Promise<void>>();
  const applied = new WeakMap<NativeView, boolean>();
  return async (view: NativeView, focus = false): Promise<void> => {
    const operation = (pending.get(view) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const reconcile = async () => {
        let desired = shouldShow(view);
        while (applied.get(view) !== desired) {
          if (desired) {
            await view.show();
            onVisibilityChanged?.(view, true);
          } else {
            onVisibilityChanged?.(view, false);
            await view.hide();
          }
          applied.set(view, desired);
          desired = shouldShow(view);
        }
      };
      await reconcile();
      if (focus && shouldShow(view)) {
        await view.setFocus();
        // A popup or tab switch may have arrived while native focus was pending.
        await reconcile();
      }
    });
    pending.set(view, operation);
    await operation;
  };
}
