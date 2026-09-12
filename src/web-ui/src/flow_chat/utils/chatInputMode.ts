import { HARNESS_IDS, canonicalAgentId, canonicalHarnessId, type HarnessId } from '@/shared/agents/identity';
import { WorkspaceKind, type WorkspaceInfo } from '@/shared/types';

const MAIN_AGENT_EXCLUDED_MODE_IDS = new Set([
  ...HARNESS_IDS.map(id => id.toLowerCase()),
  'claw',
  // Retired built-in modes that may still be advertised by an older peer.
  'multitask',
  'plan',
]);

export type AgentExecutionTier = HarnessId;
export function agentExecutionTier(agentType: string | null | undefined): AgentExecutionTier {
  return canonicalHarnessId(agentType) ?? 'Standard';
}

export function resolveChatInputCanUseMcp(params: {
  targetAgentType: string;
  isAcpTargetSession: boolean;
  isDispatchTransport: boolean;
}): boolean {
  return !params.isAcpTargetSession
    && !params.isDispatchTransport
    && canonicalHarnessId(params.targetAgentType) !== 'Minimal';
}

export function canSwitchSessionMainAgent(params: {
  sessionStarted: boolean;
  currentAgentType: string | null | undefined;
  nextAgentType: string | null | undefined;
}): boolean {
  return !params.sessionStarted
    || normalizeModeLookupId(params.currentAgentType) === normalizeModeLookupId(params.nextAgentType);
}

const THREAD_GOAL_TOOL_IDS = ['get_goal', 'create_goal', 'update_goal'] as const;

/** Whether an agent tool set exposes the complete thread-goal lifecycle. */
export function hasCompleteThreadGoalTools(tools: Iterable<string> | null | undefined): boolean {
  const normalized = new Set(
    Array.from(tools ?? [], tool => tool.trim().toLowerCase()),
  );
  return THREAD_GOAL_TOOL_IDS.every(tool => normalized.has(tool));
}
const SUBAGENT_HIDDEN_CHAT_INPUT_ACTION_IDS = new Set(['goal', 'review', 'deepreview', 'init']);

type WorkspaceResolutionInfo = Pick<
  WorkspaceInfo,
  'id' | 'rootPath' | 'workspaceKind' | 'connectionId'
>;

export type ChatInputFixedModeReason =
  | 'assistant-workspace'
  | 'acp-session'
  | 'current-mode'
  | 'session-mode';

export interface ChatInputModePolicy {
  canSwitchModes: boolean;
  fixedModeId: string | null;
  fixedReason: ChatInputFixedModeReason | null;
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeAgentTypeString(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized || normalized.toLowerCase() === 'not provided') {
    return null;
  }

  return canonicalAgentId(normalized);
}

function normalizeWorkspacePath(value: string | null | undefined): string | null {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/[\\/]+$/, '');
}

function isWorkspaceConnectionCompatible(
  workspaceConnectionId: string | null | undefined,
  sessionRemoteConnectionId: string | null | undefined,
): boolean {
  const normalizedWorkspaceConnectionId = normalizeOptionalString(workspaceConnectionId);
  const normalizedSessionRemoteConnectionId = normalizeOptionalString(sessionRemoteConnectionId);

  if (normalizedSessionRemoteConnectionId && normalizedWorkspaceConnectionId) {
    return normalizedWorkspaceConnectionId === normalizedSessionRemoteConnectionId;
  }

  if (normalizedSessionRemoteConnectionId && !normalizedWorkspaceConnectionId) {
    return false;
  }

  return true;
}

function resolveSessionWorkspaceMatch(params: {
  currentWorkspace?: WorkspaceResolutionInfo | null;
  sessionWorkspaceId?: string | null;
  sessionWorkspacePath?: string | null;
  sessionRemoteConnectionId?: string | null;
  openedWorkspaces?: Iterable<WorkspaceResolutionInfo>;
}): WorkspaceResolutionInfo | null {
  const normalizedSessionWorkspaceId = normalizeOptionalString(params.sessionWorkspaceId);
  const normalizedSessionWorkspacePath = normalizeWorkspacePath(params.sessionWorkspacePath);
  const normalizedSessionRemoteConnectionId = normalizeOptionalString(params.sessionRemoteConnectionId);
  const currentWorkspace = params.currentWorkspace ?? null;
  const openedWorkspaces = params.openedWorkspaces ?? [];

  if (normalizedSessionWorkspaceId) {
    if (currentWorkspace?.id === normalizedSessionWorkspaceId) {
      return currentWorkspace;
    }

    for (const workspace of openedWorkspaces) {
      if (workspace.id === normalizedSessionWorkspaceId) {
        return workspace;
      }
    }
  }

  if (!normalizedSessionWorkspacePath) {
    return null;
  }

  const matchingWorkspaces: WorkspaceResolutionInfo[] = [];
  const pushIfMatching = (workspace: WorkspaceResolutionInfo | null | undefined) => {
    if (!workspace) {
      return;
    }

    if (normalizeWorkspacePath(workspace.rootPath) !== normalizedSessionWorkspacePath) {
      return;
    }

    if (!isWorkspaceConnectionCompatible(workspace.connectionId, normalizedSessionRemoteConnectionId)) {
      return;
    }

    if (!matchingWorkspaces.some(candidate => candidate.id === workspace.id)) {
      matchingWorkspaces.push(workspace);
    }
  };

  pushIfMatching(currentWorkspace);
  for (const workspace of openedWorkspaces) {
    pushIfMatching(workspace);
  }

  if (normalizedSessionRemoteConnectionId) {
    const exactConnectionMatch = matchingWorkspaces.find(
      (workspace) => normalizeOptionalString(workspace.connectionId) === normalizedSessionRemoteConnectionId,
    );
    if (exactConnectionMatch) {
      return exactConnectionMatch;
    }
  }

  return matchingWorkspaces[0] ?? null;
}

export function normalizeUserDefaultChatInputModeId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.toLowerCase() === 'claw' ? 'Claw' : canonicalAgentId(trimmed);
}

export function resolveSessionAssistantWorkspace(params: {
  currentWorkspace?: WorkspaceResolutionInfo | null;
  sessionWorkspaceId?: string | null;
  sessionWorkspacePath?: string | null;
  sessionRemoteConnectionId?: string | null;
  openedWorkspaces?: Iterable<WorkspaceResolutionInfo>;
}): boolean {
  const matchedWorkspace = resolveSessionWorkspaceMatch(params);
  if (matchedWorkspace) {
    return matchedWorkspace.workspaceKind === WorkspaceKind.Assistant;
  }

  const hasExplicitSessionWorkspace =
    normalizeOptionalString(params.sessionWorkspaceId) !== null
    || normalizeWorkspacePath(params.sessionWorkspacePath) !== null;
  if (hasExplicitSessionWorkspace) {
    return false;
  }

  return params.currentWorkspace?.workspaceKind === WorkspaceKind.Assistant;
}

function normalizeModeLookupId(value: string | null | undefined): string | null {
  const id = normalizeOptionalString(value);
  return id ? canonicalAgentId(id).toLowerCase() : null;
}

function canonicalFixedModeId(value: string | null | undefined): string | null {
  switch (normalizeModeLookupId(value)) {
    case 'claw':
      return 'Claw';
    default:
      return null;
  }
}

export function resolveChatInputModePolicy(params: {
  currentMode: string;
  isAssistantWorkspace: boolean;
  sessionMode?: string | null;
  isAcpTargetSession?: boolean;
}): ChatInputModePolicy {
  if (params.isAcpTargetSession) {
    return {
      canSwitchModes: false,
      fixedModeId: null,
      fixedReason: 'acp-session',
    };
  }

  if (params.isAssistantWorkspace) {
    return {
      canSwitchModes: false,
      fixedModeId: 'Claw',
      fixedReason: 'assistant-workspace',
    };
  }

  const fixedSessionModeId = canonicalFixedModeId(params.sessionMode);
  if (fixedSessionModeId) {
    return {
      canSwitchModes: false,
      fixedModeId: fixedSessionModeId,
      fixedReason: 'session-mode',
    };
  }

  const fixedCurrentModeId = canonicalFixedModeId(params.currentMode);
  if (fixedCurrentModeId) {
    return {
      canSwitchModes: false,
      fixedModeId: fixedCurrentModeId,
      fixedReason: 'current-mode',
    };
  }

  return {
    canSwitchModes: true,
    fixedModeId: null,
    fixedReason: null,
  };
}

/**
 * Main Agents are selected with the Harness control before the first Turn.
 * Minimal, Standard, Ultimate, and Creative are already represented by Harness profiles;
 * Claw belongs to Assistant workspaces. Retired built-in modes stay filtered
 * when an older peer still advertises them.
 */
export function resolveChatInputMainAgentModes<TMode extends { id: string }>(
  availableModes: Iterable<TMode>,
): TMode[] {
  return Array.from(availableModes).filter(
    mode => !MAIN_AGENT_EXCLUDED_MODE_IDS.has(normalizeModeLookupId(mode.id) ?? ''),
  );
}

export function resolveChatInputSendAgentType(params: {
  isSubagentTarget: boolean;
  subagentType?: string | null;
  sessionMode?: string | null;
  acpTargetAgentType?: string | null;
  composerMode: string;
}): string {
  const composerMode = normalizeAgentTypeString(params.composerMode) ?? 'Standard';
  if (!params.isSubagentTarget) {
    return normalizeAgentTypeString(params.acpTargetAgentType) ?? composerMode;
  }

  return (
    normalizeAgentTypeString(params.sessionMode) ??
    normalizeAgentTypeString(params.subagentType) ??
    composerMode
  );
}

export function resolveChatInputCanUseSkills(params: {
  isSubagentTarget: boolean;
  targetAgentType: string;
  availableAgents: Iterable<{ id: string; defaultTools?: string[] }>;
}): boolean {
  const targetAgentType = normalizeModeLookupId(params.targetAgentType);
  if (!targetAgentType) {
    return !params.isSubagentTarget;
  }

  for (const agent of params.availableAgents) {
    if (normalizeModeLookupId(agent.id) !== targetAgentType) {
      continue;
    }

    if (!Array.isArray(agent.defaultTools)) {
      return !params.isSubagentTarget;
    }

    return agent.defaultTools.some(tool => normalizeModeLookupId(tool) === 'skill');
  }

  return !params.isSubagentTarget;
}

export function isChatInputActionVisibleForTarget(params: {
  actionId: string;
  isSubagentTarget: boolean;
}): boolean {
  if (!params.isSubagentTarget) {
    return true;
  }

  const actionId = normalizeModeLookupId(params.actionId);
  return !actionId || !SUBAGENT_HIDDEN_CHAT_INPUT_ACTION_IDS.has(actionId);
}

export function isPrimarySlashActionVisible(params: {
  actionId: 'btw' | 'review';
  isBtwSession: boolean;
  canLaunchReview: boolean;
}): boolean {
  if (params.isBtwSession) {
    return false;
  }

  return params.actionId === 'btw' || params.canLaunchReview;
}

export function resolveWorkspaceChatInputMode(params: {
  currentMode: string;
  isAssistantWorkspace: boolean;
  sessionMode?: string | null;
}): string | null {
  const normalizedSessionMode = normalizeAgentTypeString(params.sessionMode);

  if (params.isAssistantWorkspace) {
    return params.currentMode === 'Claw' ? null : 'Claw';
  }

  if (normalizedSessionMode?.toLowerCase() === 'claw') {
    return params.currentMode === 'Claw' ? null : 'Claw';
  }

  if (normalizedSessionMode && normalizedSessionMode !== params.currentMode) {
    return normalizedSessionMode;
  }

  if (!normalizedSessionMode && params.currentMode === 'Claw') {
    return 'Standard';
  }

  return null;
}

export function resolveAvailableChatInputMode(params: {
  currentMode: string;
  isAssistantWorkspace: boolean;
  sessionMode?: string | null;
  userDefaultModeId?: string | null;
  availableModeIds: Iterable<string>;
}): string | null {
  const availableModeIds = new Set(
    Array.from(params.availableModeIds, (modeId) => canonicalAgentId(modeId.trim())).filter(Boolean),
  );
  const normalizedSessionMode = normalizeAgentTypeString(params.sessionMode);
  const synchronizedMode = resolveWorkspaceChatInputMode(params);

  // A persisted standard-Session mode is an execution binding, not a catalog
  // suggestion. If its source is temporarily unavailable, retain the logical
  // id and let the backend's durable route owner fail closed. Only an explicit
  // user selection may replace it. Assistant workspaces keep their product
  // rule below, where Claw remains authoritative.
  if (!params.isAssistantWorkspace && normalizedSessionMode) {
    return synchronizedMode;
  }

  if (availableModeIds.size === 0) {
    return null;
  }

  if (synchronizedMode && availableModeIds.has(synchronizedMode)) {
    return synchronizedMode;
  }

  const normalizedCurrentMode = canonicalAgentId(params.currentMode.trim());
  const normalizedUserDefaultModeId = normalizeUserDefaultChatInputModeId(params.userDefaultModeId);
  const effectiveUserDefaultModeId =
    normalizedUserDefaultModeId
      // Do not restore Assistant-fixed or retired Agents from user config.
      && !['claw', 'multitask', 'plan'].includes(normalizeModeLookupId(normalizedUserDefaultModeId) ?? '')
      && availableModeIds.has(normalizedUserDefaultModeId)
      ? normalizedUserDefaultModeId
      : null;
  const canUseUserDefaultMode =
    !params.isAssistantWorkspace &&
    !normalizedSessionMode &&
    Boolean(effectiveUserDefaultModeId);

  if (canUseUserDefaultMode && effectiveUserDefaultModeId && normalizedCurrentMode === 'Standard') {
    return effectiveUserDefaultModeId;
  }

  if (normalizedCurrentMode && availableModeIds.has(normalizedCurrentMode)) {
    return null;
  }

  if (canUseUserDefaultMode && effectiveUserDefaultModeId) {
    return effectiveUserDefaultModeId;
  }

  if (params.isAssistantWorkspace && availableModeIds.has('Claw')) {
    return 'Claw';
  }

  if (availableModeIds.has('Standard')) {
    return 'Standard';
  }

  return availableModeIds.values().next().value ?? null;
}
