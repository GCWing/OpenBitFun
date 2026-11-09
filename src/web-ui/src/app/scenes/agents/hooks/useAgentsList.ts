import { modelSelectionsConfigPath, effectiveModelSelections } from '@/infrastructure/config/services/modelSelections';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { modelPoolAPI, readableModelPools, supportsModelPools, type ModelPoolDefinition } from '@/infrastructure/api/service-api/ModelPoolAPI';
import { primaryAgentKind, agentName } from '@/shared/agents/identity';
import { isPrimaryAgent, isOrdinaryAgent } from '../agentVisibility';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
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
  AgentModelTargetSelection,
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
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';

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
  | 'loading'
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
  selectedAgentId?: string | null;
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
  builtinOverrides: Record<string, AgentModelTargetSelection>,
): AgentModelTargetSelection | undefined {
  const source = subagent.subagentSource ?? subagent.source;
  if (source === 'builtin') {
    return builtinOverrides[subagent.id];
  }

  if (!subagent.modelIsExplicit || !subagent.model?.trim()) {
    return undefined;
  }

  return subagent.model.trim() === 'inherit'
    ? { kind: 'inherit' }
    : { kind: 'model', model_ref: subagent.model.trim() };
}

function subagentModelDisplayName(
  selection: AgentModelTargetSelection | undefined,
  models: AIModelConfig[],
  defaultModels: DefaultModelsConfig,
): string | undefined {
  if (!selection || selection.kind === 'inherit') {
    return undefined;
  }

  if (selection.kind === 'pool') return selection.pool_id;
  const modelId = selection.model_ref.trim();
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
  selectedAgentId = null,
  filterLevel,
  filterType,
  t,
}: UseAgentsListOptions) {
  const notification = useNotification();
  const { workspace, workspacePath } = useCurrentWorkspace();
  const peerDevice = usePeerDeviceModeOptional();
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
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
  const [toolCatalogStatus, setToolCatalogStatus] = useState<ToolCatalogStatus>('loading');
  const [modelCatalogReady, setModelCatalogReady] = useState(false);
  const [modelPools, setModelPools] = useState<ModelPoolDefinition[]>([]);
  const [configuredModels, setConfiguredModels] = useState<AIModelConfig[]>([]);
  const [modeProfiles, setModeProfiles] = useState<Record<string, ModeProfileEntry>>({});
  const [agentSkills, setAgentSkills] = useState<Record<string, ModeSkillInfo[]>>({});
  const [skillCounts, setSkillCounts] = useState<Record<string, number>>({});
  const [subagentCounts, setSubagentCounts] = useState<Record<string, number>>({});
  const [countsLoading, setCountsLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [countsError, setCountsError] = useState<string | null>(null);
  const [modeConfigs, setModeConfigs] = useState<Record<string, AgentProfileConfigItem>>({});
  const [modeManageableSubagents, setModeManageableSubagents] = useState<Record<string, SubagentInfo[]>>({});
  const [hiddenAgentIds, setHiddenAgentIds] = useState<ReadonlySet<string>>(() => new Set(HIDDEN_AGENT_IDS));
  const [, setDetailRevision] = useState(0);
  const loadRequestIdRef = useRef(0);
  const catalogContextKey = scope.key(scope.epoch, renderedPeerDeviceId, workspace?.id, String(canQueryToolCatalog));
  const loadedContextKeyRef = useRef<string | null>(null);
  const translateRef = useRef(t);
  translateRef.current = t;
  const selectedIdRef = useRef(selectedAgentId);
  selectedIdRef.current = selectedAgentId;
  const catalogRef = useRef<{
    key: string; modes: ModeInfo[]; subagents: SubagentInfo[];
    profiles: Record<string, ModeProfileEntry>;
    configs: Record<string, AgentProfileConfigItem>;
  } | null>(null);
  const catalogFlight = useRef<{ key: string; promise: Promise<void> } | null>(null);
  const toolsFlight = useRef<{ key: string; promise: Promise<ToolCatalogLoadResult> } | null>(null);
  const details = useRef(new Map<string, { loaded: boolean; pending?: Promise<void>; error?: string; generation: number }>());
  const detailLoaderRef = useRef<(id: string, force?: boolean) => Promise<void>>(async () => {});

  const loadAgentDetails = useCallback((agentId: string, force = false): Promise<void> => {
    const catalog = catalogRef.current;
    if (!catalog || catalog.key !== catalogContextKey || !scope.isCurrent()) return Promise.resolve();
    const mode = catalog.modes.find(item => item.id === agentId);
    const subagent = catalog.subagents.find(item => item.id === agentId);
    if (!mode && !subagent) return Promise.resolve();
    const profile = mode ? catalog.profiles[modeProfileIdFor(mode)] : undefined;
    const profileId = profile?.profileId ?? agentId;
    const targetId = profile?.representativeModeId ?? agentId;
    const key = `${catalogContextKey}:${profileId}`;
    const previous = details.current.get(key);
    if (previous?.pending) return previous.pending;
    if (previous?.loaded && !force) return Promise.resolve();
    const entry = { loaded: previous?.loaded ?? false, generation: (previous?.generation ?? 0) + 1 } as {
      loaded: boolean; generation: number; pending?: Promise<void>; error?: string;
    };
    details.current.set(key, entry);
    setDetailRevision(value => value + 1);
    const current = () => scope.isCurrent() && catalogRef.current?.key === catalogContextKey && details.current.get(key) === entry;
    const fetchTools = (): Promise<ToolCatalogLoadResult> => {
      if (toolsFlight.current?.key === catalogContextKey) return toolsFlight.current.promise;
      const promise = !canQueryToolCatalog
        ? Promise.resolve<ToolCatalogLoadResult>({ tools: [], status: 'unsupported' })
        : api.invoke<ToolInfo[]>('get_all_tools_info').then(tools => ({ tools, status: tools.length ? 'available' : 'empty' } as ToolCatalogLoadResult)).catch(error => {
          toolLog.error('Failed to load tool catalog', { error });
          return { tools: [], status: 'failed' } as ToolCatalogLoadResult;
        });
      toolsFlight.current = { key: catalogContextKey, promise };
      return promise;
    };
    const configuredTools = mode
      ? catalog.configs[profileId]?.enabled_tools ?? mode.defaultTools ?? []
      : subagent?.defaultTools ?? [];
    entry.pending = Promise.all([
      fetchTools(),
      configuredTools.includes('Skill') ? configAPI.getModeSkillConfigs({ modeId: targetId, workspaceId: workspace?.id }) : Promise.resolve([] as ModeSkillInfo[]),
      mode ? SubagentAPI.listManageableSubagents({ parentAgentType: targetId, workspaceId: workspace?.id }) : Promise.resolve([] as SubagentInfo[]),
    ]).then(([toolCatalog, skills, manageable]) => {
      if (!current()) return;
      setAvailableTools(toolCatalog.tools);
      setToolCatalogStatus(toolCatalog.status);
      // A failed tool read is explicit and is retried on the next detail open.
      if (toolCatalog.status === 'failed') toolsFlight.current = null;
      setAgentSkills(state => ({ ...state, [profileId]: skills }));
      setSkillCounts(state => ({ ...state, [profileId]: skills.filter(skill => skill.effectiveEnabled).length }));
      if (mode) {
        setModeManageableSubagents(state => ({ ...state, [profileId]: manageable }));
        setSubagentCounts(state => ({ ...state, [profileId]: manageable.filter(agent => agent.effectiveEnabled).length }));
      }
      entry.loaded = true;
    }).catch(error => {
      if (!current()) return;
      entry.error = error instanceof Error ? error.message : String(error);
      toolLog.error('Failed to load Agent detail capabilities', { agentId, error });
    }).finally(() => {
      if (!current()) return;
      entry.pending = undefined;
      setDetailRevision(value => value + 1);
    });
    return entry.pending;
  }, [canQueryToolCatalog, catalogContextKey, scope, workspace?.id]);
  detailLoaderRef.current = loadAgentDetails;

  const loadAgents = useCallback((options?: { background?: boolean; force?: boolean }): Promise<void> => {
    const existing = catalogFlight.current;
    if (!options?.force && existing?.key === catalogContextKey) return existing.promise;
    const requestId = ++loadRequestIdRef.current;
    const current = () => requestId === loadRequestIdRef.current && scope.isCurrent();
    const retained = loadedContextKeyRef.current === catalogContextKey;
    setLoading(!(options?.background && retained));
    setCatalogError(null);
    if (!retained) {
      setSkillCounts({}); setSubagentCounts({}); setAgentSkills({});
      setModeManageableSubagents({}); setAvailableTools([]); setToolCatalogStatus('loading');
      setConfiguredModels([]); setModelPools([]); setModelCatalogReady(false);
    }
    const flight = { key: catalogContextKey, promise: Promise.resolve() };
    catalogFlight.current = flight;
    flight.promise = (async () => {
      try {
        const [modes, subagents, configs, reviewTeam] = await Promise.all([
          agentAPI.getAvailableModes({ workspaceId: workspace?.id, includeSubagentCounts: true }),
          SubagentAPI.listSubagents({ workspaceId: workspace?.id }),
          configAPI.getAgentProfileConfigs(),
          loadDefaultReviewTeamDefinition().catch(() => undefined),
        ]);
        if (!current()) return;
        const profiles = buildProfileMap(modes);
        const byProfile = buildModeConfigsByProfile(modes, configs);
        for (const [key, detail] of details.current) {
          if (key.startsWith(catalogContextKey + ':')) details.current.set(key, { ...detail, pending: undefined });
        }
        catalogRef.current = { key: catalogContextKey, modes, subagents, profiles, configs: byProfile };
        setModeProfiles(profiles); setModeConfigs(byProfile);
        setHiddenAgentIds(new Set([...HIDDEN_AGENT_IDS, ...(reviewTeam?.hiddenAgentIds ?? [])]));
        const initialCounts: Record<string, number> = {};
        for (const mode of modes) if (typeof mode.manageableSubagentCount === 'number') initialCounts[modeProfileIdFor(mode)] = mode.manageableSubagentCount;
        setSubagentCounts(state => retained ? { ...state, ...initialCounts } : initialCounts);
        const modeAgents = modes.map(mode => enrichCapabilities({
          key: `mode::${mode.id}`, id: mode.id, name: agentName(mode, translateRef.current),
          description: mode.description, isReadonly: mode.isReadonly, toolCount: mode.toolCount,
          defaultTools: mode.defaultTools ?? [], source: mode.source, path: mode.path, model: mode.model,
          promptCacheScopeKey: mode.promptCacheScopeKey, configProfileId: mode.configProfileId,
          configProfileLabel: mode.configProfileLabel, configProfileMemberModeIds: mode.configProfileMemberModeIds,
          visibleSubagentCount: initialCounts[modeProfileIdFor(mode)], capabilities: [], agentKind: primaryAgentKind(mode),
        }));
        const subAgents = subagents.map(agent => enrichCapabilities({ ...agent, name: agentName(agent, translateRef.current), capabilities: [], agentKind: 'subagent' as const }));
        setAllAgents([...modeAgents, ...subAgents]);
        loadedContextKeyRef.current = catalogContextKey;
        setLoading(false);
        setCountsLoading(true); setCountsError(null);
        toolsFlight.current = null;
        // An already-open editor keeps its mounted content while capabilities
        // are revalidated. Opening a closed detail is handled by its own effect.
        if (selectedIdRef.current) void detailLoaderRef.current(selectedIdRef.current, true);
        const skillTargets = [
          ...Object.values(profiles).map(profile => ({ key: profile.profileId, id: profile.representativeModeId })),
          ...subagents.filter(agent => agent.defaultTools.includes('Skill')).map(agent => ({ key: agent.id, id: agent.id })),
        ];
        const missingCounts = Object.values(profiles).filter(profile => initialCounts[profile.profileId] === undefined);
        const [skillResult, subagentResult, modelResult] = await Promise.allSettled([
          configAPI.getModeSkillCounts(skillTargets.map(target => target.id), workspace?.id),
          Promise.all(missingCounts.map(async profile => [profile.profileId, (await SubagentAPI.listManageableSubagents({ parentAgentType: profile.representativeModeId, workspaceId: workspace?.id })).filter(agent => agent.effectiveEnabled).length] as const)),
          Promise.all([
            configAPI.getConfigs(['ai.models', 'ai.default_models', modelSelectionsConfigPath()]),
            supportsModelPools() ? modelPoolAPI.list() : Promise.resolve(undefined),
          ]),
        ]);
        if (!current()) return;
        const failures: string[] = [];
        if (skillResult.status === 'fulfilled') {
          setSkillCounts(Object.fromEntries(skillTargets.map(target => [target.key, skillResult.value[target.id]])));
        } else failures.push(String(skillResult.reason));
        if (subagentResult.status === 'fulfilled') {
          setSubagentCounts(state => ({ ...state, ...Object.fromEntries(subagentResult.value) }));
        } else failures.push(String(subagentResult.reason));
        if (modelResult.status === 'fulfilled') {
          const [modelConfigs, document] = modelResult.value;
          const models = (modelConfigs['ai.models'] as AIModelConfig[] | undefined) ?? [];
          const defaults = (modelConfigs['ai.default_models'] as DefaultModelsConfig | undefined) ?? {};
          const overrides = effectiveModelSelections(modelConfigs[modelSelectionsConfigPath()] as AgentModelDefaultsConfig | undefined).subagents.builtin;
          const pools = document ? readableModelPools(document) : [];
          setModelPools(pools); setConfiguredModels(models); setModelCatalogReady(true);
          const projected = new Map(subagents.map(agent => {
            const selection = subagentModelOverride(agent, overrides);
            return [agent.id, { subagentModelOverride: selection, subagentModelDisplayName: selection?.kind === 'pool' ? pools.find(pool => pool.id === selection.pool_id)?.name ?? selection.pool_id : subagentModelDisplayName(selection, models, defaults) }];
          }));
          setAllAgents(state => state.map(agent => agent.agentKind === 'subagent' ? { ...agent, ...projected.get(agent.id) } : agent));
        } else failures.push(String(modelResult.reason));
        if (failures.length) {
          setCountsError(failures.join('\n'));
          toolLog.error('Failed to load Agent catalog summaries', { errors: failures });
        }
      } catch (error) {
        if (current()) {
          setCatalogError(error instanceof Error ? error.message : String(error));
          toolLog.error('Failed to load Agent catalog', { error });
        }
      } finally {
        if (current()) { setLoading(false); setCountsLoading(false); }
        if (catalogFlight.current === flight) catalogFlight.current = null;
      }
    })();
    return flight.promise;
  }, [catalogContextKey, scope, workspace?.id]);

  useEffect(() => { void loadAgents(); }, [loadAgents]);
  useEffect(() => {
    const refresh = () => { void loadAgents({ background: true, force: true }); };
    globalEventBus.on('custom-agent:updated', refresh);
    return () => globalEventBus.off('custom-agent:updated', refresh);
  }, [loadAgents]);
  useEffect(() => {
    if (selectedAgentId) void loadAgentDetails(selectedAgentId, true);
  }, [selectedAgentId, loadAgentDetails]);

  const profileForCount = (agentId: string) => {
    const mode = catalogRef.current?.modes.find(mode => mode.id === agentId);
    return mode ? modeProfileIdFor(mode) : agentId;
  };
  const getAgentSkillCount = (agentId: string): number | null => skillCounts[profileForCount(agentId)] ?? null;
  const getAgentSubagentCount = (agentId: string): number | null => subagentCounts[profileForCount(agentId)] ?? null;
  const detailMode = catalogRef.current?.modes.find(mode => mode.id === selectedAgentId);
  const detailKey = `${catalogContextKey}:${detailMode ? modeProfileIdFor(detailMode) : selectedAgentId}`;
  const selectedDetail = details.current.get(detailKey);
  const detailsLoading = Boolean(selectedAgentId && !selectedDetail?.loaded && !selectedDetail?.error);
  const detailsError = selectedDetail?.error ?? null;
  // Changing only the language reprojects labels, without restarting requests.
  const localizedAgents = useMemo(() => allAgents.map(agent => ({ ...agent, name: agentName(agent, t) })), [allAgents, t]);
  const catalogOwned = loadedContextKeyRef.current === catalogContextKey;

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
    void loadAgents({ background: true, force: true });

    try {
      const { globalEventBus } = await import('@/infrastructure/event-bus');
      globalEventBus.emit('mode:config:updated');
    } catch {
      // ignore
    }
  }, [getModeConfig, getModeProfile, loadAgents]);

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
      setSkillCounts(state => ({ ...state, [profile.profileId]: updatedSkills.filter(skill => skill.effectiveEnabled).length }));
      void loadAgents({ background: true, force: true });
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
  }, [getModeProfile, loadAgents, notification, t, workspace?.id]);

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
      setSkillCounts(state => ({ ...state, [cacheKey]: updatedSkills.filter(skill => skill.effectiveEnabled).length }));
      void loadAgents({ background: true, force: true });

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
  }, [getModeProfile, loadAgents, notification, t, workspace?.id]);

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
      setSkillCounts(state => ({ ...state, [cacheKey]: updatedSkills.filter(skill => skill.effectiveEnabled).length }));
      void loadAgents({ background: true, force: true });

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
  }, [getModeProfile, loadAgents, notification, t, workspace?.id]);

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
      });

      setSubagentCounts(state => ({ ...state, [profile.profileId]: updatedSubagents.filter(agent => agent.effectiveEnabled).length }));
      void loadAgents({ background: true, force: true });
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
  }, [getModeProfile, loadAgents, notification, t, workspace?.id]);

  const handleSetSubagentModel = useCallback(async (
    subagentId: string,
    selection: AgentModelTargetSelection | undefined,
  ) => {
    try {
      const source = allAgents.find(agent => agent.id === subagentId && agent.agentKind === 'subagent');
      if (source && resolveAgentSource(source) === 'builtin' && modelSelectionsConfigPath() === 'ai.agent_model_selections') {
        await configManager.setConfig(`ai.agent_model_selections.subagents.builtin.${subagentId}`, selection ?? null);
      } else {
        if (selection?.kind === 'pool') throw new Error('Model pools are not supported by this agent configuration');
        await SubagentAPI.updateSubagentConfig({
          subagentId,
          model: selection ? (selection.kind === 'inherit' ? 'inherit' : selection.model_ref) : undefined,
          clearModelOverride: !selection,
          workspaceId: workspace?.id,
        });
      }
      await loadAgents({ background: true, force: true });
    } catch {
      notification.error(t('agentCard.modelSelector.updateFailed'));
    }
  }, [allAgents, loadAgents, notification, t, workspace?.id]);

  const filteredAgents = useMemo(() => localizedAgents.filter((agent) => {
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
  }), [localizedAgents, filterLevel, filterType, searchQuery]);

  const overviewAgents = useMemo(
    () => localizedAgents.filter((agent) => !hiddenAgentIds.has(agent.id) && agent.agentKind !== 'harness'),
    [localizedAgents, hiddenAgentIds],
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
    catalogContextKey,
    workspacePath,
    workspaceId: workspace?.id,
    workspaceIsRemote: isRemoteWorkspace(workspace),
    allAgents: catalogOwned ? localizedAgents : [],
    filteredAgents: catalogOwned ? filteredAgents : [],
    loading: (loading || !catalogOwned) && !catalogError,
    countsLoading, catalogError, countsError,
    detailsLoading, detailsLoaded: Boolean(selectedDetail?.loaded), detailsError, loadAgentDetails,
    getAgentSkillCount, getAgentSubagentCount,
    availableTools,
    toolCatalogStatus,
    configuredModels,
    modelPools,
    modelCatalogReady,
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
