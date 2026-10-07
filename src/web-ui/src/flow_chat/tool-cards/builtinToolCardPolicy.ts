import type { FlowToolItem } from '../types/flow-chat';
import { getRuntimeToolInput, runtimeToolRecord } from './runtimeToolCardModel';

export const SEMANTIC_BUILTIN_TOOL_NAMES = [
  'get_goal', 'create_goal', 'update_goal', 'AgentList', 'AgentDelete', 'SessionHistory',
  'analyze_image', 'GetTime', 'ListMCPResources', 'ReadMCPResource', 'ListMCPPrompts', 'GetMCPPrompt',
  'Worktree', 'PortForward', 'ReviewPlatform', 'FrontendWorkbench', 'FinalizeMiniApp',
  'PublishMiniApp', 'PublishAppearance', 'Playbook',
] as const;
export type SemanticBuiltinToolName = typeof SEMANTIC_BUILTIN_TOOL_NAMES[number];
const names: ReadonlySet<string> = new Set(SEMANTIC_BUILTIN_TOOL_NAMES);
export function isSemanticBuiltinTool(name: string): name is SemanticBuiltinToolName {
  return names.has(name);
}

export function getBuiltinToolInput(item: FlowToolItem): Record<string, unknown> {
  let data = runtimeToolRecord(item.toolResult?.result);
  for (let depth = 0; depth < 4 && typeof data.ok === 'boolean' && 'data' in data; depth++) data = runtimeToolRecord(data.data);
  return { operation: data.operation, action: data.action, ...getRuntimeToolInput(item) };
}

const REVIEW_READ_ACTIONS = new Set([
  'get_workspace_snapshot', 'list_remotes', 'list_pull_requests', 'count_pull_requests',
  'get_pull_request', 'get_pull_request_detail_page', 'get_pull_request_ci_log',
]);

/** Unknown actions remain visible as consequential operations; never infer permission from a skin. */
export function getBuiltinToolAttention(name: SemanticBuiltinToolName, input?: unknown): 'ambient' | 'prominent' {
  const request = runtimeToolRecord(input);
  switch (name) {
    case 'create_goal': case 'update_goal': case 'AgentDelete': case 'FinalizeMiniApp':
    case 'PublishMiniApp': case 'PublishAppearance': return 'prominent';
    case 'Worktree': return request.operation === 'list' ? 'ambient' : 'prominent';
    case 'PortForward': return ['targets', 'detect', 'list'].includes(String(request.operation)) ? 'ambient' : 'prominent';
    case 'ReviewPlatform': return REVIEW_READ_ACTIONS.has(String(request.action)) ? 'ambient' : 'prominent';
    case 'FrontendWorkbench': return ['prepare', 'status', 'inspect'].includes(String(request.action)) ? 'ambient' : 'prominent';
    default: return 'ambient';
  }
}
