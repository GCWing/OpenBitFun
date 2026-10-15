import { isPrimaryAgent, isOrdinaryAgent } from './agentVisibility';
import {
  Button, Combobox, Dialog, DialogBody, DialogClose, DialogFooter,
  DialogHeader, DialogHeaderActions, DialogHeading, DialogTitle, Field,
  FormSection, Icon, IconButton, SearchField, Select, StatusPill, Toolbar, Tooltip,
} from '@openbitfun/ui';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { TFunction } from 'i18next';
import { RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { confirmDanger } from '@/infrastructure/confirm-dialog';
import { AssistantAvatar } from '@/app/components/AssistantAvatar';
import agentAvatar from '@/flow_chat/assets/subagent-avatars/robot-04.svg';
import {
  GalleryEmpty,
  GalleryGrid,
  GalleryLayout,
  GalleryPageHeader,
  GallerySkeleton,
  GalleryZone,
} from '@/app/components/GalleryLayout';
import AgentCard from './components/AgentCard';
import AgentHarnessOverview from './components/AgentHarnessOverview';
import { AgentCapabilityCards, type AgentCapabilityEntry, type CapabilitySection } from './components/AgentCapabilityCards';
import { HarnessPreviewContent } from './components/HarnessPreviewContent';
import { useHarnessDialogTransition, type AgentDetailView } from './components/useHarnessDialogTransition';
import { isHarnessId } from '@/shared/agents/identity';
import CoreAgentCard from './components/CoreAgentCard';
import CreateAgentPage from './components/CreateAgentPage';
import {
  AgentCapabilityTooltip,
  type AgentCapabilityTooltipField,
} from './components/AgentCapabilityTooltip';
import { capabilityTooltipAriaLabel } from './components/agentCapabilityTooltipUtils';
import { AgentCapabilityOption } from './components/AgentCapabilityOption';
import { SkillGroupPicker, SkillGroupSummary } from './components/SkillGroupPicker';
import { ToolGroupPicker, ToolGroupSummary } from './components/ToolGroupPicker';
import { useUserSkillGroups } from '@/features/skill-groups/useUserSkillGroups';
import { useUserToolGroups } from './components/useUserToolGroups';
import {
  type AgentFilterLevel,
  type AgentFilterType,
  type AgentWithCapabilities,
  useAgentsStore,
} from './agentsStore';
import { useAgentsList } from './hooks/useAgentsList';
import { isAgentProfileConfigurableToolName } from './agentToolVisibility';
import { getAgentBadge, getAgentDescription } from './utils';
import './AgentsView.scss';
import './AgentsScene.scss';
import './components/AgentDetailDialog.scss';
import { useGallerySceneAutoRefresh } from '@/app/hooks/useGallerySceneAutoRefresh';
import {
  isAgentInOverviewZone,
  isLocallyManageableSubagent,
} from './agentVisibility';
import { CustomAgentAPI } from '@/infrastructure/api/service-api/CustomAgentAPI';
import { useComputerUseEnabled } from '@/infrastructure/config/hooks/useComputerUseEnabled';
import type { ModeSkillInfo, SubagentModelSelection } from '@/infrastructure/config/types';
import {
  buildSkillCoverageSourceMap,
  getModeSkillRuntimeStatus,
} from '@/infrastructure/config/skillSourcePresentation';
import type { SubagentInfo } from '@/infrastructure/api/service-api/SubagentAPI';
import { useNotification } from '@/shared/notification-system';
import {
  type ModelSelectOption,
  useModelSelectPresentation,
} from '@/infrastructure/config/components/ModelSelectPresentation';
import { openEcosystemCompatibility } from '@/app/scenes/ecosystem-compatibility/ecosystemCompatibilityStore';

const DEFAULT_SUBAGENT_MODEL_OVERRIDE_VALUE = '__default_subagent_model__';

type AgentDetailSection = 'basic' | CapabilitySection;

function normalizeSelectValue(value: string | number | (string | number)[]): string {
  return String(Array.isArray(value) ? (value[0] ?? '') : value);
}

function subagentModelOverrideValue(selection: SubagentModelSelection | undefined): string {
  if (!selection) {
    return DEFAULT_SUBAGENT_MODEL_OVERRIDE_VALUE;
  }
  return selection.kind === 'inherit' ? 'inherit' : selection.model_id;
}

function subagentModelSelectionFromValue(value: string): SubagentModelSelection | undefined {
  if (value === DEFAULT_SUBAGENT_MODEL_OVERRIDE_VALUE) {
    return undefined;
  }
  return value === 'inherit'
    ? { kind: 'inherit' }
    : { kind: 'fixed', model_id: value };
}

function getConfiguredEnabledSkillKeys(skills: ModeSkillInfo[]): string[] {
  return skills.filter((skill) => skill.effectiveEnabled).map((skill) => skill.key);
}

function hasSkillTool(enabledTools: string[]): boolean {
  return enabledTools.includes('Skill');
}

function hasAgentCollaborationTool(enabledTools: string[]): boolean {
  return enabledTools.includes('AgentSpawn');
}

function skillRuntimeStatusLabel(
  skill: ModeSkillInfo,
  coverageSourceBySkillKey: ReadonlyMap<string, string>,
  t: TFunction<'scenes/agents'>,
): string | undefined {
  const status = getModeSkillRuntimeStatus(
    skill,
    coverageSourceBySkillKey,
    t('agentsOverview.unknownSkillSource'),
  );
  switch (status.kind) {
    case 'selected':
      return t('agentsOverview.skillRuntimeSelected');
    case 'covered':
      return t('agentsOverview.skillRuntimeCovered', { source: status.sourceLabel });
    case 'enabled':
      return t('agentsOverview.skillRuntimeEnabled');
    case 'disabled':
      return undefined;
  }
}

function subagentSourceLabel(
  source: SubagentInfo['source'] | undefined,
  t: TFunction<'scenes/agents'>,
): string {
  switch (source) {
    case 'project':
      return t('filters.project');
    case 'user':
      return t('filters.user');
    case 'external':
      return t('filters.external');
    default:
      return t('filters.builtin');
  }
}

function subagentTooltipFields(
  subagent: SubagentInfo,
  t: TFunction<'scenes/agents'>,
  isExternal: boolean,
): AgentCapabilityTooltipField[] {
  const source = subagent.subagentSource ?? subagent.source;
  return [
    {
      label: t('agentsOverview.capabilityTooltip.subagentId'),
      value: subagent.id,
      monospace: true,
    },
    {
      label: t('agentsOverview.capabilityTooltip.source'),
      value: subagentSourceLabel(source, t),
    },
    {
      label: t('agentsOverview.capabilityTooltip.toolCount'),
      value: String(subagent.toolCount),
    },
    ...(isExternal ? [{
      label: t('agentsOverview.capabilityTooltip.status'),
      value: t('agentsOverview.capabilityTooltip.externalManaged'),
    }] : []),
  ];
}

const AgentsHomeView: React.FC = () => {
  const { t } = useTranslation('scenes/agents');
  const { t: tComponents } = useI18n('components');
  const notification = useNotification();
  const [deletingAgent, setDeletingAgent] = useState(false);
  const {
    searchQuery,
    agentFilterLevel,
    agentFilterType,
    setSearchQuery,
    setAgentFilterLevel,
    setAgentFilterType,
    openCreateAgent,
    openEditAgent,
  } = useAgentsStore();
  const [selectedAgentId, setSelectedAgentId] = React.useState<string | null>(null);
  const [detailView, setDetailView] = useState<AgentDetailView>('details');
  const [activeDetailSection, setActiveDetailSection] = React.useState<AgentDetailSection>('basic');
  const lastCapabilityEntry = React.useRef<CapabilitySection | null>(null);
  const detailBackRef = React.useRef<HTMLButtonElement>(null);
  const detailId = React.useId();
  const [toolsEditing, setToolsEditing] = React.useState(false);
  const [skillsEditing, setSkillsEditing] = React.useState(false);
  const [subagentsEditing, setSubagentsEditing] = React.useState(false);
  const [pendingTools, setPendingTools] = React.useState<string[] | null>(null);
  const [pendingSkills, setPendingSkills] = React.useState<string[] | null>(null);
  const [pendingSubagentIds, setPendingSubagentIds] = React.useState<string[] | null>(null);
  const [savingTools, setSavingTools] = React.useState(false);
  const [savingSkills, setSavingSkills] = React.useState(false);
  const [savingSubagents, setSavingSubagents] = React.useState(false);
  const [savingSubagentModel, setSavingSubagentModel] = React.useState(false);
  const { computerUseEnabled } = useComputerUseEnabled();
  const { buildModelOption } = useModelSelectPresentation();
  const {
    groups: userToolGroups,
    saveGroups: saveUserToolGroups,
  } = useUserToolGroups();
  const {
    groups: userSkillGroups,
    error: skillGroupsError,
    reload: reloadSkillGroups,
  } = useUserSkillGroups();

  const {
    workspaceId,
    allAgents,
    filteredAgents,
    loading,
    availableTools,
    toolCatalogStatus,
    configuredModels = [],
    getModeProfile,
    getAgentSkills,
    getModeManageableSubagents,
    hiddenAgentIds,
    loadAgents,
    getModeConfig,
    handleSetTools,
    handleResetTools,
    handleSetSkills,
    handleResetSkills,
    handleSetSubagentEnabled,
    handleSetSubagentModel,
  } = useAgentsList({
    searchQuery,
    filterLevel: agentFilterLevel,
    filterType: agentFilterType,
    t,
  });

  // Tool-catalog load state from the host (available / unsupported / failed /
  // empty). When the host doesn't expose a catalog or the read failed, the
  // tools tab must say so instead of rendering as "no tools". Writes are gated
  // off too — toggling against a failed catalog would save a config the host
  // can't act on. See PR #2428 round 5 #2.
  const toolCatalogWritable = toolCatalogStatus === 'available' || toolCatalogStatus === 'empty';
  const toolCatalogMessage = toolCatalogStatus === 'unsupported'
    ? t('agentsOverview.toolsUnsupported')
    : toolCatalogStatus === 'failed'
      ? t('agentsOverview.toolsFailed')
      : null;

  useGallerySceneAutoRefresh({
    sceneId: 'agents',
    refetch: () => {
      void loadAgents();
      void reloadSkillGroups();
    },
  });



  const coreAgents = useMemo(
    () => filteredAgents.filter((agent) => isOrdinaryAgent(agent) && !hiddenAgentIds.has(agent.id)),
    [filteredAgents, hiddenAgentIds],
  );

  const visibleAgents = useMemo(
    () => filteredAgents.filter((agent) => isAgentInOverviewZone(agent, hiddenAgentIds)),
    [filteredAgents, hiddenAgentIds],
  );

  const catalogAgents = useMemo(
    () => [...coreAgents, ...visibleAgents],
    [coreAgents, visibleAgents],
  );

  const sourceFilterOptions = useMemo(() => [
    { value: 'all', label: t('filters.anySource') },
    { value: 'builtin', label: t('filters.builtin') },
    { value: 'user', label: t('filters.user') },
    { value: 'project', label: t('filters.project') },
    { value: 'external', label: t('filters.external') },
  ], [t]);

  const typeFilterOptions = useMemo(() => [
    { value: 'all', label: t('filters.anyKind') },
    { value: 'agent', label: t('filters.agent') },
    { value: 'subagent', label: t('filters.subagent') },
  ], [t]);

  const renderSkeletons = (prefix: string) => (
    <GallerySkeleton
      count={6}
      cardHeight={132}
      minCardWidth={300}
      className={`${prefix}-skeleton`}
    />
  );

  const selectedAgent = useMemo(
    () => allAgents.find((agent) => agent.id === selectedAgentId) ?? null,
    [allAgents, selectedAgentId],
  );
  const selectedHarnessProfile = selectedAgent?.agentKind === 'harness' && isHarnessId(selectedAgent.id)
    ? selectedAgent.id : null;
  const showingHarnessPreview = Boolean(selectedHarnessProfile) && detailView !== 'details';
  const { surfaceRef: detailSurfaceRef, manage: manageHarness, captureSize: captureDetailSize } = useHarnessDialogTransition(
    Boolean(selectedAgent), detailView, setDetailView,
    `${activeDetailSection}:${toolsEditing || skillsEditing || subagentsEditing ? 'editing' : 'viewing'}`,
  );
  const selectedAgentIsExternal = (
    selectedAgent?.source ?? selectedAgent?.subagentSource
  ) === 'external';
  const selectedAgentModeConfig = useMemo(
    () => (isPrimaryAgent(selectedAgent) ? getModeConfig(selectedAgent.id) : null),
    [getModeConfig, selectedAgent],
  );
  const selectedAgentModeProfile = useMemo(
    () => (isPrimaryAgent(selectedAgent) ? getModeProfile(selectedAgent.id) : null),
    [getModeProfile, selectedAgent],
  );
  const selectedAgentSkillConfigs = useMemo(
    () => (selectedAgent ? getAgentSkills(selectedAgent.id) : []),
    [getAgentSkills, selectedAgent],
  );
  const selectedAgentManageableSubagents = useMemo(
    () => (isPrimaryAgent(selectedAgent) ? getModeManageableSubagents(selectedAgent.id) : []),
    [getModeManageableSubagents, selectedAgent],
  );
  const selectedAgentEditableSubagents = useMemo(
    () => selectedAgentManageableSubagents.filter(isLocallyManageableSubagent),
    [selectedAgentManageableSubagents],
  );
  const selectedAgentConfiguredTools = useMemo(() => (
    isPrimaryAgent(selectedAgent)
      ? (selectedAgentModeConfig?.enabled_tools ?? selectedAgent.defaultTools ?? [])
      : (selectedAgent?.defaultTools ?? [])
  ), [selectedAgent, selectedAgentModeConfig]);
  const selectedAgentTools = useMemo(
    () => selectedAgentConfiguredTools.filter(isAgentProfileConfigurableToolName),
    [selectedAgentConfiguredTools],
  );
  const agentProfileAvailableTools = useMemo(
    () => availableTools.filter((tool) => isAgentProfileConfigurableToolName(tool.name)),
    [availableTools],
  );
  const selectedAgentHasSkillTool = hasSkillTool(selectedAgentConfiguredTools);
  const selectedAgentHasAgentCollaborationTool = isPrimaryAgent(selectedAgent)
    ? hasAgentCollaborationTool(selectedAgentConfiguredTools)
    : false;
  const selectedAgentEnabledSubagents = useMemo(
    () => selectedAgentManageableSubagents.filter((subagent) => subagent.effectiveEnabled),
    [selectedAgentManageableSubagents],
  );
  const selectedAgentDefaultEnabledSubagentIds = useMemo(
    () => selectedAgentManageableSubagents
      .filter((subagent) => subagent.defaultEnabled)
      .map((subagent) => subagent.id),
    [selectedAgentManageableSubagents],
  );
  const selectedAgentEnabledSubagentIds = useMemo(
    () => selectedAgentEnabledSubagents.map((subagent) => subagent.id),
    [selectedAgentEnabledSubagents],
  );
  const selectedAgentSkills = useMemo(
    () => getConfiguredEnabledSkillKeys(selectedAgentSkillConfigs),
    [selectedAgentSkillConfigs],
  );
  const selectedAgentCoverageSourceBySkillKey = useMemo(
    () => buildSkillCoverageSourceMap(
      selectedAgentSkillConfigs,
      t('agentsOverview.unknownSkillSource'),
    ),
    [selectedAgentSkillConfigs, t],
  );
  const selectedAgentSkillItems = useMemo(
    () => selectedAgentSkillConfigs.map((skill) => ({
      ...skill,
      runtimeStatus: skillRuntimeStatusLabel(skill, selectedAgentCoverageSourceBySkillKey, t),
    })),
    [selectedAgentCoverageSourceBySkillKey, selectedAgentSkillConfigs, t],
  );
  const selectedAgentProfileMemberNames = useMemo(() => {
    if (!selectedAgentModeProfile) {
      return [];
    }

    return selectedAgentModeProfile.memberModeIds.map((memberId) => (
      allAgents.find((agent) => isPrimaryAgent(agent) && agent.id === memberId)?.name ?? memberId
    ));
  }, [allAgents, selectedAgentModeProfile]);
  const selectedAgentUsesSharedProfile = (selectedAgentModeProfile?.memberModeIds.length ?? 0) > 1;
  const getDisplayedToolCount = useCallback((agent: AgentWithCapabilities): number => {
    const configuredTools = isPrimaryAgent(agent)
      ? (getModeConfig(agent.id)?.enabled_tools ?? agent.defaultTools)
      : agent.defaultTools;
    if (configuredTools) {
      return configuredTools.filter(isAgentProfileConfigurableToolName).length;
    }
    return agent.toolCount ?? 0;
  }, [getModeConfig]);
  const getDisplayedSkillCount = useCallback((agent: AgentWithCapabilities): number => {
    const configuredTools = isPrimaryAgent(agent)
      ? (getModeConfig(agent.id)?.enabled_tools ?? agent.defaultTools ?? [])
      : (agent.defaultTools ?? []);
    return hasSkillTool(configuredTools)
      ? getConfiguredEnabledSkillKeys(getAgentSkills(agent.id)).length
      : 0;
  }, [getAgentSkills, getModeConfig]);
  const getDisplayedSubagentCount = useCallback((agent: AgentWithCapabilities): number => {
    if (!isPrimaryAgent(agent)) {
      return 0;
    }
    const configuredTools = getModeConfig(agent.id)?.enabled_tools ?? agent.defaultTools ?? [];
    return hasAgentCollaborationTool(configuredTools) ? (agent.visibleSubagentCount ?? 0) : 0;
  }, [getModeConfig]);
  const selectedAgentSourceLabel = selectedAgent
    ? subagentSourceLabel(selectedAgent.source ?? selectedAgent.subagentSource, t)
    : '';
  const selectedAgentBadge = selectedAgent
    ? getAgentBadge(
      t,
      selectedAgent.agentKind,
      selectedAgent.source ?? selectedAgent.subagentSource,
    )
    : null;
  const selectedSubagentModelValue = selectedAgent?.agentKind === 'subagent'
    ? subagentModelOverrideValue(selectedAgent.subagentModelOverride)
    : DEFAULT_SUBAGENT_MODEL_OVERRIDE_VALUE;
  const subagentModelOptions = useMemo<ModelSelectOption[]>(() => [
    {
      label: t('agentCard.modelSelector.default'),
      value: DEFAULT_SUBAGENT_MODEL_OVERRIDE_VALUE,
    },
    { label: t('agentCard.modelSelector.inherit'), value: 'inherit' },
    { label: t('agentCard.modelSelector.fast'), value: 'fast' },
    { label: t('agentCard.modelSelector.primary'), value: 'primary' },
    ...configuredModels
      .filter((model): model is typeof model & { id: string } => (
        typeof model.id === 'string'
        && model.id.trim().length > 0
        && model.enabled !== false
        && (model.capabilities ?? []).includes('text_chat')
      ))
      .map(buildModelOption),
  ], [buildModelOption, configuredModels, t]);
  const handleSubagentModelChange = useCallback(async (
    value: string | number,
  ) => {
    if (
      !selectedAgent
      || selectedAgent.agentKind !== 'subagent'
      || selectedAgentIsExternal
      || savingSubagentModel
    ) {
      return;
    }

    setSavingSubagentModel(true);
    try {
      await handleSetSubagentModel(
        selectedAgent.id,
        subagentModelSelectionFromValue(normalizeSelectValue(value)),
      );
    } finally {
      setSavingSubagentModel(false);
    }
  }, [handleSetSubagentModel, savingSubagentModel, selectedAgent, selectedAgentIsExternal]);
  const selectedAgentCapabilities = useMemo(() => {
    const entries: AgentCapabilityEntry[] = [];

    if (selectedAgent?.agentKind === 'subagent' && !selectedAgentIsExternal) {
      entries.push({
        key: 'model',
        label: t('agentCard.modelSelector.label'),
      });
    }

    if (selectedAgentTools.length > 0 || isPrimaryAgent(selectedAgent)) {
      const currentToolCount = isPrimaryAgent(selectedAgent)
        ? (toolsEditing
          ? (pendingTools ?? selectedAgentTools).length
          : selectedAgentTools.length)
        : selectedAgentTools.length;
      const totalToolCount = isPrimaryAgent(selectedAgent)
        ? agentProfileAvailableTools.length
        : selectedAgentTools.length;

      entries.push({
        key: 'tools',
        label: t('agentsOverview.tools'),
        count: isPrimaryAgent(selectedAgent)
          ? `${currentToolCount}/${totalToolCount}`
          : `${currentToolCount}`,
      });
    }

    if (selectedAgentHasSkillTool) {
      const currentSkillCount = skillsEditing
        ? (pendingSkills ?? selectedAgentSkills).length
        : selectedAgentSkills.length;
      entries.push({
        key: 'skills',
        label: t('agentsOverview.skills'),
        count: `${currentSkillCount}/${selectedAgentSkillConfigs.length}`,
      });
    }

    if (isPrimaryAgent(selectedAgent) && selectedAgentHasAgentCollaborationTool) {
      const currentSubagentIds = subagentsEditing
        ? (pendingSubagentIds ?? selectedAgentEnabledSubagentIds)
        : selectedAgentEnabledSubagentIds;
      entries.push({
        key: 'subagents',
        label: t('agentsOverview.subagents'),
        count: `${currentSubagentIds.length}/${selectedAgentManageableSubagents.length}`,
      });
    }

    return entries;
  }, [
    agentProfileAvailableTools.length,
    pendingSkills,
    pendingSubagentIds,
    pendingTools,
    selectedAgent,
    selectedAgentIsExternal,
    selectedAgentEnabledSubagentIds,
    selectedAgentHasSkillTool,
    selectedAgentHasAgentCollaborationTool,
    selectedAgentManageableSubagents.length,
    selectedAgentSkillConfigs.length,
    selectedAgentSkills,
    selectedAgentTools,
    skillsEditing,
    subagentsEditing,
    t,
    toolsEditing,
  ]);
  const currentCapabilitySection = activeDetailSection === 'basic' ? null : activeDetailSection;
  const currentCapabilityMeta = selectedAgentCapabilities.find(
    (tab) => tab.key === currentCapabilitySection,
  );
  const canManageCurrentCapability = isPrimaryAgent(selectedAgent)
    || (
      currentCapabilitySection === 'skills'
      && selectedAgent?.agentKind === 'subagent'
      && !selectedAgentIsExternal
    );
  const isCurrentSectionEditing = currentCapabilitySection === 'tools'
    ? toolsEditing
    : currentCapabilitySection === 'skills'
      ? skillsEditing
      : currentCapabilitySection === 'subagents'
        ? subagentsEditing
        : false;
  const savingCapability = savingTools || savingSkills || savingSubagents;
  const resetEditState = useCallback(() => {
    setToolsEditing(false);
    setSkillsEditing(false);
    setSubagentsEditing(false);
    setPendingTools(null);
    setPendingSkills(null);
    setPendingSubagentIds(null);
    setSavingTools(false);
    setSavingSkills(false);
    setSavingSubagents(false);
  }, []);

  const openAgentDetails = useCallback((agent: AgentWithCapabilities) => {
    lastCapabilityEntry.current = null;
    setDetailView('details');
    setSelectedAgentId(agent.id);
    setActiveDetailSection('basic');
    resetEditState();
  }, [resetEditState]);

  const openHarnessPreview = useCallback((agent: AgentWithCapabilities) => {
    lastCapabilityEntry.current = null;
    setDetailView('preview');
    setSelectedAgentId(agent.id);
    setActiveDetailSection('basic');
    resetEditState();
  }, [resetEditState]);

  const closeAgentDetails = useCallback(() => {
    lastCapabilityEntry.current = null;
    setSelectedAgentId(null);
    setDetailView('details');
    setActiveDetailSection('basic');
    resetEditState();
  }, [resetEditState]);

  const openCapabilitySection = (section: CapabilitySection) => {
    captureDetailSize();
    lastCapabilityEntry.current = section;
    setActiveDetailSection(section);
  };

  React.useLayoutEffect(() => {
    if (!selectedAgentId || showingHarnessPreview) return;
    if (activeDetailSection !== 'basic') {
      detailBackRef.current?.focus({ preventScroll: true });
    } else if (lastCapabilityEntry.current) {
      const surface = detailSurfaceRef.current;
      const card = surface?.querySelector<HTMLElement>(`[data-detail-section="${lastCapabilityEntry.current}"]`);
      (card ?? surface)?.focus({ preventScroll: true });
    }
  }, [activeDetailSection, detailSurfaceRef, selectedAgentId, showingHarnessPreview]);

  useEffect(() => {
    if (
      activeDetailSection !== 'basic'
      && !selectedAgentCapabilities.some((tab) => tab.key === activeDetailSection)
    ) {
      setActiveDetailSection('basic');
    }
  }, [activeDetailSection, selectedAgentCapabilities]);

  const handleDeleteCustomAgent = useCallback(async () => {
    if (!selectedAgent) return;
    if (['builtin', 'external'].includes(
      selectedAgent.source ?? selectedAgent.subagentSource ?? 'builtin',
    )) {
      return;
    }
    const id = selectedAgent.id;
    const name = selectedAgent.name;
    const ok = await confirmDanger(
      t('agentsOverview.deleteAgent'),
      t('agentsOverview.deleteConfirm', { name }),
    );
    if (!ok) return;
    setDeletingAgent(true);
    try {
      await CustomAgentAPI.deleteCustomAgent(id, workspaceId);
      notification.success(t('agentsOverview.deleteSuccess', { name }));
      closeAgentDetails();
      // CustomAgentAPI emits `custom-agent:updated` after the delete; the
      // useAgentsList subscriber owns the single refresh so two overlapping
      // catalog loads cannot race their status snapshots.
    } catch (e) {
      notification.error(
        `${t('agentsOverview.deleteFailed')}${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setDeletingAgent(false);
    }
  }, [selectedAgent, closeAgentDetails, notification, t, workspaceId]);

  const startCurrentCapabilityEdit = () => {
    if (!selectedAgent || savingCapability) return;
    captureDetailSize();
    if (currentCapabilitySection === 'tools') {
      if (!toolCatalogWritable) return;
      setPendingTools([...selectedAgentTools]);
      setToolsEditing(true);
      return;
    }
    if (currentCapabilitySection === 'skills') {
      setPendingSkills([...selectedAgentSkills]);
      setSkillsEditing(true);
      return;
    }
    setPendingSubagentIds([...selectedAgentEnabledSubagentIds]);
    setSubagentsEditing(true);
  };

  const cancelCurrentCapabilityEdit = () => {
    captureDetailSize();
    if (currentCapabilitySection === 'tools') {
      setToolsEditing(false);
      setPendingTools(null);
      return;
    }
    if (currentCapabilitySection === 'skills') {
      setSkillsEditing(false);
      setPendingSkills(null);
      return;
    }
    setSubagentsEditing(false);
    setPendingSubagentIds(null);
  };

  const resetCurrentCapability = async () => {
    if (!selectedAgent || savingCapability) return;
    if (currentCapabilitySection === 'tools') {
      setSavingTools(true);
      try {
        await handleResetTools(selectedAgent.id);
        setToolsEditing(false);
        setPendingTools(null);
      } finally {
        setSavingTools(false);
      }
      return;
    }
    if (currentCapabilitySection === 'skills') {
      setSavingSkills(true);
      try {
        if (await handleResetSkills(selectedAgent.id) !== false) {
          setSkillsEditing(false);
          setPendingSkills(null);
        }
      } finally {
        setSavingSkills(false);
      }
      return;
    }
    setSavingSubagents(true);
    try {
      const currentEnabledIds = new Set(selectedAgentEnabledSubagentIds);
      const defaultEnabledIds = new Set(selectedAgentDefaultEnabledSubagentIds);
      const changedSubagents = selectedAgentEditableSubagents.filter((subagent) =>
        currentEnabledIds.has(subagent.id) !== defaultEnabledIds.has(subagent.id));

      if (changedSubagents.length === 0) {
        setSubagentsEditing(false);
        setPendingSubagentIds(null);
        return;
      }

      for (const subagent of changedSubagents) {
        await handleSetSubagentEnabled(
          selectedAgent.id,
          subagent.id,
          defaultEnabledIds.has(subagent.id),
        );
      }
    } finally {
      setSavingSubagents(false);
      setSubagentsEditing(false);
      setPendingSubagentIds(null);
    }
  };

  const saveCurrentCapability = async () => {
    if (!selectedAgent || savingCapability) return;
    if (currentCapabilitySection === 'tools') {
      if (!pendingTools) {
        setToolsEditing(false);
        return;
      }
      setSavingTools(true);
      try {
        await handleSetTools(selectedAgent.id, pendingTools);
      } finally {
        setSavingTools(false);
        setToolsEditing(false);
        setPendingTools(null);
      }
      return;
    }

    if (currentCapabilitySection === 'skills') {
      if (!pendingSkills) {
        setSkillsEditing(false);
        return;
      }
      setSavingSkills(true);
      try {
        if (await handleSetSkills(selectedAgent.id, pendingSkills) !== false) {
          setSkillsEditing(false);
          setPendingSkills(null);
        }
      } finally {
        setSavingSkills(false);
      }
      return;
    }

    const nextEnabledIds = new Set(pendingSubagentIds ?? selectedAgentEnabledSubagentIds);
    const currentEnabledIds = new Set(selectedAgentEnabledSubagentIds);
    const changedSubagents = selectedAgentEditableSubagents.filter((subagent) =>
      currentEnabledIds.has(subagent.id) !== nextEnabledIds.has(subagent.id));

    if (changedSubagents.length === 0) {
      setSubagentsEditing(false);
      setPendingSubagentIds(null);
      return;
    }

    setSavingSubagents(true);
    try {
      for (const subagent of changedSubagents) {
        await handleSetSubagentEnabled(
          selectedAgent.id,
          subagent.id,
          nextEnabledIds.has(subagent.id),
        );
      }
    } finally {
      setSavingSubagents(false);
      setSubagentsEditing(false);
      setPendingSubagentIds(null);
    }
  };

  const canManageCustomAgent = Boolean(
    selectedAgent
    && !['builtin', 'external'].includes(
      selectedAgent.source ?? selectedAgent.subagentSource ?? 'builtin',
    ),
  );

  return (
    <GalleryLayout
      className="openbitfun-agents-scene"
      data-testid="agent-skill-panel"
      data-openbitfun-scene="agents"
      data-openbitfun-part="root"
    >
      <GalleryPageHeader
        title={t('page.title')}
        subtitle={t('page.subtitle')}
        leading={(
          <img
            src={agentAvatar}
            className="openbitfun-agents-scene__header-avatar"
            alt=""
            aria-hidden="true"
            draggable={false}
          />
        )}
      />

      <div className="gallery-zones" data-openbitfun-scene="agents" data-openbitfun-part="zones" data-testid="agent-list">
        <AgentHarnessOverview agents={allAgents.filter(agent => agent.agentKind === 'harness')} onPreview={openHarnessPreview} />

        <GalleryZone
          id="agents-zone"
          className="openbitfun-agents-scene__catalog-zone"
          data-testid="agents-catalog-zone"
          title={t('agentsZone.title')}
          titleAdornment={!loading ? <StatusPill tone="neutral">{catalogAgents.length}</StatusPill> : null}
          tools={(
            <Button
              variant="primary"
              size="sm"
              leadingIcon={<Icon name="plus" size="sm" />}
              onClick={openCreateAgent}
              data-testid="agents-create-agent-btn"
            >
              {t('page.newAgent')}
            </Button>
          )}
        >
          <div className="openbitfun-agents-scene__catalog-toolbar" data-openbitfun-scene="agents" data-openbitfun-part="filters">
            <SearchField
              className="openbitfun-agents-scene__search"
              value={searchQuery}
              onValueChange={setSearchQuery}
              leadingIcon={<Icon name="search" size="sm" aria-hidden />}
              placeholder={t('page.searchPlaceholder')}
              aria-label={t('page.searchPlaceholder')}
              size="sm"
              clearLabel={searchQuery ? tComponents('search.clear') : undefined}
              onClear={searchQuery ? () => setSearchQuery('') : undefined}
              data-testid="agents-search"
            />
            <div className="openbitfun-agents-scene__agent-filters">
              <div
                className="openbitfun-agents-scene__agent-filter-group"
                data-testid="agents-source-filter"
              >
                <span className="openbitfun-agents-scene__agent-filter-label">
                  {t('filters.source')}
                </span>
                <Select
                  className="openbitfun-agents-scene__agent-filter-select"
                  size="sm"
                  value={agentFilterLevel}
                  options={sourceFilterOptions}
                  aria-label={t('filters.source')}
                  onValueChange={(value) => setAgentFilterLevel(
                    normalizeSelectValue(value) as AgentFilterLevel,
                  )}
                />
              </div>
              <div
                className="openbitfun-agents-scene__agent-filter-group"
                data-testid="agents-kind-filter"
              >
                <span className="openbitfun-agents-scene__agent-filter-label">
                  {t('filters.kind')}
                </span>
                <Select
                  className="openbitfun-agents-scene__agent-filter-select"
                  size="sm"
                  value={agentFilterType}
                  options={typeFilterOptions}
                  aria-label={t('filters.kind')}
                  onValueChange={(value) => setAgentFilterType(
                    normalizeSelectValue(value) as AgentFilterType,
                  )}
                />
              </div>
            </div>
          </div>

          {loading ? renderSkeletons('agent') : null}

          {!loading && catalogAgents.length === 0 ? (
            <GalleryEmpty
              icon={{ name: 'user' }}
              message={allAgents.length === 0 ? t('agentsZone.empty.noAgents') : t('agentsZone.empty.noMatch')}
              testId="agent-list-empty"
            />
          ) : null}

          {!loading && catalogAgents.length > 0 ? (
            <GalleryGrid
              minCardWidth={300}
              data-openbitfun-scene="agents"
              data-openbitfun-part="catalogGrid"
            >
              {catalogAgents.map((agent) => {
                const commonCardProps = {
                  agent,
                  toolCount: getDisplayedToolCount(agent),
                  skillCount: getDisplayedSkillCount(agent),
                  subagentCount: getDisplayedSubagentCount(agent),
                  onOpenDetails: openAgentDetails,
                  disabledReason: agent.id === 'ComputerUse' && !computerUseEnabled
                    ? t('coreAgentsZone.computerUseDisabledBadge')
                    : undefined,
                };

                if (isOrdinaryAgent(agent)) {
                  return (
                    <CoreAgentCard
                      key={agent.id}
                      {...commonCardProps}
                    />
                  );
                }

                return <AgentCard key={agent.id} {...commonCardProps} />;
              })}
            </GalleryGrid>
          ) : null}
        </GalleryZone>
      </div>

      <Dialog
        ref={detailSurfaceRef}
        open={Boolean(selectedAgent)}
        onOpenChange={(open) => { if (!open) closeAgentDetails(); }}
        className={`agent-detail-dialog${showingHarnessPreview ? ' harness-preview' : activeDetailSection !== 'basic' ? ' agent-detail-dialog--configuration' : ''}`}
        size={showingHarnessPreview ? 'sm' : 'lg'}
        aria-labelledby={!showingHarnessPreview && activeDetailSection !== 'basic' ? `${detailId}-section-title` : undefined}
        aria-describedby={showingHarnessPreview ? `${detailId}-preview-description` : undefined}
        data-detail-view={detailView}
        data-profile={selectedHarnessProfile ?? undefined}
        data-testid={showingHarnessPreview ? 'harness-preview-dialog' : 'agent-detail-panel'}
      >
        {selectedAgent ? (
          <>
              <DialogHeaderActions className="agent-detail-dialog__window-actions">
                {(showingHarnessPreview || activeDetailSection === 'basic') && canManageCustomAgent ? (
                  <>
                    <Tooltip content={t('agentsOverview.editAgent')}>
                      <IconButton
                        aria-label={t('agentsOverview.editAgent')}
                        size="sm"
                        icon={<Icon name="edit" />}
                        onClick={() => {
                          const id = selectedAgent.id;
                          closeAgentDetails();
                          openEditAgent(id);
                        }}
                      />
                    </Tooltip>
                    <Tooltip content={t('agentsOverview.deleteAgent')}>
                      <IconButton
                        aria-label={t('agentsOverview.deleteAgent')}
                        size="sm"
                        loading={deletingAgent}
                        onClick={() => void handleDeleteCustomAgent()}
                        icon={<Icon name="delete" />}
                      />
                    </Tooltip>
                  </>
                ) : (showingHarnessPreview || activeDetailSection === 'basic') && selectedAgentIsExternal ? (
                  <Tooltip content={t('agentsOverview.manageExternalAgent')}>
                    <IconButton
                      aria-label={t('agentsOverview.manageExternalAgent')}
                      size="sm"
                      icon={<Icon name="extension" />}
                      onClick={() => {
                        closeAgentDetails();
                        openEcosystemCompatibility({ ownerSurface: 'external-sources' });
                      }}
                    />
                  </Tooltip>
                ) : null}
                <DialogClose data-testid="agent-detail-close" />
              </DialogHeaderActions>
            {showingHarnessPreview || activeDetailSection === 'basic' ? (
            <DialogHeader className="agent-detail-dialog__header">
              <AssistantAvatar size={64} name={selectedAgent.name} />
              <DialogHeading>
                <DialogTitle data-testid="agent-detail-title">{selectedAgent.name}</DialogTitle>
              </DialogHeading>
            </DialogHeader>
            ) : null}
            {showingHarnessPreview && selectedHarnessProfile ? (
              <HarnessPreviewContent
                profile={selectedHarnessProfile}
                transitioning={detailView === 'transitioning'}
                descriptionId={`${detailId}-preview-description`}
                onManage={manageHarness}
              />
            ) : (
            <>
            {activeDetailSection !== 'basic' ? (
            <Toolbar
              className="agent-detail-dialog__toolbar"
              bordered={false}
              data-testid="agent-detail-configuration"
              leading={(
                <div className="agent-detail-dialog__navigation">
                  <Tooltip content={t('agentsOverview.detail.backToOverview')}>
                    <IconButton
                      ref={detailBackRef}
                      className="agent-detail-dialog__back"
                      variant="quiet"
                      size="sm"
                      icon={<Icon name="chevron-left" size="sm" />}
                      aria-label={t('agentsOverview.detail.backToOverview')}
                      disabled={savingCapability || savingSubagentModel}
                      onClick={() => { captureDetailSize(); setActiveDetailSection('basic'); }}
                      data-testid="agent-detail-back"
                    />
                  </Tooltip>
                  <span id={`${detailId}-section-title`} className="agent-detail-dialog__section-title">
                    {currentCapabilityMeta?.label}
                  </span>
                  {currentCapabilityMeta?.count && <span className="agent-detail-dialog__count">{currentCapabilityMeta.count}</span>}
                </div>
              )}
              trailing={currentCapabilityMeta && canManageCurrentCapability ? (
                isCurrentSectionEditing ? (
                  <Tooltip content={currentCapabilitySection === 'tools'
                    ? t('agentsOverview.toolsReset')
                    : t('agentsOverview.reset')}>
                    <IconButton
                      aria-label={currentCapabilitySection === 'tools'
                        ? t('agentsOverview.toolsReset')
                        : t('agentsOverview.reset')}
                      size="sm"
                      disabled={savingCapability}
                      onClick={() => void resetCurrentCapability()}
                      icon={<Icon glyph={RotateCcw} />}
                    />
                  </Tooltip>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={currentCapabilitySection === 'tools' && !toolCatalogWritable}
                    onClick={startCurrentCapabilityEdit}
                  >
                    {t('manage')}
                  </Button>
                )
              ) : undefined}
            />
            ) : null}
            <DialogBody
              key={`${selectedAgent.id}-${activeDetailSection}`}
              className="agent-detail-dialog__body"
              id={`${detailId}-panel-${activeDetailSection}`}
              role="region"
              aria-label={activeDetailSection === 'basic' ? t('agentsOverview.detail.overview') : undefined}
              aria-labelledby={activeDetailSection !== 'basic' ? `${detailId}-section-title` : undefined}
              data-detail-page={activeDetailSection}
            >
              <div className="agent-detail-dialog__content">
              {activeDetailSection === 'basic' ? (
                <div className="agent-detail-dialog__overview" data-testid="agent-detail-basic-section">
                  <div className="agent-detail-dialog__facts" role="group" aria-label={t('agentsOverview.detail.basicInfo')}>
                    <Tooltip content={t('agentsOverview.detail.type')}>
                      <StatusPill tone="neutral">{selectedAgentBadge?.label}</StatusPill>
                    </Tooltip>
                    <Tooltip content={t('agentsOverview.detail.source')}>
                      <StatusPill tone="neutral">{selectedAgentSourceLabel}</StatusPill>
                    </Tooltip>
                    {selectedAgent.externalProviderLabel ? (
                      <StatusPill tone="neutral">
                        {t('agentCard.meta.externalProvider', { provider: selectedAgent.externalProviderLabel })}
                      </StatusPill>
                    ) : null}
                    <StatusPill tone="neutral">
                      {t('agentsOverview.detail.followUp')} · {selectedAgent.supportsFollowUp === false
                        ? t('agentsOverview.detail.unsupported')
                        : t('agentsOverview.detail.supported')}
                    </StatusPill>
                  </div>
                  <p className="agent-detail-dialog__description" data-testid="agent-detail-description">
                    {getAgentDescription(t, selectedAgent)}
                  </p>
                  <AgentCapabilityCards entries={selectedAgentCapabilities} onOpen={openCapabilitySection} />
                  {isPrimaryAgent(selectedAgent) && selectedAgentUsesSharedProfile ? (
                    <FormSection
                      headingAs="h3"
                      title={t('agentsOverview.sharedProfileLabel')}
                      description={t('agentsOverview.sharedProfileDescription', {
                        modes: selectedAgentProfileMemberNames.join(', '),
                      })}
                      data-openbitfun-scene="agents"
                      data-openbitfun-part="detailSection"
                    >
                      <span className="agent-detail-dialog__note">
                        {selectedAgentModeProfile?.profileLabel ?? t('agentsOverview.sharedProfileDefaultLabel')}
                      </span>
                    </FormSection>
                  ) : null}
                </div>
              ) : null}

              {currentCapabilitySection === 'model'
                && selectedAgent.agentKind === 'subagent'
                && !selectedAgentIsExternal ? (
                <Field label={t('agentCard.modelSelector.label')}>
                  <Combobox
                    size="sm"
                    className="agent-detail-dialog__model-select"
                    options={subagentModelOptions}
                    value={selectedSubagentModelValue}
                    onValueChange={(value) => void handleSubagentModelChange(value)}
                    disabled={savingSubagentModel}
                    data-testid="agent-detail-subagent-model-select"
                  />
                </Field>
              ) : null}

              {currentCapabilitySection === 'tools' ? (
                toolCatalogMessage ? (
                  <span className="agent-detail-dialog__empty" data-testid="agent-detail-tools-catalog-status">
                    {toolCatalogMessage}
                  </span>
                ) : isPrimaryAgent(selectedAgent) && toolsEditing ? (
                  <ToolGroupPicker
                    tools={agentProfileAvailableTools}
                    selectedToolNames={pendingTools ?? selectedAgentTools}
                    userGroups={userToolGroups}
                    onSelectionChange={setPendingTools}
                    onSaveUserGroups={saveUserToolGroups}
                    showSelectionCount={false}
                    disabled={savingTools || !toolCatalogWritable}
                    testId="agent-detail-tool-groups"
                  />
                ) : (
                  <ToolGroupSummary
                    tools={agentProfileAvailableTools}
                    selectedToolNames={selectedAgentTools}
                    userGroups={userToolGroups}
                  />
                )
              ) : null}

              {currentCapabilitySection === 'skills' && skillGroupsError ? (
                <Toolbar
                  bordered={false}
                  role="alert"
                  leading={<span className="agent-detail-dialog__empty">
                    {t('agentsOverview.skillGroupPicker.loadFailed')}
                  </span>}
                  trailing={(
                    <Button size="sm" variant="text" onClick={() => void reloadSkillGroups()}>
                      {t('agentsOverview.skillGroupPicker.retry')}
                    </Button>
                  )}
                />
              ) : null}

              {currentCapabilitySection === 'skills'
                && selectedAgentHasSkillTool
                ? (
                skillsEditing ? (
                  <SkillGroupPicker
                    skills={selectedAgentSkillItems}
                    selectedSkillKeys={pendingSkills ?? selectedAgentSkills}
                    userGroups={userSkillGroups}
                    onSelectionChange={setPendingSkills}
                    disabled={savingSkills}
                    testId="agent-detail-skill-groups"
                  />
                ) : (
                  <SkillGroupSummary
                    skills={selectedAgentSkillItems}
                    selectedSkillKeys={selectedAgentSkills}
                    userGroups={userSkillGroups}
                  />
                )
              ) : null}

              {currentCapabilitySection === 'subagents'
                && isPrimaryAgent(selectedAgent)
                && selectedAgentHasAgentCollaborationTool ? (
                selectedAgentManageableSubagents.length === 0 ? (
                  <span className="agent-detail-dialog__empty">
                    {t('agentsOverview.noSubagents')}
                  </span>
                ) : subagentsEditing ? (
                  <>
                    <Toolbar
                      bordered={false}
                      leading={<span className="agent-detail-dialog__note">
                        {t('agentsOverview.selectionSaveHint')}
                      </span>}
                    />
                    <div className="agent-detail-dialog__token-grid">
                      {selectedAgentManageableSubagents.map((subagent: SubagentInfo) => {
                        const isOn = (pendingSubagentIds ?? selectedAgentEnabledSubagentIds).includes(subagent.id);
                        const isExternal = !isLocallyManageableSubagent(subagent);
                        const tooltipFields = subagentTooltipFields(subagent, t, isExternal);
                        return (
                          <AgentCapabilityTooltip
                            key={subagent.key}
                            title={subagent.name}
                            description={subagent.description}
                            fields={tooltipFields}
                          >
                            <AgentCapabilityOption
                              className="agent-detail-dialog__token"
                              checked={isOn}
                              label={`${subagent.name}${isExternal ? ` · ${t('filters.external')}` : ''}`}
                              disabled={isExternal || savingSubagents}
                              inputAriaLabel={capabilityTooltipAriaLabel(
                                subagent.name,
                                subagent.description,
                                tooltipFields,
                              )}
                              onCheckedChange={(checked) => {
                                if (isExternal) return;
                                setPendingSubagentIds((prev) => {
                                  const current = prev ?? selectedAgentEnabledSubagentIds;
                                  return checked
                                    ? [...new Set([...current, subagent.id])]
                                    : current.filter((id) => id !== subagent.id);
                                });
                              }}
                            />
                          </AgentCapabilityTooltip>
                        );
                      })}
                    </div>
                  </>
                ) : (
                  <div className="agent-detail-dialog__chip-grid">
                    {selectedAgentEnabledSubagents.length === 0 ? (
                      <span className="agent-detail-dialog__empty">
                        {t('agentsOverview.noEnabledSubagents')}
                      </span>
                    ) : (
                      selectedAgentEnabledSubagents.map((subagent: SubagentInfo) => {
                        const tooltipFields = subagentTooltipFields(
                          subagent,
                          t,
                          !isLocallyManageableSubagent(subagent),
                        );
                        return (
                          <AgentCapabilityTooltip
                            key={subagent.key}
                            title={subagent.name}
                            description={subagent.description}
                            fields={tooltipFields}
                          >
                            <StatusPill
                              tone="neutral"
                              leading={<Icon name="check-line" size="xs" />}
                              aria-label={`${subagent.name}: ${t('agentsOverview.capabilityEnabled')}`}
                            >
                              {subagent.name}
                            </StatusPill>
                          </AgentCapabilityTooltip>
                        );
                      })
                    )}
                  </div>
                )
              ) : null}
              </div>
            </DialogBody>
            {currentCapabilityMeta && canManageCurrentCapability && isCurrentSectionEditing ? (
              <DialogFooter appearance="floating">
                <Button
                  variant="fill"
                  disabled={savingCapability}
                  onClick={cancelCurrentCapabilityEdit}
                >
                  {t('agentsOverview.cancel')}
                </Button>
                <Button
                  variant="primary"
                  loading={savingCapability}
                  onClick={() => void saveCurrentCapability()}
                >
                  {t('agentsOverview.save')}
                </Button>
              </DialogFooter>
            ) : null}
            </>
            )}
          </>
        ) : null}
      </Dialog>
    </GalleryLayout>
  );
};

const AgentsScene: React.FC = () => {
  const { page, openHome } = useAgentsStore();

  useEffect(() => {
    return () => {
      openHome();
    };
  }, [openHome]);

  if (page === 'createAgent') {
    return (
      <div className="openbitfun-agents-scene openbitfun-agents-scene--page" data-openbitfun-scene="agents" data-openbitfun-part="root">
        <CreateAgentPage />
      </div>
    );
  }

  return <AgentsHomeView />;
};

export default AgentsScene;
