import type { DynamicToolInfo } from '@/shared/types/agent-api';

export interface SubagentEditorToolInfo {
  name: string;
  description: string;
  isReadonly: boolean;
  needsPermissions?: boolean;
  dynamicInfo?: DynamicToolInfo;
}

export {
  REVIEW_SUBAGENT_OPTIONAL_TOOLS,
  REVIEW_SUBAGENT_RECOMMENDED_TOOLS,
  REVIEW_SUBAGENT_REQUIRED_TOOLS,
  evaluateReviewSubagentToolReadiness,
  type ReviewSubagentToolReadiness,
  type ReviewSubagentToolReadinessResult,
} from '@/shared/services/reviewSubagentCapabilities';

export function filterToolsForReadonlyMode(
  tools: SubagentEditorToolInfo[],
  readonly: boolean,
): SubagentEditorToolInfo[] {
  return readonly ? tools.filter((tool) => tool.isReadonly) : tools;
}

export interface NormalizeToolPermissionStateInput {
  review: boolean;
  readonly: boolean;
  selectedTools: Set<string>;
  availableTools: SubagentEditorToolInfo[];
}

export interface NormalizeToolPermissionStateResult {
  readonly: boolean;
  selectedTools: Set<string>;
  removedToolNames: string[];
}

export function normalizeToolPermissionState(
  input: NormalizeToolPermissionStateInput,
): NormalizeToolPermissionStateResult {
  if (!input.review && !input.readonly) {
    return {
      readonly: input.readonly,
      selectedTools: new Set(input.selectedTools),
      removedToolNames: [],
    };
  }

  const readonlyToolNames = new Set(
    input.availableTools
      .filter((tool) => tool.isReadonly)
      .map((tool) => tool.name),
  );
  const selectedTools = new Set<string>();
  const removedToolNames: string[] = [];

  input.selectedTools.forEach((toolName) => {
    if (readonlyToolNames.has(toolName)) {
      selectedTools.add(toolName);
    } else {
      removedToolNames.push(toolName);
    }
  });

  return {
    readonly: true,
    selectedTools,
    removedToolNames,
  };
}
