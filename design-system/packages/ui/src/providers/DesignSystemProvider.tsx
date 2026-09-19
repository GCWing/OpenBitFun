import { useMemo, type ReactNode } from "react";
import type {
  ColorScheme,
  ContrastMode,
  DensityMode,
} from "../primitives/ThemeRoot";
import { getOverlayLayerStack } from "../overlay/LayerStack";
import { resolvePortalTarget } from "../overlay/Portal";
import type { OverlayPortalTarget } from "../overlay/types";
import {
  defaultDesignSystemContext,
  defaultDesignSystemMessages,
  DesignSystemContext,
  LayerStackContext,
  type DesignSystemContextValue,
  type DesignSystemMessages,
} from "./DesignSystemProvider.context";

export interface DesignSystemProviderProps {
  children: ReactNode;
  colorScheme?: ColorScheme;
  contrast?: ContrastMode;
  density?: DensityMode;
  locale?: string;
  messages?: Partial<DesignSystemMessages>;
  portalHost?: OverlayPortalTarget;
  tooltipDelay?: number;
}

export function DesignSystemProvider({
  children,
  colorScheme = defaultDesignSystemContext.colorScheme,
  contrast = defaultDesignSystemContext.contrast,
  density = defaultDesignSystemContext.density,
  locale = defaultDesignSystemContext.locale,
  messages,
  portalHost,
  tooltipDelay = defaultDesignSystemContext.tooltipDelay,
}: DesignSystemProviderProps) {
  const layerStack = getOverlayLayerStack(resolvePortalTarget(portalHost)?.ownerDocument);
  const value = useMemo<DesignSystemContextValue>(() => ({
    colorScheme,
    contrast,
    density,
    locale,
    messages: { ...defaultDesignSystemMessages, ...messages },
    portalHost,
    tooltipDelay,
  }), [colorScheme, contrast, density, locale, messages, portalHost, tooltipDelay]);

  return (
    <DesignSystemContext.Provider value={value}>
      <LayerStackContext.Provider value={layerStack}>
        {children}
      </LayerStackContext.Provider>
    </DesignSystemContext.Provider>
  );
}
