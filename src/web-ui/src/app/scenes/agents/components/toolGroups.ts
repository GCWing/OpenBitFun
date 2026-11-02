import type { UseI18nReturn } from '@/infrastructure/i18n/hooks/useI18n';
import type { UserToolGroup, UserToolGroupsConfig } from '@/infrastructure/config/types';
import type { DynamicToolInfo } from '@/shared/types/agent-api';
import { isUserSelectableToolName } from '@/shared/utils/toolVisibility';

export const USER_TOOL_GROUPS_CONFIG_PATH = 'app.user_tool_groups';
export const USER_TOOL_GROUPS_CONFIG_VERSION = 1;

export interface GroupableTool {
  name: string;
  description: string;
  is_readonly: boolean;
  needs_permissions?: boolean;
  dynamic_info?: DynamicToolInfo;
}

export type ToolGroupKind = 'builtin' | 'user' | 'extension' | 'other';

export interface ResolvedToolGroup {
  id: string;
  kind: ToolGroupKind;
  label: string;
  tools: GroupableTool[];
}

interface BuiltinToolGroupDefinition {
  id: string;
  labelKey: string;
  toolNames: string[];
}

const BUILTIN_TOOL_GROUPS: BuiltinToolGroupDefinition[] = [
  {
    id: 'builtin:files-search',
    labelKey: 'agentsOverview.toolGroups.filesSearch',
    toolNames: ['LS', 'Read', 'Glob', 'Grep'],
  },
  {
    id: 'builtin:file-editing',
    labelKey: 'agentsOverview.toolGroups.fileEditing',
    toolNames: ['Write', 'Edit', 'Delete'],
  },
  {
    id: 'builtin:commands',
    labelKey: 'agentsOverview.toolGroups.commands',
    toolNames: ['ExecCommand', 'WriteStdin', 'ExecControl'],
  },
  {
    id: 'builtin:delegation',
    labelKey: 'agentsOverview.toolGroups.delegation',
    toolNames: ['AgentSpawn', 'AgentSendInput', 'AgentControl', 'AgentList', 'ListModels', 'AgentWait', 'Skill'],
  },
  {
    id: 'builtin:web',
    labelKey: 'agentsOverview.toolGroups.web',
    toolNames: ['WebSearch', 'WebFetch'],
  },
  {
    id: 'builtin:image-understanding',
    labelKey: 'agentsOverview.toolGroups.imageUnderstanding',
    toolNames: ['analyze_image', 'view_image'],
  },
  {
    id: 'builtin:interaction-canvas',
    labelKey: 'agentsOverview.toolGroups.interactionCanvas',
    toolNames: [
      'AskUserQuestion',
      'GenerativeUI',
      'CreateCanvas',
      'ReadCanvas',
      'PatchCanvas',
      'UpdateCanvas',
    ],
  },
  {
    id: 'builtin:computer-automation',
    labelKey: 'agentsOverview.toolGroups.computerAutomation',
    toolNames: ['ComputerUse', 'ControlHub', 'Playbook'],
  },
];

function normalizeToolNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    const name = item.trim();
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    names.push(name);
  }
  return names;
}

function normalizeUserToolGroup(value: unknown): UserToolGroup | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!id || !name) {
    return null;
  }
  return {
    id,
    name,
    toolNames: normalizeToolNames(record.toolNames),
  };
}

export function normalizeUserToolGroupsConfig(value: unknown): UserToolGroupsConfig {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const version = typeof record.version === 'number' && Number.isInteger(record.version)
    ? record.version
    : USER_TOOL_GROUPS_CONFIG_VERSION;
  const groups = Array.isArray(record.groups)
    ? record.groups
      .map(normalizeUserToolGroup)
      .filter((group): group is UserToolGroup => group !== null)
    : [];

  return { version, groups };
}

export function createUserToolGroupsConfig(groups: UserToolGroup[]): UserToolGroupsConfig {
  return normalizeUserToolGroupsConfig({
    version: USER_TOOL_GROUPS_CONFIG_VERSION,
    groups,
  });
}

function activeTools(tools: GroupableTool[]): GroupableTool[] {
  return tools.filter((tool) => tool.name.trim() && isUserSelectableToolName(tool.name));
}

function toolsForNames(
  toolByName: Map<string, GroupableTool>,
  names: readonly string[],
): GroupableTool[] {
  return names
    .map((name) => toolByName.get(name))
    .filter((tool): tool is GroupableTool => Boolean(tool));
}

function sortedTools(tools: GroupableTool[]): GroupableTool[] {
  return [...tools].sort((left, right) => left.name.localeCompare(right.name));
}

function dynamicGroupLabel(tool: GroupableTool): string {
  return tool.dynamic_info?.mcp?.serverName?.trim()
    || tool.dynamic_info?.providerId?.trim()
    || tool.name;
}

export function resolveToolGroups(
  tools: GroupableTool[],
  userGroups: UserToolGroup[],
  t: UseI18nReturn['t'],
): ResolvedToolGroup[] {
  const selectableTools = activeTools(tools);
  const toolByName = new Map(selectableTools.map((tool) => [tool.name, tool]));
  const resolved: ResolvedToolGroup[] = [];
  const builtinOrDynamicToolNames = new Set<string>();

  for (const group of userGroups) {
    const groupTools = sortedTools(toolsForNames(toolByName, group.toolNames));
    if (groupTools.length === 0) {
      continue;
    }
    resolved.push({
      id: `user:${group.id}`,
      kind: 'user',
      label: group.name,
      tools: groupTools,
    });
  }

  for (const definition of BUILTIN_TOOL_GROUPS) {
    const groupTools = sortedTools(toolsForNames(toolByName, definition.toolNames));
    if (groupTools.length === 0) {
      continue;
    }
    groupTools.forEach((tool) => builtinOrDynamicToolNames.add(tool.name));
    resolved.push({
      id: definition.id,
      kind: 'builtin',
      label: t(definition.labelKey),
      tools: groupTools,
    });
  }

  const dynamicGroups = new Map<string, GroupableTool[]>();
  const dynamicLabels = new Map<string, string>();
  for (const tool of selectableTools) {
    const providerId = tool.dynamic_info?.providerId?.trim();
    if (!providerId) {
      continue;
    }
    const groupId = `extension:${providerId}`;
    const members = dynamicGroups.get(groupId) ?? [];
    members.push(tool);
    dynamicGroups.set(groupId, members);
    dynamicLabels.set(groupId, dynamicGroupLabel(tool));
    builtinOrDynamicToolNames.add(tool.name);
  }
  for (const [groupId, groupTools] of dynamicGroups) {
    resolved.push({
      id: groupId,
      kind: 'extension',
      label: t('agentsOverview.toolGroups.extension', {
        provider: dynamicLabels.get(groupId) ?? groupId,
      }),
      tools: sortedTools(groupTools),
    });
  }

  const otherTools = sortedTools(
    selectableTools.filter((tool) => !builtinOrDynamicToolNames.has(tool.name)),
  );
  if (otherTools.length > 0) {
    resolved.push({
      id: 'other',
      kind: 'other',
      label: t('agentsOverview.toolGroups.other'),
      tools: otherTools,
    });
  }

  return resolved;
}

export function groupToolNames(group: ResolvedToolGroup): string[] {
  return group.tools.map((tool) => tool.name);
}

export function setToolGroupSelection(
  currentToolNames: readonly string[],
  groupToolNamesToUpdate: readonly string[],
  enabled: boolean,
): string[] {
  const current = normalizeToolNames(currentToolNames);
  const members = new Set(normalizeToolNames(groupToolNamesToUpdate));
  if (!enabled) {
    return current.filter((toolName) => !members.has(toolName));
  }

  const next = [...current];
  for (const toolName of members) {
    if (!next.includes(toolName)) {
      next.push(toolName);
    }
  }
  return next;
}

export function toggleToolSelection(
  currentToolNames: readonly string[],
  toolName: string,
): string[] {
  const current = normalizeToolNames(currentToolNames);
  return current.includes(toolName)
    ? current.filter((name) => name !== toolName)
    : [...current, toolName];
}

export function resolveToolGroupSummary(
  tools: GroupableTool[],
  userGroups: UserToolGroup[],
  selectedToolNames: readonly string[],
  t: UseI18nReturn['t'],
): ResolvedToolGroup[] {
  const selected = new Set(normalizeToolNames(selectedToolNames));
  const groups = resolveToolGroups(tools, userGroups, t);
  const ordered = [
    ...groups.filter((group) => group.kind === 'user'),
    ...groups.filter((group) => group.kind !== 'user'),
  ];
  const assigned = new Set<string>();

  return ordered.flatMap((group) => {
    const groupTools = group.tools.filter((tool) => (
      selected.has(tool.name) && !assigned.has(tool.name)
    ));
    groupTools.forEach((tool) => assigned.add(tool.name));
    return groupTools.length > 0 ? [{ ...group, tools: groupTools }] : [];
  });
}

export function unavailableUserToolNames(
  group: UserToolGroup,
  tools: GroupableTool[],
): string[] {
  const activeNames = new Set(activeTools(tools).map((tool) => tool.name));
  return normalizeToolNames(group.toolNames).filter((toolName) => !activeNames.has(toolName));
}
