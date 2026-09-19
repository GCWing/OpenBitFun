import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { getOverlayLayerStack } from "./LayerStack";

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export interface UseFocusScopeOptions {
  active: boolean;
  autoFocus?: boolean;
  containerRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  ownerDocument?: Document | null;
  restoreFocus?: boolean;
  trapFocus?: boolean;
}

export function useFocusScope({
  active, autoFocus = true, containerRef, initialFocusRef, ownerDocument,
  restoreFocus = true, trapFocus = true,
}: UseFocusScopeOptions): void {
  const identity = useRef(Symbol("openbitfun-focus-scope"));
  useIsomorphicLayoutEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    const doc = ownerDocument ?? container?.ownerDocument;
    if (!container || !doc) return;
    const HTMLElementType = doc.defaultView?.HTMLElement;
    return getOverlayLayerStack(doc).registerFocusScope({
      id: identity.current,
      element: container,
      autoFocus,
      trapFocus,
      restoreFocus,
      initialFocus: initialFocusRef?.current,
      previousFocus: HTMLElementType && doc.activeElement instanceof HTMLElementType ? doc.activeElement : null,
    });
  }, [active, autoFocus, containerRef, initialFocusRef, ownerDocument, restoreFocus, trapFocus]);
}
