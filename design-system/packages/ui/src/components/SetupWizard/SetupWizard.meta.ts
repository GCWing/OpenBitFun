import type { ComponentMeta } from "../../registry.types";

export const setupWizardMeta = {
  name: "SetupWizard",
  category: "form",
  maturity: "stable",
  description: "A controlled split-pane setup layout with effect-oriented guidance, one current-step indicator, form or editor content, and independent actions.",
  props: [
    { name: "title", type: "ReactNode" },
    { name: "titleId", type: "string" },
    { name: "headerActions", type: "ReactNode" },
    { name: "guideLabel", type: "string" },
    { name: "step", type: "SetupWizardStep" },
    { name: "footer", type: "ReactNode" },
    { name: "contentMode", type: "scroll | contained", defaultValue: "scroll" },
    { name: "children", type: "ReactNode" },
  ],
  states: ["form", "contained", "narrow"],
  tokens: [
    "color.surface.chrome", "color.surface.scene", "color.content.primary", "color.content.muted",
    "space.2", "space.3", "space.4", "space.5", "space.6", "space.8",
    "type.heading.dialog.fontSize", "type.heading.page.fontSize", "type.body.lg.fontSize", "type.label.sm.fontSize",
  ],
} as const satisfies ComponentMeta;
