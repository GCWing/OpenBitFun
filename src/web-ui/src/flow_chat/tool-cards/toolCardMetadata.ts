import { dedicatedToolNames } from '@openbitfun/flow-chat-presentation/registry';
/**
 * Tool-card metadata and lightweight helpers.
 *
 * Keep this module free of card component imports so startup-visible callers can
 * inspect tool behavior without pulling heavy renderers into the first bundle.
 */

import type { FlowItem, FlowToolItem, ToolCardConfig } from '../types/flow-chat';
import { isMcpToolName, parseMcpToolName } from '@/infrastructure/mcp/toolName';
import { APPEARANCE_DOMAIN_TOKENS } from '@/infrastructure/appearance/appearanceDomainTokens';
import { getEffectiveToolName, projectEffectiveToolItem } from '../utils/toolInvocationIdentity';
import { getOpenBitFunControlInput, isOpenBitFunControlDiscovery } from './openBitFunControlCardModel';
import { isShellToolName } from '../grouping/activityClassification';
import { getControlHubInput, isControlHubObservation } from './runtimeToolCardModel';
import { SEMANTIC_BUILTIN_TOOL_NAMES, getBuiltinToolInput, getBuiltinToolAttention, isSemanticBuiltinTool } from './builtinToolCardPolicy';
import { readInteractionInput, readToolRecord } from './toolInteractionModel';

type ToolCardDefinition = Omit<ToolCardConfig, 'attention' | 'presentation'>;

const AMBIENT_TOOL_CARD_NAMES = new Set([
  'Read',
  'Delete',
  'Grep',
  'Glob',
  'LS',
  'WebSearch',
  'WebFetch',
  'AgentWait',
  'GetToolSpec',
  'ListModels',
  'Skill',
  'TerminalControl',
  'ListWorkspaces',
  'SessionControl',
  'SessionMessage',
  'AgentSendInput',
  'AgentInterrupt',
  'Cron',
  'RunCode',
  'ComputerUse',
  'view_image',
]);

const PROMINENT_TOOL_CARD_NAMES = new Set([
  'TodoWrite',
  'OpenBitFunControl',
  'ControlHub',
  'Write',
  'Edit',
  'Task',
  'LaunchReviewAgent',
  'AgentSpawn',
  'submit_code_review',
  'ContextCompression',
  'ReviewSessionSummary',
  'Git',
  'GetFileDiff',
  'InitMiniApp',
  'PageDeploy',
  'PagePublish',
  'GenerativeUI',
  'CreateCanvas',
  'ReadCanvas',
  'UpdateCanvas',
  'PatchCanvas',
]);

export const DEDICATED_TOOL_CARD_PRESENTATION_NAMES = new Set([
  'AskUserQuestion',
  'CreatePlan',
]);

function getToolCardClassification(toolName: string): Pick<ToolCardConfig, 'attention' | 'presentation'> {
  if (isSemanticBuiltinTool(toolName)) {
    return { attention: getBuiltinToolAttention(toolName), presentation: 'standard' };
  }
  if (DEDICATED_TOOL_CARD_PRESENTATION_NAMES.has(toolName)) {
    return { attention: 'prominent', presentation: 'dedicated' };
  }

  return {
    attention: AMBIENT_TOOL_CARD_NAMES.has(toolName) || isShellToolName(toolName)
      ? 'ambient'
      : PROMINENT_TOOL_CARD_NAMES.has(toolName)
        ? 'prominent'
        : 'ambient',
    presentation: 'standard',
  };
}

// Tool card config map - uses backend tool names
const TOOL_CARD_DEFINITIONS: Record<string, ToolCardDefinition> = {
  ...Object.fromEntries(SEMANTIC_BUILTIN_TOOL_NAMES.map(toolName => [toolName, {
    toolName, displayName: toolName, icon: '', requiresConfirmation: false,
    resultDisplayType: 'detailed', displayMode: 'standard',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.toolIdentity.assistantAction,
  } satisfies ToolCardDefinition])),
  'ListModels': {
    toolName: 'ListModels', displayName: 'List Models', icon: '',
    requiresConfirmation: false, resultDisplayType: 'detailed', displayMode: 'compact',
    description: 'List enabled models and their configured identities',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.toolIdentity.assistantAction,
  },
  'ControlHub': {
    toolName: 'ControlHub', displayName: 'Control Hub', icon: '',
    requiresConfirmation: false, resultDisplayType: 'detailed', displayMode: 'standard',
    description: 'Control browsers and terminals or inspect available capabilities',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.toolIdentity.assistantAction,
  },
  'OpenBitFunControl': {
    toolName: 'OpenBitFunControl',
    displayName: 'OpenBitFun',
    icon: 'CONTROL',
    requiresConfirmation: false,
    resultDisplayType: 'detailed',
    description: 'Discover and control OpenBitFun features and settings',
    displayMode: 'standard',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.toolIdentity.assistantAction,
  },
  // File tools
  'Read': {
    toolName: 'Read',
    displayName: 'Read File',
    icon: 'R',
    requiresConfirmation: false,
    resultDisplayType: 'summary',
    description: 'Read file contents',
    displayMode: 'compact',
    primaryColor: 'var(--openbitfun-color-accent-hover)'
  },
  'Write': {
    toolName: 'Write',
    displayName: 'Write File',
    icon: 'W',
    requiresConfirmation: false, // Snapshot system handles confirmation.
    resultDisplayType: 'summary',
    description: 'Write or create a file',
    displayMode: 'standard',
    primaryColor: 'var(--openbitfun-color-status-success-content)'
  },
  'Edit': {
    toolName: 'Edit',
    displayName: 'Edit File',
    icon: 'E',
    requiresConfirmation: false, // Snapshot system handles confirmation.
    resultDisplayType: 'detailed',
    description: 'Edit file contents',
    displayMode: 'standard',
    primaryColor: 'var(--openbitfun-color-status-warning-content)'
  },
  'Delete': {
    toolName: 'Delete',
    displayName: 'Delete File',
    icon: 'D',
    requiresConfirmation: false, // Snapshot system handles confirmation.
    resultDisplayType: 'summary',
    description: 'Delete a file',
    displayMode: 'detailed',
    primaryColor: 'var(--openbitfun-color-status-danger-content)'
  },
  'LS': {
    toolName: 'LS',
    displayName: 'List Directory',
    icon: 'L',
    requiresConfirmation: false,
    resultDisplayType: 'summary',
    description: 'List directory contents',
    displayMode: 'compact',
    primaryColor: 'var(--openbitfun-domain-tool-search)'
  },

  // Search tools
  'Grep': {
    toolName: 'Grep',
    displayName: 'Text Search',
    icon: 'G',
    requiresConfirmation: false,
    resultDisplayType: 'detailed',
    description: 'Search text in files',
    displayMode: 'compact',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.toolIdentity.search
  },
  'Glob': {
    toolName: 'Glob',
    displayName: 'File Search',
    icon: 'F',
    requiresConfirmation: false,
    resultDisplayType: 'summary',
    description: 'Search files by pattern',
    displayMode: 'compact',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.toolIdentity.search
  },

  // Web tools
  'WebSearch': {
    toolName: 'WebSearch',
    displayName: 'Web Search',
    icon: 'WS',
    requiresConfirmation: false,
    resultDisplayType: 'detailed',
    description: 'Search the web',
    displayMode: 'compact',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.toolIdentity.reviewSummary
  },
  'WebFetch': {
    toolName: 'WebFetch',
    displayName: 'Read Webpage',
    icon: 'WF',
    requiresConfirmation: false,
    resultDisplayType: 'detailed',
    description: 'Fetch webpage content',
    displayMode: 'standard',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.toolIdentity.webSearch
  },

  // Advanced tools
  'Task': {
    toolName: 'Task',
    displayName: 'Run Task',
    icon: '',
    requiresConfirmation: false,
    resultDisplayType: 'detailed',
    description: 'Run a specialized AI task',
    displayMode: 'detailed',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.toolIdentity.assistantAction
  },
  'AgentSpawn': {
    toolName: 'AgentSpawn',
    displayName: 'Launch Agent',
    icon: '',
    requiresConfirmation: false,
    resultDisplayType: 'detailed',
    description: 'Launch a background agent',
    displayMode: 'detailed',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.toolIdentity.assistantAction
  },
  'AgentSendInput': {
    toolName: 'AgentSendInput',
    displayName: 'Send Agent Input',
    icon: '',
    requiresConfirmation: false,
    resultDisplayType: 'detailed',
    description: 'Send a follow-up instruction to an agent',
    displayMode: 'detailed',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.toolIdentity.assistantAction
  },
  'AgentInterrupt': {
    toolName: 'AgentInterrupt',
    displayName: 'Interrupt Agent',
    icon: '',
    requiresConfirmation: false,
    resultDisplayType: 'detailed',
    description: 'Interrupt active background work for an agent',
    displayMode: 'standard',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.toolIdentity.assistantAction
  },
  'AgentWait': {
    toolName: 'AgentWait',
    displayName: 'Wait for Agents',
    icon: 'WAIT',
    requiresConfirmation: false,
    resultDisplayType: 'summary',
    description: 'Wait for background agent results',
    displayMode: 'compact',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.toolIdentity.assistantAction
  },
  'TodoWrite': {
    toolName: 'TodoWrite',
    displayName: 'Task Manager',
    icon: 'T',
    requiresConfirmation: false,
    resultDisplayType: 'summary',
    description: 'Manage task lists',
    displayMode: 'standard',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.todo
  },
  'submit_code_review': {
    toolName: 'submit_code_review',
    displayName: 'Code Review',
    icon: 'CR',
    requiresConfirmation: false,
    resultDisplayType: 'detailed',
    description: 'Submit code review results',
    displayMode: 'compact',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.toolIdentity.assistantAction
  },
  'ContextCompression': {
    toolName: 'ContextCompression',
    displayName: 'Context Compression',
    icon: 'CC',
    requiresConfirmation: false,
    resultDisplayType: 'detailed',
    description: 'Compress conversation context to reduce tokens',
    displayMode: 'compact',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.contextCompression
  },
  'GetToolSpec': {
    toolName: 'GetToolSpec',
    displayName: 'Read Tool Spec',
    icon: 'SPEC',
    requiresConfirmation: false,
    resultDisplayType: 'detailed',
    description: 'Read usage instructions and schema for a deferred tool',
    displayMode: 'compact',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.tealAction
  },

  // Skill tool
  'Skill': {
    toolName: 'Skill',
    displayName: 'Skill',
    icon: 'S',
    requiresConfirmation: false,
    resultDisplayType: 'detailed',
    description: 'Load and run skills',
    displayMode: 'compact',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.toolIdentity.assistantAction
  },

  // AskUserQuestion tool
  'AskUserQuestion': {
    toolName: 'AskUserQuestion',
    displayName: 'Ask User',
    icon: 'Q',
    requiresConfirmation: false,
    resultDisplayType: 'detailed',
    description: 'Ask the user a question and wait for a reply',
    displayMode: 'detailed',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.toolIdentity.assistantAction
  },

  'ReviewSessionSummary': {
    toolName: 'ReviewSessionSummary',
    displayName: 'Review summary',
    icon: 'REV',
    requiresConfirmation: false,
    resultDisplayType: 'hidden',
    description: 'Review session summary marker',
    displayMode: 'detailed',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.toolIdentity.reviewSummary
  },

  // GetFileDiff tool
  'GetFileDiff': {
    toolName: 'GetFileDiff',
    displayName: 'File Diff',
    icon: 'DIFF',
    requiresConfirmation: false, // Read-only tool.
    resultDisplayType: 'detailed',
    description: 'Get file diffs (Baseline/Git/Full)',
    displayMode: 'compact',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.toolIdentity.git
  },

  // Legacy CreatePlan history remains displayable after runtime tool removal.
  'CreatePlan': {
    toolName: 'CreatePlan',
    displayName: 'Create Plan',
    icon: 'PLAN',
    requiresConfirmation: false,
    resultDisplayType: 'detailed',
    description: 'Create and manage project plans',
    displayMode: 'detailed',
    primaryColor: 'var(--openbitfun-color-status-warning-content)'
  },

  'ListWorkspaces': {
    toolName: 'ListWorkspaces',
    displayName: 'List Workspaces',
    icon: 'LW',
    requiresConfirmation: false,
    resultDisplayType: 'summary',
    description: 'Discover registered local and remote workspaces',
    displayMode: 'compact',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.toolIdentity.assistantAction
  },

  'SessionControl': {
    toolName: 'SessionControl',
    displayName: 'Session Control',
    icon: 'SC',
    requiresConfirmation: false,
    resultDisplayType: 'summary',
    description: 'Create, delete, or list sessions',
    displayMode: 'compact',
    primaryColor: 'var(--openbitfun-color-accent-hover)'
  },

  'SessionMessage': {
    toolName: 'SessionMessage',
    displayName: 'Session Message',
    icon: 'SM',
    requiresConfirmation: false,
    resultDisplayType: 'summary',
    description: 'Send a message to another session',
    displayMode: 'compact',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.toolIdentity.assistantAction
  },

  'Cron': {
    toolName: 'Cron',
    displayName: 'Scheduled Job',
    icon: 'CRON',
    requiresConfirmation: false,
    resultDisplayType: 'summary',
    description: 'Create, update, list, or run scheduled jobs',
    displayMode: 'compact',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.toolIdentity.assistantAction
  },

  // Code-mode agents (e.g. DeepSeek Harness's PTC preset) answer a step by
  // writing one program instead of calling one tool per action.
  'RunCode': {
    toolName: 'RunCode',
    displayName: 'Run Code',
    icon: 'CODE',
    requiresConfirmation: false,
    resultDisplayType: 'detailed',
    description: 'Run a program and show what it printed',
    displayMode: 'standard',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.toolIdentity.terminal
  },

  'ExecCommand': {
    toolName: 'ExecCommand',
    displayName: 'Run Command',
    icon: 'TERM',
    requiresConfirmation: false,
    resultDisplayType: 'detailed',
    description: 'Run a command in a fresh process',
    displayMode: 'standard',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.toolIdentity.terminal
  },

  'WriteStdin': {
    toolName: 'WriteStdin',
    displayName: 'Write Input',
    icon: 'TERM',
    requiresConfirmation: false,
    resultDisplayType: 'detailed',
    description: 'Write to or poll a running command process',
    displayMode: 'standard',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.toolIdentity.terminal
  },

  'ExecControl': {
    toolName: 'ExecControl',
    displayName: 'Control Process',
    icon: 'TERM',
    requiresConfirmation: false,
    resultDisplayType: 'detailed',
    description: 'Interrupt or kill a running command process',
    displayMode: 'standard',
    primaryColor: 'var(--openbitfun-color-status-danger-content)'
  },

  // MiniApp tool
  'InitMiniApp': {
    toolName: 'InitMiniApp',
    displayName: 'Init Mini App',
    icon: 'APP',
    requiresConfirmation: false,
    resultDisplayType: 'detailed',
    description: 'Create Mini App skeleton for editing',
    displayMode: 'standard',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.miniApp
  },
  'FinalizeMiniApp': {
    toolName: 'FinalizeMiniApp',
    displayName: 'Finalize Mini App',
    icon: 'APP',
    requiresConfirmation: false,
    resultDisplayType: 'detailed',
    description: 'Compile Mini App edits and refresh open runtimes',
    displayMode: 'standard',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.miniApp
  },
  'PublishMiniApp': {
    toolName: 'PublishMiniApp',
    displayName: 'Publish Mini App',
    icon: 'APP',
    requiresConfirmation: false,
    resultDisplayType: 'detailed',
    description: 'Submit a Mini App to the market for review',
    displayMode: 'standard',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.miniApp
  },
  'PublishAppearance': {
    toolName: 'PublishAppearance',
    displayName: 'Publish Skin',
    icon: 'APP',
    requiresConfirmation: false,
    resultDisplayType: 'detailed',
    description: 'Submit an Appearance package to the Skin market for review',
    displayMode: 'standard',
    primaryColor: 'var(--openbitfun-color-accent-hover)'
  },
  'PageDeploy': {
    toolName: 'PageDeploy',
    displayName: 'Deploy Page',
    icon: 'WEB',
    requiresConfirmation: false,
    resultDisplayType: 'detailed',
    description: 'Deploy a saved OpenBitFun Page version to production',
    displayMode: 'standard',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.toolIdentity.terminal
  },
  'PagePublish': {
    toolName: 'PagePublish',
    displayName: 'Publish Page',
    icon: 'WEB',
    requiresConfirmation: true,
    resultDisplayType: 'detailed',
    description: 'Publish OpenBitFun Page content (upload, save version, deploy)',
    displayMode: 'standard',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.toolIdentity.terminal
  },
  'GenerativeUI': {
    toolName: 'GenerativeUI',
    displayName: 'Generative UI',
    icon: 'UI',
    requiresConfirmation: false,
    resultDisplayType: 'detailed',
    description: 'Render interactive widget previews inline in FlowChat',
    displayMode: 'detailed',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.generativeUi
  },
  // Computer use (desktop automation)
  'ComputerUse': {
    toolName: 'ComputerUse',
    displayName: 'Computer Use',
    icon: 'CU',
    requiresConfirmation: false,
    resultDisplayType: 'summary',
    description: 'Screen capture, mouse/keyboard, and accessibility control of the desktop',
    displayMode: 'compact',
    primaryColor: 'var(--openbitfun-color-accent-hover)'
  },

  'view_image': {
    toolName: 'view_image',
    displayName: 'view_image',
    icon: 'IMG',
    requiresConfirmation: false,
    resultDisplayType: 'detailed',
    description: '',
    displayMode: 'compact',
    primaryColor: 'var(--openbitfun-color-accent-hover)'
  },

  // OpenBitFun Canvas tools
  'CreateCanvas': {
    toolName: 'CreateCanvas',
    displayName: 'Create Canvas',
    icon: 'UI',
    requiresConfirmation: false,
    resultDisplayType: 'detailed',
    description: 'Create a OpenBitFun Canvas artifact',
    displayMode: 'detailed',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.generativeUi
  },
  'ReadCanvas': {
    toolName: 'ReadCanvas',
    displayName: 'Read Canvas',
    icon: 'UI',
    requiresConfirmation: false,
    resultDisplayType: 'detailed',
    description: 'Read a OpenBitFun Canvas artifact',
    displayMode: 'detailed',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.generativeUi
  },
  'UpdateCanvas': {
    toolName: 'UpdateCanvas',
    displayName: 'Update Canvas',
    icon: 'UI',
    requiresConfirmation: false,
    resultDisplayType: 'detailed',
    description: 'Update a OpenBitFun Canvas artifact',
    displayMode: 'detailed',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.generativeUi
  },
  'PatchCanvas': {
    toolName: 'PatchCanvas',
    displayName: 'Patch Canvas',
    icon: 'UI',
    requiresConfirmation: false,
    resultDisplayType: 'detailed',
    description: 'Patch a OpenBitFun Canvas artifact',
    displayMode: 'detailed',
    primaryColor: APPEARANCE_DOMAIN_TOKENS.generativeUi
  },
};

export const TOOL_CARD_CONFIGS: Record<string, ToolCardConfig> = Object.fromEntries(
  Object.entries(TOOL_CARD_DEFINITIONS).map(([toolName, definition]) => [
    toolName,
    { ...definition, ...getToolCardClassification(toolName) },
  ]),
);

/**
 * Get tool card config.
 */
export function getToolCardConfig(toolName: string, input?: unknown): ToolCardConfig {
  if (isSemanticBuiltinTool(toolName)) {
    return { ...TOOL_CARD_CONFIGS[toolName], attention: getBuiltinToolAttention(toolName, input) };
  }
  if (toolName === 'ControlHub') {
    return { ...TOOL_CARD_CONFIGS[toolName], attention: isControlHubObservation(input) ? 'ambient' : 'prominent' };
  }
  if (toolName === 'OpenBitFunControl') {
    return {
      ...TOOL_CARD_CONFIGS[toolName],
      attention: isOpenBitFunControlDiscovery(input) ? 'ambient' : 'prominent',
    };
  }
  // Check MCP tools (prefix: mcp__).
  if (isMcpToolName(toolName)) {
    const parsed = parseMcpToolName(toolName);
    const actualToolName = parsed?.toolName ?? toolName;

    return {
      attention: 'prominent',
      presentation: 'standard',
      toolName,
      displayName: actualToolName || toolName,
      icon: 'MCP',
      requiresConfirmation: false,
      resultDisplayType: 'detailed',
      description: 'MCP',
      displayMode: 'compact',
      primaryColor: APPEARANCE_DOMAIN_TOKENS.toolIdentity.mcp
    };
  }

  // Match by name or fall back to defaults.
  return TOOL_CARD_CONFIGS[toolName] || {
    ...getToolCardClassification(toolName),
    toolName,
    displayName: `Tool: ${toolName}`,
    icon: 'TOOL',
    requiresConfirmation: false,
    resultDisplayType: 'summary',
    description: `Run ${toolName} tool`,
    displayMode: 'standard',
    primaryColor: 'var(--openbitfun-color-content-muted)'
  };
}

/** Keep wrapper and transcript spacing aligned with action-specific card anatomy. */
export function getToolItemCardConfig(
  toolItem: FlowToolItem,
): ToolCardConfig {
  const effective = projectEffectiveToolItem(toolItem);
  const config = getToolCardConfig(effective.toolName, effective.toolName === 'OpenBitFunControl'
    ? getOpenBitFunControlInput(effective)
    : effective.toolName === 'ControlHub' ? getControlHubInput(effective)
      : isSemanticBuiltinTool(effective.toolName) ? getBuiltinToolInput(effective) : effective.toolCall?.input);
  // Approval is a grouping boundary, but does not change an ambient card's skin.
  const attention = isShellToolName(effective.toolName) && effective.status === 'rejected'
    ? 'prominent'
    : effective.toolName === 'Task' && effective.status === 'cancelled'
      ? 'ambient' : config.attention;
  const input = readInteractionInput(effective);
  const action = readToolRecord(effective.toolResult?.result).action ?? input.action;
  const relation = ['SessionMessage', 'AgentSendInput', 'AgentInterrupt', 'AgentWait', 'AgentDelete', 'WriteStdin', 'ExecControl'].includes(effective.toolName)
    || effective.toolName === 'SessionControl' && ['create', 'cancel', 'delete', 'rename'].includes(String(action))
    || effective.toolName === 'Task' && ['send_input', 'cancel'].includes(String(action));
  return { ...config, attention, presentation: relation ? 'relation' : config.presentation };
}

/**
 * Check whether a tool needs confirmation.
 */
export function requiresConfirmation(toolName: string): boolean {
  const config = getToolCardConfig(toolName);
  return config.requiresConfirmation;
}

/**
 * Get all registered tool names.
 */
export function getAllToolNames(): string[] {
  return Object.keys(TOOL_CARD_CONFIGS);
}

// ==================== Collapsible explorer tools ====================

/**
 * Tools with a dedicated FlowChat card renderer.
 *
 * Keep this lightweight mirror aligned with TOOL_CARD_COMPONENTS. The registry
 * test enforces equality so classification callers do not need to import every
 * card component just to tell dedicated cards from the DefaultToolCard.
 */
export const DEDICATED_TOOL_CARD_NAMES = dedicatedToolNames;

/** Whether FlowChat renders this tool through DefaultToolCard. */
export function usesDefaultToolCard(toolName: string): boolean {
  return !isMcpToolName(toolName) && !DEDICATED_TOOL_CARD_NAMES.has(toolName);
}


/** Relationship rows and ordinary cards own their element-level interactions. */
export const CAPSULE_TOOL_NAMES = new Set<string>();

export function isToolCapsule(toolName: string): boolean {
  return CAPSULE_TOOL_NAMES.has(toolName);
}

/** Read-only exploration candidates; Shell joins through its own activity policy. */
export const COLLAPSIBLE_TOOL_NAMES = new Set([
  'Read',
  'LS',
  'Grep',
  'Glob',
  'WebSearch',
  'WebFetch',
  'view_image',
]);

/** Read tools (counted in readCount). */
export const READ_TOOL_NAMES = new Set(['Read', 'LS', 'WebFetch', 'view_image']);

/** Search tools (counted in searchCount). */
export const SEARCH_TOOL_NAMES = new Set(['Grep', 'Glob', 'WebSearch']);

/** Shell launches count as commands; polling and process control do not. */
export const COMMAND_TOOL_NAMES = new Set(['ExecCommand', 'Bash']);

/** Count operations consistently for whole-round and inline exploration groups. */
export function computeExploreStats(items: readonly FlowItem[]) {
  let readCount = 0;
  let searchCount = 0;
  let commandCount = 0;
  for (const item of items) {
    if (item.type !== 'tool') continue;
    const toolName = getEffectiveToolName(item as FlowToolItem);
    if (READ_TOOL_NAMES.has(toolName)) readCount++;
    else if (SEARCH_TOOL_NAMES.has(toolName)) searchCount++;
    else if (COMMAND_TOOL_NAMES.has(toolName)) commandCount++;
  }
  return { readCount, searchCount, commandCount };
}

/** Check whether a tool is collapsible. */
export function isCollapsibleTool(toolName: string): boolean {
  return COLLAPSIBLE_TOOL_NAMES.has(toolName);
}

/**
 * Check whether a FlowItem is collapsible (no context).
 * - Text needs context (use isCollapsibleItemWithContext).
 * - Thinking can be collapsed with explorer tools.
 * - Only explorer tools are collapsible.
 */
export function isCollapsibleItem(item: FlowItem): boolean {
  // Text: default not collapsed (needs isCollapsibleItemWithContext).
  if (item.type === 'text') return false;

  // Thinking can be collapsed with explorer tools.
  if (item.type === 'thinking') return true;

  // Tools: only explorer tools are collapsible.
  if (item.type === 'tool') {
    return item.status === 'completed' && (item as FlowToolItem).toolResult?.success !== false && isCollapsibleTool(getEffectiveToolName(item as FlowToolItem));
  }

  return false;
}

/**
 * Check whether a FlowItem is collapsible with context.
 * @param item Current item
 * @param nextItem Next item (optional)
 * @param isLast Whether this is the last item
 */
export function isCollapsibleItemWithContext(
  item: FlowItem,
  nextItem: FlowItem | undefined,
  isLast: boolean
): boolean {
  // Visible narrative is always a boundary, even between two read operations.
  if (item.type === 'text') return false;
  if (item.type === 'thinking') {
    // Last item should stay visible.
    if (isLast || !nextItem) return false;

    // If followed by an explorer tool, collapse together.
    if (nextItem.type === 'tool') {
      return isCollapsibleItem(nextItem);
    }

    // If followed by text or thinking, treat as collapsible for grouping.
    if (nextItem.type === 'thinking') {
      return true;
    }

    // Otherwise do not collapse.
    return false;
  }

  // Tools: only explorer tools are collapsible.
  if (item.type === 'tool') {
    return isCollapsibleItem(item);
  }

  return false;
}
