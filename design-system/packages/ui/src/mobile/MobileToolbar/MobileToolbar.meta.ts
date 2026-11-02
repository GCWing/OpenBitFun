import type { ComponentMeta } from "../../registry.types";

export const mobileToolbarMeta = {
  category: "mobile",
  description: "A bottom action bar with leading, middle, and trailing slots that keeps clear of the home indicator.",
  maturity: "stable",
  name: "MobileToolbar",
  props: [
    { name: "leading", type: "ReactNode" },
    { name: "children", type: "ReactNode" },
    { name: "trailing", type: "ReactNode" },
    { name: "label", type: "string" },
    { defaultValue: "surface", name: "appearance", type: '"surface" | "plain"' },
    { defaultValue: "true", name: "safeArea", type: "boolean" },
    { defaultValue: "false", name: "sticky", type: "boolean" },
  ],
  states: ["default", "plain", "sticky", "safe-area"],
  tokens: [
    "color.surface.panel",
    "shadow.sm",
    "space.2",
    "space.3",
    "space.4",
  ],
} as const satisfies ComponentMeta;
