import type { componentRegistry } from '@openbitfun/ui/registry';
type FlowChatViewName = Extract<(typeof componentRegistry)[number], { readonly category: 'flow-chat' }>['name'];

/** Product presentation bindings. No React values, stores or host imports here. */
export const toolPresentationRegistry = {
  Read: { owner: 'standard', component: 'ReadFileToolCard' },
  Write: { owner: 'standard', component: 'FileOperationToolCard' },
  Edit: { owner: 'standard', component: 'FileOperationToolCard' },
  Delete: { owner: 'standard', component: 'FileOperationToolCard' },
  Grep: { owner: 'standard', component: 'GrepSearchToolCard' },
  Glob: { owner: 'standard', component: 'GlobSearchToolCard' },
  LS: { owner: 'standard', component: 'DirectoryListToolCard' },
  WebSearch: { owner: 'standard', component: 'WebSearchToolCard' },
  WebFetch: { owner: 'standard', component: 'WebFetchToolCard' },
  ListModels: { owner: 'standard', component: 'ListModelsToolCard' },
  ControlHub: { owner: 'standard', component: 'ControlHubToolCard' },
  AgentSpawn: { owner: 'standard', component: 'AgentControlToolCard' },
  AgentSendInput: { owner: 'standard', component: 'SessionMessageToolCard' },
  AgentWait: { owner: 'standard', component: 'AgentWaitToolCard' },
  TodoWrite: { owner: 'standard', component: 'TodoToolCard' },
  ContextCompression: { owner: 'standard', component: 'ContextCompressionToolCard' },
  GetToolSpec: { owner: 'standard', component: 'GetToolSpecToolCard' },
  Skill: { owner: 'standard', component: 'SkillToolCard' },
  ReviewSessionSummary: { owner: 'standard', component: 'ReviewSummaryToolCard' },
  GetFileDiff: { owner: 'standard', component: 'FileDiffToolCard' },
  SessionControl: { owner: 'standard', component: 'SessionControlToolCard' },
  SessionMessage: { owner: 'standard', component: 'SessionMessageToolCard' },
  Cron: { owner: 'standard', component: 'CronToolCard' },
  RunCode: { owner: 'standard', component: 'RunCodeToolCard' },
  ExecCommand: { owner: 'standard', component: 'CommandToolCard' },
  WriteStdin: { owner: 'standard', component: 'CommandToolCard' },
  ExecControl: { owner: 'standard', component: 'CommandToolCard' },
  PageDeploy: { owner: 'standard', component: 'PageDeployToolCard' },
  PagePublish: { owner: 'standard', component: 'PagePublishToolCard' },
  view_image: { owner: 'standard', component: 'ViewImageToolCard' },
  get_goal: { owner: 'standard', component: 'GoalToolCard' },
  create_goal: { owner: 'standard', component: 'GoalToolCard' },
  update_goal: { owner: 'standard', component: 'GoalToolCard' },
  AgentList: { owner: 'standard', component: 'AgentRosterToolCard' },
  SessionHistory: { owner: 'standard', component: 'SessionHistoryToolCard' },
  analyze_image: { owner: 'standard', component: 'ImageAnalysisToolCard' },
  GetTime: { owner: 'standard', component: 'TimeToolCard' },
  ListMCPResources: { owner: 'standard', component: 'McpResourceToolCard' },
  ReadMCPResource: { owner: 'standard', component: 'McpResourceToolCard' },
  ListMCPPrompts: { owner: 'standard', component: 'McpResourceToolCard' },
  GetMCPPrompt: { owner: 'standard', component: 'McpResourceToolCard' },
  Worktree: { owner: 'standard', component: 'WorktreeToolCard' },
  PortForward: { owner: 'standard', component: 'PortForwardToolCard' },
  ReviewPlatform: { owner: 'standard', component: 'ReviewPlatformToolCard' },
  FrontendWorkbench: { owner: 'standard', component: 'FrontendWorkbenchToolCard' },
  FinalizeMiniApp: { owner: 'standard', component: 'MiniAppFinalizeToolCard' },
  PublishMiniApp: { owner: 'standard', component: 'MarketplacePublishToolCard' },
  PublishAppearance: { owner: 'standard', component: 'MarketplacePublishToolCard' },
  Playbook: { owner: 'standard', component: 'PlaybookToolCard' },
  LaunchReviewAgent: { owner: 'product', component: 'AgentControlToolCard' },
  submit_code_review: { owner: 'product', component: null },
  AskUserQuestion: { owner: 'product', component: 'AskUser' },
  // Reading historical CreatePlan calls remains supported.
  CreatePlan: { owner: 'product', component: null },
  InitMiniApp: { owner: 'product', component: null },
  GenerativeUI: { owner: 'product', component: null },
  ComputerUse: { owner: 'product', component: null },
  OpenBitFunControl: { owner: 'product', component: null },
  CreateCanvas: { owner: 'product', component: null },
  ReadCanvas: { owner: 'product', component: null },
  UpdateCanvas: { owner: 'product', component: null },
  PatchCanvas: { owner: 'product', component: null },
} as const satisfies Record<string, { owner: 'standard' | 'product'; component: FlowChatViewName | null }>;

export type RegisteredToolName = keyof typeof toolPresentationRegistry;
export type ToolNameForOwner<Owner extends 'standard' | 'product'> = {
  [Name in RegisteredToolName]: typeof toolPresentationRegistry[Name]['owner'] extends Owner ? Name : never
}[RegisteredToolName];

export const dedicatedToolNames: ReadonlySet<string> = new Set(Object.keys(toolPresentationRegistry));

/** The public component catalog is distinct from the current product tool map. */
export function toolsForComponent(component: string): string[] {
  return Object.entries(toolPresentationRegistry)
    .filter(([, entry]) => entry.owner === 'standard' && entry.component === component)
    .map(([name]) => name);
}

export const productOwnedToolNames = Object.entries(toolPresentationRegistry)
  .filter(([, entry]) => entry.owner === 'product')
  .map(([name]) => name);
