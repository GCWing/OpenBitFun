export {
  hasOverlayLayers,
  useHasOverlayLayers,
  useHasModalOverlay,
  useOverlayLayerActions,
  type OverlayLayerDescriptor,
} from "./LayerStack";
export { Portal, OverlayRegion, OverlayLayer, createOverlayPortal, getOverlayHost, resolvePortalTarget, type PortalProps } from "./Portal";
export {
  useDismissibleLayer,
  type UseDismissibleLayerOptions,
} from "./useDismissibleLayer";
export { useFocusScope, type UseFocusScopeOptions } from "./useFocusScope";
export { subscribeOverlayInteraction } from "./subscribeOverlayInteraction";
export { usePresence, type PresenceSnapshot, type PresenceState } from "./usePresence";
export { useScrollLock } from "./useScrollLock";
export type {
  OverlayDismissReason,
  OverlayLayerScope,
  OverlayPortalContainer,
  OverlayPortalTarget,
} from "./types";
