import type { ComponentMeta } from "../../registry.types";

const prominentTokens = [
  "color.content.primary",
  "color.content.secondary",
  "color.content.muted",
  "color.surface.canvas",
  "color.surface.raised",
  "color.border.default",
  "color.codeChange.added",
  "color.codeChange.removed",
  "color.status.danger.content",
  "color.status.success.content",
  "color.status.warning.content",
  "font.family.sans",
  "font.size.sm",
  "font.weight.medium",
  "font.weight.regular",
  "radius.sm",
  "shadow.xs",
] as const;

const expandableProps = [
  { name: "status", type: "FlowChatToolStatus" },
  { defaultValue: "false", name: "isExpanded", type: "boolean" },
  { name: "onToggle", type: "() => void" },
] as const;

export const agentControlToolCardMeta = {
  category: "flow-chat",
  description: "An avatar-led agent card with visible type, model and lifecycle status that opens the agent in the host detail pane.",
  maturity: "stable",
  name: "AgentControlToolCard",
  props: [
    { name: "status", type: "FlowChatToolStatus" },
    { name: "agentName", type: "ReactNode" },
    { name: "avatar", type: "ReactNode" },
    { name: "summary", type: "ReactNode" },
    { name: "preview", type: "AgentControlToolCardProps['preview']" },
    { name: "statusLabel", type: "ReactNode" },
    { name: "onOpenAgent", type: "(event: MouseEvent<HTMLButtonElement>) => void" },
    { name: "openAgentLabel", type: "string" },
  ],
  states: ["default", "hover", "loading", "error"],
  tokens: [
    ...prominentTokens, "color.surface.panel", "control.activityItem.surfaceHeight",
    "control.activityItem.surfaceRadius", "control.flowChat.cardGap", "control.flowChat.transcriptMaxWidth",
    "layout.card.paddingMd", "layout.card.gapMd", "layout.card.gapSm",
  ],
} as const satisfies ComponentMeta;

export const fileDiffToolCardMeta = {
  category: "flow-chat",
  description: "A prominent file-diff card with a compact file path, change summary, message, and renderer slot.",
  maturity: "stable",
  name: "FileDiffToolCard",
  props: [
    ...expandableProps,
    { name: "path", type: "string" },
    { name: "pathLabel", type: "ReactNode" },
    { name: "changeSummary", type: "FileDiffToolCardProps['changeSummary']" },
    { name: "preview", type: "ReactNode" },
  ],
  states: ["default", "hover", "loading", "expanded", "error"],
  tokens: [...prominentTokens, "font.family.mono"],
} as const satisfies ComponentMeta;

export const gitToolCardMeta = {
  category: "flow-chat",
  description: "A prominent Git command card with output, warning, failure, and execution metadata.",
  maturity: "stable",
  name: "GitToolCard",
  props: expandableProps,
  states: ["default", "hover", "loading", "expanded", "error"],
  tokens: prominentTokens,
} as const satisfies ComponentMeta;

export const pageDeployToolCardMeta = {
  category: "flow-chat",
  description: "A prominent page-deploy card with version metadata and host-provided actions.",
  maturity: "stable",
  name: "PageDeployToolCard",
  props: expandableProps,
  states: ["default", "hover", "loading", "expanded", "error"],
  tokens: prominentTokens,
} as const satisfies ComponentMeta;

export const pagePublishToolCardMeta = {
  category: "flow-chat",
  description: "A prominent page-publish card with production and preview metadata and actions.",
  maturity: "stable",
  name: "PagePublishToolCard",
  props: expandableProps,
  states: ["default", "hover", "loading", "expanded", "error"],
  tokens: prominentTokens,
} as const satisfies ComponentMeta;

export const reviewSummaryToolCardMeta = {
  category: "flow-chat",
  description: "A prominent review summary with changed files, status, and a host navigation action.",
  maturity: "stable",
  name: "ReviewSummaryToolCard",
  props: expandableProps,
  states: ["default", "hover", "loading", "expanded", "error"],
  tokens: prominentTokens,
} as const satisfies ComponentMeta;
