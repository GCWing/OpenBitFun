import type { ComponentMeta } from "../../registry.types";

export const iconMeta = {
  category: "primitive",
  description: "Lucide icons with shared size, tone and accessibility, plus reviewed brand-derived mode, reasoning, thinking and Git artwork.",
  maturity: "stable",
  name: "Icon",
  props: [
    { name: "name", type: "IconName" },
    { name: "glyph", type: "LucideIcon" },
    { defaultValue: "lg", name: "size", type: "2xs | xs | sm | md | lg" },
    { defaultValue: "inherit", name: "tone", type: "inherit | primary | secondary | muted | disabled | info | success | warning | danger" },
    { name: "label", type: "string" },
  ],
  states: ["default"],
  tokens: [
    "opacity.iconArtwork",
    "color.content.primary",
    "color.content.secondary",
    "color.content.muted",
    "color.content.disabled",
    "color.status.info.content",
    "color.status.success.content",
    "color.status.warning.content",
    "color.status.danger.content",
    "control.icon.size2xs",
    "control.icon.sizeXs",
    "control.icon.sizeSm",
    "control.icon.sizeMd",
    "control.icon.sizeLg",
  ],
} as const satisfies ComponentMeta;
