import type { ComponentMeta } from "../../registry.types";

export const mobileTabBarMeta = {
  category: "mobile",
  description: "The bottom destination bar: equal-width items, a filled selection pill, and safe-area padding.",
  maturity: "stable",
  name: "MobileTabBar",
  props: [
    { name: "items", type: "readonly MobileTabBarItem[]" },
    { name: "value", type: "string" },
    { name: "defaultValue", type: "string" },
    { name: "onValueChange", type: "(value: string) => void" },
    { name: "label", type: "string" },
    { defaultValue: "surface", name: "appearance", type: '"surface" | "plain"' },
    { defaultValue: "true", name: "safeArea", type: "boolean" },
  ],
  states: ["default", "selected", "hover", "active", "focus-visible", "disabled", "safe-area"],
  tokens: [
    "color.action.neutral.surface.hover",
    "color.action.neutral.surface.pressed",
    "color.content.disabled",
    "color.content.primary",
    "color.content.secondary",
    "color.focus.ring",
    "color.selection.surface",
    "color.surface.panel",
    "radius.md",
    "radius.pill",
    "space.1",
    "space.2",
    "type.label.md.fontWeight",
    "type.label.sm.fontSize",
  ],
} as const satisfies ComponentMeta;
