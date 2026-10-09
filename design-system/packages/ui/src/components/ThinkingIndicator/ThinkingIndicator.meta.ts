import type { ComponentMeta } from "../../registry.types";

export const thinkingIndicatorMeta = {
  category: "feedback",
  description: "The thinking mark forms node by node, holds its complete shape, then dissolves in reverse order.",
  maturity: "stable",
  name: "ThinkingIndicator",
  props: [
    { defaultValue: "true", name: "active", type: "boolean" },
    { defaultValue: "sm", name: "size", type: "2xs | xs | sm | md | lg" },
    { name: "label", type: "string" },
  ],
  states: ["active", "static"],
  tokens: ["control.icon.size2xs", "control.icon.sizeXs", "control.icon.sizeSm", "control.icon.sizeMd", "control.icon.sizeLg"],
} as const satisfies ComponentMeta;
