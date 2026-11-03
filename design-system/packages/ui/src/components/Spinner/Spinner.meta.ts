import type { ComponentMeta } from "../../registry.types";

export const spinnerMeta = {
  category: "feedback",
  description: "A compact activity indicator with a breathing, rotating double-hexagon logo and a bar presentation.",
  maturity: "stable",
  name: "Spinner",
  props: [
    { defaultValue: "logo", name: "variant", type: "logo | bars (matrix is a legacy alias for logo)" },
    { defaultValue: "md", name: "size", type: "xs | sm | md | lg" },
    { defaultValue: "true", name: "active", type: "boolean" },
    { name: "aria-label", type: "string" },
  ],
  states: ["logo", "bars", "reduced-motion"],
  tokens: [
    "color.content.secondary",
    "color.content.muted",
    "layout.spinner.matrixCellMd",
    "layout.spinner.matrixGapMd",
  ],
} as const satisfies ComponentMeta;

export const loadingStateMeta = {
  category: "feedback",
  description: "A centered loading composition that pairs Spinner with optional support copy.",
  maturity: "stable",
  name: "LoadingState",
  props: [
    { defaultValue: "md", name: "size", type: "xs | sm | md | lg" },
    { name: "children", type: "ReactNode" },
  ],
  states: ["indicator", "with-label"],
  tokens: [
    "color.content.secondary",
    "color.content.muted",
    "space.2",
    "type.support",
  ],
} as const satisfies ComponentMeta;
