import type { ComponentMeta } from "../../registry.types";

const tokens = ["space.1", "space.2", "space.3", "space.5", "radius.sm",
  "color.content.primary", "color.content.secondary", "color.content.muted", "color.status.danger.content",
  "type.body.sm.fontFamily", "type.body.sm.fontSize", "type.body.sm.fontWeight", "type.body.sm.lineHeight",
  "type.label.lg.fontWeight"] as const;
const props = [
  { name: "action", type: "ReactNode" }, { name: "summary", type: "ReactNode" },
  { name: "status", type: "FlowChatToolStatus" }, { name: "attention", type: '"ambient" | "prominent"' },
  { name: "fields", type: "readonly ToolCardField[]" }, { name: "records", type: "readonly SemanticToolCardRecord[]" },
  { name: "sections", type: "readonly SemanticToolCardSection[]" }, { name: "outcome", type: "{ label: ReactNode; tone: StatusPillTone }" },
  { name: "actions", type: "readonly SemanticToolCardAction[]" }, { name: "isExpanded", type: "boolean", defaultValue: "false" },
  { name: "onToggle", type: "() => void" },
] as const;
const states = ["default", "hover", "loading", "expanded", "confirmation", "error"] as const;

export const semanticToolCardMetas = [
  {
    category: "flow-chat", name: "GoalToolCard", maturity: "stable",
    description: "Thread goals with recorded status, objective and explicit budget usage.",
    props, states, tokens,
  },
  {
    category: "flow-chat", name: "AgentRosterToolCard", maturity: "stable",
    description: "Child-agent identities, recorded states and permanent subtree deletion results.",
    props, states, tokens,
  },
  {
    category: "flow-chat", name: "SessionHistoryToolCard", maturity: "stable",
    description: "Exported session history, turn selection, transcript and index locations.",
    props, states, tokens,
  },
  {
    category: "flow-chat", name: "ImageAnalysisToolCard", maturity: "stable",
    description: "Vision analysis with source image, question and readable findings.",
    props, states, tokens,
  },
  {
    category: "flow-chat", name: "TimeToolCard", maturity: "stable",
    description: "The recorded local and UTC time, offset and timestamps.",
    props, states, tokens,
  },
  {
    category: "flow-chat", name: "McpResourceToolCard", maturity: "stable",
    description: "MCP resource and prompt discovery, content and source identities.",
    props, states, tokens,
  },
  {
    category: "flow-chat", name: "WorktreeToolCard", maturity: "stable",
    description: "Worktree inspection, isolated sessions, branch creation and safe removal.",
    props, states, tokens,
  },
  {
    category: "flow-chat", name: "PortForwardToolCard", maturity: "stable",
    description: "SSH forwarding endpoints, actual bound ports and access scope.",
    props, states, tokens,
  },
  {
    category: "flow-chat", name: "ReviewPlatformToolCard", maturity: "stable",
    description: "Hosted pull-request reads, review mutations and credential-safe details.",
    props, states, tokens,
  },
  {
    category: "flow-chat", name: "FrontendWorkbenchToolCard", maturity: "stable",
    description: "Frontend customization drafts, activation outcomes and rollback evidence.",
    props, states, tokens,
  },
  {
    category: "flow-chat", name: "MiniAppFinalizeToolCard", maturity: "stable",
    description: "MiniApp compilation, version and content-change results.",
    props, states, tokens,
  },
  {
    category: "flow-chat", name: "MarketplacePublishToolCard", maturity: "stable",
    description: "Marketplace authorization, submission and review outcomes.",
    props, states, tokens,
  },
  {
    category: "flow-chat", name: "PlaybookToolCard", maturity: "stable",
    description: "Resolved operation guides and ordered steps, independent of execution.",
    props, states, tokens,
  },
] as const satisfies readonly ComponentMeta[];
