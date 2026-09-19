import type { RefObject } from "react";
import { getOverlayLayerStack, type OverlayInteractionType } from "./OverlayCoordinator";

/** Custom keyboard/outside behavior shares the painted layer's event ownership. */
export function subscribeOverlayInteraction<K extends OverlayInteractionType>(
  surfaceRef: RefObject<HTMLElement | null>,
  type: K,
  listener: (event: DocumentEventMap[K]) => void,
): () => void {
  const ownerDocument = surfaceRef.current?.ownerDocument
    ?? (typeof document === "undefined" ? null : document);
  return getOverlayLayerStack(ownerDocument).registerInteraction({
    id: Symbol("openbitfun-overlay-interaction"), type,
    element: () => surfaceRef.current,
    listener: event => listener(event as DocumentEventMap[K]),
  });
}
