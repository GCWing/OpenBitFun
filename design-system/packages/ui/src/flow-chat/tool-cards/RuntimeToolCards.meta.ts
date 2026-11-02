import type { ComponentMeta } from "../../registry.types";

const tokens = [
  "control.flowChat.rowIconSize", "control.flowChat.rowIconGap",
  "color.content.primary", "color.content.secondary", "color.content.muted",
  "color.status.danger.content", "space.1", "space.2", "space.3", "space.4",
  "type.body.sm.fontSize", "type.flow.code.fontFamily",
] as const;
const props = [
  { name: "action", type: "ReactNode" }, { name: "summary", type: "ReactNode" },
  { name: "status", type: "FlowChatToolStatus" },
  { name: "isExpanded", type: "boolean", defaultValue: "false" },
  { name: "onToggle", type: "() => void" }, { name: "error", type: "ReactNode" },
] as const;

export const listModelsToolCardMeta = {
  category: "flow-chat", name: "ListModelsToolCard", maturity: "stable",
  description: "An ambient model discovery card with provider, model name, configuration ID, query and empty-result details.",
  props: [...props, { name: "models", type: "readonly ListModelsToolCardModel[]" }, { name: "query", type: "string" }],
  states: ["default", "hover", "loading", "expanded", "error"], tokens,
} as const satisfies ComponentMeta;

export const controlHubToolCardMeta = {
  category: "flow-chat", name: "ControlHubToolCard", maturity: "stable",
  description: "An action-aware browser, terminal and capability card with structured targets, results and recoverable failure details.",
  props: [...props, { name: "attention", type: '"ambient" | "prominent"' },
    { name: "domain", type: '"browser" | "terminal" | "meta" | "unknown"' },
    { name: "fields", type: "readonly ToolCardField[]" }, { name: "records", type: "readonly ControlHubToolCardRecord[]" }],
  states: ["default", "hover", "loading", "expanded", "confirmation", "error"], tokens,
} as const satisfies ComponentMeta;
