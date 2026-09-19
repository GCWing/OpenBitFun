import { useCallback, useContext, useSyncExternalStore } from "react";
import { LayerStackContext } from "../providers/DesignSystemProvider.context";
import { getOverlayLayerStack } from "./OverlayCoordinator";
import type { OverlayLayerScope } from "./types";

export { OverlayLayerStack, getOverlayLayerStack, type OverlayLayerDescriptor } from "./OverlayCoordinator";

/** Synchronous boundary for host shortcut routers that run before React events. */
export function hasOverlayLayers(ownerDocument?: Document | null): boolean {
  return getOverlayLayerStack(ownerDocument ?? (typeof document === "undefined" ? null : document)).hasLayers();
}

export function useOverlayLayerStack(ownerDocument?: Document | null) {
  const inherited = useContext(LayerStackContext);
  return ownerDocument ? getOverlayLayerStack(ownerDocument)
    : inherited ?? getOverlayLayerStack(typeof document === "undefined" ? null : document);
}

export function useHasOverlayLayers(scope?: OverlayLayerScope): boolean {
  const stack = useOverlayLayerStack();
  useSyncExternalStore(stack.subscribe, stack.getSnapshot, stack.getSnapshot);
  return stack.hasLayers(scope);
}

export function useHasModalOverlay(): boolean {
  const stack = useOverlayLayerStack();
  useSyncExternalStore(stack.subscribe, stack.getSnapshot, stack.getSnapshot);
  return stack.hasModal();
}

export function useOverlayLayerActions() {
  const stack = useOverlayLayerStack();
  const dismissTop = useCallback((scope?: OverlayLayerScope) => stack.dismissTop(scope), [stack]);
  const dismissAll = useCallback(() => stack.dismissAll(), [stack]);
  return { dismissAll, dismissTop };
}
