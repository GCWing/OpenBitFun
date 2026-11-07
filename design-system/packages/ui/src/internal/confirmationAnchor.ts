import { getOverlayLayerStack } from "../overlay/LayerStack";

/** A user action's origin, captured before a menu can close or its row unmount. */
export interface ConfirmationAnchor {
  element: HTMLElement;
  owner: HTMLElement;
  rect: Pick<DOMRect, "left" | "top" | "right" | "bottom" | "width" | "height">;
}

export function captureConfirmationAnchor(element: HTMLElement | null | undefined): ConfirmationAnchor | undefined {
  if (!element?.isConnected) return undefined;
  const box = element.getBoundingClientRect();
  const stack = getOverlayLayerStack(element.ownerDocument);
  let owner = element;
  let layer = stack.getLayerForElement(owner);
  // A closing menu is not the owner of the next confirmation. Preserve the
  // trigger (and its modal ancestor) rather than attaching to an exiting layer.
  const visited = new Set<HTMLElement>();
  while (layer && !layer.modal && !visited.has(owner)) {
    visited.add(owner);
    const next = layer.ownerElement?.() ?? layer.activationFocus;
    if (!next?.isConnected || next === owner) break;
    owner = next;
    layer = stack.getLayerForElement(owner);
  }
  return {
    element,
    owner,
    rect: { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height },
  };
}
