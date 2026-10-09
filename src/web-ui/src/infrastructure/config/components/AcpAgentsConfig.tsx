import { OverflowText,
  Alert,
  Button,
  ConfirmDialog,
  FieldGroup,
  FormSection,
  Icon,
  IconButton,
  SearchField,
  Select,
  Spinner,
  StatusPill,
  TabGroup,
  Textarea,
  ToolbarGroup,
  Tooltip,
  type StatusPillTone,
} from '@openbitfun/ui';
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { CircleAlert, EyeOff, FileJson, Save, Server } from 'lucide-react';
import {
  ConfigPageContent,
  ConfigPageHeader,
  ConfigPageLayout,
  ConfigPageSection,
  ConfigPageSectionStack,
  ConfigLoadingState,
  ConfigRefreshButton,
  formatStandaloneUiText,
  ConfigMessage,
  ConfigRetryState,
} from './common';
import {
  ACPClientAPI,
  type AcpClientInfo,
  type AcpClientPermissionMode,
  type AcpClientRequirementProbe,
  type AcpClientSubagentConfig,
  type AcpRequirementProbeItem,
} from '../../api/service-api/ACPClientAPI';
import { systemAPI } from '../../api/service-api/SystemAPI';
import { sshApi } from '@/features/ssh-remote/sshApi';
import type { SavedConnection } from '@/features/ssh-remote/types';
import { useNotification } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { useSettingsDraft } from '@/infrastructure/config/settingsDraftRegistry';
import './AcpAgentsConfig.scss';

const log = createLogger('AcpAgentsConfig');
const HIDDEN_REMOTE_CONNECTION_IDS_STORAGE_KEY =
  'openbitfun:settings:acp-agents:hidden-remote-connections:v1';

function loadHiddenRemoteConnectionIds(): Set<string> {
  try {
    const stored = localStorage.getItem(HIDDEN_REMOTE_CONNECTION_IDS_STORAGE_KEY);
    if (!stored) return new Set();
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === 'string' && id.trim().length > 0));
  } catch {
    return new Set();
  }
}

function persistHiddenRemoteConnectionIds(connectionIds: Set<string>): void {
  try {
    localStorage.setItem(
      HIDDEN_REMOTE_CONNECTION_IDS_STORAGE_KEY,
      JSON.stringify(Array.from(connectionIds).sort())
    );
  } catch {
    // Keep the preference in memory when browser storage is unavailable.
  }
}

interface AcpClientConfig {
  name?: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  readonly: boolean;
  subagent: AcpClientSubagentConfig;
  permissionMode: AcpClientPermissionMode;
}

interface AcpClientConfigFile {
  acpClients: Record<string, AcpClientConfig>;
}

interface AcpClientPreset {
  id: string;
  name: string;
  version?: string;
  command: string;
  args: string[];
}

// Presets that speak ACP natively and therefore need no separate adapter
// package (their CLI binary is launched directly).
const NATIVE_ACP_PRESET_IDS = new Set(['opencode', 'dsh', 'omp']);

// Presets OpenBitFun cannot install on the user's behalf — the agent must be
// installed manually (e.g. omp targets bun and ships via its own installer).
// The UI hides the one-click "Install CLI" action for these.
const SELF_MANAGED_INSTALL_PRESET_IDS = new Set(['omp']);

const CLI_INSTALL_PACKAGES: Record<string, string> = {
  opencode: 'opencode-ai',
  dsh: '@deepseek-ai/dsh',
  'claude-code': '@anthropic-ai/claude-code',
  codex: '@openai/codex',
};

const PRESETS: AcpClientPreset[] = [
  {
    id: 'opencode',
    name: 'opencode',
    command: 'opencode',
    args: ['acp'],
  },
  // OpenBitFun ships the ACP bridge for DeepSeek Harness and installs it into the
  // user's own dsh as a profile on first launch, so the only setup left is the
  // harness itself and the model the user picks inside it.
  {
    id: 'dsh',
    name: 'DeepSeek Harness',
    command: 'dsh',
    args: ['--profile', 'openbitfun-acp'],
  },
  {
    id: 'omp',
    name: 'Oh My Pi',
    command: 'omp',
    args: ['acp'],
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'npx',
    args: ['--yes', '@agentclientprotocol/claude-agent-acp@latest'],
  },
  {
    id: 'codex',
    name: 'Codex',
    command: 'npx',
    args: ['--yes', '@agentclientprotocol/codex-acp@latest'],
  },
];

const PRESET_BY_ID = new Map(PRESETS.map(preset => [preset.id, preset]));

interface SelfManagedInstallInfo extends Record<string, string> {
  name: string;
  command: string;
}

interface InstallConfirmation {
  preset: AcpClientPreset;
  remoteConnectionId?: string;
  hostLabel: string;
  packageName: string;
}

export type AcpConfigView = 'local' | 'ssh' | 'json';

export interface AcpAgentsConfigHandle {
  /** The configuration owner resolves pending edits before closing its host. */
  requestClose: () => void;
}

interface AcpAgentsConfigProps {
  /** When embedded in an ecosystem, expose only that product’s clients. */
  clientIds?: readonly string[];
  presentation?: 'page' | 'dialog';
  onClose?: () => void;
  viewId?: AcpConfigView;
  navigationRequestId?: number;
  onViewChange?: (view: AcpConfigView) => void;
  settingsDraftEnabled?: boolean;
}

function normalizeAcpConfigView(viewId?: string): AcpConfigView {
  return viewId === 'ssh' || viewId === 'json' ? viewId : 'local';
}

function selfManagedInstallInfoForPreset(preset?: AcpClientPreset): SelfManagedInstallInfo | null {
  if (!preset || !SELF_MANAGED_INSTALL_PRESET_IDS.has(preset.id)) {
    return null;
  }
  return {
    name: preset.name,
    command: preset.command,
  };
}

function loadRequirementProbes(options: { force?: boolean } = {}): Promise<AcpClientRequirementProbe[]> {
  return ACPClientAPI.probeClientRequirements({ force: options.force });
}

function hasTransientProbeFailure(probe?: AcpClientRequirementProbe): boolean {
  if (!probe) return false;

  return [probe.tool.error, probe.adapter?.error]
    .filter(Boolean)
    .some((error) => {
      const lower = error!.toLowerCase();
      return lower.includes('timeout') || lower.includes('timed out');
    });
}

function defaultConfigForPreset(preset: AcpClientPreset): AcpClientConfig {
  return {
    name: preset.name,
    command: preset.command,
    args: preset.args,
    env: {},
    enabled: true,
    readonly: false,
    subagent: { enabled: true },
    permissionMode: 'ask',
  };
}

function normalizeConfigValue(value: unknown): {
  config: AcpClientConfigFile;
  hasLegacyPermissionModes: boolean;
} {
  const candidate = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const rawClients = (
    candidate.acpClients && typeof candidate.acpClients === 'object' && !Array.isArray(candidate.acpClients)
  )
    ? candidate.acpClients as Record<string, unknown>
    : candidate;

  const acpClients: Record<string, AcpClientConfig> = {};
  let hasLegacyPermissionModes = false;
  for (const [id, rawConfig] of Object.entries(rawClients)) {
    if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
      continue;
    }

    const item = rawConfig as Record<string, unknown>;
    const command = typeof item.command === 'string' ? item.command.trim() : '';
    if (!command) {
      continue;
    }

    hasLegacyPermissionModes ||= item.permissionMode === 'reject_once';
    acpClients[id] = {
      name: typeof item.name === 'string' ? item.name : undefined,
      command,
      args: Array.isArray(item.args) ? item.args.map(String) : [],
      env: normalizeEnvObject(item.env),
      enabled: item.enabled !== false,
      readonly: item.readonly === true,
      subagent: normalizeSubagentConfig(item.subagent),
      permissionMode: normalizePermissionMode(item.permissionMode),
    };
  }

  return { config: { acpClients }, hasLegacyPermissionModes };
}

function normalizeEnvObject(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, envValue]) => [key, String(envValue)])
  );
}

function normalizePermissionMode(value: unknown): AcpClientPermissionMode {
  return value === 'allow_once' ? value : 'ask';
}

function normalizeSubagentConfig(value: unknown): AcpClientSubagentConfig {
  const candidate = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const description = typeof candidate.description === 'string'
    ? candidate.description.trim()
    : '';
  const bestFor = typeof candidate.bestFor === 'string'
    ? candidate.bestFor.trim()
    : '';
  return {
    enabled: candidate.enabled !== false,
    ...(description ? { description } : {}),
    ...(bestFor ? { bestFor } : {}),
  };
}

function formatConfig(config: AcpClientConfigFile): string {
  return JSON.stringify(config, null, 2);
}

function parseEnvText(value: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of value.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) {
      throw new Error(`Invalid env line: ${line}`);
    }
    env[line.slice(0, separator).trim()] = line.slice(separator + 1);
  }
  return env;
}

function formatEnv(env: Record<string, string>): string {
  return Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n');
}

function requirementTone(
  item?: AcpRequirementProbeItem,
  checking = false,
): StatusPillTone {
  if (!item) return checking ? 'info' : 'neutral';
  return item.installed ? 'success' : 'danger';
}

type RegistryFilter = 'all' | 'installed' | 'not_installed' | 'invalid';
type AgentRowStatus = 'enabled' | 'ready' | 'partial' | 'not_installed' | 'invalid' | 'checking';

type RequirementIssueKind =
  | 'none'
  | 'cli_missing'
  | 'adapter_missing'
  | 'connection_failed'
  | 'permission_denied'
  | 'path_invalid'
  | 'version_mismatch'
  | 'config_invalid';

function classifyRequirementError(error?: string): Exclude<RequirementIssueKind, 'none' | 'adapter_missing'> {
  const lower = error?.toLowerCase() ?? '';
  if (!lower) {
    return 'config_invalid';
  }
  if (
    lower.includes('permission denied') ||
    lower.includes('operation not permitted') ||
    lower.includes('access denied')
  ) {
    return 'permission_denied';
  }
  if (
    lower.includes('ssh') ||
    lower.includes('connection refused') ||
    lower.includes('timed out') ||
    lower.includes('timeout') ||
    lower.includes('network') ||
    lower.includes('host key')
  ) {
    return 'connection_failed';
  }
  if (
    lower.includes('version') ||
    lower.includes('mismatch') ||
    lower.includes('incompatible')
  ) {
    return 'version_mismatch';
  }
  if (
    lower.includes('not found') ||
    lower.includes('no such file or directory') ||
    lower.includes('command -v') ||
    lower.includes('path')
  ) {
    return 'path_invalid';
  }
  return 'config_invalid';
}

function getAgentRowStatus({
  configured,
  enabled,
  toolInstalled,
  adapterInstalled,
  requiresAdapter,
  probePending,
  probe,
}: {
  configured: boolean;
  enabled: boolean;
  toolInstalled?: boolean;
  adapterInstalled?: boolean;
  requiresAdapter: boolean;
  probePending: boolean;
  probe?: AcpClientRequirementProbe;
}): AgentRowStatus {
  if (probePending) return 'checking';
  if (toolInstalled === false) {
    if (configured && enabled && hasTransientProbeFailure(probe)) {
      return 'enabled';
    }
    return 'not_installed';
  }
  if (requiresAdapter && adapterInstalled === false) {
    if (configured && enabled && hasTransientProbeFailure(probe)) {
      return 'enabled';
    }
    return 'partial';
  }
  if (!configured) return 'ready';
  if (!enabled) return 'invalid';
  return 'enabled';
}

function agentStatusTone(status: AgentRowStatus): StatusPillTone {
  switch (status) {
    case 'enabled':
    case 'ready':
      return 'success';
    case 'partial':
      return 'warning';
    case 'invalid':
      return 'danger';
    case 'checking':
      return 'info';
    case 'not_installed':
      return 'neutral';
  }
}

function CapabilityStatusPill({
  icon,
  item,
  label,
  checking,
  installedText,
  missingText,
  checkingText,
}: {
  icon: React.ReactNode;
  item?: AcpRequirementProbeItem;
  label: string;
  checking?: boolean;
  installedText: string;
  missingText: string;
  checkingText: string;
}) {
  const tone = requirementTone(item, checking);
  const title = item
    ? [label, item.installed ? installedText : missingText, item.path, item.version, item.error]
      .filter(Boolean)
      .join('\n')
    : checking ? `${label}\n${checkingText}` : label;

  return (
    <StatusPill
      aria-label={title}
      data-openbitfun-state={item ? (item.installed ? 'installed' : 'missing') : checking ? 'checking' : 'unknown'}
      leading={icon}
      title={title}
      tone={tone}
    >
      {label}
    </StatusPill>
  );
}

function AgentStatusPill({
  status,
  label,
  title,
}: {
  status: AgentRowStatus;
  label: string;
  title?: string;
}) {
  return (
    <StatusPill
      aria-label={title ? `${label}. ${title}` : label}
      data-openbitfun-state={status}
      leading={status === 'checking' ? <Spinner size="xs" /> : undefined}
      title={title}
      tone={agentStatusTone(status)}
    >
      {label}
    </StatusPill>
  );
}

const AcpAgentsConfig = forwardRef<AcpAgentsConfigHandle, AcpAgentsConfigProps>(function AcpAgentsConfig({
  viewId,
  clientIds,
  presentation = 'page',
  onClose,
  navigationRequestId = 0,
  onViewChange,
  settingsDraftEnabled = false,
}, ref) {
  const { t } = useI18n(['settings/acp-agents', 'settings']);
  const { error: notifyError, info: notifyInfo, success: notifySuccess } = useNotification();
  const jsonEditorRef = useRef<HTMLTextAreaElement>(null);

  const [config, setConfig] = useState<AcpClientConfigFile>({ acpClients: {} });
  const [clients, setClients] = useState<AcpClientInfo[]>([]);
  const [savedConnections, setSavedConnections] = useState<SavedConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [pendingPermissionMigration, setPendingPermissionMigration] = useState(false);
  const [jsonConfig, setJsonConfig] = useState('');
  const [jsonBaseline, setJsonBaseline] = useState(formatConfig({ acpClients: {} }));
  const [jsonDirty, setJsonDirty] = useState(false);
  const [activeView, setActiveView] = useState<AcpConfigView>(() => normalizeAcpConfigView(viewId));
  const [pendingView, setPendingView] = useState<AcpConfigView | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [envDrafts, setEnvDrafts] = useState<Record<string, string>>({});
  const [requirementProbes, setRequirementProbes] = useState<AcpClientRequirementProbe[]>([]);
  const [remoteRequirementProbes, setRemoteRequirementProbes] = useState<Record<string, AcpClientRequirementProbe[]>>({});
  const [probingRemoteRequirements, setProbingRemoteRequirements] = useState<Set<string>>(() => new Set());
  const [probingRequirements, setProbingRequirements] = useState(false);
  const [registrySearch, setRegistrySearch] = useState('');
  const [registryFilter, setRegistryFilter] = useState<RegistryFilter>('all');
  const [installingClientIds, setInstallingClientIds] = useState<Set<string>>(() => new Set());
  const [installingRemoteClientIds, setInstallingRemoteClientIds] = useState<Set<string>>(() => new Set());
  const [hiddenRemoteConnectionIds, setHiddenRemoteConnectionIds] = useState(loadHiddenRemoteConnectionIds);
  const [showHiddenRemoteConnections, setShowHiddenRemoteConnections] = useState(false);
  const [installConfirmation, setInstallConfirmation] = useState<InstallConfirmation | null>(null);
  const requirementProbeRequestIdRef = useRef(0);
  const savingConfigRef = useRef(false);
  const lastNavigationRequestIdRef = useRef(navigationRequestId);
  const activeViewRef = useRef(activeView);
  const localRequirementProbeStartedRef = useRef(false);
  const loadedRemoteProbeIdsRef = useRef<Set<string>>(new Set());
  const [remoteProbeRefreshNonce, setRemoteProbeRefreshNonce] = useState(0);

  useImperativeHandle(ref, () => ({
    requestClose: () => {
      if (savingConfigRef.current || installingClientIds.size > 0 || installingRemoteClientIds.size > 0) return;
      if (dirty || jsonDirty) {
        setConfirmClose(true);
      } else {
        onClose?.();
      }
    },
  }), [dirty, installingClientIds, installingRemoteClientIds, jsonDirty, onClose]);

  const clientsById = useMemo(() => new Map(clients.map(client => [client.id, client])), [clients]);
  const remoteConnectionRows = useMemo(() => {
    return [...savedConnections].sort((left, right) => {
      const leftTime = left.lastConnected ?? 0;
      const rightTime = right.lastConnected ?? 0;
      if (leftTime !== rightTime) return rightTime - leftTime;
      return (left.name || left.id).localeCompare(right.name || right.id);
    });
  }, [savedConnections]);
  const visibleRemoteConnectionRows = useMemo(
    () => remoteConnectionRows.filter(connection => !hiddenRemoteConnectionIds.has(connection.id)),
    [hiddenRemoteConnectionIds, remoteConnectionRows]
  );
  const hiddenRemoteConnectionRows = useMemo(
    () => remoteConnectionRows.filter(connection => hiddenRemoteConnectionIds.has(connection.id)),
    [hiddenRemoteConnectionIds, remoteConnectionRows]
  );
  const probesById = useMemo(
    () => new Map(requirementProbes.map(probe => [probe.id, probe])),
    [requirementProbes]
  );
  const customClientRows = useMemo(() => {
    const ids = new Set<string>([
      ...Object.keys(config.acpClients),
      ...clients.map(client => client.id),
    ]);

    return Array.from(ids)
      .filter(id => !PRESET_BY_ID.has(id) && (!clientIds || clientIds.includes(id)))
      .sort((a, b) => a.localeCompare(b));
  }, [clientIds, clients, config.acpClients]);

  const getPresetDescription = useCallback((presetId: string) => {
    switch (presetId) {
      case 'opencode':
        return t('presets.opencode.description');
      case 'dsh':
        return t('presets.dsh.description');
      case 'omp':
        return t('presets.omp.description');
      case 'claude-code':
        return t('presets.claudeCode.description');
      case 'codex':
        return t('presets.codex.description');
      default:
        return '';
    }
  }, [t]);

  const registryPresets = useMemo(() => {
    const search = registrySearch.trim().toLowerCase();
    return PRESETS.filter(preset => {
      if (clientIds && !clientIds.includes(preset.id)) return false;
      const probe = probesById.get(preset.id);
      const probePending = probingRequirements && !probe;
      const configured = Boolean(config.acpClients[preset.id]);
      const enabled = config.acpClients[preset.id]?.enabled ?? clientsById.get(preset.id)?.enabled ?? false;
      const status = getAgentRowStatus({
        configured,
        enabled,
        toolInstalled: probe?.tool.installed,
        adapterInstalled: probe?.adapter?.installed,
        requiresAdapter: Boolean(probe?.adapter || !NATIVE_ACP_PRESET_IDS.has(preset.id)),
        probePending,
        probe,
      });
      if (registryFilter === 'installed' && status !== 'enabled' && status !== 'ready') return false;
      if (registryFilter === 'not_installed' && status !== 'not_installed') return false;
      if (registryFilter === 'invalid' && status !== 'invalid') return false;
      if (!search) return true;
      return [
        preset.name,
        preset.id,
        getPresetDescription(preset.id),
        preset.command,
        ...preset.args,
      ].join(' ').toLowerCase().includes(search);
    });
  }, [
    clientIds,
    clientsById,
    config.acpClients,
    getPresetDescription,
    probesById,
    probingRequirements,
    registryFilter,
    registrySearch,
  ]);

  const visibleCustomClientRows = useMemo(() => {
    const search = registrySearch.trim().toLowerCase();
    return customClientRows.filter(clientId => {
      const clientConfig = config.acpClients[clientId];
      const clientInfo = clientsById.get(clientId);
      const requirementProbe = probesById.get(clientId);
      const probePending = probingRequirements && !requirementProbe;
      const configured = Boolean(clientConfig || clientInfo);
      const enabled = clientConfig?.enabled ?? clientInfo?.enabled ?? false;
      const status = getAgentRowStatus({
        configured,
        enabled,
        toolInstalled: requirementProbe?.tool.installed,
        adapterInstalled: requirementProbe?.adapter?.installed,
        requiresAdapter: Boolean(requirementProbe?.adapter),
        probePending,
        probe: requirementProbe,
      });
      if (registryFilter === 'installed' && status !== 'enabled' && status !== 'ready') return false;
      if (registryFilter === 'not_installed' && status !== 'not_installed') return false;
      if (registryFilter === 'invalid' && status !== 'invalid') return false;
      if (!search) return true;
      return [
        clientId,
        clientConfig?.name,
        clientInfo?.name,
        clientConfig?.command,
        ...(clientConfig?.args ?? []),
      ].filter(Boolean).join(' ').toLowerCase().includes(search);
    });
  }, [clientsById, config.acpClients, customClientRows, probesById, probingRequirements, registryFilter, registrySearch]);

  useEffect(() => {
    activeViewRef.current = activeView;
  }, [activeView]);

  const refreshRequirementProbes = useCallback(async (
    options: { force?: boolean; notifyOnError?: boolean } = {}
  ) => {
    const requestId = ++requirementProbeRequestIdRef.current;
    localRequirementProbeStartedRef.current = true;
    setProbingRequirements(true);
    try {
      const nextRequirementProbes = await loadRequirementProbes({ force: options.force });
      if (requirementProbeRequestIdRef.current === requestId) {
        setRequirementProbes(nextRequirementProbes);
      }
    } catch (error) {
      log.error('Failed to probe ACP agent requirements', error);
      if (options.notifyOnError ?? true) {
        notifyError(error instanceof Error ? error.message : String(error), {
          title: t('notifications.probeFailed'),
        });
      }
    } finally {
      if (requirementProbeRequestIdRef.current === requestId) {
        setProbingRequirements(false);
      }
    }
  }, [notifyError, t]);

  const refreshRemoteRequirementProbes = useCallback(async (
    connectionId: string,
    options: { force?: boolean; notifyOnError?: boolean } = {}
  ) => {
    const normalizedConnectionId = connectionId.trim();
    if (!normalizedConnectionId) return;
    if (!options.force && loadedRemoteProbeIdsRef.current.has(normalizedConnectionId)) return;

    setProbingRemoteRequirements(prev => {
      const next = new Set(prev);
      next.add(normalizedConnectionId);
      return next;
    });
    try {
      const nextRequirementProbes = await ACPClientAPI.probeClientRequirements({
        remoteConnectionId: normalizedConnectionId,
        force: options.force,
      });
      loadedRemoteProbeIdsRef.current.add(normalizedConnectionId);
      setRemoteRequirementProbes(prev => ({
        ...prev,
        [normalizedConnectionId]: nextRequirementProbes,
      }));
    } catch (error) {
      log.error('Failed to probe remote ACP agent requirements', error);
      if (options.notifyOnError ?? true) {
        notifyError(error instanceof Error ? error.message : String(error), {
          title: t('notifications.probeFailed'),
        });
      }
    } finally {
      setProbingRemoteRequirements(prev => {
        const next = new Set(prev);
        next.delete(normalizedConnectionId);
        return next;
      });
    }
  }, [notifyError, t]);

  const loadConfig = useCallback(async (
    options: { showLoading?: boolean; refreshRequirements?: boolean } = {}
  ) => {
    const showLoading = options.showLoading ?? true;
    const refreshRequirements = options.refreshRequirements ?? true;
    try {
      if (showLoading) {
        setLoading(true);
        setLoadFailed(false);
      }
      const [rawConfig, nextClients] = await Promise.all([
        ACPClientAPI.loadJsonConfig(),
        ACPClientAPI.getClients(),
      ]);
      const nextSavedConnections = await sshApi.listSavedConnections().catch((error) => {
        log.warn('Failed to load saved SSH connections for ACP remote overrides', error);
        return [] as SavedConnection[];
      });
      const { config: parsed, hasLegacyPermissionModes } = normalizeConfigValue(JSON.parse(rawConfig || '{}'));
      setConfig(parsed);
      setPendingPermissionMigration(hasLegacyPermissionModes);
      const formattedConfig = formatConfig(parsed);
      setJsonConfig(formattedConfig);
      setJsonBaseline(formattedConfig);
      setEnvDrafts(
        Object.fromEntries(
          Object.entries(parsed.acpClients).map(([clientId, clientConfig]) => [
            clientId,
            formatEnv(clientConfig.env),
          ])
        )
      );
      setClients(nextClients);
      setSavedConnections(nextSavedConnections);
      setDirty(false);
      setJsonDirty(false);
      if (refreshRequirements && activeViewRef.current === 'local') {
        void refreshRequirementProbes({ notifyOnError: false });
      }
    } catch (error) {
      log.error('Failed to load ACP agent config', error);
      if (showLoading) setLoadFailed(true);
      else {
        notifyError(error instanceof Error ? error.message : String(error), {
          title: t('notifications.loadFailed'),
        });
      }
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  }, [notifyError, refreshRequirementProbes, t]);

  const hideRemoteConnection = useCallback((connection: SavedConnection) => {
    const connectionName = connection.name || connection.id;
    setHiddenRemoteConnectionIds(prev => {
      const next = new Set(prev).add(connection.id);
      persistHiddenRemoteConnectionIds(next);
      return next;
    });
    notifySuccess(t('notifications.connectionHidden', { name: connectionName }));
  }, [notifySuccess, t]);

  const restoreRemoteConnection = useCallback((connection: SavedConnection) => {
    const connectionName = connection.name || connection.id;
    if (hiddenRemoteConnectionRows.length <= 1) {
      setShowHiddenRemoteConnections(false);
    }
    setHiddenRemoteConnectionIds(prev => {
      const next = new Set(prev);
      next.delete(connection.id);
      persistHiddenRemoteConnectionIds(next);
      return next;
    });
    notifySuccess(t('notifications.connectionRestored', { name: connectionName }));
  }, [hiddenRemoteConnectionRows.length, notifySuccess, t]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    if (settingsDraftEnabled || (!dirty && !jsonDirty)) return undefined;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [dirty, jsonDirty, settingsDraftEnabled]);

  useEffect(() => {
    if (loading || activeView !== 'local' || localRequirementProbeStartedRef.current) return;
    void refreshRequirementProbes({ notifyOnError: false });
  }, [activeView, loading, refreshRequirementProbes]);

  useEffect(() => {
    const handleAcpClientsChanged = () => {
      if (savingConfigRef.current || dirty || jsonDirty) {
        return;
      }
      void loadConfig({ showLoading: false });
    };
    window.addEventListener('openbitfun:acp-clients-changed', handleAcpClientsChanged);
    return () => {
      window.removeEventListener('openbitfun:acp-clients-changed', handleAcpClientsChanged);
    };
  }, [dirty, jsonDirty, loadConfig]);

  useEffect(() => {
    if (loading || activeView !== 'ssh') return;
    for (const connection of visibleRemoteConnectionRows) {
      void refreshRemoteRequirementProbes(connection.id, { notifyOnError: false });
    }
  }, [
    activeView,
    loading,
    refreshRemoteRequirementProbes,
    remoteProbeRefreshNonce,
    visibleRemoteConnectionRows,
  ]);

  const patchClientConfig = (clientId: string, patch: Partial<AcpClientConfig>) => {
    setConfig(prev => {
      const preset = PRESET_BY_ID.get(clientId);
      const current = prev.acpClients[clientId] ??
        (preset ? defaultConfigForPreset(preset) : undefined);
      if (!current) return prev;

      const next = {
        ...prev,
        acpClients: {
          ...prev.acpClients,
          [clientId]: {
            ...current,
            ...patch,
          },
        },
      };
      const formattedConfig = formatConfig(next);
      setJsonConfig(formattedConfig);
      setJsonBaseline(formattedConfig);
      return next;
    });
    setDirty(true);
  };

  const requestInstallPresetClient = (
    preset: AcpClientPreset,
    options: { remoteConnectionId?: string; hostLabel?: string } = {},
  ) => {
    const packageName = CLI_INSTALL_PACKAGES[preset.id];
    if (!packageName) {
      notifyError(t('installConfirm.packageUnknown'));
      return;
    }
    setInstallConfirmation({
      preset,
      remoteConnectionId: options.remoteConnectionId,
      hostLabel: options.hostLabel || t('installConfirm.localHost'),
      packageName,
    });
  };

  const installPresetClient = async (
    preset: AcpClientPreset,
    options: { remoteConnectionId?: string } = {}
  ) => {
    const remoteConnectionId = options.remoteConnectionId?.trim();
    const installKey = remoteConnectionId ? `${remoteConnectionId}:${preset.id}` : preset.id;
    const setInstalling = remoteConnectionId ? setInstallingRemoteClientIds : setInstallingClientIds;
    setInstalling(prev => new Set(prev).add(installKey));
    try {
      await ACPClientAPI.installClientCli({
        clientId: preset.id,
        remoteConnectionId,
      });
      if (remoteConnectionId) {
        loadedRemoteProbeIdsRef.current.delete(remoteConnectionId);
        await refreshRemoteRequirementProbes(remoteConnectionId, { force: true, notifyOnError: false });
      } else {
        await refreshRequirementProbes({ force: true, notifyOnError: false });
      }
      notifySuccess(t('notifications.installSuccess'));
    } catch (error) {
      log.error('Failed to install ACP agent CLI', error);
      notifyError(error instanceof Error ? error.message : String(error), {
        title: t('notifications.installFailed'),
      });
    } finally {
      setInstalling(prev => {
        const next = new Set(prev);
        next.delete(installKey);
        return next;
      });
    }
  };

  const confirmInstallPresetClient = () => {
    const request = installConfirmation;
    if (!request) return;
    setInstallConfirmation(null);
    void installPresetClient(request.preset, {
      remoteConnectionId: request.remoteConnectionId,
    });
  };

  const configurePresetClient = async (preset: AcpClientPreset) => {
    const installKey = preset.id;
    setInstallingClientIds(prev => new Set(prev).add(installKey));
    try {
      await ACPClientAPI.predownloadClientAdapter({
        clientId: preset.id,
      });
      await refreshRequirementProbes({ force: true, notifyOnError: false });
      notifySuccess(t('notifications.configureSuccess'));
    } catch (error) {
      log.error('Failed to predownload ACP adapter', error);
      notifyError(error instanceof Error ? error.message : String(error), {
        title: t('notifications.configureFailed'),
      });
    } finally {
      setInstallingClientIds(prev => {
        const next = new Set(prev);
        next.delete(installKey);
        return next;
      });
    }
  };

  const mergeEnvDrafts = (baseConfig: AcpClientConfigFile): AcpClientConfigFile => ({
    acpClients: Object.fromEntries(
      Object.entries(baseConfig.acpClients).map(([clientId, clientConfig]) => [
        clientId,
        {
          ...clientConfig,
          env: envDrafts[clientId] !== undefined
            ? parseEnvText(envDrafts[clientId])
            : clientConfig.env,
        },
      ])
    ),
  });

  const saveConfig = async (
    nextConfig = config,
    options: { mergeEnvDrafts?: boolean; successMessage?: string } = {}
  ): Promise<boolean> => {
    if (savingConfigRef.current) return false;
    savingConfigRef.current = true;
    try {
      setSaving(true);
      const configToSave = options.mergeEnvDrafts === false
        ? nextConfig
        : mergeEnvDrafts(nextConfig);
      const formattedConfig = formatConfig(configToSave);
      await ACPClientAPI.saveJsonConfig(formattedConfig);
      const nextClients = await ACPClientAPI.getClients();
      setClients(nextClients);
      setConfig(configToSave);
      setJsonConfig(formattedConfig);
      setJsonBaseline(formattedConfig);
      setDirty(false);
      setJsonDirty(false);
      setPendingPermissionMigration(false);
      await refreshRequirementProbes({ force: true, notifyOnError: false });
      loadedRemoteProbeIdsRef.current.clear();
      setRemoteProbeRefreshNonce(prev => prev + 1);
      notifySuccess(options.successMessage ?? t('notifications.saveSuccess'));
      return true;
    } catch (error) {
      log.error('Failed to save ACP agent config', error);
      notifyError(error instanceof Error ? error.message : String(error), {
        title: t('notifications.saveFailed'),
      });
      return false;
    } finally {
      savingConfigRef.current = false;
      setSaving(false);
    }
  };

  const addPresetClient = async (
    preset: AcpClientPreset,
    options: { manualCliRequired?: boolean } = {}
  ) => {
    const nextClient = defaultConfigForPreset(preset);
    const next = {
      ...config,
      acpClients: {
        ...config.acpClients,
        [preset.id]: nextClient,
      },
    };
    setConfig(next);
    const formattedConfig = formatConfig(next);
    setJsonConfig(formattedConfig);
    setJsonBaseline(formattedConfig);
    setEnvDrafts(prev => ({
      ...prev,
      [preset.id]: formatEnv(nextClient.env),
    }));
    setDirty(true);
    await saveConfig(next, {
      mergeEnvDrafts: false,
      successMessage: options.manualCliRequired
        ? t('notifications.configAddedManualCliRequired', {
          name: preset.name,
          command: preset.command,
        })
        : t('notifications.configAdded'),
    });
  };

  const saveJsonConfig = async (): Promise<boolean> => {
    try {
      const { config: parsed } = normalizeConfigValue(JSON.parse(jsonConfig));
      const saved = await saveConfig(parsed, { mergeEnvDrafts: false });
      if (!saved) return false;
      setConfig(parsed);
      setEnvDrafts(
        Object.fromEntries(
          Object.entries(parsed.acpClients).map(([clientId, clientConfig]) => [
            clientId,
            formatEnv(clientConfig.env),
          ])
        )
      );
      setJsonDirty(false);
      return true;
    } catch (error) {
      notifyError(error instanceof Error ? error.message : String(error), {
        title: t('notifications.invalidJson'),
      });
      return false;
    }
  };

  const discardAcpDraft = useCallback(async () => {
    if (activeView === 'json' && jsonDirty) {
      setJsonConfig(jsonBaseline);
      setJsonDirty(false);
      return;
    }
    await loadConfig({ showLoading: false, refreshRequirements: false });
  }, [activeView, jsonBaseline, jsonDirty, loadConfig]);

  useSettingsDraft({
    id: 'acp-agent-config',
    pageId: 'tools.external-agents',
    viewId: activeView === 'json' && jsonDirty ? 'json' : undefined,
    label: activeView === 'json' && jsonDirty ? t('json.title') : t('title'),
    dirty: dirty || jsonDirty,
    saving,
    save: () => activeView === 'json' ? saveJsonConfig() : saveConfig(),
    discard: discardAcpDraft,
    enabled: settingsDraftEnabled,
  });

  const permissionOptions = useMemo(() => [
    { value: 'ask', label: t('permissionMode.ask') },
    { value: 'allow_once', label: t('permissionMode.allowOnce') },
  ], [t]);

  const registryFilterOptions = useMemo(() => [
    { value: 'all', label: t('registry.filters.all') },
    { value: 'installed', label: t('registry.filters.enabled') },
    { value: 'not_installed', label: t('registry.filters.notInstalled') },
    { value: 'invalid', label: t('registry.filters.configInvalid') },
  ], [t]);

  const getIssueKind = useCallback((args: {
    probe?: AcpClientRequirementProbe;
    requiresAdapter: boolean;
  }): RequirementIssueKind => {
    const { probe, requiresAdapter } = args;
    if (!probe) return 'config_invalid';

    const toolIssue = classifyRequirementError(probe.tool.error);
    if (toolIssue !== 'config_invalid') {
      return toolIssue;
    }

    if (!probe.tool.installed) {
      return 'cli_missing';
    }

    if (requiresAdapter) {
      if (probe.adapter?.error) {
        const adapterIssue = classifyRequirementError(probe.adapter.error);
        if (adapterIssue !== 'config_invalid') {
          return adapterIssue;
        }
      }
      if (probe.adapter && !probe.adapter.installed) {
        return 'adapter_missing';
      }
    }

    return probe.runnable ? 'none' : 'config_invalid';
  }, []);

  const getStatusLabel = useCallback((args: {
    status: AgentRowStatus;
    issueKind: RequirementIssueKind;
    probe?: AcpClientRequirementProbe;
    requiresAdapter: boolean;
  }) => {
    const { status, issueKind, probe, requiresAdapter } = args;
    if (status === 'enabled') return t('registry.enabled');
    if (status === 'ready') return t('registry.ready');
    if (status === 'partial') return t('registry.partial');
    if (status === 'checking') return t('registry.checking');

    if (issueKind === 'connection_failed') return t('registry.connectionFailed');
    if (issueKind === 'permission_denied') return t('registry.permissionDenied');
    if (issueKind === 'path_invalid') return t('registry.pathInvalid');
    if (issueKind === 'version_mismatch') return t('registry.versionMismatch');
    if (issueKind === 'adapter_missing' || (requiresAdapter && probe?.adapter && !probe.adapter.installed)) {
      return t('registry.acpMissing');
    }
    if (issueKind === 'cli_missing' || probe?.tool.installed === false) {
      return t('registry.cliMissing');
    }
    return t('registry.configInvalid');
  }, [t]);

  const getStatusTitle = useCallback((args: {
    status: AgentRowStatus;
    issueKind: RequirementIssueKind;
    probe?: AcpClientRequirementProbe;
    requiresAdapter: boolean;
    selfManagedInstallInfo?: SelfManagedInstallInfo | null;
  }) => {
    const { status, issueKind, probe, requiresAdapter, selfManagedInstallInfo } = args;
    const lines: string[] = [];
    if (status === 'enabled') {
      lines.push(t('registry.enabled'));
    } else if (status === 'ready') {
      lines.push(t('registry.ready'));
    } else if (status === 'partial') {
      lines.push(t('registry.partialDetail'));
    } else if (status === 'checking') {
      lines.push(t('registry.checking'));
    }

    if (issueKind === 'connection_failed') {
      lines.push(t('registry.connectionFailedDetail'));
    } else if (issueKind === 'permission_denied') {
      lines.push(t('registry.permissionDeniedDetail'));
    } else if (issueKind === 'path_invalid') {
      lines.push(t('registry.pathInvalidDetail'));
    } else if (issueKind === 'version_mismatch') {
      lines.push(t('registry.versionMismatchDetail'));
    } else if (issueKind === 'adapter_missing' || (requiresAdapter && probe?.adapter && !probe.adapter.installed)) {
      lines.push(t('registry.acpMissingDetail'));
    } else if (issueKind === 'cli_missing' || probe?.tool.installed === false) {
      lines.push(
        selfManagedInstallInfo
          ? t('registry.selfManagedCliMissingDetail', selfManagedInstallInfo)
          : t('registry.cliMissingDetail')
      );
    } else if (status === 'invalid') {
      lines.push(t('registry.configInvalidDetail'));
    }

    if (probe?.tool.path) {
      lines.push(`${t('registry.toolPath')}: ${probe.tool.path}`);
    }
    if (probe?.tool.version) {
      lines.push(`${t('registry.toolVersion')}: ${probe.tool.version}`);
    }
    if (probe?.tool.error) {
      lines.push(probe.tool.error);
    }
    if (probe?.adapter?.error) {
      lines.push(probe.adapter.error);
    }
    if (probe?.notes.length) {
      lines.push(...probe.notes);
    }
    return lines.filter(Boolean).join('\n');
  }, [t]);

  const getRemoteSummary = useCallback((available: number, total: number) => {
    return t('remote.summary', { available, total });
  }, [t]);

  const showSelfManagedInstallInfo = useCallback((info: SelfManagedInstallInfo) => {
    notifyInfo(t('registry.selfManagedCliMissingDetail', info), {
      title: t('registry.cliMissing'),
    });
  }, [notifyInfo, t]);

  const openLearnMore = useCallback(() => {
    void systemAPI.openExternal('https://agentclientprotocol.com/get-started/introduction').catch((error) => {
      log.error('Failed to open ACP documentation', error);
      notifyError(error instanceof Error ? error.message : String(error), {
        title: t('notifications.openLinkFailed'),
      });
    });
  }, [notifyError, t]);

  const remoteAgentIds = useMemo(() => {
    const ids = new Set<string>([
      ...PRESETS.map(preset => preset.id),
      ...Object.keys(config.acpClients),
    ]);
    return Array.from(ids).filter(id => !clientIds || clientIds.includes(id)).sort((left, right) => {
      const leftPresetIndex = PRESETS.findIndex(preset => preset.id === left);
      const rightPresetIndex = PRESETS.findIndex(preset => preset.id === right);
      if (leftPresetIndex !== -1 || rightPresetIndex !== -1) {
        if (leftPresetIndex === -1) return 1;
        if (rightPresetIndex === -1) return -1;
        return leftPresetIndex - rightPresetIndex;
      }
      return left.localeCompare(right);
    });
  }, [clientIds, config.acpClients]);

  const viewTabs = useMemo(() => [
    {
      id: 'acp-config-local-tab',
      label: t('views.local'),
      panelId: 'acp-config-local-panel',
      value: 'local',
    },
    {
      id: 'acp-config-ssh-tab',
      label: t('views.ssh'),
      panelId: 'acp-config-ssh-panel',
      value: 'ssh',
    },
    {
      id: 'acp-config-json-tab',
      label: t('views.json'),
      panelId: 'acp-config-json-panel',
      value: 'json',
    },
  ].filter(tab => !clientIds || tab.value !== 'json'), [clientIds, t]);

  const activateView = useCallback((nextView: AcpConfigView) => {
    if (nextView === 'json') {
      const formattedConfig = formatConfig(config);
      setJsonConfig(formattedConfig);
      setJsonBaseline(formattedConfig);
      setJsonDirty(false);
    }
    setActiveView(nextView);
  }, [config]);

  const handleViewChange = useCallback((value: string) => {
    if (value !== 'local' && value !== 'ssh' && value !== 'json') return;
    if (value === activeView) return;
    if (!settingsDraftEnabled && activeView === 'json' && jsonDirty) {
      setPendingView(value);
      return;
    }
    if (onViewChange) {
      onViewChange(value);
      return;
    }
    activateView(value);
  }, [activateView, activeView, jsonDirty, onViewChange, settingsDraftEnabled]);

  const discardJsonChanges = useCallback(() => {
    const nextView = pendingView;
    setJsonConfig(jsonBaseline);
    setJsonDirty(false);
    setPendingView(null);
    if (nextView) {
      activateView(nextView);
      onViewChange?.(nextView);
    }
  }, [activateView, jsonBaseline, onViewChange, pendingView]);

  const keepEditingJson = useCallback(() => {
    setPendingView(null);
    onViewChange?.('json');
  }, [onViewChange]);

  useEffect(() => {
    if (lastNavigationRequestIdRef.current === navigationRequestId) return;
    lastNavigationRequestIdRef.current = navigationRequestId;
    const requestedView = normalizeAcpConfigView(viewId);
    if (requestedView === activeView) return;
    if (!settingsDraftEnabled && activeView === 'json' && jsonDirty) {
      setPendingView(requestedView);
      return;
    }
    activateView(requestedView);
  }, [activeView, activateView, jsonDirty, navigationRequestId, settingsDraftEnabled, viewId]);

  // The dialog host owns its title, gutters and scrolling. Keep the page shell
  // only for settings so the same manager never nests two scrolling surfaces.
  const Layout = presentation === 'dialog' ? 'div' : ConfigPageLayout;
  const Content = presentation === 'dialog' ? 'div' : ConfigPageContent;
  const layoutClassName = `openbitfun-acp-agents${presentation === 'dialog' ? ' openbitfun-acp-agents--dialog' : ''}`;
  const contentClassName = presentation === 'dialog' ? 'openbitfun-acp-agents__dialog-content' : undefined;
  const documentationAction = (
    <Button
      variant="outline"
      size="sm"
      trailingIcon={<Icon name="arrow-up-right" size="sm" />}
      onClick={openLearnMore}
    >
      {t('actions.learnMore')}
    </Button>
  );

  if (loading || loadFailed) {
    return (
      <Layout
        className={layoutClassName}
        data-openbitfun-component="acp-agents-config"
        data-openbitfun-part="root"
      >
        {presentation === 'page' ? <ConfigPageHeader title={t('title')} subtitle={t('subtitle')} /> : null}
        <Content className={contentClassName}>
          {loading ? (
            <ConfigLoadingState label={t('clients.loading')} />
          ) : (
            <ConfigRetryState
              message={t('notifications.loadFailedLocked')}
              retryLabel={t('actions.retry')}
              onRetry={() => void loadConfig()}
            />
          )}
        </Content>
      </Layout>
    );
  }

  return (
    <Layout
      className={layoutClassName}
      data-openbitfun-component="acp-agents-config"
      data-openbitfun-part="root"
      data-openbitfun-view={activeView}
    >
      {presentation === 'page' ? <ConfigPageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        extra={documentationAction}
      /> : null}

      <Content
        className={contentClassName}
        data-openbitfun-component="acp-agents-config"
        data-openbitfun-part="content"
        aria-busy={saving}
        {...(saving ? { inert: '' } : {})}
      >
        <div className="openbitfun-acp-agents__view-controls">
          <TabGroup
            className="openbitfun-acp-agents__tabs"
            data-openbitfun-component="acp-agents-config"
            data-openbitfun-part="tabs"
            size="sm"
            items={viewTabs}
            onValueChange={handleViewChange}
            value={activeView}
          />
          <ToolbarGroup className="openbitfun-acp-agents__toolbar-actions">
            {presentation === 'dialog' ? documentationAction : null}
            {dirty && activeView !== 'json' ? (
              <Button
                variant="primary"
                size="sm"
                leadingIcon={<Save />}
                onClick={() => { void saveConfig(); }}
                loading={saving}
              >
                {t('actions.save')}
              </Button>
            ) : null}
          </ToolbarGroup>
        </div>
        {pendingPermissionMigration && (
          <Alert
            tone="warning"
            message={t('permissionMode.legacyRejectWarning')}
            description={(
              <Button
                variant="primary"
                size="sm"
                disabled={saving}
                loading={saving}
                onClick={() => { void (activeView === 'json' ? saveJsonConfig() : saveConfig()); }}
              >
                {t('permissionMode.saveAndApply')}
              </Button>
            )}
          />
        )}
        {activeView === 'json' && (
          <ConfigMessage message={{ type: 'warning', text: t('security.secretWarning') }} />
        )}
        <ConfigPageSectionStack
          className="openbitfun-acp-agents__manager"
          data-openbitfun-component="acp-agents-config"
          data-openbitfun-part="manager"
        >
          {activeView === 'json' && (
            <ConfigPageSection
              title={t('json.title')}
              description={t('json.description')}
            >
              <Textarea
                ref={jsonEditorRef}
                className="openbitfun-acp-agents__json-textarea"
                data-openbitfun-component="acp-agents-config"
                data-openbitfun-part="jsonEditor"
                value={jsonConfig}
                onChange={(event) => {
                  const nextValue = event.target.value;
                  setJsonConfig(nextValue);
                  setJsonDirty(nextValue !== jsonBaseline);
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Tab') return;
                  event.preventDefault();
                  const target = event.currentTarget;
                  const start = target.selectionStart ?? 0;
                  const end = target.selectionEnd ?? 0;
                  const nextValue = jsonConfig.slice(0, start) + '  ' + jsonConfig.slice(end);
                  setJsonConfig(nextValue);
                  setJsonDirty(nextValue !== jsonBaseline);
                  requestAnimationFrame(() => {
                    jsonEditorRef.current?.focus();
                    jsonEditorRef.current?.setSelectionRange(start + 2, start + 2);
                  });
                }}
                rows={16}
                spellCheck={false}
                disabled={saving}
              />
              <div
                className="openbitfun-acp-agents__json-actions"
                data-openbitfun-component="acp-agents-config"
                data-openbitfun-part="jsonActions"
              >
                <Button variant="fill" size="sm" onClick={() => {
                  setJsonConfig(jsonBaseline);
                  setJsonDirty(false);
                }}>
                  {t('actions.revert')}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => { void saveJsonConfig(); }}
                  loading={saving}
                  disabled={!jsonDirty && !dirty}
                >
                  {t('actions.saveJson')}
                </Button>
              </div>
            </ConfigPageSection>
          )}

          {activeView === 'local' && (
          <FormSection
            headingAs="h3"
            title={t('registry.title')}
            description={t('registry.description')}
            actions={(
              <ConfigRefreshButton
                tooltip={t('actions.refresh')}
                onClick={() => { void refreshRequirementProbes({ force: true }); }}
                loading={probingRequirements}
              />
            )}
          >
          <div
            className="openbitfun-acp-agents__toolbar"
            data-openbitfun-component="acp-agents-config"
            data-openbitfun-part="toolbar"
          >
            <SearchField
              className="openbitfun-acp-agents__search"
              value={registrySearch}
              onValueChange={setRegistrySearch}
              onClear={registrySearch ? () => setRegistrySearch('') : undefined}
              clearLabel={t('common:nav.search.clear')}
              placeholder={t('registry.searchPlaceholder')}
              aria-label={t('registry.searchPlaceholder')}
              leadingIcon={<Icon name="search" size="sm" />}
              size="sm"
            />
            <Select
              className="openbitfun-acp-agents__filter-select"
              options={registryFilterOptions}
              value={registryFilter}
              onValueChange={(value) => setRegistryFilter(value as RegistryFilter)}
              aria-label={t('registry.filterLabel')}
              size="sm"
            />
          </div>
          <FieldGroup appearance="subtle" dividers={false} fieldSurface="ambient">
          {loading ? (
            <div className="openbitfun-acp-agents__empty" data-openbitfun-component="acp-agents-config" data-openbitfun-part="empty">
              {t('clients.loading')}
            </div>
          ) : registryPresets.length === 0 && visibleCustomClientRows.length === 0 ? (
            <div className="openbitfun-acp-agents__empty" data-openbitfun-component="acp-agents-config" data-openbitfun-part="empty">
              {t('registry.empty')}
            </div>
          ) : (
            <div
              className="openbitfun-acp-agents__registry-list"
              data-openbitfun-component="acp-agents-config"
              data-openbitfun-part="registryList"
            >
              {registryPresets.map(preset => {
                const clientConfig = config.acpClients[preset.id] ?? defaultConfigForPreset(preset);
                const requirementProbe = probesById.get(preset.id);
                const probePending = probingRequirements && !requirementProbe;
                const hasConfigEntry = Boolean(config.acpClients[preset.id]);
                const configured = hasConfigEntry;
                const enabled = clientConfig.enabled;
                const requiresAdapter = Boolean(requirementProbe?.adapter || !NATIVE_ACP_PRESET_IDS.has(preset.id));
                const issueKind = getIssueKind({ probe: requirementProbe, requiresAdapter });
                const selfManagedInstallInfo = selfManagedInstallInfoForPreset(preset);
                const status = getAgentRowStatus({
                  configured,
                  enabled,
                  toolInstalled: requirementProbe?.tool.installed,
                  adapterInstalled: requirementProbe?.adapter?.installed,
                  requiresAdapter,
                  probePending,
                  probe: requirementProbe,
                });
                const statusLabel = getStatusLabel({
                  status,
                  issueKind,
                  probe: requirementProbe,
                  requiresAdapter,
                });
                const selfManagedCliMissing = Boolean(selfManagedInstallInfo)
                  && status === 'not_installed'
                  && (issueKind === 'cli_missing' || requirementProbe?.tool.installed === false);
                const statusTitle = getStatusTitle({
                  status,
                  issueKind,
                  probe: requirementProbe,
                  requiresAdapter,
                  selfManagedInstallInfo,
                });
                const installing = installingClientIds.has(preset.id);
                const configuring = installingClientIds.has(preset.id);
                const showSelect = hasConfigEntry && (status === 'enabled' || status === 'ready');
                const canInstallCli = status === 'not_installed'
                  && issueKind !== 'connection_failed'
                  && !SELF_MANAGED_INSTALL_PRESET_IDS.has(preset.id);
                const canConfigureAcp = !requiresAdapter
                  ? false
                  : issueKind === 'adapter_missing' || (status === 'partial' && issueKind === 'config_invalid');
                const canViewError = status === 'invalid'
                  || issueKind === 'connection_failed'
                  || issueKind === 'permission_denied'
                  || issueKind === 'path_invalid'
                  || issueKind === 'version_mismatch';

                return (
                  <div
                    key={preset.id}
                    className="openbitfun-acp-agents__registry-row"
                    data-openbitfun-component="acp-agents-config"
                    data-openbitfun-part="registryRow"
                  >
                    <div
                      className="openbitfun-acp-agents__registry-main"
                      data-openbitfun-component="acp-agents-config"
                      data-openbitfun-part="registryMain"
                    >
                      <span className="openbitfun-acp-agents__registry-icon">
                        <Icon name="user" size="md" />
                      </span>
                      <div className="openbitfun-acp-agents__registry-copy">
                        <OverflowText className="openbitfun-acp-agents__registry-name">{preset.name}</OverflowText>
                        <p className="openbitfun-acp-agents__registry-description">
                          {formatStandaloneUiText(getPresetDescription(preset.id))}
                        </p>
                      </div>
                    </div>
                    <div
                      className="openbitfun-acp-agents__status-cell"
                      data-openbitfun-component="acp-agents-config"
                      data-openbitfun-part="status"
                    >
                      <AgentStatusPill status={status} label={statusLabel} title={statusTitle} />
                    </div>
                    <div
                      className="openbitfun-acp-agents__confirmation-cell"
                      data-openbitfun-component="acp-agents-config"
                      data-openbitfun-part="confirmation"
                    >
                      {showSelect ? (
                        <Select
                          className="openbitfun-acp-agents__confirmation-select"
                          options={permissionOptions}
                          value={clientConfig.permissionMode}
                          onValueChange={(value) => patchClientConfig(preset.id, {
                            permissionMode: normalizePermissionMode(value),
                          })}
                          size="sm"
                        />
                      ) : canInstallCli ? (
                        <Button
                          variant="outline"
                          size="sm"
                          leadingIcon={<Icon name="arrow-down" size="sm" />}
                          onClick={() => requestInstallPresetClient(preset)}
                          loading={installing}
                        >
                          {t('actions.installCli')}
                        </Button>
                      ) : canConfigureAcp ? (
                        <Button
                          variant="outline"
                          size="sm"
                          leadingIcon={<FileJson />}
                          onClick={() => { void configurePresetClient(preset); }}
                          loading={configuring}
                        >
                          {t('actions.configureAcp')}
                        </Button>
                      ) : selfManagedCliMissing && hasConfigEntry && selfManagedInstallInfo ? (
                        <Button
                          variant="outline"
                          size="sm"
                          leadingIcon={<CircleAlert />}
                          onClick={() => showSelfManagedInstallInfo(selfManagedInstallInfo)}
                        >
                          {t('actions.viewInstructions')}
                        </Button>
                      ) : canViewError ? (
                        <Button
                          variant="outline"
                          size="sm"
                          leadingIcon={<CircleAlert />}
                          onClick={() => {
                            notifyError(
                              statusTitle || t('registry.configInvalidDetail'),
                              { title: statusLabel }
                            );
                          }}
                        >
                          {t('actions.viewError')}
                        </Button>
                      ) : !hasConfigEntry ? (
                        <Button
                          variant="outline"
                          size="sm"
                          leadingIcon={<Icon name="plus" size="sm" />}
                          onClick={() => addPresetClient(preset, {
                            manualCliRequired: selfManagedCliMissing,
                          })}
                        >
                          {selfManagedCliMissing ? t('actions.addConfig') : t('actions.add')}
                        </Button>
                      ) : (
                        null
                      )}
                    </div>
                  </div>
                );
              })}
              {visibleCustomClientRows.map(clientId => {
                const clientInfo = clientsById.get(clientId);
                const clientConfig = config.acpClients[clientId];
                if (!clientConfig) return null;

                const requirementProbe = probesById.get(clientId);
                const probePending = probingRequirements && !requirementProbe;
                const requiresAdapter = Boolean(requirementProbe?.adapter);
                const issueKind = getIssueKind({ probe: requirementProbe, requiresAdapter });
                const status = getAgentRowStatus({
                  configured: true,
                  enabled: clientConfig.enabled !== false,
                  toolInstalled: requirementProbe?.tool.installed,
                  adapterInstalled: requirementProbe?.adapter?.installed,
                  requiresAdapter,
                  probePending,
                  probe: requirementProbe,
                });
                const statusLabel = getStatusLabel({
                  status,
                  issueKind,
                  probe: requirementProbe,
                  requiresAdapter,
                });
                const statusTitle = getStatusTitle({
                  status,
                  issueKind,
                  probe: requirementProbe,
                  requiresAdapter,
                });
                const displayName = clientConfig.name || clientInfo?.name || clientId;
                const canViewError = status === 'invalid'
                  || issueKind === 'connection_failed'
                  || issueKind === 'permission_denied'
                  || issueKind === 'path_invalid'
                  || issueKind === 'version_mismatch';

                return (
                  <div
                    key={clientId}
                    className="openbitfun-acp-agents__registry-row"
                    data-openbitfun-component="acp-agents-config"
                    data-openbitfun-part="registryRow"
                  >
                    <div
                      className="openbitfun-acp-agents__registry-main"
                      data-openbitfun-component="acp-agents-config"
                      data-openbitfun-part="registryMain"
                    >
                      <span className="openbitfun-acp-agents__registry-icon">
                        <Icon name="user" size="md" />
                      </span>
                      <div className="openbitfun-acp-agents__registry-copy">
                        <OverflowText className="openbitfun-acp-agents__registry-name">{displayName}</OverflowText>
                        <p className="openbitfun-acp-agents__registry-description openbitfun-acp-agents__registry-command">
                          {[clientConfig.command, ...clientConfig.args].join(' ')}
                        </p>
                      </div>
                    </div>
                    <div
                      className="openbitfun-acp-agents__status-cell"
                      data-openbitfun-component="acp-agents-config"
                      data-openbitfun-part="status"
                    >
                      <AgentStatusPill status={status} label={statusLabel} title={statusTitle} />
                    </div>
                    <div
                      className="openbitfun-acp-agents__confirmation-cell"
                      data-openbitfun-component="acp-agents-config"
                      data-openbitfun-part="confirmation"
                    >
                      {status === 'enabled' || status === 'ready' ? (
                        <Select
                          className="openbitfun-acp-agents__confirmation-select"
                          options={permissionOptions}
                          value={clientConfig.permissionMode}
                          onValueChange={(value) => patchClientConfig(clientId, {
                            permissionMode: normalizePermissionMode(value),
                          })}
                          size="sm"
                        />
                      ) : canViewError ? (
                        <Button
                          variant="outline"
                          size="sm"
                          leadingIcon={<CircleAlert />}
                          onClick={() => {
                            notifyError(
                              statusTitle || t('registry.configInvalidDetail'),
                              { title: statusLabel }
                            );
                          }}
                        >
                          {t('actions.viewError')}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          </FieldGroup>
          </FormSection>
          )}

          {activeView === 'ssh' && (
          <ConfigPageSection
            title={t('remote.title')}
            description={t('remote.description')}
            extra={hiddenRemoteConnectionRows.length > 0 ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowHiddenRemoteConnections(visible => !visible)}
                aria-expanded={showHiddenRemoteConnections}
              >
                {showHiddenRemoteConnections ? <EyeOff size={14} /> : <Icon name="eye" size="sm" />}
                {t(
                  showHiddenRemoteConnections
                    ? 'remote.hideHiddenConnections'
                    : 'remote.showHiddenConnections',
                  { count: hiddenRemoteConnectionRows.length }
                )}
              </Button>
            ) : undefined}
          >
            {visibleRemoteConnectionRows.length === 0 ? (
              <div className="openbitfun-acp-agents__empty" data-openbitfun-component="acp-agents-config" data-openbitfun-part="empty">
                {t(remoteConnectionRows.length === 0 ? 'remote.empty' : 'remote.emptyVisible')}
              </div>
            ) : (
              <div
                className="openbitfun-acp-agents__remote-list"
                data-openbitfun-component="acp-agents-config"
                data-openbitfun-part="remoteList"
              >
                {visibleRemoteConnectionRows.map(connection => {
                  const hostLabel = [connection.username, connection.host]
                    .filter(Boolean)
                    .join('@');
                  const remoteProbes = remoteRequirementProbes[connection.id] ?? [];
                  const remoteProbesById = new Map(remoteProbes.map(probe => [probe.id, probe]));
                  const remoteProbeLoaded = Object.prototype.hasOwnProperty.call(
                    remoteRequirementProbes,
                    connection.id
                  );
                  const probingRemote = probingRemoteRequirements.has(connection.id);
                  const remoteRows = remoteAgentIds.map(clientId => {
                    const preset = PRESET_BY_ID.get(clientId);
                    const clientConfig = config.acpClients[clientId];
                    const requirementProbe = remoteProbesById.get(clientId);
                    const probePending = probingRemote || !remoteProbeLoaded || !requirementProbe;
                    const hasConfigEntry = Boolean(clientConfig);
                    const effectiveConfig = clientConfig ?? (preset ? defaultConfigForPreset(preset) : undefined);
                    const enabled = effectiveConfig?.enabled ?? true;
                    const requiresAdapter = Boolean(
                      requirementProbe?.adapter || (preset && !NATIVE_ACP_PRESET_IDS.has(preset.id))
                    );
                    const issueKind = getIssueKind({ probe: requirementProbe, requiresAdapter });
                    const selfManagedInstallInfo = selfManagedInstallInfoForPreset(preset);
                    const status = getAgentRowStatus({
                      configured: hasConfigEntry,
                      enabled,
                      toolInstalled: requirementProbe?.tool.installed,
                      adapterInstalled: requirementProbe?.adapter?.installed,
                      requiresAdapter,
                      probePending,
                      probe: requirementProbe,
                    });
                    const displayName = effectiveConfig?.name || preset?.name || clientId;
                    const description = preset
                      ? getPresetDescription(preset.id)
                      : effectiveConfig
                        ? [effectiveConfig.command, ...effectiveConfig.args].join(' ')
                        : clientId;
                    const installingRemote = installingRemoteClientIds.has(`${connection.id}:${clientId}`);

                    return {
                      clientId,
                      preset,
                      clientConfig,
                      requirementProbe,
                      probePending,
                      hasConfigEntry,
                      enabled,
                      requiresAdapter,
                      issueKind,
                      selfManagedInstallInfo,
                      status,
                      displayName,
                      description,
                      installingRemote,
                    };
                  });
                  const availableCount = remoteRows.filter(row => row.status === 'enabled' || row.status === 'ready').length;
                  const issueCount = remoteRows.filter(row => (
                    row.status === 'partial' ||
                    row.status === 'not_installed' ||
                    row.status === 'invalid'
                  )).length;
                  const remoteChecking = remoteRows.some(row => row.status === 'checking');

                  return (
                    <div
                      key={connection.id}
                      className="openbitfun-acp-agents__remote-server"
                      data-openbitfun-component="acp-agents-config"
                      data-openbitfun-part="remoteServer"
                    >
                      <div
                        className="openbitfun-acp-agents__remote-head"
                        data-openbitfun-component="acp-agents-config"
                        data-openbitfun-part="remoteHeader"
                      >
                        <div
                          className="openbitfun-acp-agents__registry-main"
                          data-openbitfun-component="acp-agents-config"
                          data-openbitfun-part="registryMain"
                        >
                          <span className="openbitfun-acp-agents__registry-icon">
                            <Server size={16} />
                          </span>
                          <div className="openbitfun-acp-agents__registry-copy">
                            <OverflowText className="openbitfun-acp-agents__registry-name">
                              {connection.name || connection.id}
                            </OverflowText>
                            <p className="openbitfun-acp-agents__registry-description">
                              {hostLabel || connection.id}
                            </p>
                            <div className="openbitfun-acp-agents__remote-summary">
                              <StatusPill
                                leading={remoteChecking ? <Spinner size="xs" /> : undefined}
                                tone={remoteChecking ? 'info' : availableCount > 0 ? 'success' : 'neutral'}
                              >
                                {getRemoteSummary(availableCount, remoteRows.length)}
                              </StatusPill>
                              {issueCount > 0 && (
                                <StatusPill tone="warning">
                                  {t('remote.issueSummary', { count: issueCount })}
                                </StatusPill>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="openbitfun-acp-agents__remote-actions">
                          <Button
                            variant="outline"
                            size="sm"
                            leadingIcon={<Icon name="refresh" size="sm" />}
                            onClick={() => {
                              loadedRemoteProbeIdsRef.current.delete(connection.id);
                              void refreshRemoteRequirementProbes(connection.id, {
                                force: true,
                              });
                            }}
                            loading={probingRemote}
                          >
                            {t('remote.refreshDetection')}
                          </Button>
                          <Tooltip content={t('remote.hideConnection', {
                              name: connection.name || connection.id,
                            })}>
                            <IconButton
                              size="sm"
                              aria-label={t('remote.hideConnection', {
                                name: connection.name || connection.id,
                              })}
                              onClick={() => hideRemoteConnection(connection)}
                              icon={<EyeOff size={14} />}
                            />
                          </Tooltip>
                        </div>
                      </div>
                      <div
                        className="openbitfun-acp-agents__remote-agent-list"
                        data-openbitfun-component="acp-agents-config"
                        data-openbitfun-part="remoteAgents"
                      >
                        {remoteRows.map(row => {
                          const statusLabel = getStatusLabel({
                            status: row.status,
                            issueKind: row.issueKind,
                            probe: row.requirementProbe,
                            requiresAdapter: row.requiresAdapter,
                          });
                          const statusTitle = getStatusTitle({
                            status: row.status,
                            issueKind: row.issueKind,
                            probe: row.requirementProbe,
                            requiresAdapter: row.requiresAdapter,
                            selfManagedInstallInfo: row.selfManagedInstallInfo,
                          });
                          const canInstallCli = row.preset && row.status === 'not_installed' && row.issueKind === 'cli_missing'
                            && !SELF_MANAGED_INSTALL_PRESET_IDS.has(row.preset.id);
                          const selfManagedCliMissing = Boolean(row.selfManagedInstallInfo)
                            && row.status === 'not_installed'
                            && (row.issueKind === 'cli_missing' || row.requirementProbe?.tool.installed === false);
                          const canViewError = row.status === 'invalid' || row.status === 'partial'
                            || row.issueKind === 'connection_failed'
                            || row.issueKind === 'permission_denied'
                            || row.issueKind === 'path_invalid'
                            || row.issueKind === 'version_mismatch'
                            || row.issueKind === 'adapter_missing';

                          return (
                            <div
                              key={row.clientId}
                              className="openbitfun-acp-agents__registry-row openbitfun-acp-agents__registry-row--remote"
                              data-openbitfun-component="acp-agents-config"
                              data-openbitfun-part="registryRow"
                            >
                              <div
                                className="openbitfun-acp-agents__registry-main"
                                data-openbitfun-component="acp-agents-config"
                                data-openbitfun-part="registryMain"
                              >
                                <span className="openbitfun-acp-agents__registry-icon">
                                  <Icon name="user" size="md" />
                                </span>
                                <div className="openbitfun-acp-agents__registry-copy">
                                  <OverflowText className="openbitfun-acp-agents__registry-name">{row.displayName}</OverflowText>
                                  <p className="openbitfun-acp-agents__registry-description">{row.preset ? formatStandaloneUiText(row.description) : row.description}</p>
                                </div>
                              </div>
                              <div
                                className="openbitfun-acp-agents__capabilities"
                                data-openbitfun-component="acp-agents-config"
                                data-openbitfun-part="capabilities"
                              >
                                <CapabilityStatusPill
                                  icon={<Icon name="terminal" size="xs" />}
                                  item={row.requirementProbe?.tool}
                                  label={t('requirements.tool')}
                                  installedText={t('requirements.installed')}
                                  missingText={t('requirements.missing')}
                                  checking={row.probePending}
                                  checkingText={t('requirements.checking')}
                                />
                                {row.requirementProbe?.adapter && (
                                  <CapabilityStatusPill
                                    icon={<FileJson size={12} />}
                                    item={row.requirementProbe.adapter}
                                    label={t('requirements.adapter')}
                                    installedText={t('requirements.installed')}
                                    missingText={t('requirements.missing')}
                                    checking={row.probePending}
                                    checkingText={t('requirements.checking')}
                                  />
                                )}
                              </div>
                              <div
                                className="openbitfun-acp-agents__status-cell"
                                data-openbitfun-component="acp-agents-config"
                                data-openbitfun-part="status"
                              >
                                <AgentStatusPill status={row.status} label={statusLabel} title={statusTitle} />
                              </div>
                              <div
                                className="openbitfun-acp-agents__confirmation-cell"
                                data-openbitfun-component="acp-agents-config"
                                data-openbitfun-part="confirmation"
                              >
                                {canInstallCli ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    leadingIcon={<Icon name="arrow-down" size="sm" />}
                                    onClick={() => requestInstallPresetClient(row.preset!, {
                                      remoteConnectionId: connection.id,
                                      hostLabel: [connection.username, connection.host]
                                        .filter(Boolean)
                                        .join('@') || connection.name || connection.id,
                                    })}
                                    loading={row.installingRemote}
                                  >
                                    {t('actions.installCli')}
                                  </Button>
                                ) : selfManagedCliMissing && row.selfManagedInstallInfo ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    leadingIcon={<CircleAlert />}
                                    onClick={() => showSelfManagedInstallInfo(row.selfManagedInstallInfo!)}
                                  >
                                    {t('actions.viewInstructions')}
                                  </Button>
                                ) : row.status === 'enabled' || row.status === 'ready' ? (
                                  row.clientConfig ? (
                                    <Select
                                      className="openbitfun-acp-agents__confirmation-select"
                                      options={permissionOptions}
                                      value={row.clientConfig.permissionMode}
                                      onValueChange={(value) => patchClientConfig(row.clientId, {
                                        permissionMode: normalizePermissionMode(value),
                                      })}
                                      size="sm"
                                    />
                                  ) : row.preset ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    leadingIcon={<Icon name="plus" size="sm" />}
                                    onClick={() => addPresetClient(row.preset!)}
                                  >
                                    {t('actions.add')}
                                  </Button>
                                  ) : null
                                ) : canViewError ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    leadingIcon={<CircleAlert />}
                                    onClick={() => {
                                      notifyError(
                                        statusTitle || t('registry.configInvalidDetail'),
                                        { title: statusLabel }
                                      );
                                    }}
                                  >
                                    {t('actions.viewError')}
                                  </Button>
                                ) : (
                                  null
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {showHiddenRemoteConnections && hiddenRemoteConnectionRows.length > 0 && (
              <div
                className="openbitfun-acp-agents__hidden-remote-list"
                data-openbitfun-component="acp-agents-config"
                data-openbitfun-part="hiddenRemoteList"
              >
                {hiddenRemoteConnectionRows.map(connection => {
                  const hostLabel = [connection.username, connection.host]
                    .filter(Boolean)
                    .join('@');
                  return (
                    <div
                      key={connection.id}
                      className="openbitfun-acp-agents__hidden-remote-row"
                      data-openbitfun-component="acp-agents-config"
                      data-openbitfun-part="hiddenRemoteRow"
                    >
                      <div className="openbitfun-acp-agents__registry-main">
                        <span className="openbitfun-acp-agents__registry-icon">
                          <Server size={16} />
                        </span>
                        <div className="openbitfun-acp-agents__registry-copy">
                          <OverflowText className="openbitfun-acp-agents__registry-name">
                            {connection.name || connection.id}
                          </OverflowText>
                          <p className="openbitfun-acp-agents__registry-description">
                            {hostLabel || connection.id}
                          </p>
                        </div>
                      </div>
                      <Tooltip content={t('remote.restoreConnection', {
                          name: connection.name || connection.id,
                        })}>
                        <IconButton
                          size="sm"
                          aria-label={t('remote.restoreConnection', {
                            name: connection.name || connection.id,
                          })}
                          onClick={() => restoreRemoteConnection(connection)}
                          icon={<Icon name="eye" size="sm" />}
                        />
                      </Tooltip>
                    </div>
                  );
                })}
              </div>
            )}
          </ConfigPageSection>
          )}
        </ConfigPageSectionStack>
      </Content>
      <ConfirmDialog
        open={confirmClose}
        onOpenChange={() => setConfirmClose(false)}
        onConfirm={async () => {
          if (await (activeView === 'json' ? saveJsonConfig() : saveConfig())) {
            setConfirmClose(false);
            onClose?.();
          }
        }}
        onSecondary={() => {
          setConfirmClose(false);
          onClose?.();
        }}
        title={t('settings:changeGuard.title')}
        message={t('settings:changeGuard.message')}
        confirmText={t('settings:changeGuard.saveAndLeave')}
        secondaryText={t('settings:changeGuard.discardAndLeave')}
        cancelText={t('settings:changeGuard.keepEditing')}
        type="warning"
      />
      <ConfirmDialog
        open={!settingsDraftEnabled && pendingView !== null}
        onOpenChange={(open) => { if (!open) keepEditingJson(); }}
        onConfirm={discardJsonChanges}
        title={t('json.discardTitle')}
        message={t('json.discardMessage')}
        confirmText={t('json.discardConfirm')}
        type="warning"
      />
      <ConfirmDialog
        open={!!installConfirmation}
        onOpenChange={(open) => { if (!open) setInstallConfirmation(null); }}
        onConfirm={confirmInstallPresetClient}
        title={t('installConfirm.title', { name: installConfirmation?.preset.name || '' })}
        message={t('installConfirm.message', {
          host: installConfirmation?.hostLabel || '',
          command: installConfirmation
            ? `npm install -g ${installConfirmation.packageName}`
            : '',
        })}
        confirmText={t('installConfirm.confirm')}
        type="warning"
      />
    </Layout>
  );
});

export default AcpAgentsConfig;
