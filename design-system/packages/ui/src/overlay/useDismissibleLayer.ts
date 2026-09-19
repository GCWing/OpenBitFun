import { useEffect, useRef, type RefObject } from "react";
import { getOverlayLayerStack } from "./LayerStack";
import type { OverlayDismissReason, OverlayLayerScope } from "./types";

export interface UseDismissibleLayerOptions {
  branchRefs?: readonly RefObject<HTMLElement | null>[];
  containsTarget?: (target: Node) => boolean;
  dismissOnEscape?: boolean;
  dismissOnPointerOutside?: boolean;
  enabled: boolean;
  layerRef: RefObject<HTMLElement | null>;
  onDismiss: (reason: OverlayDismissReason) => void;
  ownerDocument?: Document | null;
  scope?: OverlayLayerScope;
}

/** Adds interaction policy to the painted layer; never allocates another z-index. */
export function useDismissibleLayer(options: UseDismissibleLayerOptions): symbol {
  const identityRef = useRef(Symbol("openbitfun-overlay-dismissal"));
  const latest = useRef(options);
  latest.current = options;
  const { enabled, layerRef, ownerDocument, scope } = options;

  useEffect(() => {
    if (!enabled) return;
    const documentOwner = ownerDocument ?? layerRef.current?.ownerDocument
      ?? (typeof document === "undefined" ? null : document);
    const stack = getOverlayLayerStack(documentOwner);
    return stack.register({
      id: identityRef.current,
      scope,
      element: () => latest.current.layerRef.current,
      onDismiss: reason => latest.current.onDismiss(reason),
      get dismissOnEscape() { return latest.current.dismissOnEscape; },
      get dismissOnPointerOutside() { return latest.current.dismissOnPointerOutside; },
      containsTarget: target => Boolean(latest.current.branchRefs?.some(branch => branch.current?.contains(target))
        || latest.current.containsTarget?.(target)),
    });
  }, [enabled, layerRef, ownerDocument, scope]);
  return identityRef.current;
}
