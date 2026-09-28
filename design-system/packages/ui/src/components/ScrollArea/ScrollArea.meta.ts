import type { ComponentMeta } from "../../registry.types";

export const scrollAreaMeta = {
  category: "primitive",
  description: "Provides native scrolling with consistent orientation, scrollbar visibility, and optional inner edge fades.",
  maturity: "stable",
  name: "ScrollArea",
  props: [
    { defaultValue: "vertical", name: "orientation", type: "vertical | horizontal | both" },
    { defaultValue: "auto", name: "scrollbarVisibility", type: "auto | hover | always | hidden" },
    { defaultValue: "none", name: "edgeFade", type: "none | vertical" },
    { defaultValue: "contain", name: "overscrollBehaviorY", type: "auto | contain" },
  ],
  states: ["auto", "hover", "always", "hidden"],
  tokens: [
    "color.content.onLight",
    "color.scrollbar.thumb",
    "color.scrollbar.thumbHover",
    "scrollbar.width",
    "scrollbar.radius",
    "layout.scrollArea.fadeExtent",
  ],
} as const satisfies ComponentMeta;
