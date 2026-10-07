import { useContext, useMemo, type ReactNode } from "react";
import { ApplicationTitleTooltips, ApplicationTitleTooltipsContext } from "./ApplicationTitleTooltips";
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
  /** Set at the document root to route legacy HTML title hints through Tooltip. */
  nativeTooltipPolicy?: "native" | "application";
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
  nativeTooltipPolicy = "native",
}: DesignSystemProviderProps) {
  const ownerDocument = resolvePortalTarget(portalHost)?.ownerDocument;
  const layerStack = getOverlayLayerStack(ownerDocument);
  const inheritedTitlePolicy = useContext(ApplicationTitleTooltipsContext);
  const applicationTitles = inheritedTitlePolicy || nativeTooltipPolicy === "application";
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
        <ApplicationTitleTooltipsContext.Provider value={applicationTitles}>
          {children}
          {applicationTitles && !inheritedTitlePolicy && ownerDocument && (
            <ApplicationTitleTooltips ownerDocument={ownerDocument} />
          )}
        </ApplicationTitleTooltipsContext.Provider>
      </LayerStackContext.Provider>
    </DesignSystemContext.Provider>
  );
}
