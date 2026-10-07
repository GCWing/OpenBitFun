import type { ComponentMeta } from "../../registry.types";

export const radioMeta = {
  category: "form",
  description: "A native radio control with label, description, invalid, and disabled states.",
  maturity: "stable",
  name: "Radio",
  props: [
    { name: "checked", type: "boolean" },
    { name: "readOnly", type: "boolean", defaultValue: "false" },
    { name: "label", type: "ReactNode" },
    { name: "description", type: "ReactNode" },
    { name: "invalid", type: "boolean", defaultValue: "false" },
    { name: "size", type: "sm | md | lg", defaultValue: "md" },
  ],
  states: ["default", "hover", "focus-visible", "checked", "invalid", "disabled"],
  tokens: ["color.content.primary", "color.content.muted", "color.content.disabled", "color.field.background", "color.field.border", "color.accent.default", "color.focus.ring"],
} as const satisfies ComponentMeta;
