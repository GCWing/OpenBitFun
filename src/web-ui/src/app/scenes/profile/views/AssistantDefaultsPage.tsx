import {
  Alert,
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogHeader,
  DialogHeaderActions,
  DialogHeading,
  DialogTitle,
  Empty,
  Field,
  FieldGroup,
  FieldRow,
  FormSection,
  Icon,
  IconButton,
  NumberBadge,
  OverflowText,
  PageHeader,
  ScrollArea,
  SearchField,
  SegmentedControl,
  Spinner,
  StatusPill,
  Switch,
  Tooltip,
} from '@openbitfun/ui';
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Plug2, RotateCcw, Wrench } from 'lucide-react';

import { configAPI } from '@/infrastructure/api/service-api/ConfigAPI';
import { MCPAPI, type MCPServerInfo } from '@/infrastructure/api/service-api/MCPAPI';
import { toolAPI } from '@/infrastructure/api/service-api/ToolAPI';
import type { AgentProfileConfigItem, ModeSkillInfo } from '@/infrastructure/config/types';
import {
  buildSkillCoverageSourceMap,
  formatSkillOrigin,
  getModeSkillRuntimeStatus,
} from '@/infrastructure/config/skillSourcePresentation';
import { useI18n } from '@/infrastructure/i18n';
import { notificationService } from '@/shared/notification-system';
import type { ToolInfo } from '@/shared/types/agent-api';
import { createLogger } from '@/shared/utils/logger';
import { isUserSelectableToolName } from '@/shared/utils/toolVisibility';
import { useNurseryStore } from '../nurseryStore';
import {
  differsFromProductDefault,
  isMcpServerAvailable,
  matchesAssistantDefaultsFilter,
  type AssistantDefaultsFilterableItem,
  type AssistantDefaultsStatusFilter,
} from './assistantDefaultsPresentation';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { canQueryToolCatalogOnSurface } from '@/infrastructure/peer-device/peerCapabilityResolution';
import './NurseryView.scss';
import './AssistantDefaultsPage.scss';

const log = createLogger('AssistantDefaultsPage');
const ASSISTANT_MODE_ID = 'Claw';

type AssistantDefaultsTab = 'skills' | 'builtin' | 'mcp';
type SaveState = 'saved' | 'saving' | 'error';

type TemplateDetail =
  | { type: 'tool'; tool: ToolInfo; isMcp: boolean }
  | { type: 'mcpServer'; serverId: string }
  | { type: 'skill'; skill: ModeSkillInfo };

interface CapabilityRow extends AssistantDefaultsFilterableItem {
  id: string;
  kind: 'skill' | 'builtin' | 'mcp';
  detail: TemplateDetail;
  statusNote: string | null;
  accessLabel: string;
  accessHint: string;
  switchDisabled: boolean;
}

interface McpGroup {
  id: string;
  server: MCPServerInfo | undefined;
  rows: CapabilityRow[];
}

interface VisibleMcpGroup extends McpGroup {
  allRows: CapabilityRow[];
}

function isMcpTool(tool: ToolInfo): boolean {
  return tool.dynamic_info?.providerKind === 'mcp' && Boolean(tool.dynamic_info.mcp);
}

function getMcpServerId(tool: ToolInfo): string {
  return tool.dynamic_info?.mcp?.serverId ?? tool.name;
}

function getMcpShortName(tool: ToolInfo): string {
  return tool.dynamic_info?.mcp?.toolName ?? tool.name;
}

function buildDuplicateSkillNameSet(skills: ModeSkillInfo[]): Set<string> {
  const counts = new Map<string, number>();
  for (const skill of skills) counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1);
  return new Set(
    [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([name]) => name),
  );
}

function formatSkillDisplayName(
  skill: ModeSkillInfo,
  duplicateNames: Set<string>,
  origin: string,
): string {
  if (!duplicateNames.has(skill.name)) return skill.name;
  return `${skill.name} [${origin}]`;
}

function isSameDetail(left: TemplateDetail | null, right: TemplateDetail): boolean {
  if (!left || left.type !== right.type) return false;
  if (left.type === 'tool' && right.type === 'tool') return left.tool.name === right.tool.name;
  if (left.type === 'skill' && right.type === 'skill') return left.skill.key === right.skill.key;
  if (left.type === 'mcpServer' && right.type === 'mcpServer') return left.serverId === right.serverId;
  return false;
}

const AssistantDefaultsPage: React.FC = () => {
  const { t } = useI18n('scenes/profile');
  const { openGallery } = useNurseryStore();
  const peerDevice = usePeerDeviceModeOptional();
  // Identity of the rendered surface, so A→B (same capability, same workspace)
  // still reloads the catalog from B instead of keeping A's stale list while
  // config mutations route to B. See PR #2428 #3.
  const renderedPeerDeviceId = peerDevice?.peerMode.active
    ? peerDevice.peerMode.deviceId
    : null;

  const [assistantModeConfig, setAssistantModeConfig] = useState<AgentProfileConfigItem | null>(null);
  const [availableTools, setAvailableTools] = useState<ToolInfo[]>([]);
  const [mcpServers, setMcpServers] = useState<MCPServerInfo[]>([]);
  const [modeSkills, setModeSkills] = useState<ModeSkillInfo[]>([]);
  const [toolsLoading, setToolsLoading] = useState<Record<string, boolean>>({});
  const [skillsLoading, setSkillsLoading] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [loadWarning, setLoadWarning] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [activeTab, setActiveTab] = useState<AssistantDefaultsTab>('skills');
  const categoryPanelId = useId();
  const [statusFilter, setStatusFilter] = useState<AssistantDefaultsStatusFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<TemplateDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const loadRequestIdRef = useRef(0);

  // Distinguish "host doesn't expose a catalog" / "read failed" / "really no
  // tools" so the UI doesn't collapse all three into an empty list. See #2428 #5.
  const [toolCatalogStatus, setToolCatalogStatus] = useState<
    'available' | 'unsupported' | 'failed' | 'empty'
  >('available');

  // Whether the current host advertises the `tool_catalog` capability. Local
  // always does; a peer host must answer `peer_mode_ping` with tool_catalog.
  // While the capability is still being probed (null) we stay optimistic so the
  // tool list doesn't disappear then reappear — a CLI Peer Host now implements
  // get_all_tools_info, so the optimistic default is correct in the common case.
  // An older CLI that didn't advertise the field is resolved via `hostKind`
  // (cli → unsupported) by the shared helper, so the UI shows the unsupported
  // state instead of masking a "not supported" error as an empty list. See PR
  // #2428 round 5 #1.
  const canQueryToolCatalog = canQueryToolCatalogOnSurface(
    Boolean(peerDevice?.peerMode.active),
    peerDevice?.currentPeerCapabilities ?? null,
  );

  // Writes (tool toggle, group toggle-all, reset) only make sense when the
  // catalog loaded from this host. An unsupported or failed read would let the
  // user toggle entries that don't reflect the runtime and save a config that
  // the host can't act on. `empty` (catalog available, just no tools) keeps
  // writes enabled because there is nothing to toggle anyway. See PR #2428
  // round 5 #2.
  const toolCatalogWritable = toolCatalogStatus === 'available' || toolCatalogStatus === 'empty';
  const toolCatalogUnavailable = toolCatalogStatus === 'unsupported' || toolCatalogStatus === 'failed';

  const loadDefaults = useCallback(async () => {
    // Stale-load guard: a peer switch or capability change can trigger a second
    // load before the first resolves. Only the latest request may commit state;
    // an earlier result that lands after would overwrite it with stale data.
    // See PR #2428 round 6.
    const requestId = ++loadRequestIdRef.current;
    setLoading(true);
    setDetailOpen(false);
    setDetail(null);
    setLoadWarning(false);
    try {
      // Skip the tool catalog invoke when the peer host cannot answer it,
      // instead of swallowing the unsupported error as an empty list. The
      // empty list then means "this host doesn't expose a catalog", not
      // "the runtime has no tools". The status is carried alongside the
      // tools and applied once, after the guard, so a partial state (tools
      // set, status still pending) can't flash through the UI.
      let toolsPromise: Promise<{
        tools: ToolInfo[];
        status: 'available' | 'unsupported' | 'failed' | 'empty';
      }>;
      if (canQueryToolCatalog) {
        toolsPromise = toolAPI.getAllToolsInfo()
          .then((tools) => ({
            tools,
            status: tools.length > 0 ? 'available' as const : 'empty' as const,
          }))
          .catch((error) => {
            log.error('Failed to load assistant tools', error);
            return { tools: [] as ToolInfo[], status: 'failed' as const };
          });
      } else {
        toolsPromise = Promise.resolve({
          tools: [] as ToolInfo[],
          status: 'unsupported' as const,
        });
      }
      const [modeConf, toolCatalog, skillList, servers] = await Promise.all([
        configAPI.getAgentProfileConfig(ASSISTANT_MODE_ID).catch((error) => {
          log.error('Failed to load assistant profile config', error);
          return null;
        }),
        toolsPromise,
        configAPI.getModeSkillConfigs({ modeId: ASSISTANT_MODE_ID }).catch((error) => {
          log.error('Failed to load assistant skills', error);
          return [];
        }),
        MCPAPI.getServers().catch((error) => {
          log.error('Failed to load MCP servers', error);
          return [];
        }),
      ]);
      if (requestId !== loadRequestIdRef.current) return;
      setAssistantModeConfig(modeConf);
      setAvailableTools(toolCatalog.tools);
      setToolCatalogStatus(toolCatalog.status);
      setModeSkills(skillList ?? []);
      setMcpServers(servers ?? []);
      setLoadWarning(modeConf === null);
      setSaveState(modeConf === null ? 'error' : 'saved');
    } catch (error) {
      log.error('Failed to load assistant defaults', error);
      if (requestId === loadRequestIdRef.current) {
        setLoadWarning(true);
        setSaveState('error');
      }
    } finally {
      if (requestId === loadRequestIdRef.current) {
        setLoading(false);
      }
    }
  }, [canQueryToolCatalog]);

  useEffect(() => {
    void loadDefaults();
  }, [loadDefaults, renderedPeerDeviceId]);

  const duplicateSkillNames = useMemo(
    () => buildDuplicateSkillNameSet(modeSkills),
    [modeSkills],
  );
  const coverageSourceBySkillKey = useMemo(
    () => buildSkillCoverageSourceMap(
      modeSkills,
      t('nursery.template.unknownSkillSource'),
    ),
    [modeSkills, t],
  );

  const getLocalizedSkillOrigin = useCallback((skill: ModeSkillInfo) => (
    formatSkillOrigin(skill, {
      fallbackSourceLabel: t('nursery.template.unknownSkillSource'),
      userLabel: t('nursery.template.skillScopeUser'),
      projectLabel: t('nursery.template.skillScopeProject'),
    })
  ), [t]);

  const getSkillRuntimeStatusLabel = useCallback((skill: ModeSkillInfo): string | null => {
    const status = getModeSkillRuntimeStatus(
      skill,
      coverageSourceBySkillKey,
      t('nursery.template.unknownSkillSource'),
    );
    switch (status.kind) {
      case 'selected': return t('nursery.template.skillRuntimeSelected');
      case 'covered': return t('nursery.template.skillRuntimeCovered', { source: status.sourceLabel });
      case 'enabled': return t('nursery.template.skillRuntimeEnabled');
      case 'disabled': return null;
    }
  }, [coverageSourceBySkillKey, t]);

  const getMcpStatusLabel = useCallback((status?: string): string => {
    switch (status?.toLowerCase()) {
      case 'uninitialized': return t('nursery.template.mcpStatus.uninitialized');
      case 'starting': return t('nursery.template.mcpStatus.starting');
      case 'connected': return t('nursery.template.mcpStatus.connected');
      case 'healthy': return t('nursery.template.mcpStatus.healthy');
      case 'needsauth': return t('nursery.template.mcpStatus.needsAuth');
      case 'reconnecting': return t('nursery.template.mcpStatus.reconnecting');
      case 'failed': return t('nursery.template.mcpStatus.failed');
      case 'stopping': return t('nursery.template.mcpStatus.stopping');
      case 'stopped': return t('nursery.template.mcpStatus.stopped');
      default: return t('nursery.template.mcpStatus.unknown');
    }
  }, [t]);

  const userSelectableTools = useMemo(
    () => availableTools.filter((tool) => isUserSelectableToolName(tool.name)),
    [availableTools],
  );
  const builtinTools = useMemo(
    () => userSelectableTools.filter((tool) => !isMcpTool(tool)),
    [userSelectableTools],
  );
  const mcpTools = useMemo(
    () => userSelectableTools.filter(isMcpTool),
    [userSelectableTools],
  );

  const skillRows = useMemo<CapabilityRow[]>(() => modeSkills.map((skill) => {
    const origin = getLocalizedSkillOrigin(skill);
    return {
      id: skill.key,
      kind: 'skill',
      name: formatSkillDisplayName(skill, duplicateSkillNames, origin),
      description: skill.description?.trim() || t('nursery.template.noDescription'),
      source: origin,
      originalId: skill.key,
      enabled: skill.effectiveEnabled,
      defaultEnabled: skill.defaultEnabled,
      available: skill.globallyEnabled,
      detail: { type: 'skill', skill },
      statusNote: getSkillRuntimeStatusLabel(skill),
      accessLabel: t('nursery.template.permissionInherited'),
      accessHint: t('nursery.template.permissionInheritedHint'),
      switchDisabled: !skill.globallyEnabled,
    };
  }), [
    duplicateSkillNames,
    getLocalizedSkillOrigin,
    getSkillRuntimeStatusLabel,
    modeSkills,
    t,
  ]);

  const buildToolRow = useCallback((tool: ToolInfo, mcp: boolean): CapabilityRow => {
    const serverId = mcp ? getMcpServerId(tool) : null;
    const server = serverId ? mcpServers.find((candidate) => candidate.id === serverId) : undefined;
    const enabled = assistantModeConfig?.enabled_tools?.includes(tool.name) ?? false;
    const defaultEnabled = assistantModeConfig?.default_tools?.includes(tool.name) ?? enabled;
    const available = mcp ? isMcpServerAvailable(server) : true;
    return {
      id: tool.name,
      kind: mcp ? 'mcp' : 'builtin',
      name: mcp ? getMcpShortName(tool) : tool.name,
      description: tool.description?.trim() || t('nursery.template.noDescription'),
      source: mcp
        ? (server?.name ?? tool.dynamic_info?.mcp?.serverName ?? serverId ?? t('nursery.template.unknownSkillSource'))
        : t('nursery.template.officialSource'),
      originalId: tool.name,
      enabled,
      defaultEnabled,
      available,
      detail: { type: 'tool', tool, isMcp: mcp },
      statusNote: mcp ? getMcpStatusLabel(server?.status) : null,
      accessLabel: tool.is_readonly
        ? t('nursery.template.readonlyTool')
        : t('nursery.template.executableTool'),
      accessHint: tool.is_readonly
        ? t('nursery.template.readonlyToolHint')
        : t('nursery.template.executableToolHint'),
      switchDisabled: assistantModeConfig === null,
    };
  }, [assistantModeConfig, getMcpStatusLabel, mcpServers, t]);

  const builtinRows = useMemo(
    () => builtinTools.map((tool) => buildToolRow(tool, false)),
    [buildToolRow, builtinTools],
  );
  const mcpRows = useMemo(
    () => mcpTools.map((tool) => buildToolRow(tool, true)),
    [buildToolRow, mcpTools],
  );
  const allCapabilityRows = useMemo(
    () => [...skillRows, ...builtinRows, ...mcpRows],
    [builtinRows, mcpRows, skillRows],
  );
  const mcpGroups = useMemo<McpGroup[]>(() => {
    const ids = new Set([
      ...mcpRows.map((row) => {
        const rowDetail = row.detail;
        return rowDetail.type === 'tool' ? getMcpServerId(rowDetail.tool) : row.id;
      }),
      ...mcpServers.map((server) => server.id),
    ]);
    return [...ids].map((id) => ({
      id,
      server: mcpServers.find((server) => server.id === id),
      rows: mcpRows.filter((row) => {
        const rowDetail = row.detail;
        return rowDetail.type === 'tool' && getMcpServerId(rowDetail.tool) === id;
      }),
    }));
  }, [mcpRows, mcpServers]);

  const visibleFlatRows = useMemo(() => {
    const rows = activeTab === 'skills' ? skillRows : builtinRows;
    if (activeTab === 'mcp') return [];
    return rows.filter((row) => matchesAssistantDefaultsFilter(row, statusFilter, searchQuery));
  }, [activeTab, builtinRows, searchQuery, skillRows, statusFilter]);

  const visibleMcpGroups = useMemo<VisibleMcpGroup[]>(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    return mcpGroups.flatMap((group) => {
      const serverName = group.server?.name ?? group.id;
      const serverMatches = normalizedQuery.length > 0 && [
        serverName,
        group.id,
        group.server?.transport ?? '',
      ].some((value) => value.toLowerCase().includes(normalizedQuery));
      const rows = group.rows.filter((row) => matchesAssistantDefaultsFilter(
        row,
        statusFilter,
        serverMatches ? '' : searchQuery,
      ));
      const shouldKeepEmptyServer = group.rows.length === 0
        && statusFilter === 'all'
        && (normalizedQuery.length === 0 || serverMatches);
      return rows.length > 0 || shouldKeepEmptyServer
        ? [{ ...group, allRows: group.rows, rows }]
        : [];
    });
  }, [mcpGroups, searchQuery, statusFilter]);

  const visibleCount = activeTab === 'mcp'
    ? visibleMcpGroups.reduce((count, group) => count + group.rows.length, 0)
    : visibleFlatRows.length;

  const handleToolToggle = useCallback(async (toolName: string) => {
    if (!assistantModeConfig || !isUserSelectableToolName(toolName)) return;
    setToolsLoading((previous) => ({ ...previous, [toolName]: true }));
    setSaveState('saving');
    const current = assistantModeConfig.enabled_tools ?? [];
    const enabled = current.includes(toolName);
    const nextTools = enabled
      ? current.filter((name) => name !== toolName)
      : [...current, toolName];
    const nextConfig = { ...assistantModeConfig, enabled_tools: nextTools };
    setAssistantModeConfig(nextConfig);
    try {
      await configAPI.setAgentProfileConfig(ASSISTANT_MODE_ID, nextConfig);
      const { globalEventBus } = await import('@/infrastructure/event-bus');
      globalEventBus.emit('mode:config:updated');
      setSaveState('saved');
    } catch (error) {
      log.error('Failed to toggle tool', error);
      notificationService.error(t('notifications.toggleFailed'));
      setAssistantModeConfig(assistantModeConfig);
      setSaveState('error');
    } finally {
      setToolsLoading((previous) => ({ ...previous, [toolName]: false }));
    }
  }, [assistantModeConfig, t]);

  const handleGroupToggleAll = useCallback(async (toolNames: string[]) => {
    if (!assistantModeConfig) return;
    const selectableNames = toolNames.filter(isUserSelectableToolName);
    if (selectableNames.length === 0) return;
    setToolsLoading((previous) => ({
      ...previous,
      ...Object.fromEntries(selectableNames.map((name) => [name, true])),
    }));
    setSaveState('saving');
    const current = assistantModeConfig.enabled_tools ?? [];
    const allEnabled = selectableNames.every((name) => current.includes(name));
    const nextTools = allEnabled
      ? current.filter((name) => !selectableNames.includes(name))
      : [...new Set([...current, ...selectableNames])];
    const nextConfig = { ...assistantModeConfig, enabled_tools: nextTools };
    setAssistantModeConfig(nextConfig);
    try {
      await configAPI.setAgentProfileConfig(ASSISTANT_MODE_ID, nextConfig);
      const { globalEventBus } = await import('@/infrastructure/event-bus');
      globalEventBus.emit('mode:config:updated');
      setSaveState('saved');
    } catch (error) {
      log.error('Failed to toggle tool group', error);
      notificationService.error(t('notifications.toggleFailed'));
      setAssistantModeConfig(assistantModeConfig);
      setSaveState('error');
    } finally {
      setToolsLoading((previous) => ({
        ...previous,
        ...Object.fromEntries(selectableNames.map((name) => [name, false])),
      }));
    }
  }, [assistantModeConfig, t]);

  const handleSkillToggle = useCallback(async (skill: ModeSkillInfo) => {
    if (!skill.globallyEnabled) return;
    setSkillsLoading((previous) => ({ ...previous, [skill.key]: true }));
    setSaveState('saving');
    try {
      await configAPI.setModeSkillDisabled({
        modeId: ASSISTANT_MODE_ID,
        skillKey: skill.key,
        disabled: skill.effectiveEnabled,
      });
      const updatedSkills = await configAPI.getModeSkillConfigs({ modeId: ASSISTANT_MODE_ID });
      setModeSkills(updatedSkills);
      const { globalEventBus } = await import('@/infrastructure/event-bus');
      globalEventBus.emit('mode:config:updated');
      setSaveState('saved');
    } catch (error) {
      log.error('Failed to toggle skill', error);
      notificationService.error(t('notifications.toggleFailed'));
      setSaveState('error');
    } finally {
      setSkillsLoading((previous) => ({ ...previous, [skill.key]: false }));
    }
  }, [t]);

  const handleResetDefaults = useCallback(async () => {
    setResetting(true);
    setSaveState('saving');
    try {
      await configAPI.resetAgentProfileConfig(ASSISTANT_MODE_ID);
      const [modeConf, skills] = await Promise.all([
        configAPI.getAgentProfileConfig(ASSISTANT_MODE_ID),
        configAPI.getModeSkillConfigs({ modeId: ASSISTANT_MODE_ID }),
      ]);
      setAssistantModeConfig(modeConf);
      setModeSkills(skills);
      const { globalEventBus } = await import('@/infrastructure/event-bus');
      globalEventBus.emit('mode:config:updated');
      notificationService.success(t('notifications.resetSuccess'));
      setSaveState('saved');
    } catch (error) {
      log.error('Failed to reset assistant defaults', error);
      notificationService.error(t('notifications.resetFailed'));
      setSaveState('error');
    } finally {
      setResetting(false);
    }
  }, [t]);

  const handleTabChange = useCallback((tab: AssistantDefaultsTab) => {
    setActiveTab(tab);
    setDetailOpen(false);
  }, []);

  const toggleCollapse = useCallback((id: string) => {
    setCollapsedGroups((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const openDetail = useCallback((nextDetail: TemplateDetail) => {
    setDetail(nextDetail);
    setDetailOpen(true);
  }, []);

  const toggleCapability = useCallback((row: CapabilityRow) => {
    if (row.detail.type === 'skill') {
      void handleSkillToggle(row.detail.skill);
      return;
    }
    if (row.detail.type === 'tool') void handleToolToggle(row.detail.tool.name);
  }, [handleSkillToggle, handleToolToggle]);

  const statusFilters = useMemo<Array<{ id: AssistantDefaultsStatusFilter; label: string }>>(() => [
    { id: 'all', label: t('nursery.template.filters.all') },
    { id: 'enabled', label: t('nursery.template.filters.enabled') },
    { id: 'disabled', label: t('nursery.template.filters.disabled') },
    { id: 'changed', label: t('nursery.template.filters.changed') },
    { id: 'unavailable', label: t('nursery.template.filters.unavailable') },
  ], [t]);

  const renderCapabilityRow = (row: CapabilityRow) => {
    const selected = detailOpen && isSameDetail(detail, row.detail);
    const changed = differsFromProductDefault(row);
    const defaultState = row.defaultEnabled
      ? t('nursery.template.state.enabled')
      : t('nursery.template.state.disabled');
    const differenceHint = `${t('nursery.template.summary.changed')} · ${t('nursery.template.detailFields.productDefault')}: ${defaultState}`;
    const loadingRow = row.detail.type === 'skill'
      ? skillsLoading[row.detail.skill.key]
      : row.detail.type === 'tool' && toolsLoading[row.detail.tool.name];
    const icon = row.kind === 'skill'
      ? <Icon name="book-open" size="sm" />
      : row.kind === 'mcp'
        ? <Plug2 size={15} />
        : <Wrench size={15} />;
    const rowClassName = `assistant-defaults-row${selected ? ' assistant-defaults-row--selected' : ''}${!row.available ? ' assistant-defaults-row--unavailable' : ''}`;
    const rowState = [
      selected && 'selected',
      !row.enabled && 'disabled',
      !row.available && 'unavailable',
      changed && 'changed',
    ].filter(Boolean).join(' ') || undefined;
    const rowContent = (
      <>
        <div role="cell" className="assistant-defaults-row__name-cell">
          <button data-overflow-trigger
            type="button"
            className="assistant-defaults-row__identity"
            onClick={() => openDetail(row.detail)}
            aria-label={t('nursery.template.openCapabilityDetail', { name: row.name })}
            aria-haspopup="dialog"
          >
            <span className={`assistant-defaults-row__icon assistant-defaults-row__icon--${row.kind}`}>{icon}</span>
            <span className="assistant-defaults-row__copy">
              <strong title={row.name}><OverflowText>{row.name}</OverflowText></strong>
              <OverflowText title={row.description}>{row.description}</OverflowText>
              {row.statusNote ? <small title={row.statusNote}><OverflowText>{row.statusNote}</OverflowText></small> : null}
            </span>
          </button>
        </div>
        <div role="cell" className="assistant-defaults-row__cell assistant-defaults-row__source" title={row.source}><OverflowText>{row.source}</OverflowText></div>
        <div role="cell" className="assistant-defaults-row__actions">
          <Tooltip content={differenceHint} disabled={!changed} trigger="hover-focus">
            <span className={`assistant-defaults-row__toggle${changed ? ' assistant-defaults-row__toggle--changed' : ''}`}>
              <Switch
                checked={row.enabled}
                disabled={row.switchDisabled || Boolean(loadingRow)}
                aria-busy={Boolean(loadingRow)}
                aria-description={changed ? differenceHint : undefined}
                onChange={() => toggleCapability(row)}
                aria-label={t('nursery.template.toggleCapability', { name: row.name })}
              />
            </span>
          </Tooltip>
          <IconButton
            type="button"
            size="sm"
            className="assistant-defaults-row__detail"
            onClick={() => openDetail(row.detail)}
            aria-label={t('nursery.template.openCapabilityDetail', { name: row.name })}
            aria-haspopup="dialog"
            icon={<Icon name="chevron-right" size="sm" />}
          />
        </div>
      </>
    );

    if (row.kind === 'skill') {
      return (
        <div
          key={row.id}
          role="row"
          className={rowClassName}
          data-openbitfun-component="assistant-defaults-page"
          data-openbitfun-part="skill"
          data-openbitfun-state={rowState}
        >
          {rowContent}
        </div>
      );
    }

    return (
      <div
        key={row.id}
        role="row"
        className={rowClassName}
        data-openbitfun-component="assistant-defaults-page"
        data-openbitfun-part="tool"
        data-openbitfun-state={rowState}
      >
        {rowContent}
      </div>
    );
  };

  const renderListHeader = () => (
    <div role="row" className="assistant-defaults-list__header" data-openbitfun-component="assistant-defaults-page" data-openbitfun-part="listHeader">
      <div role="columnheader">{t('nursery.template.columns.name')}</div>
      <div role="columnheader">{t('nursery.template.columns.source')}</div>
      <div role="columnheader" aria-label={t('nursery.template.columns.actions')} />
    </div>
  );

  const renderEmptyState = (message: string) => (
    <div data-openbitfun-component="assistant-defaults-page" data-openbitfun-part="empty">
      <Empty
        icon={<Icon name="search" />}
        description={message}
        actions={(searchQuery || statusFilter !== 'all') ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setSearchQuery('');
              setStatusFilter('all');
            }}
          >
            {t('nursery.template.clearFilters')}
          </Button>
        ) : undefined}
      />
    </div>
  );

  const renderMcpGroups = () => {
    if (mcpGroups.length === 0) {
      // The MCP catalog comes from the same get_all_tools_info read as built-in
      // tools, so an unsupported/failed host affects it the same way: surface
      // the host state instead of masking it as "no MCP servers". See PR #2428
      // round 6.
      if (toolCatalogUnavailable) {
        return renderEmptyState(
          toolCatalogStatus === 'unsupported'
            ? t('empty.toolsUnsupported')
            : t('empty.toolsFailed'),
        );
      }
      return renderEmptyState(t('nursery.template.mcpEmptyHint'));
    }
    if (visibleMcpGroups.length === 0) return renderEmptyState(t('nursery.template.noFilterResults'));

    return (
      <div className="assistant-defaults-groups">
        {visibleMcpGroups.map((group) => {
          const collapsed = collapsedGroups.has(group.id);
          const serverName = group.server?.name ?? group.id;
          const allNames = group.allRows.map((row) => row.originalId);
          const enabledCount = group.allRows.filter((row) => row.enabled).length;
          const allEnabled = allNames.length > 0 && enabledCount === allNames.length;
          const available = isMcpServerAvailable(group.server);
          return (
            <section
              key={group.id}
              className="assistant-defaults-group"
              data-openbitfun-component="assistant-defaults-page"
              data-openbitfun-part="group"
              data-openbitfun-state={collapsed ? 'collapsed' : undefined}
            >
              <div className="assistant-defaults-group__header" data-openbitfun-component="assistant-defaults-page" data-openbitfun-part="groupHeader">
                <IconButton
                  type="button"
                  size="sm"
                  className="assistant-defaults-group__collapse"
                  onClick={() => toggleCollapse(group.id)}
                  aria-expanded={!collapsed}
                  aria-label={t('nursery.template.toggleServerGroup', { name: serverName })}
                  icon={<Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size="sm" />}
                />
                <span className="assistant-defaults-group__icon"><Plug2 size={14} /></span>
                <div className="assistant-defaults-group__identity">
                  <strong><OverflowText>{serverName}</OverflowText></strong>
                  <OverflowText>{getMcpStatusLabel(group.server?.status)}</OverflowText>
                </div>
                <StatusPill className="assistant-defaults-group__status" tone={available ? 'success' : 'warning'}>
                  {available
                    ? t('nursery.template.availability.available')
                    : t('nursery.template.availability.unavailable')}
                </StatusPill>
                <span className="assistant-defaults-group__count">
                  {t('nursery.template.enabledCount', { enabled: enabledCount, total: group.allRows.length })}
                </span>
                <IconButton
                  type="button"
                  size="sm"
                  className="assistant-defaults-group__detail"
                  onClick={() => openDetail({ type: 'mcpServer', serverId: group.id })}
                  aria-label={t('nursery.template.openServerDetail')}
                  aria-haspopup="dialog"
                  icon={<Icon name="info" size="sm" />}
                />
                {allNames.length > 0 ? (
                  <Switch
                    checked={allEnabled}
                    disabled={!toolCatalogWritable
                      || assistantModeConfig === null
                      || allNames.some((name) => toolsLoading[name])}
                    aria-busy={allNames.some((name) => toolsLoading[name])}
                    onChange={() => void handleGroupToggleAll(allNames)}
                    aria-label={t('nursery.template.toggleServerTools', { name: serverName })}
                  />
                ) : null}
              </div>
              {!collapsed ? (
                group.rows.length > 0
                  ? <div role="rowgroup">{group.rows.map(renderCapabilityRow)}</div>
                  : <p className="assistant-defaults-group__empty">{t('nursery.template.mcpServerNoTools')}</p>
              ) : null}
            </section>
          );
        })}
      </div>
    );
  };

  const saveLabel = saveState === 'saving'
    ? t('nursery.template.saveState.saving')
    : saveState === 'error'
      ? t('nursery.template.saveState.error')
      : t('nursery.template.saveState.saved');

  const renderSaveStatus = () => (
    <StatusPill
      tone={saveState === 'error' ? 'danger' : 'neutral'}
      role="status"
      aria-live="polite"
      leading={saveState === 'saving'
        ? <Spinner size="sm" />
        : <Icon name={saveState === 'error' ? 'info' : 'check-line'} size="xs" />}
    >
      {saveLabel}
    </StatusPill>
  );

  const renderAvailability = (available: boolean) => (
    <StatusPill tone={available ? 'success' : 'warning'}>
      {available
        ? t('nursery.template.availability.available')
        : t('nursery.template.availability.unavailable')}
    </StatusPill>
  );

  const renderDetailField = (label: string, value: React.ReactNode) => (
    <div className="assistant-defaults-detail__field">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );

  const renderDetailDescription = (description: string) => (
    <ScrollArea className="assistant-defaults-detail__description-scroll" tabIndex={0}>
      <p className="assistant-defaults-detail__description">{description}</p>
    </ScrollArea>
  );

  const renderDetailDialog = (title: string, kindLabel: string, children: React.ReactNode) => (
    <Dialog open={detailOpen} onOpenChange={setDetailOpen} size="lg">
      <div className="assistant-defaults-detail" data-openbitfun-component="assistant-defaults-page" data-openbitfun-part="detail">
        <div className="assistant-defaults-detail__header" data-openbitfun-component="assistant-defaults-page" data-openbitfun-part="detailHeader">
          <DialogHeader>
            <DialogHeading>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>{kindLabel}</DialogDescription>
            </DialogHeading>
            <DialogHeaderActions>
              {renderSaveStatus()}
              <DialogClose aria-label={t('nursery.template.closeDetail')} />
            </DialogHeaderActions>
          </DialogHeader>
        </div>
        <DialogBody>
          <div className="assistant-defaults-detail__body" data-openbitfun-component="assistant-defaults-page" data-openbitfun-part="detailBody">
            {children}
          </div>
        </DialogBody>
      </div>
    </Dialog>
  );

  const renderDetail = () => {
    if (!detail) return null;

    if (detail.type === 'mcpServer') {
      const server = mcpServers.find((candidate) => candidate.id === detail.serverId);
      const rows = mcpRows.filter((row) => {
        const rowDetail = row.detail;
        return rowDetail.type === 'tool' && getMcpServerId(rowDetail.tool) === detail.serverId;
      });
      const allNames = rows.map((row) => row.originalId);
      const allEnabled = allNames.length > 0 && rows.every((row) => row.enabled);
      const available = isMcpServerAvailable(server);
      const title = server?.name ?? detail.serverId;
      const saving = allNames.some((name) => toolsLoading[name]);

      return renderDetailDialog(title, 'MCP', (
        <>
          {server?.statusMessage ? renderDetailDescription(server.statusMessage) : null}
          {allNames.length > 0 ? (
            <FieldGroup>
              <FieldRow>
                <Field
                  orientation="horizontal"
                  label={t('nursery.template.enableAllServerTools')}
                  description={t('nursery.template.enableAllServerToolsHint')}
                >
                  <Switch
                    checked={allEnabled}
                    disabled={!toolCatalogWritable || assistantModeConfig === null || saving}
                    aria-busy={saving}
                    onChange={() => void handleGroupToggleAll(allNames)}
                    aria-label={t('nursery.template.toggleServerTools', { name: title })}
                  />
                </Field>
              </FieldRow>
            </FieldGroup>
          ) : <p className="assistant-defaults-detail__description">{t('nursery.template.mcpServerNoTools')}</p>}
          <FormSection headingAs="h3" title={t('nursery.template.detailSections.basic')}>
            <dl className="assistant-defaults-detail__fields">
              {renderDetailField(t('nursery.template.detailFields.fullName'), title)}
              {renderDetailField(t('nursery.template.detailFields.originalId'), detail.serverId)}
              {renderDetailField(t('nursery.template.detailFields.source'), 'MCP')}
              {renderDetailField(t('nursery.template.detailFields.scope'), t('nursery.template.scopeLabel'))}
              {renderDetailField(t('nursery.template.detailFields.transport'), server?.transport || '—')}
            </dl>
          </FormSection>
          <FormSection headingAs="h3" title={t('nursery.template.detailSections.status')}>
            <dl className="assistant-defaults-detail__fields">
              {renderDetailField(t('nursery.template.detailFields.currentState'), getMcpStatusLabel(server?.status))}
              {renderDetailField(t('nursery.template.detailFields.availability'), renderAvailability(available))}
              {renderDetailField(t('nursery.template.detailFields.autoStart'), server?.autoStart ? t('nursery.template.valueYes') : t('nursery.template.valueNo'))}
              {renderDetailField(t('nursery.template.detailFields.toolCount'), rows.length)}
            </dl>
          </FormSection>
        </>
      ));
    }

    const row = allCapabilityRows.find((candidate) => isSameDetail(candidate.detail, detail));
    if (!row) return null;
    const changed = differsFromProductDefault(row);
    const kindLabel = row.kind === 'skill'
      ? t('cards.skills')
      : row.kind === 'mcp'
        ? t('nursery.template.toolTypeMcp')
        : t('nursery.template.toolTypeBuiltin');
    const saving = detail.type === 'skill'
      ? skillsLoading[detail.skill.key]
      : toolsLoading[detail.tool.name];

    return renderDetailDialog(row.name, kindLabel, (
      <>
        {renderDetailDescription(row.description)}
        <FieldGroup>
          <FieldRow>
            <Field
              orientation="horizontal"
              label={t('nursery.template.useByDefault')}
              description={t('nursery.template.useByDefaultHint')}
            >
              <Switch
                checked={row.enabled}
                disabled={row.switchDisabled || saving}
                aria-busy={saving}
                onChange={() => toggleCapability(row)}
                aria-label={t('nursery.template.toggleCapability', { name: row.name })}
              />
            </Field>
          </FieldRow>
        </FieldGroup>
        <FormSection headingAs="h3" title={t('nursery.template.detailSections.basic')}>
          <dl className="assistant-defaults-detail__fields">
            {renderDetailField(t('nursery.template.detailFields.fullName'), row.name)}
            {renderDetailField(t('nursery.template.detailFields.originalId'), row.originalId)}
            {renderDetailField(t('nursery.template.detailFields.source'), row.source)}
            {renderDetailField(t('nursery.template.detailFields.scope'), t('nursery.template.scopeLabel'))}
            {renderDetailField(t('nursery.template.detailFields.productDefault'), row.defaultEnabled
              ? t('nursery.template.state.enabled')
              : t('nursery.template.state.disabled'))}
          </dl>
        </FormSection>
        <FormSection headingAs="h3" title={t('nursery.template.detailSections.status')}>
          <dl className="assistant-defaults-detail__fields">
            {renderDetailField(t('nursery.template.detailFields.currentState'), row.enabled
              ? t('nursery.template.state.enabled')
              : t('nursery.template.state.disabled'))}
            {renderDetailField(t('nursery.template.detailFields.changed'), changed
              ? t('nursery.template.valueYes')
              : t('nursery.template.valueNo'))}
            {renderDetailField(t('nursery.template.detailFields.availability'), renderAvailability(row.available))}
            {row.statusNote ? renderDetailField(t('nursery.template.detailFields.runtimeState'), row.statusNote) : null}
          </dl>
        </FormSection>
        <FormSection headingAs="h3" title={t('nursery.template.detailSections.permissions')}>
          <div>
            <StatusPill tone="neutral">{row.accessLabel}</StatusPill>
            <p className="assistant-defaults-detail__permission-hint">{row.accessHint}</p>
          </div>
        </FormSection>
      </>
    ));
  };

  const tabs: Array<{ id: AssistantDefaultsTab; label: string; count: number }> = [
    { id: 'skills', label: t('cards.skills'), count: skillRows.length },
    { id: 'builtin', label: t('nursery.template.builtinToolsSection'), count: builtinRows.length },
    { id: 'mcp', label: t('nursery.template.mcpToolsSection'), count: mcpRows.length },
  ];
  const activeCategoryLabel = tabs.find((tab) => tab.id === activeTab)?.label;

  return (
    <div data-openbitfun-component="assistant-defaults-page" data-openbitfun-part="root" className="nursery-page nursery-page--assistant-defaults">
      <div className="assistant-defaults" data-openbitfun-component="assistant-defaults-page" data-openbitfun-part="content">
        <header className="nursery-page__header assistant-defaults__header" data-openbitfun-component="assistant-defaults-page" data-openbitfun-part="header">
          <PageHeader
            className="nursery-page__heading"
            level={2}
            title={t('nursery.template.title')}
            description={t('nursery.template.pageDescription')}
            leading={(
              <Tooltip content={t('nursery.backToGallery')}>
                <IconButton
                  size="sm"
                  onClick={openGallery}
                  aria-label={t('nursery.backToGallery')}
                  icon={<Icon name="arrow-left" size="sm" />}
                />
              </Tooltip>
            )}
          />
          <div className="assistant-defaults__toolbar" data-openbitfun-component="assistant-defaults-page" data-openbitfun-part="toolbar">
            <StatusPill tone="neutral">{t('nursery.template.scopeLabel')}</StatusPill>
            <div className="assistant-defaults__header-actions">
              {renderSaveStatus()}
              <Button
                variant="outline"
                size="sm"
                leadingIcon={<RotateCcw />}
                loading={resetting}
                className="assistant-defaults__reset"
                onClick={() => void handleResetDefaults()}
                disabled={resetting || assistantModeConfig === null}
              >
                {t('nursery.template.restoreProductDefaults')}
              </Button>
            </div>
          </div>
        </header>

        {loading ? (
          <div className="assistant-defaults__loading" data-openbitfun-component="assistant-defaults-page" data-openbitfun-part="loading">
            <Spinner size="md" />
            <span>{t('nursery.template.loading')}</span>
          </div>
        ) : (
          <div className="assistant-defaults__workspace" data-openbitfun-component="assistant-defaults-page" data-openbitfun-part="shell">
            <ScrollArea className="assistant-defaults__main" data-openbitfun-component="assistant-defaults-page" data-openbitfun-part="main">
              {loadWarning ? (
                <Alert
                  className="assistant-defaults__warning"
                  tone="warning"
                  message={t('nursery.template.configurationUnavailable')}
                  description={(
                    <Button
                      variant="outline"
                      size="sm"
                      leadingIcon={<Icon name="refresh" size="sm" />}
                      onClick={() => void loadDefaults()}
                    >
                      {t('nursery.template.retry')}
                    </Button>
                  )}
                />
              ) : null}

              <div className="assistant-defaults-tabs" data-openbitfun-component="assistant-defaults-page" data-openbitfun-part="tabs">
                <SegmentedControl
                  className="assistant-defaults-tabs__control"
                  aria-label={t('nursery.template.categoryLabel')}
                  aria-controls={categoryPanelId}
                  tone="neutral"
                  variant="bar"
                  size="md"
                  value={activeTab}
                  onValueChange={(value) => handleTabChange(value as AssistantDefaultsTab)}
                  options={tabs.map((tab) => ({
                    value: tab.id,
                    label: <span className="assistant-defaults-tabs__label">{tab.label}<NumberBadge value={tab.count} /></span>,
                  }))}
                />
              </div>

              <div role="region" id={categoryPanelId} aria-label={activeCategoryLabel}>
                <section className="assistant-defaults-controls" aria-label={t('nursery.template.filterLabel')} data-openbitfun-component="assistant-defaults-page" data-openbitfun-part="filters">
                  <SearchField
                    className="assistant-defaults-search"
                    value={searchQuery}
                    onValueChange={setSearchQuery}
                    onClear={searchQuery ? () => setSearchQuery('') : undefined}
                    clearLabel={searchQuery ? t('nursery.template.clearSearch') : undefined}
                    leadingIcon={<Icon name="search" size="md" />}
                    placeholder={t('nursery.template.searchPlaceholder')}
                    aria-label={t('nursery.template.filterLabel')}
                  />
                  <SegmentedControl
                    className="assistant-defaults-filters"
                    aria-label={t('nursery.template.filterLabel')}
                    tone="neutral"
                    variant="pills"
                    size="sm"
                    value={statusFilter}
                    onValueChange={(value) => setStatusFilter(value as AssistantDefaultsStatusFilter)}
                    options={statusFilters.map((filter) => ({ value: filter.id, label: filter.label }))}
                  />
                </section>

                <section className="assistant-defaults-list" role="table" aria-label={activeCategoryLabel} data-openbitfun-component="assistant-defaults-page" data-openbitfun-part="list">
                  {renderListHeader()}
                  {activeTab === 'mcp' ? renderMcpGroups() : visibleFlatRows.length > 0 ? (
                    activeTab === 'skills' ? (
                      <div role="rowgroup" data-openbitfun-component="assistant-defaults-page" data-openbitfun-part="skillList">
                        {visibleFlatRows.map(renderCapabilityRow)}
                      </div>
                    ) : (
                      <div role="rowgroup" data-openbitfun-component="assistant-defaults-page" data-openbitfun-part="toolList">
                        {visibleFlatRows.map(renderCapabilityRow)}
                      </div>
                    )
                  ) : renderEmptyState(t('nursery.template.noFilterResults'))}
                </section>
                <footer className="assistant-defaults__footer">{t('nursery.template.resultCount', { count: visibleCount })}</footer>
              </div>
            </ScrollArea>
          </div>
        )}
        {renderDetail()}
      </div>
    </div>
  );
};

export default AssistantDefaultsPage;
