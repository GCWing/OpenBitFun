import type { ComponentMeta } from "../../registry.types";

export const checkboxMeta = {
  category: "form",
  description: "A native checkbox with indeterminate, invalid, label, and description states.",
  maturity: "stable",
  name: "Checkbox",
  props: [
    { name: "appearance", type: "custom | native", defaultValue: "custom" },
    { name: "checked", type: "boolean" },
    { name: "readOnly", type: "boolean", defaultValue: "false" },
    { name: "indeterminate", type: "boolean", defaultValue: "false" },
    { name: "invalid", type: "boolean", defaultValue: "false" },
    { name: "label", type: "ReactNode" },
    { name: "description", type: "ReactNode" },
    { name: "size", type: "sm | md | lg", defaultValue: "md" },
  ],
  states: ["default", "hover", "focus-visible", "checked", "indeterminate", "invalid", "disabled"],
  tokens: ["color.content.primary", "color.content.muted", "color.content.disabled", "color.field.background", "color.field.border", "color.accent.default", "color.focus.ring"],
} as const satisfies ComponentMeta;
