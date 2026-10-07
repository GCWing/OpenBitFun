import type { ComponentMeta } from "../../registry.types";

const ambientTokens = [
  "control.flowChat.cardPaddingInline",
  "control.toolCard.fieldLabelWidth",
  "control.flowChat.rowIconSize",
  "control.flowChat.rowIconGap",
  "color.content.primary",
  "color.content.secondary",
  "color.content.muted",
  "color.surface.canvas",
  "color.surface.raised",
  "color.border.default",
  "color.status.danger.content",
  "color.status.success.content",
  "font.family.sans",
  "font.size.sm",
  "font.weight.medium",
  "font.weight.regular",
  "radius.sm",
] as const;

const activityProps = [
  { name: "status", type: "FlowChatToolStatus" },
  { name: "action", type: "ReactNode" },
  { name: "summary", type: "ReactNode" },
  { name: "extra", type: "ReactNode" },
] as const;

const expandableProps = [
  { name: "status", type: "FlowChatToolStatus" },
  { name: "summary", type: "ReactNode" },
  { defaultValue: "false", name: "isExpanded", type: "boolean" },
  { name: "onToggle", type: "() => void" },
] as const;

const searchProps = [
  { name: "status", type: "FlowChatToolStatus" },
  { name: "action", type: "ReactNode" },
  { name: "summary", type: "ReactNode" },
  { defaultValue: "false", name: "isExpanded", type: "boolean" },
  { name: "onToggle", type: "() => void" },
] as const;

export const agentWaitToolCardMeta = {
  category: "flow-chat",
  description: "A concrete ambient card for background-agent wait progress and completion summaries.",
  maturity: "stable",
  name: "AgentWaitToolCard",
  props: [...activityProps,
    { name: "interaction", type: "ToolCardInteraction" },
    { name: "agents", type: "AgentWaitTargets" },
  ],
  states: ["default", "loading", "error"],
  tokens: ambientTokens,
} as const satisfies ComponentMeta;

export const cronToolCardMeta = {
  category: "flow-chat",
  description: "An ambient scheduled-job card with schedule, next-run, and payload details.",
  maturity: "stable",
  name: "CronToolCard",
  props: expandableProps,
  states: ["default", "hover", "loading", "expanded", "error"],
  tokens: ambientTokens,
} as const satisfies ComponentMeta;

export const defaultToolCardMeta = {
  category: "flow-chat",
  description: "The fallback ambient card for a tool summary, sanitized input, result, and confirmation state.",
  maturity: "stable",
  name: "DefaultToolCard",
  props: expandableProps,
  states: ["default", "hover", "loading", "expanded", "confirmation", "error"],
  tokens: ambientTokens,
} as const satisfies ComponentMeta;

export const directoryListToolCardMeta = {
  category: "flow-chat",
  description: "An ambient directory-list card with structured metadata and file results.",
  maturity: "stable",
  name: "DirectoryListToolCard",
  props: searchProps,
  states: ["default", "hover", "loading", "expanded", "error"],
  tokens: ambientTokens,
} as const satisfies ComponentMeta;

export const getToolSpecToolCardMeta = {
  category: "flow-chat",
  description: "A concrete ambient card for loading a tool specification into runtime context.",
  maturity: "stable",
  name: "GetToolSpecToolCard",
  props: activityProps,
  states: ["default", "loading", "error"],
  tokens: ambientTokens,
} as const satisfies ComponentMeta;

export const globSearchToolCardMeta = {
  category: "flow-chat",
  description: "An ambient file-pattern search card with reusable result-list anatomy.",
  maturity: "stable",
  name: "GlobSearchToolCard",
  props: searchProps,
  states: ["default", "hover", "loading", "expanded", "error"],
  tokens: ambientTokens,
} as const satisfies ComponentMeta;

export const grepSearchToolCardMeta = {
  category: "flow-chat",
  description: "An ambient text-search card with query metadata, file-grouped excerpts and aligned line numbers.",
  maturity: "stable",
  name: "GrepSearchToolCard",
  props: [
    ...searchProps,
    { name: "resultBlocks", type: "readonly GrepSearchResultBlock[]" },
    { name: "resultText", type: "string" },
  ],
  states: ["default", "hover", "loading", "expanded", "error"],
  tokens: ambientTokens,
} as const satisfies ComponentMeta;

export const runCodeToolCardMeta = {
  category: "flow-chat",
  description: "An ambient code-execution card with host-rendered program and output slots.",
  maturity: "stable",
  name: "RunCodeToolCard",
  props: expandableProps,
  states: ["default", "hover", "loading", "expanded", "error"],
  tokens: ambientTokens,
} as const satisfies ComponentMeta;

export const sessionControlToolCardMeta = {
  category: "flow-chat",
  description: "An ambient session-lifecycle card with semantic detail fields and session rows.",
  maturity: "stable",
  name: "SessionControlToolCard",
  props: [...expandableProps, { name: "interaction", type: "ToolCardInteraction" }],
  states: ["default", "hover", "loading", "expanded", "error"],
  tokens: ambientTokens,
} as const satisfies ComponentMeta;

export const sessionMessageToolCardMeta = {
  category: "flow-chat",
  description: "An ambient cross-session message card with target details and message content.",
  maturity: "stable",
  name: "SessionMessageToolCard",
  props: [...expandableProps,
    { name: "interaction", type: "ToolCardInteraction" },
    { name: "openAction", type: "{ label: string; onPress: (event: MouseEvent<HTMLButtonElement>) => void }" },
  ],
  states: ["default", "hover", "loading", "expanded", "error"],
  tokens: ambientTokens,
} as const satisfies ComponentMeta;

export const skillToolCardMeta = {
  category: "flow-chat",
  description: "A concrete ambient card for skill loading progress and outcomes.",
  maturity: "stable",
  name: "SkillToolCard",
  props: activityProps,
  states: ["default", "loading", "error"],
  tokens: ambientTokens,
} as const satisfies ComponentMeta;

export const terminalControlToolCardMeta = {
  category: "flow-chat",
  description: "A concrete ambient card for interrupting or terminating a terminal session.",
  maturity: "stable",
  name: "TerminalControlToolCard",
  props: activityProps,
  states: ["default", "loading", "error"],
  tokens: ambientTokens,
} as const satisfies ComponentMeta;

export const todoToolCardMeta = {
  category: "flow-chat",
  description: "A prominent task-progress card with a current-task summary and an expandable list.",
  maturity: "stable",
  name: "TodoToolCard",
  props: expandableProps,
  states: ["default", "hover", "loading", "expanded", "error"],
  tokens: ambientTokens,
} as const satisfies ComponentMeta;

export const viewImageToolCardMeta = {
  category: "flow-chat",
  description: "An ambient image-result card with an expandable preview and accessible lightbox.",
  maturity: "stable",
  name: "ViewImageToolCard",
  props: expandableProps,
  states: ["default", "hover", "loading", "expanded", "error"],
  tokens: ambientTokens,
} as const satisfies ComponentMeta;

export const webFetchToolCardMeta = {
  category: "flow-chat",
  description: "An ambient web-fetch card with source metadata, result actions, and content preview.",
  maturity: "stable",
  name: "WebFetchToolCard",
  props: expandableProps,
  states: ["default", "hover", "loading", "expanded", "error"],
  tokens: ambientTokens,
} as const satisfies ComponentMeta;

export const webSearchToolCardMeta = {
  category: "flow-chat",
  description: "An ambient web-search card with link, snippet, URL, and summary result presentations.",
  maturity: "stable",
  name: "WebSearchToolCard",
  props: searchProps,
  states: ["default", "hover", "loading", "expanded", "error"],
  tokens: ambientTokens,
} as const satisfies ComponentMeta;
