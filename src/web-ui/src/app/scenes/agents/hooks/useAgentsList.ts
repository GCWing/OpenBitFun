import { primaryAgentKind, agentName } from '@/shared/agents/identity';
import { isPrimaryAgent, isOrdinaryAgent } from '../agentVisibility';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { agentAPI, type ModeInfo } from '@/infrastructure/api/service-api/AgentAPI';
import { api } from '@/infrastructure/api/service-api/ApiClient';
import type { AgentSource } from '@/infrastructure/api/service-api/CustomAgentAPI';
import { SubagentAPI, type SubagentInfo } from '@/infrastructure/api/service-api/SubagentAPI';
import { configAPI } from '@/infrastructure/api/service-api/ConfigAPI';
import type {
  AgentModelDefaultsConfig,
  AgentProfileConfigItem,
  AIModelConfig,
  DefaultModelsConfig,
  ModeSkillInfo,
  SubagentModelSelection,
} from '@/infrastructure/config/types';
import { useNotification } from '@/shared/notification-system';
import type { DynamicToolInfo } from '@/shared/types/agent-api';
import type { AgentWithCapabilities } from '../agentsStore';
import { enrichCapabilities } from '../utils';
import { HIDDEN_AGENT_IDS } from '../agentVisibility';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { loadDefaultReviewTeamDefinition } from '@/shared/services/reviewTeamService';
import { globalEventBus } from '@/infrastructure/event-bus';
import { isRemoteWorkspace } from '@/shared/types';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { canQueryToolCatalogOnSurface } from '@/infrastructure/peer-device/peerCapabilityResolution';
import { createLogger } from '@/shared/utils/logger';

const toolLog = createLogger('useAgentsList');

export type FilterLevel = 'all' | 'builtin' | 'user' | 'project' | 'external';
export type FilterType = 'all' | 'agent' | 'subagent';

/**
 * State of the tool catalog load, so the UI can distinguish "host doesn't expose
 * a catalog", "the read failed (retryable)", and "the runtime really has no
 * tools" — collapsing all three into `[]` masked transport failures as an
 * empty list. See PR #2428 #5.
 */
export type ToolCatalogStatus =
  | 'available'
  | 'unsupported'
  | 'failed'
  | 'empty';

export interface ToolInfo {
  name: string;
  description: string;
  is_readonly: boolean;
  dynamic_info?: DynamicToolInfo;
}

interface ToolCatalogLoadResult {
  tools: ToolInfo[];
  status: ToolCatalogStatus;
}

interface UseAgentsListOptions {
  searchQuery: string;
  filterLevel: FilterLevel;
  filterType: FilterType;
  t: TFunction<'scenes/agents'>;
}

interface ModeProfileEntry {
  profileId: string;
  profileLabel?: string;
  memberModeIds: string[];
  representativeModeId: string;
}

function modeProfileIdFor(mode: Pick<ModeInfo, 'id' | 'configProfileId'>): string {
  return mode.configProfileId || mode.id;
}

function buildProfileMap(modes: ModeInfo[]): Record<string, ModeProfileEntry> {
  const profiles = new Map<string, ModeProfileEntry>();

  for (const mode of modes) {
    const profileId = modeProfileIdFor(mode);
    const existing = profiles.get(profileId);
    const memberModeIds = mode.configProfileMemberModeIds?.length
      ? mode.configProfileMemberModeIds
      : [mode.id];

    if (existing) {
      existing.memberModeIds = Array.from(new Set([...existing.memberModeIds, ...memberModeIds]));
      continue;
    }

    profiles.set(profileId, {
      profileId,
      profileLabel: mode.configProfileLabel,
      memberModeIds: [...memberModeIds],
      representativeModeId: mode.id,
    });
  }

  return Object.fromEntries(profiles.entries());
}

function buildModeConfigsByProfile(
  modes: ModeInfo[],
  configs: Record<string, AgentProfileConfigItem>,
): Record<string, AgentProfileConfigItem> {
  const byProfile: Record<string, AgentProfileConfigItem> = {};

  for (const mode of modes) {
    const config = configs[mode.id];
    if (!config) {
      continue;
    }
    byProfile[modeProfileIdFor(mode)] = config;
  }

  return byProfile;
}

function resolveAgentSource(
  agent: Pick<AgentWithCapabilities, 'source' | 'subagentSource'>,
): AgentSource {
  return agent.source ?? agent.subagentSource ?? 'builtin';
}

function configuredModelName(
  models: AIModelConfig[],
  modelId: string | null | undefined,
): string | undefined {
  if (!modelId?.trim()) {
    return undefined;
  }

  const model = models.find((candidate) => candidate.id === modelId);
  return model?.model_name?.trim() || model?.name?.trim() || model?.id;
}

function subagentModelOverride(
  subagent: SubagentInfo,
  builtinOverrides: Record<string, SubagentModelSelection>,
): SubagentModelSelection | undefined {
  const source = subagent.subagentSource ?? subagent.source;
  if (source === 'builtin') {
    return builtinOverrides[subagent.id];
  }

  if (!subagent.modelIsExplicit || !subagent.model?.trim()) {
    return undefined;
  }

  return subagent.model.trim() === 'inherit'
    ? { kind: 'inherit' }
    : { kind: 'fixed', model_id: subagent.model.trim() };
}

function subagentModelDisplayName(
  selection: SubagentModelSelection | undefined,
  models: AIModelConfig[],
  defaultModels: DefaultModelsConfig,
): string | undefined {
  if (!selection || selection.kind === 'inherit') {
    return undefined;
  }

  const modelId = selection.model_id.trim();
  if (!modelId) {
    return undefined;
  }

  if (modelId === 'primary') {
    return configuredModelName(models, defaultModels.primary) ?? modelId;
  }

  if (modelId === 'fast') {
    return configuredModelName(models, defaultModels.fast)
      ?? configuredModelName(models, defaultModels.primary)
      ?? modelId;
  }

  return configuredModelName(models, modelId) ?? modelId;
}

export function useAgentsList({
  searchQuery,
  filterLevel,
  filterType,
  t,
}: UseAgentsListOptions) {
  const notification = useNotification();
  const { workspace, workspacePath } = useCurrentWorkspace();
  const peerDevice = usePeerDeviceModeOptional();
  // Identity of the rendered surface: null on the controller, otherwise the
  // peer device id. Part of the catalog-load deps so A→B (same workspacePath,
  // same capability) still reloads — otherwise the UI keeps A's catalog while
  // config mutations route to B. The loadRequestIdRef guard drops A's in-flight
  // result once B's load starts. See PR #2428 #3.
  const renderedPeerDeviceId = peerDevice?.peerMode.active
    ? peerDevice.peerMode.deviceId
    : null;
  // True on this machine; on a peer, true only after the host advertises the
  // `tool_catalog` capability (null while probing = optimistic, since a CLI
  // Peer Host now implements it). When a peer does not support the catalog we
  // skip the invoke instead of swallowing the unsupported error as an empty
  // list — the UI can then show "no tools" without masking a transport failure.
  // An older CLI that didn't advertise the field is resolved via `hostKind`
  // (cli → unsupported) by the shared helper. See PR #2428 round 5 #1.
  const canQueryToolCatalog = canQueryToolCatalogOnSurface(
    Boolean(peerDevice?.peerMode.active),
    peerDevice?.currentPeerCapabilities ?? null,
  );
  const [allAgents, setAllAgents] = useState<AgentWithCapabilities[]>([]);
  const [loading, setLoading] = useState(true);
  const [availableTools, setAvailableTools] = useState<ToolInfo[]>([]);
  const [toolCatalogStatus, setToolCatalogStatus] = useState<ToolCatalogStatus>('available');
  const [configuredModels, setConfiguredModels] = useState<AIModelConfig[]>([]);
  const [modeProfiles, setModeProfiles] = useState<Record<string, ModeProfileEntry>>({});
  const [agentSkills, setAgentSkills] = useState<Record<string, ModeSkillInfo[]>>({});
  const [modeConfigs, setModeConfigs] = useState<Record<string, AgentProfileConfigItem>>({});
  const [modeManageableSubagents, setModeManageableSubagents] = useState<Record<string, SubagentInfo[]>>({});
  const [hiddenAgentIds, setHiddenAgentIds] = useState<ReadonlySet<string>>(
    () => new Set(HIDDEN_AGENT_IDS),
  );
  const loadRequestIdRef = useRef(0);

  const loadAgents = useCallback(async () => {
    const requestId = ++loadRequestIdRef.current;
    setLoading(true);
    // `renderedPeerDeviceId` is read here so a surface switch (A→B) recreates
    // this callback even when canQueryToolCatalog/workspacePath are unchanged;
    // the requestId guard then drops the previous surface's in-flight result.
    // See PR #2428 #3.
    const surfaceTag = renderedPeerDeviceId ?? 'controller';

    const fetchTools = async (): Promise<ToolCatalogLoadResult> => {
      if (!canQueryToolCatalog) {
        toolLog.info('Tool catalog unsupported on the current peer host; leaving the list empty', { surface: surfaceTag });
        return { tools: [], status: 'unsupported' };
      }
      try {
        const tools = await api.invoke<ToolInfo[]>('get_all_tools_info');
        return {
          tools,
          status: tools.length > 0 ? 'available' : 'empty',
        };
      } catch (error) {
        toolLog.error('Failed to load tool catalog', { error });
        return { tools: [], status: 'failed' };
      }
    };

    try {
      const [modes, subagents, toolCatalog, configs, reviewTeamDefinition, modelConfigs] = await Promise.all([
        agentAPI.getAvailableModes({ workspaceId: workspace?.id }).catch(() => []),
        SubagentAPI.listSubagents({ workspaceId: workspace?.id }).catch(() => []),
        fetchTools(),
        configAPI.getAgentProfileConfigs().catch(() => ({})),
        loadDefaultReviewTeamDefinition().catch(() => undefined),
        configAPI.getConfigs([
          'ai.models',
          'ai.default_models',
          'ai.agent_model_defaults',
        ]).catch((): Record<string, unknown> => ({})),
      ]);

      const profileMap = buildProfileMap(modes);
      const profileEntries = Object.values(profileMap);

      const skillTargets = [
        ...profileEntries.map((profile) => ({
          cacheKey: profile.profileId,
          agentId: profile.representativeModeId,
        })),
        ...subagents
          .filter((subagent) => subagent.defaultTools.includes('Skill'))
          .map((subagent) => ({
            cacheKey: subagent.id,
            agentId: subagent.id,
          })),
      ];
      const skillEntries = await Promise.all(
        skillTargets.map(async ({ cacheKey, agentId }) => [
          cacheKey,
          await configAPI.getModeSkillConfigs({
            modeId: agentId,
            workspaceId: workspace?.id,
          }).catch(() => []),
        ] as const),
      );
      const manageableSubagentEntries = await Promise.all(
        profileEntries.map(async (profile) => [
          profile.profileId,
          await SubagentAPI.listManageableSubagents({
            parentAgentType: profile.representativeModeId,
            workspaceId: workspace?.id,
          }).catch(() => []),
        ] as const),
      );

      if (requestId !== loadRequestIdRef.current) {
        return;
      }

      const manageableSubagentsByProfile = Object.fromEntries(manageableSubagentEntries);
      const models = (modelConfigs['ai.models'] as AIModelConfig[] | undefined) ?? [];
      const defaultModels = (
        modelConfigs['ai.default_models'] as DefaultModelsConfig | undefined
      ) ?? {};
      const builtinOverrides = (
        modelConfigs['ai.agent_model_defaults'] as AgentModelDefaultsConfig | undefined
      )?.subagents?.builtin ?? {};

      const modeAgents: AgentWithCapabilities[] = modes.map((mode) =>
        enrichCapabilities({
          key: `mode::${mode.id}`,
          id: mode.id,
          name: agentName(mode, t),
          description: mode.description,
          isReadonly: mode.isReadonly,
          toolCount: mode.toolCount,
          defaultTools: mode.defaultTools ?? [],
          source: mode.source,
          path: mode.path,
          model: mode.model,
          promptCacheScopeKey: mode.promptCacheScopeKey,
          configProfileId: mode.configProfileId,
          configProfileLabel: mode.configProfileLabel,
          configProfileMemberModeIds: mode.configProfileMemberModeIds,
          visibleSubagentCount: manageableSubagentsByProfile[mode.configProfileId]
            ?.filter((subagent) => subagent.effectiveEnabled).length ?? 0,
          capabilities: [],
          agentKind: primaryAgentKind(mode),
        }),
      );

      const subAgents: AgentWithCapabilities[] = subagents.map((subagent) => {
        const modelOverride = subagentModelOverride(subagent, builtinOverrides);

        return enrichCapabilities({
          ...subagent,
          name: agentName(subagent, t),
          capabilities: [],
          agentKind: 'subagent',
          subagentModelOverride: modelOverride,
          subagentModelDisplayName: subagentModelDisplayName(modelOverride, models, defaultModels),
        });
      });

      setAllAgents([...modeAgents, ...subAgents]);
      setAvailableTools(toolCatalog.tools);
      setToolCatalogStatus(toolCatalog.status);
      setConfiguredModels(models);
      setModeProfiles(profileMap);
      setAgentSkills(Object.fromEntries(skillEntries));
      setModeConfigs(buildModeConfigsByProfile(modes, configs as Record<string, AgentProfileConfigItem>));
      setModeManageableSubagents(manageableSubagentsByProfile);
      setHiddenAgentIds(new Set([
        ...HIDDEN_AGENT_IDS,
        ...(reviewTeamDefinition?.hiddenAgentIds ?? []),
      ]));
    } finally {
      if (requestId === loadRequestIdRef.current) {
        setLoading(false);
      }
    }
  }, [canQueryToolCatalog, workspace?.id, renderedPeerDeviceId, t]);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  useEffect(() => {
    const handleCustomAgentUpdated = () => {
      void loadAgents();
    };

    globalEventBus.on('custom-agent:updated', handleCustomAgentUpdated);
    return () => {
      globalEventBus.off('custom-agent:updated', handleCustomAgentUpdated);
    };
  }, [loadAgents]);

  const getModeProfile = useCallback((agentId: string): ModeProfileEntry | null => {
    const agent = allAgents.find((item) => item.id === agentId && isPrimaryAgent(item));
    if (!agent) {
      return null;
    }

    const profileId = agent.configProfileId ?? agentId;
    return modeProfiles[profileId] ?? {
      profileId,
      profileLabel: agent.configProfileLabel,
      memberModeIds: agent.configProfileMemberModeIds ?? [agentId],
      representativeModeId: agentId,
    };
  }, [allAgents, modeProfiles]);

  const getModeConfig = useCallback((agentId: string): AgentProfileConfigItem | null => {
    const agent = allAgents.find((item) => item.id === agentId && isPrimaryAgent(item));
    if (!agent) return null;

    const profileId = agent.configProfileId ?? agentId;
    const userConfig = modeConfigs[profileId];
    const defaultTools = agent.defaultTools ?? [];

    if (!userConfig) {
      return {
        profile_id: agent.configProfileId ?? agentId,
        enabled_tools: defaultTools,
        default_tools: defaultTools,
      };
    }

    return {
      ...userConfig,
      profile_id: profileId,
      default_tools: userConfig.default_tools ?? defaultTools,
    };
  }, [allAgents, modeConfigs]);

  const getAgentSkills = useCallback((agentId: string): ModeSkillInfo[] => {
    const profile = getModeProfile(agentId);
    return agentSkills[profile?.profileId ?? agentId] ?? [];
  }, [agentSkills, getModeProfile]);

  const getModeManageableSubagents = useCallback((agentId: string): SubagentInfo[] => {
    const profile = getModeProfile(agentId);
    return profile ? (modeManageableSubagents[profile.profileId] ?? []) : [];
  }, [getModeProfile, modeManageableSubagents]);

  const saveModeConfig = useCallback(async (agentId: string, updates: Partial<AgentProfileConfigItem>) => {
    const config = getModeConfig(agentId);
    const profile = getModeProfile(agentId);
    if (!config || !profile) return;

    const updated = { ...config, ...updates };
    await configAPI.setAgentProfileConfig(profile.representativeModeId, updated);
    setModeConfigs((prev) => ({ ...prev, [profile.profileId]: updated }));

    try {
      const { globalEventBus } = await import('@/infrastructure/event-bus');
      globalEventBus.emit('mode:config:updated');
    } catch {
      // ignore
    }
  }, [getModeConfig, getModeProfile]);

  const handleSetTools = useCallback(async (agentId: string, toolNames: string[]) => {
    try {
      const nextTools = Array.from(new Set(toolNames));
      await saveModeConfig(agentId, { enabled_tools: nextTools });
    } catch {
      notification.error(t('agentsOverview.toolToggleFailed'));
    }
  }, [notification, saveModeConfig, t]);

  const handleResetTools = useCallback(async (agentId: string) => {
    const profile = getModeProfile(agentId);
    if (!profile) return;

    try {
      await configAPI.resetAgentProfileConfig(profile.representativeModeId);
      const updated = await configAPI.getAgentProfileConfigs();
      const updatedSkills = await configAPI.getModeSkillConfigs({
        modeId: profile.representativeModeId,
        workspaceId: workspace?.id,
      });
      const modes = await agentAPI.getAvailableModes().catch(() => []);
      setModeConfigs(buildModeConfigsByProfile(modes, updated as Record<string, AgentProfileConfigItem>));
      setAgentSkills((prev) => ({ ...prev, [profile.profileId]: updatedSkills }));
      notification.success(t('agentsOverview.toolsResetSuccess'));

      try {
        const { globalEventBus } = await import('@/infrastructure/event-bus');
        globalEventBus.emit('mode:config:updated');
      } catch {
        // ignore
      }
    } catch {
      notification.error(t('agentsOverview.toolsResetFailed'));
    }
  }, [getModeProfile, notification, t, workspace?.id]);

  const handleSetSkills = useCallback(async (agentId: string, enabledSkillKeys: string[]) => {
    const profile = getModeProfile(agentId);
    const cacheKey = profile?.profileId ?? agentId;
    const targetAgentId = profile?.representativeModeId ?? agentId;

    try {
      await configAPI.replaceModeSkillSelection({
        modeId: targetAgentId,
        enabledSkillKeys,
        workspaceId: workspace?.id,
      });

      const updatedSkills = await configAPI.getModeSkillConfigs({
        modeId: targetAgentId,
        workspaceId: workspace?.id,
      });
      setAgentSkills((prev) => ({ ...prev, [cacheKey]: updatedSkills }));

      try {
        const { globalEventBus } = await import('@/infrastructure/event-bus');
        globalEventBus.emit('mode:config:updated');
      } catch {
        // ignore
      }
      return true;
    } catch {
      notification.error(t('agentsOverview.skillToggleFailed'));
      return false;
    }
  }, [getModeProfile, notification, t, workspace?.id]);

  const handleResetSkills = useCallback(async (agentId: string) => {
    const profile = getModeProfile(agentId);
    const cacheKey = profile?.profileId ?? agentId;
    const targetAgentId = profile?.representativeModeId ?? agentId;

    try {
      await configAPI.resetModeSkillSelection({
        modeId: targetAgentId,
        workspaceId: workspace?.id,
      });

      const updatedSkills = await configAPI.getModeSkillConfigs({
        modeId: targetAgentId,
        workspaceId: workspace?.id,
      });
      setAgentSkills((prev) => ({ ...prev, [cacheKey]: updatedSkills }));

      try {
        const { globalEventBus } = await import('@/infrastructure/event-bus');
        globalEventBus.emit('mode:config:updated');
      } catch {
        // ignore
      }
      return true;
    } catch {
      notification.error(t('agentsOverview.skillToggleFailed'));
      return false;
    }
  }, [getModeProfile, notification, t, workspace?.id]);

  const handleSetSubagentEnabled = useCallback(async (
    agentId: string,
    subagentId: string,
    enabled: boolean,
  ) => {
    const profile = getModeProfile(agentId);
    if (!profile) return;

    try {
      await SubagentAPI.updateSubagentConfig({
        subagentId,
        parentAgentType: agentId,
        enabled,
        workspaceId: workspace?.id,
      });

      const updatedSubagents = await SubagentAPI.listManageableSubagents({
        parentAgentType: profile.representativeModeId,
        workspaceId: workspace?.id,
      }).catch(() => []);

      setModeManageableSubagents((prev) => ({
        ...prev,
        [profile.profileId]: updatedSubagents,
      }));
      setAllAgents((prev) => prev.map((agent) => (
        isPrimaryAgent(agent) && (agent.configProfileId ?? agent.id) === profile.profileId
          ? {
              ...agent,
              visibleSubagentCount: updatedSubagents.filter((subagent) => subagent.effectiveEnabled).length,
            }
          : agent
      )));

      try {
        const { globalEventBus } = await import('@/infrastructure/event-bus');
        globalEventBus.emit('mode:config:updated');
      } catch {
        // ignore
      }
    } catch {
      notification.error(t('agentsOverview.subagentToggleFailed'));
    }
  }, [getModeProfile, notification, t, workspace?.id]);

  const handleSetSubagentModel = useCallback(async (
    subagentId: string,
    selection: SubagentModelSelection | undefined,
  ) => {
    try {
      await SubagentAPI.updateSubagentConfig({
        subagentId,
        model: selection
          ? (selection.kind === 'inherit' ? 'inherit' : selection.model_id)
          : undefined,
        clearModelOverride: !selection,
        workspaceId: workspace?.id,
      });
      await loadAgents();
    } catch {
      notification.error(t('agentCard.modelSelector.updateFailed'));
    }
  }, [loadAgents, notification, t, workspace?.id]);

  const filteredAgents = useMemo(() => allAgents.filter((agent) => {
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      if (!agent.name.toLowerCase().includes(query) && !agent.description.toLowerCase().includes(query)) {
        return false;
      }
    }

    if (filterType !== 'all') {
      if (filterType === 'agent' && !isOrdinaryAgent(agent)) return false;
      if (filterType === 'subagent' && agent.agentKind !== 'subagent') return false;
    }

    if (filterLevel !== 'all') {
      const level = resolveAgentSource(agent);
      if (level !== filterLevel) return false;
    }

    return true;
  }), [allAgents, filterLevel, filterType, searchQuery]);

  const overviewAgents = useMemo(
    () => allAgents.filter((agent) => !hiddenAgentIds.has(agent.id) && agent.agentKind !== 'harness'),
    [allAgents, hiddenAgentIds],
  );

  const counts = useMemo(() => ({
    all: overviewAgents.length,
    builtin: overviewAgents.filter((agent) => resolveAgentSource(agent) === 'builtin').length,
    user: overviewAgents.filter((agent) => resolveAgentSource(agent) === 'user').length,
    project: overviewAgents.filter((agent) => resolveAgentSource(agent) === 'project').length,
    external: overviewAgents.filter((agent) => resolveAgentSource(agent) === 'external').length,
    agent: overviewAgents.filter(isOrdinaryAgent).length,
    subagent: overviewAgents.filter((agent) => agent.agentKind === 'subagent').length,
  }), [overviewAgents]);

  return {
    workspacePath,
    workspaceId: workspace?.id,
    workspaceIsRemote: isRemoteWorkspace(workspace),
    allAgents,
    filteredAgents,
    loading,
    availableTools,
    toolCatalogStatus,
    configuredModels,
    getModeProfile,
    getAgentSkills,
    getModeManageableSubagents,
    counts,
    hiddenAgentIds,
    loadAgents,
    getModeConfig,
    handleSetTools,
    handleResetTools,
    handleSetSkills,
    handleResetSkills,
    handleSetSubagentEnabled,
    handleSetSubagentModel,
  };
}

export { enrichCapabilities };
