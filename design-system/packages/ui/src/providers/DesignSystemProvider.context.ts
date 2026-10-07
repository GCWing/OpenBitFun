import { createContext } from "react";
import type {
  ColorScheme,
  ContrastMode,
  DensityMode,
} from "../primitives/ThemeRoot";
import type { OverlayLayerStack } from "../overlay/LayerStack";
import type { OverlayPortalTarget } from "../overlay/types";

export interface DesignSystemMessages {
  clearSelection: string;
  confirmAction: string;
  confirmCancel: string;
  createValue: string;
  dialogClose: string;
  loading: string;
  noOptions: string;
  searchOptions: string;
  selectAll: string;
  selectPlaceholder: string;
  toolCardOpenDetails: string;
  toolCardExpandDetails: string;
  toolCardCollapseDetails: string;
}

export interface DesignSystemContextValue {
  colorScheme: ColorScheme;
  contrast: ContrastMode;
  density: DensityMode;
  locale: string;
  messages: DesignSystemMessages;
  portalHost?: OverlayPortalTarget;
  tooltipDelay: number;
}

export const defaultDesignSystemMessages: DesignSystemMessages = {
  clearSelection: "Clear selection",
  confirmAction: "Confirm",
  confirmCancel: "Cancel",
  createValue: "Use custom value",
  dialogClose: "Close dialog",
  loading: "Loading",
  noOptions: "No options",
  searchOptions: "Search options",
  selectAll: "Select all",
  selectPlaceholder: "Select an option",
  toolCardOpenDetails: "Open details",
  toolCardExpandDetails: "Expand details",
  toolCardCollapseDetails: "Collapse details",
};

export const defaultDesignSystemContext: DesignSystemContextValue = {
  colorScheme: "light",
  contrast: "standard",
  density: "comfortable",
  locale: "en",
  messages: defaultDesignSystemMessages,
  tooltipDelay: 450,
};

export const DesignSystemContext = createContext<DesignSystemContextValue>(
  defaultDesignSystemContext,
);

export const LayerStackContext = createContext<OverlayLayerStack | null>(null);
