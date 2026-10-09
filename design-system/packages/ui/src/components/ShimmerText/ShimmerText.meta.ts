import type { ComponentMeta } from "../../registry.types";

export const shimmerTextMeta = {
  category: "primitive",
  description: "A slow, softly feathered fade across activity text that keeps every glyph visible, with static fallbacks for reduced motion, high contrast and print.",
  maturity: "stable",
  name: "ShimmerText",
  props: [
    { name: "children", type: "ReactNode" },
    { name: "active", type: "boolean", defaultValue: "true" },
  ],
  states: ["default", "static"],
  tokens: ["color.content.primary", "motion.duration.loop"],
} as const satisfies ComponentMeta;
