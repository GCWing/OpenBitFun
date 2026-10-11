import type { ComponentMeta } from "../../registry.types";

export const capsuleMeta = {
  category: "action",
  description: "A capsule composition with a circular glass action floating over its unmodified label. Pointer hover and keyboard focus reveal the action; touch keeps it available.",
  maturity: "stable",
  name: "Capsule",
  props: [
    { name: "children", type: "ReactNode" },
    { name: "action", type: "ReactNode" },
    { name: "size", type: "xs | sm | md | lg", defaultValue: "sm" },
  ],
  states: ["default", "hover", "focus-visible", "disabled"],
  tokens: ["control.button.xsHeight", "control.height.sm", "control.height.md", "control.height.lg", "control.iconButton.xsSize", "color.surface.raised", "color.border.subtle", "effect.blur.subtle", "radius.pill"],
} as const satisfies ComponentMeta;
