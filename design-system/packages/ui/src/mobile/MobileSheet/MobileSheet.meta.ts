import type { ComponentMeta } from "../../registry.types";

export const mobileSheetMeta = {
  category: "mobile",
  description: "A safe-area-aware mobile bottom sheet with shared dismissal, focus, and scroll-lock behavior.",
  maturity: "stable",
  name: "MobileSheet",
  props: [
    { name: "open", type: "boolean" },
    { name: "title", type: "ReactNode" },
    { name: "description", type: "ReactNode" },
    { name: "footer", type: "ReactNode" },
    { defaultValue: "true", name: "showHandle", type: "boolean" },
    { name: "onOpenChange", type: "(open: false, reason: MobileSheetCloseReason) => void" },
    { name: "headerAction", type: "ReactNode" },
  ],
  states: ["closed", "open", "exiting", "narrow", "wide"],
  tokens: [
    "color.border.strong",
    "color.border.subtle",
    "color.content.primary",
    "color.surface.panel",
    "radius.2xl",
    "radius.pill",
    "shadow.overlay",
    "space.2",
    "space.3",
    "space.4",
    "space.12",
  ],
} as const satisfies ComponentMeta;
