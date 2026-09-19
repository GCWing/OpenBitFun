/**
 * Tool card registry.
 * Maps tool configs to components.
 */

import { createLogger } from '@/shared/utils/logger';
import { isMcpToolName } from '@/infrastructure/mcp/toolName';
export {
  TOOL_CARD_CONFIGS,
  getToolCardConfig,
  getToolItemCardConfig,
  requiresConfirmation,
  getAllToolNames,
  COLLAPSIBLE_TOOL_NAMES,
  READ_TOOL_NAMES,
  SEARCH_TOOL_NAMES,
  COMMAND_TOOL_NAMES,
  DEDICATED_TOOL_CARD_NAMES,
  isCollapsibleTool,
  isCollapsibleItem,
  isCollapsibleItemWithContext,
  usesDefaultToolCard,
} from './toolCardMetadata';

const log = createLogger('ToolCardRegistry');
// Tool display components
import { ReadFileDisplay } from './ReadFileDisplay';
import { GrepSearchDisplay } from './GrepSearchDisplay';
import { GlobSearchDisplay } from './GlobSearchDisplay';
import { LSDisplay } from './LSDisplay';
import { TodoWriteDisplay } from './TodoWriteDisplay';
import { TaskToolDisplay } from './TaskToolDisplay';
import { AgentControlToolCard } from './AgentControlToolCard';
import { AgentWaitToolCard } from './AgentWaitToolCard';
import { CodeReviewToolCard } from './CodeReviewToolCard';
import { FileOperationToolCard } from './FileOperationToolCard';
import { DefaultToolCard } from './DefaultToolCard';
import { WebSearchCard } from './WebSearchCard'; // Temporary until WebSearchDisplay exists.
import { WebFetchCard } from './WebFetchCard';
import { GetToolSpecCard } from './GetToolSpecCard';
import { ContextCompressionDisplay } from './ContextCompressionDisplay';
import { MCPToolDisplay } from './MCPToolDisplay';
import { SkillDisplay } from './SkillDisplay';
import { AskUserQuestionCard } from './AskUserQuestionCard';
import { GetFileDiffDisplay } from './GetFileDiffDisplay';
import { CreatePlanDisplay } from './CreatePlanDisplay';
import { RunCodeToolCard } from './RunCodeToolCard';
import { ExecCommandToolCard } from './ExecCommandToolCard';
import { WriteStdinToolCard } from './WriteStdinToolCard';
import { ExecControlToolCard } from './ExecControlToolCard';
import { InitMiniAppDisplay } from './MiniAppToolDisplay';
import { PageDeployDisplay } from './PageDeployToolDisplay';
import { PagePublishDisplay } from './PagePublishToolDisplay';
import { GenerativeWidgetToolCard } from './GenerativeWidgetToolCard';
import { CanvasToolCard } from './CanvasToolCard';
import { ReviewSessionSummaryCard } from './ReviewSessionSummaryCard';
import { SessionControlToolCard } from './SessionControlToolCard';
import { SessionMessageToolCard } from './SessionMessageToolCard';
import { ComputerUseToolCard } from './ComputerUseToolCard';
import { ViewImageToolCard } from './ViewImageToolCard';
import { OpenBitFunControlToolCard } from './OpenBitFunControlToolCard';

/**
 * Standard tool adapters backed by concrete `@openbitfun/ui/flow-chat` views.
 *
 * These components may translate product data, localization, host callbacks,
 * and heavyweight renderer slots, but they must not own a second card anatomy.
 */
export const STANDARD_TOOL_CARD_ADAPTERS = {
  // File tools
  'Read': ReadFileDisplay, // Read does not need snapshot support.
  'Write': FileOperationToolCard,
  'Edit': FileOperationToolCard,
  'Delete': FileOperationToolCard,
  
  // Search tools
  'Grep': GrepSearchDisplay,
  'Glob': GlobSearchDisplay,
  'LS': LSDisplay,
  
  // Web tools
  'WebSearch': WebSearchCard,
  'WebFetch': WebFetchCard,
  
  // Agent activity
  'AgentSpawn': AgentControlToolCard,
  'AgentSendInput': AgentControlToolCard,
  'AgentWait': AgentWaitToolCard,
  'TodoWrite': TodoWriteDisplay,

  // Context compression
  'ContextCompression': ContextCompressionDisplay,
  'GetToolSpec': GetToolSpecCard,

  // Skill tool
  'Skill': SkillDisplay,

  'ReviewSessionSummary': ReviewSessionSummaryCard,

  // GetFileDiff tool
  'GetFileDiff': GetFileDiffDisplay,

  // Session tools
  'SessionControl': SessionControlToolCard,
  'SessionMessage': SessionMessageToolCard,

  // Code-mode agents: one program per step instead of one card per action
  'RunCode': RunCodeToolCard,

  // Exec process tools
  'ExecCommand': ExecCommandToolCard,
  'WriteStdin': WriteStdinToolCard,
  'ExecControl': ExecControlToolCard,

  // OpenBitFun Page (session-only publish)
  'PageDeploy': PageDeployDisplay,
  'PagePublish': PagePublishDisplay,

  // Model vision image preview
  'view_image': ViewImageToolCard,
} as const;

/**
 * Bespoke product cards intentionally kept in Web UI.
 *
 * Their view is inseparable from a product workflow, runtime surface, or host
 * capability. They may compose the public framework, but are not represented
 * as generic concrete views in the independent package.
 */
export const PRODUCT_OWNED_TOOL_CARD_COMPONENTS = {
  'Task': TaskToolDisplay,
  'LaunchReviewAgent': TaskToolDisplay,
  'submit_code_review': CodeReviewToolCard,
  'AskUserQuestion': AskUserQuestionCard,
  // Legacy CreatePlan history remains displayable after runtime tool removal.
  'CreatePlan': CreatePlanDisplay,
  'InitMiniApp': InitMiniAppDisplay,
  'GenerativeUI': GenerativeWidgetToolCard,
  'ComputerUse': ComputerUseToolCard,
  'OpenBitFunControl': OpenBitFunControlToolCard,

  // OpenBitFun Canvas tools
  'CreateCanvas': CanvasToolCard,
  'ReadCanvas': CanvasToolCard,
  'UpdateCanvas': CanvasToolCard,
  'PatchCanvas': CanvasToolCard,
} as const;

// Runtime map keyed by backend tool names.
export const TOOL_CARD_COMPONENTS = {
  ...STANDARD_TOOL_CARD_ADAPTERS,
  ...PRODUCT_OWNED_TOOL_CARD_COMPONENTS,
};

/**
 * Get tool card component.
 */
export function getToolCardComponent(toolName: string) {
  // Check MCP tools (prefix: mcp__).
  if (isMcpToolName(toolName)) {
    return MCPToolDisplay;
  }
  
  const component = TOOL_CARD_COMPONENTS[toolName as keyof typeof TOOL_CARD_COMPONENTS];
  
  // Debug log (only when a component is missing).
  if (!component) {
    log.warn('Tool card component not found, using default', { toolName });
  }
  
  return component || DefaultToolCard;
}

export { PlanDisplay } from './CreatePlanDisplay';
export type { PlanDisplayProps } from './CreatePlanDisplay';
