import { Disclosure, Alert, Button, Combobox, ConfirmDialog, Icon, IconButton, Select, Switch, Tooltip } from '@openbitfun/ui';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CircleDashed, FolderKanban, MinusCircle, ShieldCheck } from 'lucide-react';
import { ConfigLoadingState } from '@/infrastructure/config/components/common';

import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { i18nService } from '@/infrastructure/i18n';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { WorkspaceKind } from '@/shared/types';
import { createLogger } from '@/shared/utils/logger';
import { getMotionAwareScrollBehavior } from '@/shared/utils/motionPreference';

const logger = createLogger('ExternalSourcesConfig');
import {
  externalSourcesAPI,
  type ExternalIntegrationAccess,
  type ExternalIntegrationMode,
  type ExternalIntegrationPolicyMutation,
  type ExternalMcpDefinition,
  type ExternalSourceCatalogSnapshot,
  type ExternalSourceRecoveryAction,
  type ExternalSubagentModelBindingGroup,
  type ExternalSubagentModelBindingMethod,
  type ExternalSubagentModelBindingTarget,
  type ExternalSubagentModelProfileRequest,
  type ExternalSubagentModelRequest,
  type ExternalSubagentSummary,
  type ExternalToolCatalogEntry,
} from '@/infrastructure/api/service-api/ExternalSourcesAPI';
import {
  ConfigPageContent,
  ConfigPageHeader,
  ConfigPageLayout,
  ConfigPageRow,
  ConfigPageSection,
} from './common';
import {
  buildExternalSourcePresentationGroups,
  catalogDiagnosticsWithoutSourceDuplicates,
  externalSourceDiagnosticKey,
  type ExternalSourcePresentationGroup,
} from '../externalSourcePresentation';
import { externalSourceRequestScopeKey } from './externalSourceRequestScope';
import {
  ExternalAppsOverview,
  ExternalCommandConflicts,
  ExternalSourceSection,
  buildExternalApplicationsView,
  sourceDiagnosticCategory,
  type ExternalApplicationView,
} from './external-sources';
import './ExternalSourcesConfig.scss';

const DISCOVERY_POLL_DELAYS_MS = [750, 1_500, 3_000, 5_000] as const;

const AGENT_DIAGNOSTIC_SETTING_KEYS: Record<string, string> = {
  opencode_unknown_agent_field: 'unknownField',
  opencode_ambient_permission_not_imported: 'ambientPermissions',
  opencode_agent_permission_not_imported: 'permissions',
  opencode_agent_options_not_imported: 'options',
  opencode_native_agent_overlay_not_imported: 'nativeAgentOverlay',
  opencode_legacy_primary_mode_not_imported: 'legacyPrimaryMode',
  opencode_primary_agent_not_imported: 'primaryAgentMode',
  opencode_agent_tool_pattern_not_imported: 'toolPatterns',
  opencode_default_permission_semantics_not_imported: 'defaultPermissions',
  opencode_agent_variant_not_imported: 'variant',
  opencode_agent_temperature_not_imported: 'temperature',
  opencode_agent_top_p_not_imported: 'topP',
  opencode_agent_steps_not_imported: 'steps',
  opencode_agent_maxSteps_not_imported: 'maxSteps',
  opencode_agent_color_not_imported: 'color',
  opencode_primary_facet_not_imported: 'primaryFacet',
};

function mcpTimeoutSummary(definition: ExternalMcpDefinition, t: TFunction): string | null {
  const timeouts = definition.timeouts;
  if (!timeouts) return null;
  const values = [
    ['startupMs', 'mcp.timeoutStartup'],
    ['catalogMs', 'mcp.timeoutCatalog'],
    ['executionMs', 'mcp.timeoutExecution'],
  ] as const;
  const phases = values.flatMap(([field, label]) => {
    const milliseconds = timeouts[field];
    return milliseconds == null
      ? []
      : [t(label, {
        duration: t('mcp.timeoutMilliseconds', {
          value: i18nService.formatNumber(milliseconds),
        }),
      })];
  });
  return phases.length > 0 ? t('mcp.timeoutSummary', { values: phases.join(' · ') }) : null;
}

function McpTimeoutSummary({
  definition,
  t,
}: {
  definition: ExternalMcpDefinition;
  t: TFunction;
}) {
  const summary = mcpTimeoutSummary(definition, t);
  return summary ? <span>{summary}</span> : null;
}

type SnapshotLoadResult =
  | { status: 'accepted'; snapshot?: ExternalSourceCatalogSnapshot }
  | { status: 'ignored' }
  | { status: 'error' };

function sourceEcosystemId(
  snapshot: ExternalSourceCatalogSnapshot | null,
  source: { providerId: string; sourceId: string } | undefined,
): string | undefined {
  if (!snapshot || !source) return undefined;
  return snapshot.sources.find((candidate) => (
    candidate.record.key.providerId === source.providerId
    && candidate.record.key.sourceId === source.sourceId
  ))?.record.ecosystemId;
}

function onlyEcosystemId(values: Array<string | undefined>): string | undefined {
  const ecosystems = new Set(values.filter((value): value is string => Boolean(value)));
  return ecosystems.size === 1 ? ecosystems.values().next().value : undefined;
}

function abbreviatedLocation(location: string): string {
  const normalized = location.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  return segments.length <= 3 ? normalized : `…/${segments.slice(-3).join('/')}`;
}

function matchesToolSource(
  source: ExternalSourceCatalogSnapshot['sources'][number],
  tool: ExternalToolCatalogEntry,
): boolean {
  return source.record.key.providerId === tool.definition.id.target.source.providerId
    && source.record.key.sourceId === tool.definition.id.target.source.sourceId;
}

function agentDiagnosticCategory(code: string, blocksActivation: boolean): string {
  if (code.includes('configuration_unavailable')) return 'configurationUnavailable';
  if (code.includes('model_unavailable')) return 'modelUnavailable';
  if (code.includes('tool_unavailable')) return 'toolUnavailable';
  if (code === 'opencode_agent_prompt_not_imported') return 'promptMissing';
  if (AGENT_DIAGNOSTIC_SETTING_KEYS[code]) {
    return blocksActivation ? 'unsupportedSetting' : 'ignoredSetting';
  }
  if (code.includes('type_invalid') || code.includes('definition_invalid')
    || code.endsWith('_invalid')) {
    return 'invalidDefinition';
  }
  return blocksActivation ? 'unsupportedBehavior' : 'ignoredOption';
}

function agentDiagnosticParams(
  code: string,
  category: string,
  unavailableToolLabels: string[],
  t: TFunction,
): Record<string, string> | undefined {
  if (category === 'toolUnavailable') {
    return {
      tools: unavailableToolLabels.join(', ') || t('agents.unavailableToolsUnknown'),
    };
  }
  const settingKey = AGENT_DIAGNOSTIC_SETTING_KEYS[code];
  return settingKey
    ? { setting: t(`agentDiagnostics.settings.${settingKey}`) }
    : undefined;
}

const MCP_START_FAILURE_TRANSLATIONS: Record<string, string> = {
  'external_mcp.start.authentication': 'mcp.failureReasons.authentication',
  'external_mcp.start.timeout': 'mcp.failureReasons.timeout',
  'external_mcp.start.command_unavailable': 'mcp.failureReasons.commandUnavailable',
  'external_mcp.start.working_directory_unavailable': 'mcp.failureReasons.workingDirectoryUnavailable',
  'external_mcp.start.connection_failed': 'mcp.failureReasons.connectionFailed',
  'external_mcp.start.protocol_failed': 'mcp.failureReasons.protocolFailed',
  'external_mcp.start.other': 'mcp.failureReasons.other',
  'external_mcp.native_configuration_unavailable': 'mcp.failureReasons.nativeConfigurationUnavailable',
  'external_mcp.runtime.host_read_only': 'mcp.failureReasons.hostReadOnly',
  'external_mcp.runtime.configuration_changed': 'mcp.failureReasons.configurationChanged',
  'external_mcp.runtime.configuration_invalid': 'mcp.failureReasons.configurationInvalid',
  'external_mcp.runtime.host_unavailable': 'mcp.failureReasons.hostUnavailable',
  'external_mcp.runtime.install_failed': 'mcp.failureReasons.installFailed',
  'external_mcp.runtime.preparation_failed': 'mcp.failureReasons.preparationFailed',
  'external_mcp.runtime.server_missing': 'mcp.failureReasons.serverMissing',
  'external_mcp.runtime.failed': 'mcp.failureReasons.runtimeFailed',
  'external_mcp.runtime.stopped': 'mcp.failureReasons.stopped',
  'external_mcp.runtime.status_unavailable': 'mcp.failureReasons.statusUnavailable',
};

function localizedMcpFailureReason(reason: string, t: TFunction): string {
  return t(MCP_START_FAILURE_TRANSLATIONS[reason] ?? 'mcp.failureReasons.other');
}

function sourceScopeLabel(scope: string, t: TFunction): string {
  return scope === 'workspace_local'
    ? t('shared:features.workspace')
    : t(`scope.${scope}`);
}

function externalAgentModelLabel(model: string | undefined, t: TFunction): string {
  return model || t('agents.modelUnavailable');
}

function externalAgentEffectiveModelLabel(
  model: string | undefined,
  method: ExternalSubagentModelBindingMethod,
  t: TFunction,
): string {
  if (!model && method === 'inherit') {
    return t('agents.modelResolvedFromParentAtTaskStart');
  }
  return externalAgentModelLabel(model, t);
}

function externalAgentRequestedModelLabel(
  request: ExternalSubagentModelRequest | undefined,
  t: TFunction,
): string {
  if (!request) return t('agentModelBindings.request.default');
  if (request.kind === 'default') return t('agentModelBindings.request.default');
  if (request.kind === 'inherit') return t('agentModelBindings.request.inherit');
  return request.providerHint
    ? `${request.providerHint}/${request.modelName}`
    : request.modelName;
}

function externalAgentRequestedProfileLabel(
  request: ExternalSubagentModelProfileRequest | undefined,
  t: TFunction,
): string | undefined {
  if (!request) return undefined;
  if (request.kind === 'named_variant') {
    return t('agentModelBindings.profile.namedVariant', { name: request.name });
  }
  return t('agentModelBindings.profile.reasoningEffort', { value: request.value });
}

function externalAgentBindingTargetKey(target: ExternalSubagentModelBindingTarget): string {
  if (target.kind === 'model') return `model:${target.modelId}`;
  return target.kind;
}

function externalAgentBindingTargetFallbackLabel(
  target: ExternalSubagentModelBindingTarget,
  t: TFunction,
): string {
  if (target.kind === 'model') return target.modelId;
  return t(`agentModelBindings.target.${target.kind}`);
}

function executionLocationLabel(t: TFunction, executionDomainId?: string): string {
  if (executionDomainId?.startsWith('local')) return t('executionLocation.local');
  if (executionDomainId?.startsWith('remote')) return t('executionLocation.remote');
  return t('executionLocation.unknown');
}

type ExternalSourcesError = {
  kind: 'load' | 'mutation';
  code?: string;
  retryable: boolean;
  correlationId?: string;
  recoveryActions: ExternalSourceRecoveryAction[];
};

type AgentChangeNotice = {
  key: string;
  candidateIds: string[];
  message: string;
};

function externalOperationErrorFacts(error: unknown): Pick<
ExternalSourcesError,
'code' | 'retryable' | 'correlationId' | 'recoveryActions'
> {
  if (error && typeof error === 'object') {
    const candidate = error as {
      code?: unknown;
      retryable?: unknown;
      correlationId?: unknown;
      recoveryActions?: unknown;
    };
    const code = typeof candidate.code === 'string' ? candidate.code : undefined;
    return {
      code,
      retryable: candidate.retryable === true,
      correlationId: typeof candidate.correlationId === 'string'
        ? candidate.correlationId
        : undefined,
      recoveryActions: Array.isArray(candidate.recoveryActions)
        ? candidate.recoveryActions as ExternalSourceRecoveryAction[]
        : [],
    };
  }
  return {
    retryable: false,
    recoveryActions: [],
  };
}

function externalErrorMessageKey(error: ExternalSourcesError, hasSnapshot: boolean): string {
  if (['host_capability_unavailable', 'policy_limited', 'invalid_request', 'not_found']
    .includes(error.code ?? '')) return 'operationErrors.rejected';
  if (['stale_revision', 'conflict'].includes(error.code ?? '')) {
    return 'operationErrors.refreshRequired';
  }
  if (error.code === 'policy_incompatible') return 'operationErrors.policyIncompatible';
  if (error.code === 'internal') return 'operationErrors.internal';
  if (['unavailable', 'host_unavailable'].includes(error.code ?? '') || error.retryable) {
    return 'operationErrors.unavailableRetry';
  }
  if (error.kind === 'mutation') return 'errors.mutationUnknown';
  return hasSnapshot ? 'errors.refreshFailed' : 'errors.loadFailed';
}

const DISABLED_SUBAGENT_CONFLICT_CHOICE = '__openbitfun_disabled__';
const KNOWN_INTEGRATION_MODES = new Set(['recommended', 'discover_only', 'disabled', 'custom']);
const KNOWN_INTEGRATION_ACCESS = new Set([
  'disabled',
  'discover_only',
  'ask_before_use',
  'auto',
]);

function unresolvedFirst<T extends { selectedCandidateId?: string }>(items: T[]): T[] {
  return [
    ...items.filter((item) => !item.selectedCandidateId),
    ...items.filter((item) => item.selectedCandidateId),
  ];
}

function activeAgentAvailabilityChanges(
  previous: ExternalSourceCatalogSnapshot | null,
  next: ExternalSourceCatalogSnapshot,
): Array<{ previous: ExternalSubagentSummary; state: string; decisionKey: string }> {
  if (!previous) return [];
  const nextById = new Map((next.subagents ?? []).map((agent) => [agent.candidateId, agent]));
  return (previous.subagents ?? [])
    .filter((agent) => agent.activationState.state === 'active')
    .flatMap((agent) => {
      const current = nextById.get(agent.candidateId);
      if (current?.activationState.state === 'active') return [];
      return [{
        previous: agent,
        state: current?.activationState.state ?? 'removed',
        decisionKey: current?.decisionKey ?? 'removed',
      }];
    });
}

export interface ExternalSourcesConfigProps {
  presentation?: 'full' | 'governance';
  onSnapshotChange?: (snapshot: ExternalSourceCatalogSnapshot) => void;
}

const ExternalSourcesConfig: React.FC<ExternalSourcesConfigProps> = ({
  presentation = 'full',
  onSnapshotChange,
}) => {
  const { t } = useTranslation('settings/external-apps');
  const governancePresentation = presentation === 'governance';
  const pageTitle = governancePresentation ? t('governance.title') : t('title');
  const pageSubtitle = governancePresentation ? t('governance.subtitle') : t('subtitle');
  const { workspace, workspacePath } = useCurrentWorkspace();
  const peerDevice = usePeerDeviceModeOptional();
  const translateRef = useRef(t);
  translateRef.current = t;
  const peerDeviceId = peerDevice?.peerMode.active ? peerDevice.peerMode.deviceId : undefined;
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [reviewingToolKey, setReviewingToolKey] = useState<string | null>(null);
  const [reviewingAgentKey, setReviewingAgentKey] = useState<string | null>(null);
  const [reviewingMcpKey, setReviewingMcpKey] = useState<string | null>(null);
  const [reviewingMcpConflictKey, setReviewingMcpConflictKey] = useState<string | null>(null);
  const [error, setError] = useState<ExternalSourcesError | null>(null);
  const [operationStatus, setOperationStatus] = useState<string | null>(null);
  const [policyScope, setPolicyScope] = useState<'user' | 'workspace'>(
    workspacePath ? 'workspace' : 'user',
  );
  const [expandedEcosystems, setExpandedEcosystems] = useState<Set<string>>(() => new Set());
  const [resetPolicyConfirmation, setResetPolicyConfirmation] = useState<{
    requestScope: string;
    workspaceId?: string;
    preferenceRevision: number;
  } | null>(null);
  const [agentChangeNotice, setAgentChangeNotice] = useState<AgentChangeNotice | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const snapshotRef = useRef<ExternalSourceCatalogSnapshot | null>(null);
  const agentChangeNoticeRef = useRef<AgentChangeNotice | null>(null);
  const requestSequence = useRef(0);
  const acceptedSequence = useRef(0);
  const pendingMutations = useRef(new Map<number, string>());
  const latestMutationByScope = useRef(new Map<string, number>());
  const activeMutation = useRef<{ scope: string; sequence: number } | null>(null);
  const lastFailedMutationRef = useRef<(() => Promise<boolean>) | null>(null);
  const foregroundSequence = useRef<number | null>(null);
  const requestScope = externalSourceRequestScopeKey({
    peerDeviceId,
    workspaceId: workspace?.id,
    workspaceKind: workspace?.workspaceKind,
    remoteConnectionId: workspace?.connectionId,
    remoteHost: workspace?.sshHost,
    workspacePath,
  });
  const [snapshotState, setSnapshotState] = useState<{
    scope: string;
    snapshot: ExternalSourceCatalogSnapshot;
  } | null>(null);
  const snapshot = snapshotState?.scope === requestScope ? snapshotState.snapshot : null;
  const requestScopeRef = useRef(requestScope);
  useLayoutEffect(() => {
    if (requestScopeRef.current !== requestScope) {
      requestScopeRef.current = requestScope;
      requestSequence.current += 1;
      acceptedSequence.current = requestSequence.current;
      snapshotRef.current = null;
      agentChangeNoticeRef.current = null;
    }
  }, [requestScope]);

  const applySnapshot = useCallback((
    next: ExternalSourceCatalogSnapshot,
    scope: string,
    partition: 'all' | 'subagents' = 'all',
    origin: 'read' | 'mutation' = 'read',
  ) => {
    const current = snapshotRef.current;
    let selected = next;
    if (current && next.generation < current.generation) {
      if (partition !== 'subagents') return;
      if ((current.subagentGeneration ?? 0) > (next.subagentGeneration ?? 0)
        || (current.preferenceRevision ?? 0) > (next.preferenceRevision ?? 0)) {
        return;
      }
      selected = {
        ...current,
        subagentGeneration: next.subagentGeneration,
        preferenceRevision: next.preferenceRevision,
        subagents: next.subagents,
        subagentModelBindingGroups: next.subagentModelBindingGroups,
        subagentModelBindingOptions: next.subagentModelBindingOptions,
        subagentConflicts: next.subagentConflicts,
        pendingSubagentApprovals: next.pendingSubagentApprovals,
      };
    }

    if (origin === 'read') {
      const changes = activeAgentAvailabilityChanges(current, selected);
      if (changes.length > 0) {
        const key = changes
          .map((change) => `${change.previous.candidateId}:${change.state}:${change.decisionKey}`)
          .sort()
          .join('|');
        if (agentChangeNoticeRef.current?.key !== key) {
          const message = changes.length === 1
            ? translateRef.current('agentChanges.unavailable', {
                name: changes[0].previous.displayName,
                state: changes[0].state === 'removed'
                  ? translateRef.current('agentChanges.removedState')
                  : translateRef.current(`agentState.${changes[0].state}`),
              })
            : translateRef.current('agentChanges.unavailableMany', { count: changes.length });
          const notice = {
            key,
            candidateIds: changes.map((change) => change.previous.candidateId),
            message,
          };
          agentChangeNoticeRef.current = notice;
          setAgentChangeNotice(notice);
        }
      } else if (agentChangeNoticeRef.current) {
        const currentById = new Map(
          (selected.subagents ?? []).map((agent) => [agent.candidateId, agent]),
        );
        const recovered = agentChangeNoticeRef.current.candidateIds.every(
          (candidateId) => currentById.get(candidateId)?.activationState.state === 'active',
        );
        if (recovered) {
          agentChangeNoticeRef.current = null;
          setAgentChangeNotice(null);
        }
      }
    }

    snapshotRef.current = selected;
    setSnapshotState({ scope, snapshot: selected });
    if (requestScopeRef.current === scope) onSnapshotChange?.(selected);
  }, [onSnapshotChange]);

  const acceptReadSnapshot = useCallback((
    next: ExternalSourceCatalogSnapshot,
    scope: string,
    sequence: number,
  ): boolean => {
    if (requestScopeRef.current !== scope || sequence < acceptedSequence.current) return false;
    if (Array.from(pendingMutations.current.values()).includes(scope)) return false;
    acceptedSequence.current = sequence;
    applySnapshot(next, scope);
    return true;
  }, [applySnapshot]);

  const acceptMutationSnapshot = useCallback((
    next: ExternalSourceCatalogSnapshot,
    scope: string,
    sequence: number,
    partition: 'all' | 'subagents',
  ): boolean => {
    if (requestScopeRef.current !== scope) return false;
    if ((latestMutationByScope.current.get(scope) ?? sequence) > sequence) return false;
    acceptedSequence.current = Math.max(acceptedSequence.current, sequence);
    applySnapshot(next, scope, partition, 'mutation');
    return true;
  }, [applySnapshot]);

  const loadSnapshot = useCallback(async (
    forceRefresh: boolean,
    foreground: boolean,
  ): Promise<SnapshotLoadResult> => {
    const scope = requestScope;
    const sequence = ++requestSequence.current;
    if (foreground) {
      foregroundSequence.current = sequence;
      setRefreshing(true);
    }
    try {
      const next = await externalSourcesAPI.getSnapshot(workspace?.id, forceRefresh);
      if (!acceptReadSnapshot(next, scope, sequence)) return { status: 'ignored' };
      setError(null);
      return { status: 'accepted', snapshot: next };
    } catch (loadError) {
      if (requestScopeRef.current !== scope
        || sequence < acceptedSequence.current
        || Array.from(pendingMutations.current.values()).includes(scope)) {
        return { status: 'ignored' };
      }
      acceptedSequence.current = sequence;
      setError({ kind: 'load', ...externalOperationErrorFacts(loadError) });
      return { status: 'error' };
    } finally {
      if (requestScopeRef.current === scope) {
        if (sequence >= acceptedSequence.current) setLoading(false);
        if (foregroundSequence.current === sequence) {
          foregroundSequence.current = null;
          setRefreshing(false);
        }
      }
    }
  }, [acceptReadSnapshot, requestScope, workspace?.id]);

  useEffect(() => {
    setSnapshotState(null);
    snapshotRef.current = null;
    agentChangeNoticeRef.current = null;
    setAgentChangeNotice(null);
    setError(null);
    setOperationStatus(null);
    setBusyKey(null);
    setReviewingToolKey(null);
    setReviewingAgentKey(null);
    setReviewingMcpKey(null);
    setReviewingMcpConflictKey(null);
    setResetPolicyConfirmation(null);
    lastFailedMutationRef.current = null;
    setLoading(true);
    setPolicyScope(workspacePath ? 'workspace' : 'user');
    void loadSnapshot(false, false);
    const refreshWhenActive = () => {
      if (document.visibilityState === 'visible') {
        void loadSnapshot(false, false);
      }
    };
    window.addEventListener('focus', refreshWhenActive);
    document.addEventListener('visibilitychange', refreshWhenActive);
    return () => {
      window.removeEventListener('focus', refreshWhenActive);
      document.removeEventListener('visibilitychange', refreshWhenActive);
    };
  }, [loadSnapshot, requestScope, workspacePath, workspace?.id]);

  useEffect(() => {
    if (!snapshot?.discoveryPending) return undefined;
    let cancelled = false;
    let timer: number | undefined;
    let attempt = 0;
    const schedulePoll = () => {
      const delay = DISCOVERY_POLL_DELAYS_MS[
        Math.min(attempt, DISCOVERY_POLL_DELAYS_MS.length - 1)
      ];
      timer = window.setTimeout(async () => {
        const result = await loadSnapshot(false, false);
        if (cancelled) return;
        if (result.status === 'accepted' && !result.snapshot?.discoveryPending) return;
        attempt += 1;
        schedulePoll();
      }, delay);
    };
    schedulePoll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [loadSnapshot, snapshot?.discoveryPending]);

  const startingMcpSignature = (snapshot?.mcpServers ?? [])
    .filter((server) => server.activationState.state === 'starting')
    .map((server) => server.candidateId)
    .sort()
    .join('\u001f');

  useEffect(() => {
    if (!startingMcpSignature) return undefined;
    let cancelled = false;
    let timer: number | undefined;
    let attempt = 0;
    const schedulePoll = () => {
      const delay = DISCOVERY_POLL_DELAYS_MS[
        Math.min(attempt, DISCOVERY_POLL_DELAYS_MS.length - 1)
      ];
      timer = window.setTimeout(async () => {
        const result = await loadSnapshot(false, false);
        if (cancelled) return;
        const finished = result.status === 'accepted'
          && !(result.snapshot?.mcpServers ?? []).some(
            (server) => server.activationState.state === 'starting',
          );
        if (finished) return;
        attempt += 1;
        schedulePoll();
      }, delay);
    };
    schedulePoll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [loadSnapshot, startingMcpSignature]);

  const sourceGroups = useMemo(
    () => snapshot ? buildExternalSourcePresentationGroups(snapshot) : [],
    [snapshot],
  );
  const opencodeGroups = useMemo(
    () => sourceGroups.filter((group) => group.ecosystemId === 'opencode'),
    [sourceGroups],
  );
  const nonOpencodeGroups = useMemo(
    () => sourceGroups.filter((group) => group.ecosystemId !== 'opencode'),
    [sourceGroups],
  );
  const opencodeScopeLabel = useMemo(() => {
    const scopes = Array.from(new Set(opencodeGroups.flatMap((group) => group.scopes)));
    return (scopes.length > 0 ? scopes : ['user_global'])
      .map((scope) => sourceScopeLabel(scope, t))
      .join(' + ');
  }, [opencodeGroups, t]);
  const catalogDiagnostics = useMemo(
    () => snapshot ? catalogDiagnosticsWithoutSourceDuplicates(snapshot, sourceGroups) : [],
    [snapshot, sourceGroups],
  );
  const applications = useMemo(
    () => buildExternalApplicationsView(snapshot, policyScope),
    [policyScope, snapshot],
  );

  const commandConflicts = useMemo(
    () => unresolvedFirst(snapshot?.commandConflicts ?? []),
    [snapshot?.commandConflicts],
  );

  const toolConflicts = useMemo(
    () => unresolvedFirst(snapshot?.toolConflicts ?? []),
    [snapshot?.toolConflicts],
  );

  const agentConflicts = useMemo(
    () => unresolvedFirst(snapshot?.subagentConflicts ?? []),
    [snapshot?.subagentConflicts],
  );

  const mcpConflicts = useMemo(
    () => unresolvedFirst(snapshot?.mcpConflicts ?? []),
    [snapshot?.mcpConflicts],
  );

  const hostCapabilities = snapshot?.hostCapabilities ?? {
    canRefresh: false,
    canMutatePolicy: false,
    canManageSources: false,
    canApproveRuntime: false,
    canExecuteExternalAssets: false,
    canSetSafeMode: false,
    canRevealSourceLocation: false,
  };
  const control = snapshot?.control;
  const canRefresh = hostCapabilities.canRefresh;
  const safeModeEnabled = control?.safeMode;
  const canSetSafeMode = hostCapabilities.canSetSafeMode;
  const policyStatus = snapshot?.integrationPolicy?.status;
  const policyCompatible = policyStatus === 'compatible';
  const policyIncompatible = policyStatus === 'incompatible_schema';
  const policyUnknown = !policyCompatible && !policyIncompatible;
  const hostReadOnly = !hostCapabilities.canMutatePolicy
    && !hostCapabilities.canManageSources
    && !hostCapabilities.canApproveRuntime
    && !hostCapabilities.canSetSafeMode;
  const remoteWorkspace = workspace?.workspaceKind === WorkspaceKind.Remote;
  const readOnlyHintKey = remoteWorkspace
    ? 'policy.remoteReadOnlyHint'
    : 'policy.hostReadOnlyHint';

  const runMutation = useCallback(async (
    mutationKey: string,
    request: () => Promise<ExternalSourceCatalogSnapshot>,
    _focusResult = false,
    partition: 'all' | 'subagents' = 'all',
    successMessage?: string,
    requiredCapability:
      | 'canMutatePolicy'
      | 'canManageSources'
      | 'canApproveRuntime'
      | 'canSetSafeMode' = 'canManageSources',
    policyGate: 'compatible' | 'compatible_or_incompatible' | 'none' = 'compatible',
  ): Promise<boolean> => {
    const current = snapshotRef.current;
    const currentCapabilities = current?.hostCapabilities ?? {
      canMutatePolicy: false,
      canManageSources: false,
      canApproveRuntime: false,
      canSetSafeMode: false,
    };
    const currentStatus = current?.integrationPolicy.status;
    if (!current || currentCapabilities[requiredCapability] !== true
      || (policyGate === 'compatible' && currentStatus !== 'compatible')
      || (policyGate === 'compatible_or_incompatible'
        && currentStatus !== 'compatible'
        && currentStatus !== 'incompatible_schema')) {
      setOperationStatus(t(readOnlyHintKey));
      return false;
    }
    if (activeMutation.current?.scope === requestScope) {
      setOperationStatus(t('actions.waitForUpdate'));
      return false;
    }
    const scope = requestScope;
    const sequence = ++requestSequence.current;
    activeMutation.current = { scope, sequence };
    pendingMutations.current.set(sequence, scope);
    latestMutationByScope.current.set(scope, sequence);
    setBusyKey(mutationKey);
    setOperationStatus(null);
    try {
      setError(null);
      const next = await request();
      const accepted = acceptMutationSnapshot(next, scope, sequence, partition);
      if (accepted) {
        lastFailedMutationRef.current = null;
        setOperationStatus(successMessage ?? t('actions.updated'));
      }
      return accepted;
    } catch (updateError) {
      if (requestScopeRef.current === scope
        && latestMutationByScope.current.get(scope) === sequence) {
        acceptedSequence.current = sequence;
        const facts = externalOperationErrorFacts(updateError);
        lastFailedMutationRef.current = facts.recoveryActions.some(
          (action) => action.type === 'retry',
        )
          ? () => runMutation(
            mutationKey,
            request,
            _focusResult,
            partition,
            successMessage,
            requiredCapability,
            policyGate,
          )
          : null;
        setError({ kind: 'mutation', ...facts });
      }
      return false;
    } finally {
      if (activeMutation.current?.scope === scope
        && activeMutation.current.sequence === sequence) {
        activeMutation.current = null;
      }
      pendingMutations.current.delete(sequence);
      if (requestScopeRef.current === scope) {
        setBusyKey((current) => (current === mutationKey ? null : current));
      }
    }
  }, [acceptMutationSnapshot, readOnlyHintKey, requestScope, t]);

  const setEnabled = useCallback(async (
    sourceKey: string,
    enabled: boolean,
  ) => {
    const currentSnapshot = snapshotRef.current;
    if (!currentSnapshot) return;
    await runMutation(
      sourceKey,
      () => externalSourcesAPI.setSourceEnabled(
        workspace?.id,
        sourceKey,
        enabled,
        currentSnapshot.preferenceRevision ?? 0,
      ),
    );
  }, [runMutation, workspace?.id]);

  const setSafeMode = useCallback(async (enabled: boolean) => {
    const currentSnapshot = snapshotRef.current;
    if (!currentSnapshot?.control) return;
    await runMutation(
      'external-safe-mode',
      () => externalSourcesAPI.setSafeMode(
        workspace?.id,
        enabled,
        currentSnapshot.control?.preferenceRevision ?? 0,
      ),
      false,
      'all',
      t(enabled ? 'safeMode.entered' : 'safeMode.exited'),
      'canSetSafeMode',
      'none',
    );
  }, [runMutation, t, workspace?.id]);

  const chooseConflict = useCallback(async (conflictKey: string, candidateId: string) => {
    if (!snapshot) return;
    await runMutation(
      conflictKey,
      () => externalSourcesAPI.setConflictChoice(
        workspace?.id,
        conflictKey,
        candidateId,
        snapshot.preferenceRevision ?? 0,
      ),
      true,
      'all',
      undefined,
      'canApproveRuntime',
    );
  }, [runMutation, snapshot, workspace?.id]);

  const decideToolTarget = useCallback(async (
    approvalKey: string,
    decisionKey: string,
    approved: boolean,
  ) => {
    if (!snapshot) return false;
    return runMutation(
      decisionKey,
      () => externalSourcesAPI.setToolTargetDecision(
        workspace?.id,
        approvalKey,
        decisionKey,
        approved,
        snapshot.preferenceRevision ?? 0,
      ),
      true,
      'all',
      undefined,
      'canApproveRuntime',
    );
  }, [runMutation, snapshot, workspace?.id]);

  const chooseToolConflict = useCallback(async (conflictKey: string, candidateId: string) => {
    if (!snapshot) return;
    await runMutation(
      conflictKey,
      () => externalSourcesAPI.setToolConflictChoice(
        workspace?.id,
        conflictKey,
        candidateId,
        snapshot.preferenceRevision ?? 0,
      ),
      true,
      'all',
      undefined,
      'canApproveRuntime',
    );
  }, [runMutation, snapshot, workspace?.id]);

  const decideAgent = useCallback(async (candidateId: string, decisionKey: string, approved: boolean) => {
    if (!snapshot) return false;
    const label = snapshot.subagents?.find((agent) => agent.candidateId === candidateId)
      ?.displayName ?? candidateId;
    const accepted = await runMutation(
      decisionKey,
      () => externalSourcesAPI.setSubagentActivation(
        workspace?.id,
        candidateId,
        approved,
        snapshot.subagentGeneration ?? 0,
        snapshot.preferenceRevision ?? 0,
        decisionKey,
      ),
      true,
      'subagents',
      t('actions.agentUpdated', { name: label }),
      'canApproveRuntime',
    );
    if (accepted) await loadSnapshot(true, false);
    return accepted;
  }, [loadSnapshot, runMutation, snapshot, t, workspace?.id]);

  const setAgentModelBinding = useCallback(async (
    group: ExternalSubagentModelBindingGroup,
    target: ExternalSubagentModelBindingTarget | undefined,
  ) => {
    const current = snapshotRef.current;
    if (!current) return;
    const accepted = await runMutation(
      group.bindingKey,
      () => externalSourcesAPI.setSubagentModelBinding(
        workspace?.id,
        group.bindingKey,
        target,
        current.subagentGeneration ?? 0,
        current.preferenceRevision ?? 0,
      ),
      true,
      'subagents',
      t('actions.modelBindingUpdated'),
      'canApproveRuntime',
    );
    if (accepted) await loadSnapshot(true, false);
  }, [loadSnapshot, runMutation, t, workspace?.id]);

  const chooseAgentConflict = useCallback(async (
    conflictKey: string,
    candidateId: string,
    approveExternal: boolean,
  ) => {
    if (!snapshot) return;
    const logicalId = snapshot.subagentConflicts
      ?.find((conflict) => conflict.conflictKey === conflictKey)?.logicalId ?? conflictKey;
    const accepted = await runMutation(
      conflictKey,
      () => externalSourcesAPI.chooseSubagentConflict(
        workspace?.id,
        conflictKey,
        candidateId,
        approveExternal,
        snapshot.subagentGeneration ?? 0,
        snapshot.preferenceRevision ?? 0,
      ),
      true,
      'subagents',
      t('actions.agentUpdated', { name: logicalId }),
      'canApproveRuntime',
    );
    if (accepted) await loadSnapshot(true, false);
  }, [loadSnapshot, runMutation, snapshot, t, workspace?.id]);

  const decideMcpServer = useCallback(async (
    candidateId: string,
    decisionKey: string,
    approved: boolean,
  ) => {
    if (!snapshot) return false;
    const accepted = await runMutation(
      decisionKey,
      () => externalSourcesAPI.setMcpServerDecision(
        workspace?.id,
        candidateId,
        decisionKey,
        approved,
        snapshot.mcpGeneration ?? 0,
        snapshot.preferenceRevision ?? 0,
      ),
      true,
      'all',
      t('actions.mcpUpdated'),
      'canApproveRuntime',
    );
    if (accepted) await loadSnapshot(true, false);
    return accepted;
  }, [loadSnapshot, runMutation, snapshot, t, workspace?.id]);

  const chooseMcpConflict = useCallback(async (
    conflictKey: string,
    candidateId: string,
    approveExternal: boolean,
  ) => {
    if (!snapshot) return false;
    const accepted = await runMutation(
      conflictKey,
      () => externalSourcesAPI.chooseMcpConflict(
        workspace?.id,
        conflictKey,
        candidateId,
        approveExternal,
        snapshot.mcpGeneration ?? 0,
        snapshot.preferenceRevision ?? 0,
      ),
      true,
      'all',
      t('actions.mcpUpdated'),
      'canApproveRuntime',
    );
    if (accepted) await loadSnapshot(true, false);
    return accepted;
  }, [loadSnapshot, runMutation, snapshot, t, workspace?.id]);

  const setToolTargetsEnabled = useCallback(async (enabled: boolean) => {
    const current = snapshotRef.current;
    if (!current) return;
    const decisions = enabled
      ? (current.toolApprovalRequests ?? []).map((request) => ({
          approvalKey: request.approvalKey,
          decisionKey: request.decisionKey,
        }))
      : Array.from(new Map((current.tools ?? []).map((tool) => [
          tool.approvalKey,
          { approvalKey: tool.approvalKey, decisionKey: tool.decisionKey },
        ])).values());
    await runMutation(
      'bulk-tools',
      () => externalSourcesAPI.setToolTargetsEnabled(
        workspace?.id,
        decisions,
        enabled,
        current.generation,
        current.preferenceRevision ?? 0,
      ),
      true,
      'all',
      t(enabled ? 'bulkActions.enabled' : 'bulkActions.disabled'),
      'canApproveRuntime',
    );
  }, [runMutation, t, workspace?.id]);

  const setSubagentsEnabled = useCallback(async (enabled: boolean) => {
    const current = snapshotRef.current;
    if (!current) return;
    const decisions = (current.subagents ?? [])
      .filter((agent) => !enabled || agent.activationState.state === 'approval_required')
      .map((agent) => ({ candidateId: agent.candidateId, decisionKey: agent.decisionKey }));
    const accepted = await runMutation(
      'bulk-subagents',
      () => externalSourcesAPI.setSubagentsEnabled(
        workspace?.id,
        decisions,
        enabled,
        current.subagentGeneration ?? 0,
        current.preferenceRevision ?? 0,
      ),
      true,
      'subagents',
      t(enabled ? 'bulkActions.enabled' : 'bulkActions.disabled'),
      'canApproveRuntime',
    );
    if (accepted) await loadSnapshot(true, false);
  }, [loadSnapshot, runMutation, t, workspace?.id]);

  const setMcpServersEnabled = useCallback(async (enabled: boolean) => {
    const current = snapshotRef.current;
    if (!current) return;
    const decisions = (enabled
      ? current.mcpApprovalRequests ?? []
      : current.mcpServers ?? []).map((server) => ({
        candidateId: server.candidateId,
        decisionKey: server.decisionKey,
      }));
    const accepted = await runMutation(
      'bulk-mcp',
      () => externalSourcesAPI.setMcpServersEnabled(
        workspace?.id,
        decisions,
        enabled,
        current.mcpGeneration ?? 0,
        current.preferenceRevision ?? 0,
      ),
      true,
      'all',
      t(enabled ? 'bulkActions.enabled' : 'bulkActions.disabled'),
      'canApproveRuntime',
    );
    if (accepted) await loadSnapshot(true, false);
  }, [loadSnapshot, runMutation, t, workspace?.id]);

  const isRemote = workspace?.workspaceKind === WorkspaceKind.Remote
    || Boolean(workspace?.connectionId);
  const policy = snapshot?.integrationPolicy;
  const selectedPolicyEnabled = policyScope === 'workspace'
    ? policy?.workspaceOverride?.enabled ?? policy?.userDefaults.enabled ?? false
    : policy?.userDefaults.enabled ?? false;
  const selectedPolicyEffective = policyScope === 'workspace'
    ? policy?.effective
    : policy?.globalEffective;
  const workspacePolicyInherited = policyScope === 'workspace'
    && policy?.workspaceOverride?.enabled === undefined
    && Object.values(policy?.workspaceOverride?.ecosystems ?? {}).every((ecosystem) => (
      ecosystem.mode === undefined
      && Object.keys(ecosystem.capabilityOverrides ?? {}).length === 0
    ));
  const ecosystemPolicies = (policy?.registeredEcosystems ?? []).map((descriptor) => {
    const ecosystemId = descriptor.ecosystemId;
    const userPolicy = policy?.userDefaults.ecosystems?.[ecosystemId];
    const workspacePolicy = policy?.workspaceOverride?.ecosystems?.[ecosystemId];
    const mode: ExternalIntegrationMode = policyScope === 'workspace'
      ? workspacePolicy?.mode ?? userPolicy?.mode ?? 'recommended'
      : userPolicy?.mode ?? 'recommended';
    const capabilityOverrides = policyScope === 'workspace'
      ? {
          ...(userPolicy?.capabilityOverrides ?? {}),
          ...(workspacePolicy?.capabilityOverrides ?? {}),
        }
      : userPolicy?.capabilityOverrides ?? {};
    const sources = (snapshot?.sources ?? []).filter(
      (source) => source.record.ecosystemId === ecosystemId,
    );
    const hasIssue = sources.some((source) => (
      ['degraded', 'unavailable'].includes(source.record.health)
      || (source.record.diagnostics?.length ?? 0) > 0
    ));
    const state: 'checking' | 'attention' | 'ready' | 'noConfig' = snapshot?.discoveryPending
      ? 'checking'
      : !policyCompatible || hasIssue
        ? 'attention'
        : sources.length > 0
          ? 'ready'
          : 'noConfig';
    return {
      descriptor,
      ecosystemId,
      mode,
      capabilityOverrides,
      effective: selectedPolicyEffective?.ecosystems[ecosystemId],
      sourceLocations: Array.from(new Set(sources.map((source) => source.record.location))),
      state,
    };
  });
  const selectedCapabilityAccess = (
    ecosystem: (typeof ecosystemPolicies)[number],
    capabilityId: string,
  ): ExternalIntegrationAccess => {
    if (!selectedPolicyEnabled) return 'disabled';
    if (ecosystem.mode === 'recommended') {
      return ecosystem.descriptor.capabilities
        .find((capability) => capability.capabilityId === capabilityId)
        ?.recommendedAccess ?? 'disabled';
    }
    if (ecosystem.mode === 'discover_only') return 'discover_only';
    if (ecosystem.mode === 'disabled' || !KNOWN_INTEGRATION_MODES.has(ecosystem.mode)) {
      return 'disabled';
    }
    const requested = ecosystem.capabilityOverrides[capabilityId] ?? 'discover_only';
    const ceiling = ecosystem.descriptor.capabilities
      .find((capability) => capability.capabilityId === capabilityId)
      ?.safetyCeiling ?? 'disabled';
    const accessRank: Record<string, number> = {
      disabled: 0,
      discover_only: 1,
      ask_before_use: 2,
      auto: 3,
    };
    if (accessRank[requested] === undefined || accessRank[ceiling] === undefined) {
      return 'disabled';
    }
    return accessRank[requested] <= accessRank[ceiling] ? requested : ceiling;
  };
  const diagnosticAttentionCount = catalogDiagnostics
    .filter((diagnostic) => diagnostic.severity !== 'info').length
    + sourceGroups.reduce((count, group) => count + group.diagnostics.length, 0);
  const externalAttentionCount = (snapshot?.toolApprovalRequests?.length ?? 0)
    + (snapshot?.pendingSubagentApprovals?.length ?? 0)
    + (snapshot?.mcpApprovalRequests?.length ?? 0)
    + commandConflicts.filter((conflict) => !conflict.selectedCandidateId).length
    + toolConflicts.filter((conflict) => !conflict.selectedCandidateId).length
    + agentConflicts.filter((conflict) => !conflict.selectedCandidateId).length
    + mcpConflicts.filter((conflict) => !conflict.selectedCandidateId).length
    + diagnosticAttentionCount
    + Number(Boolean(snapshot) && !policyCompatible);

  const updatePolicy = useCallback(async (
    change: ExternalIntegrationPolicyMutation['change'],
  ) => {
    if (!snapshot) return false;
    return runMutation(
      `integration-policy:${policyScope}`,
      () => externalSourcesAPI.updateIntegrationPolicy(workspace?.id, {
        expectedPreferenceRevision: snapshot.preferenceRevision ?? 0,
        scope: policyScope,
        change,
      }),
      true,
      'all',
      t('policy.updated'),
      'canMutatePolicy',
      change.operation === 'reset_incompatible_policy'
        ? 'compatible_or_incompatible'
        : 'compatible',
    );
  }, [policyScope, runMutation, snapshot, t, workspace?.id]);

  const toggleApplication = useCallback(async (
    application: ExternalApplicationView,
    enabled: boolean,
  ) => {
    if (!snapshot) return;
    const storedPolicy = ecosystemPolicies.find(
      (ecosystem) => ecosystem.ecosystemId === application.ecosystemId,
    );
    const hasCustomOverrides = Object.keys(
      storedPolicy?.capabilityOverrides ?? {},
    ).length > 0;
    const mode: ExternalIntegrationMode = enabled
      ? (hasCustomOverrides ? 'custom' : 'recommended')
      : 'disabled';
    await updatePolicy({
      operation: 'set_ecosystem_mode',
      ecosystemId: application.ecosystemId,
      mode,
    });
  }, [
    ecosystemPolicies,
    snapshot,
    updatePolicy,
  ]);

  const updateCapabilityAccess = useCallback((
    ecosystemId: string,
    capabilityId: string,
    access: ExternalIntegrationAccess,
  ) => updatePolicy({
    operation: 'set_capability_access',
    ecosystemId,
    capabilityId,
    access,
  }), [updatePolicy]);

  const resetIncompatiblePolicy = useCallback((confirmation: {
    requestScope: string;
    workspaceId?: string;
    preferenceRevision: number;
  }) => {
    if (requestScope !== confirmation.requestScope) return Promise.resolve(false);
    return runMutation(
      'integration-policy:recovery',
      () => externalSourcesAPI.updateIntegrationPolicy(confirmation.workspaceId, {
        expectedPreferenceRevision: confirmation.preferenceRevision,
        scope: 'user',
        change: { operation: 'reset_incompatible_policy' },
      }),
      false,
      'all',
      t('policy.recoveryResetComplete'),
      'canMutatePolicy',
      'compatible_or_incompatible',
    );
  }, [requestScope, runMutation, t]);

  const scrollToFirstAttentionItem = useCallback((ecosystemId?: string) => {
    const matchingEcosystemElements = ecosystemId
      ? Array.from(document.querySelectorAll<HTMLElement>('[data-external-ecosystem]'))
          .filter((element) => element.dataset.externalEcosystem === ecosystemId)
      : [];
    const target = ecosystemId
      ? matchingEcosystemElements.find(
          (element) => element.dataset.externalAttention === 'true',
        ) ?? matchingEcosystemElements[0]
      : document.querySelector<HTMLElement>('[data-external-attention="true"]');
    if (!target) return;
    target.scrollIntoView({
      block: 'center',
      behavior: getMotionAwareScrollBehavior('smooth'),
    });
    if (target instanceof HTMLDetailsElement) {
      target.open = true;
      target.querySelector<HTMLElement>('summary')?.focus();
      return;
    }
    const focusTarget = target.querySelector<HTMLElement>('button, [href], [tabindex]');
    if (focusTarget) {
      focusTarget.focus();
      return;
    }
    target.tabIndex = -1;
    target.focus();
  }, []);

  const openAdvancedAttention = useCallback((ecosystemId: string) => {
    setAdvancedOpen(true);
    setExpandedEcosystems((current) => new Set(current).add(ecosystemId));
    window.requestAnimationFrame(() => scrollToFirstAttentionItem(ecosystemId));
  }, [scrollToFirstAttentionItem]);

  const openAdvancedPolicy = useCallback(() => {
    setAdvancedOpen(true);
    window.requestAnimationFrame(() => {
      const policyCard = document.querySelector<HTMLElement>('[data-openbitfun-product-part="policyCard"]');
      if (!policyCard) return;
      policyCard.scrollIntoView({
        block: 'center',
        behavior: getMotionAwareScrollBehavior('smooth'),
      });
      policyCard.querySelector<HTMLInputElement>('input[type="checkbox"]')?.focus();
    });
  }, []);

  const revealSourceLocation = useCallback(async (sourceKey: string): Promise<boolean> => {
    const scope = requestScope;
    if (snapshotRef.current?.hostCapabilities.canRevealSourceLocation !== true) {
      setOperationStatus(t('common.openInExplorerUnavailable'));
      return false;
    }
    setOperationStatus(null);
    setError(null);
    try {
      await externalSourcesAPI.revealSourceLocation(workspace?.id, sourceKey);
      if (requestScopeRef.current === scope) lastFailedMutationRef.current = null;
      return true;
    } catch (revealError) {
      const facts = externalOperationErrorFacts(revealError);
      logger.warn('Could not reveal external source location', {
        sourceKey,
        code: facts.code ?? 'internal',
      });
      if (requestScopeRef.current === scope) {
        lastFailedMutationRef.current = facts.recoveryActions.some(
          (action) => action.type === 'retry',
        )
          ? () => revealSourceLocation(sourceKey)
          : null;
        setError({ kind: 'mutation', ...facts });
      }
      return false;
    }
  }, [requestScope, t, workspace?.id]);

  const renderPathLink = useCallback((location: string, sourceKey?: string) => {
    const display = abbreviatedLocation(location);
    if (isRemote || !sourceKey || !hostCapabilities.canRevealSourceLocation) {
      const unavailableMessage = isRemote
        ? t('common.openInExplorerRemote')
        : t('common.openInExplorerUnavailable');
      return (
        <Tooltip content={unavailableMessage} placement="top">
          <span
            className="openbitfun-external-sources-config__path-link openbitfun-external-sources-config__path-link--disabled"
            aria-label={unavailableMessage}
          >
            {display}
          </span>
        </Tooltip>
      );
    }
    return (
      <a
        href="#"
        className="openbitfun-external-sources-config__path-link"
        title={location}
        translate="no"
        onClick={(event) => {
          event.preventDefault();
          void revealSourceLocation(sourceKey);
        }}
      >
        {display}
      </a>
    );
  }, [hostCapabilities.canRevealSourceLocation, isRemote, revealSourceLocation, t]);

  const renderSourceMembers = useCallback((group: ExternalSourcePresentationGroup) => (
    <div
      className="openbitfun-external-sources-config__source-members"
      data-openbitfun-product-component="external-sources-config"
      data-openbitfun-product-part="sourceMembers"
      role="group"
      aria-label={t('sources.toggleLabel', { name: group.displayName })}
    >
      {group.members.map((member) => {
        const capabilityLabel = member.capability === 'source'
          ? group.displayName
          : t(`policy.capability.${member.capability}`);
        const scopeLabel = sourceScopeLabel(member.scope, t);
        const memberBusy = busyKey === member.stableKey;
        return (
          <label
            key={member.stableKey}
            className="openbitfun-external-sources-config__source-member"
          >
            <span className="openbitfun-external-sources-config__source-member-copy">
              <span className="openbitfun-external-sources-config__source-member-label">
                {capabilityLabel}
              </span>
              {group.scopes.length > 1 ? (
                <span className="openbitfun-external-sources-config__source-member-description">
                  {scopeLabel}
                </span>
              ) : null}
              {member.lifecycle !== 'available' ? (
                <span className={`openbitfun-external-sources-config__state is-${member.lifecycle}`} data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="state">
                  {t(`lifecycle.${member.lifecycle}`)}
                </span>
              ) : null}
            </span>
            <Switch
              checked={member.enabled}
              disabled={!policyCompatible
                || !member.mutable
                || !hostCapabilities.canManageSources
                || memberBusy}
              aria-busy={memberBusy}
              aria-label={t('sources.toggleLabel', {
                name: [
                  group.displayName,
                  capabilityLabel,
                  scopeLabel,
                  t(`lifecycle.${member.lifecycle}`),
                ].join(' · '),
              })}
              onChange={(event) => void setEnabled(
                member.stableKey,
                event.currentTarget.checked,
              )}
            />
          </label>
        );
      })}
    </div>
  ), [busyKey, hostCapabilities.canManageSources, policyCompatible, setEnabled, t]);

  if (loading && !snapshot) {
    return (
      <ConfigPageLayout
        className={`openbitfun-external-sources-config${governancePresentation ? ' openbitfun-external-sources-config--governance' : ''}`}
        data-presentation={presentation}
      >
        <ConfigPageHeader
          title={pageTitle}
          subtitle={pageSubtitle}
        />
        <ConfigPageContent>
          <ConfigLoadingState label={t('loading')} />
        </ConfigPageContent>
      </ConfigPageLayout>
    );
  }

  const hostUnavailable = !snapshot && error?.code === 'host_unavailable';
  const hostUnavailableDescriptionKey = peerDeviceId
    ? 'unavailable.remoteConnectionDescription'
    : remoteWorkspace
      ? 'unavailable.remoteDescription'
      : 'unavailable.hostDescription';
  const hostUnavailableCanRetry = Boolean(
    peerDeviceId
      || error?.retryable
      || error?.recoveryActions.some((action) => (
        action.type === 'refresh' || action.type === 'retry'
      )),
  );
  const safeModeSection = safeModeEnabled !== undefined ? (
    <ConfigPageSection
      title={t('safeMode.title')}
      description={safeModeEnabled ? undefined : t('safeMode.description')}
      extra={(
        <Switch
          checked={safeModeEnabled}
          disabled={busyKey !== null || !canSetSafeMode}
          aria-busy={busyKey === 'external-safe-mode'}
          aria-label={t('safeMode.toggleLabel')}
          onChange={(event) => void setSafeMode(event.currentTarget.checked)}
        />
      )}
    >
      {safeModeEnabled ? (
        <Alert
          className="openbitfun-external-sources-config__notice"
          data-openbitfun-product-component="external-sources-config"
          data-openbitfun-product-part="notice"
          role="status"
          data-external-attention="true"
          showIcon={false}
          message={(
            <>
              {t('safeMode.activeNotice')}
            </>
          )}
        />
      ) : null}
    </ConfigPageSection>
  ) : null;

  return (
    <ConfigPageLayout
      className={`openbitfun-external-sources-config${governancePresentation ? ' openbitfun-external-sources-config--governance' : ''}`}
      data-openbitfun-product-component="external-sources-config"
      data-openbitfun-product-part="root"
      data-presentation={presentation}
    >
      <ConfigPageHeader
        title={pageTitle}
        subtitle={pageSubtitle}
        extra={(
          <Tooltip
            content={refreshing ? t('actions.refreshing') : t('actions.refresh')}
            placement="top"
          >
            <Button
              variant="outline"
              size="sm"
              aria-label={refreshing ? t('actions.refreshing') : t('actions.refresh')}
              disabled={refreshing
                || (hostUnavailable
                  ? !hostUnavailableCanRetry
                  : (!canRefresh && !error))}
              onClick={() => {
                void loadSnapshot(true, true);
              }}
            >
              <Icon name="refresh" size="lg" aria-hidden="true" style={{ width: 15, height: 15 }} />
            </Button>
          </Tooltip>
        )}
      />
      <ConfigPageContent id="external-integration-attention-region">
        {hostUnavailable ? (
          <>
            <ConfigPageSection title={t('unavailable.hostTitle')}>
              <Alert
                className="openbitfun-external-sources-config__notice"
                data-openbitfun-product-component="external-sources-config"
                data-openbitfun-product-part="notice"
                role="alert"
                showIcon={false}
                message={(
                  <>
                    <div>{t(hostUnavailableDescriptionKey)}</div>
                    {hostUnavailableCanRetry ? (
                      <div className="openbitfun-external-sources-config__recovery-actions">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void loadSnapshot(true, true)}
                        >
                          {t('recoveryActions.retry')}
                        </Button>
                      </div>
                    ) : null}
                  </>
                )}
              />
            </ConfigPageSection>
          </>
        ) : (
          <>
            {error ? (
              <Alert
                className="openbitfun-external-sources-config__notice"
                data-openbitfun-product-component="external-sources-config"
                data-openbitfun-product-part="notice"
                role={error.kind === 'mutation' || !snapshot ? 'alert' : 'status'}
                showIcon={false}
                message={(
                  <>
                    <div>{t(externalErrorMessageKey(error, Boolean(snapshot)))}</div>
                    {error.correlationId ? (
                      <div>{t('operationErrors.referenceId', { id: error.correlationId })}</div>
                    ) : null}
                    {error.recoveryActions.length > 0 || (!snapshot && error.kind === 'load') ? (
                      <div className="openbitfun-external-sources-config__recovery-actions">
                        {error.recoveryActions.map((action) => {
                          if (action.type === 'refresh') {
                            return (
                              <Button
                                key={action.type}
                                size="sm"
                                variant="outline"
                                onClick={() => void loadSnapshot(true, true)}
                              >
                                {t(`recoveryActions.${action.type}`)}
                              </Button>
                            );
                          }
                          if (action.type === 'retry') {
                            return (
                              <Button
                                key={action.type}
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  if (error.kind === 'load') {
                                    void loadSnapshot(true, true);
                                  } else {
                                    void lastFailedMutationRef.current?.();
                                  }
                                }}
                              >
                                {t('recoveryActions.retry')}
                              </Button>
                            );
                          }
                          if (action.type === 'exit_safe_mode' && safeModeEnabled) {
                            return (
                              <Button
                                key={action.type}
                                size="sm"
                                variant="outline"
                                onClick={() => void setSafeMode(false)}
                              >
                                {t('recoveryActions.exit_safe_mode')}
                              </Button>
                            );
                          }
                          if (action.type === 'review' || action.type === 'resolve_conflict') {
                            return (
                              <Button
                                key={action.type}
                                size="sm"
                                variant="outline"
                                onClick={() => scrollToFirstAttentionItem()}
                              >
                                {t(`recoveryActions.${action.type}`)}
                              </Button>
                            );
                          }
                          return (
                            <span key={action.type}>{t(`recoveryActions.${action.type}`)}</span>
                          );
                        })}
                        {!snapshot
                          && error.kind === 'load'
                          && !error.recoveryActions.some((action) => (
                            action.type === 'refresh' || action.type === 'retry'
                          )) ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void loadSnapshot(true, true)}
                            >
                              {t('recoveryActions.retry')}
                            </Button>
                          ) : null}
                      </div>
                    ) : null}
                  </>
                )}
              />
            ) : null}
            {snapshot && hostReadOnly ? (
              <div className="openbitfun-external-sources-config__host-mode" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="hostMode" role="status">
                <ShieldCheck size={16} aria-hidden="true" />
                <span>{t(readOnlyHintKey)}</span>
              </div>
            ) : null}
            {control?.recoveryActions.some((action) => action.type === 'reconnect_host') ? (
              <Alert
                className="openbitfun-external-sources-config__notice"
                data-openbitfun-product-component="external-sources-config"
                data-openbitfun-product-part="notice"
                role="status"
                showIcon={false}
                message={(
                  <>
                    <div>{t('legacyHostNotice')}</div>
                    <div>{t('recoveryActions.reconnect_host')}</div>
                  </>
                )}
              />
            ) : null}
            {operationStatus ? (
              <Alert
                className="openbitfun-external-sources-config__notice"
                data-openbitfun-product-component="external-sources-config"
                data-openbitfun-product-part="notice"
                role="status"
                aria-live="polite"
                showIcon={false}
                message={(
                  <>
                    {operationStatus}
                  </>
                )}
              />
            ) : null}
            {safeModeEnabled ? safeModeSection : null}
            {snapshot && !governancePresentation ? (
              <ExternalAppsOverview
                applications={applications}
                t={t}
                busy={busyKey !== null}
                canMutate={policyCompatible && hostCapabilities.canMutatePolicy}
                policiesEnabled={selectedPolicyEnabled}
                onToggle={(application, enabled) => void toggleApplication(application, enabled)}
                onOpenAttention={openAdvancedAttention}
                onOpenPolicy={openAdvancedPolicy}
              />
            ) : null}
            {snapshot ? (
              <details
                className={`openbitfun-external-sources-config__advanced${governancePresentation ? ' is-governance' : ''}`}
                open={governancePresentation || advancedOpen}
                onToggle={governancePresentation
                  ? undefined
                  : (event) => setAdvancedOpen(event.currentTarget.open)}
              >
                {!governancePresentation ? (
                  <summary
                    className="openbitfun-external-sources-config__advanced-summary"
                    aria-expanded={advancedOpen}
                  >
                    <span>{t('applications.advanced.title')}</span>
                    <Icon name="chevron-right" size="md" className="openbitfun-external-sources-config__disclosure-icon" aria-hidden="true" />
                  </summary>
                ) : null}
            {safeModeEnabled === false ? safeModeSection : null}
            {snapshot && policy ? (
              <ConfigPageSection
                className="openbitfun-external-sources-config__policy-card"
                data-openbitfun-product-component="external-sources-config"
                data-openbitfun-product-part="policyCard"
                title={t('policy.title')}
                description={externalAttentionCount > 0 ? (
                  <span data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="policySummary">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-controls="external-integration-attention-region"
                      onClick={() => scrollToFirstAttentionItem()}
                    >
                      {t('policy.attentionSummary', {
                        count: externalAttentionCount,
                      })}
                    </Button>
                  </span>
                ) : undefined}
                extra={(
                  <Switch
                    checked={selectedPolicyEnabled}
                    disabled={!policyCompatible
                      || !hostCapabilities.canMutatePolicy
                      || busyKey === `integration-policy:${policyScope}`}
                    aria-busy={busyKey === `integration-policy:${policyScope}`}
                    aria-label={t('policy.enabledLabel')}
                    onChange={(event) => void updatePolicy({
                      operation: 'set_enabled',
                      enabled: event.currentTarget.checked,
                    })}
                  />
                )}
              >
                {policyIncompatible ? (
                  <div
                    className="openbitfun-external-sources-config__policy-recovery"
                    data-openbitfun-product-component="external-sources-config"
                    data-openbitfun-product-part="policyRecovery"
                    role="alert"
                    data-external-attention="true"
                  >
                    <AlertTriangle size={16} aria-hidden="true" />
                    <span>{t('policy.recoveryRequired')}</span>
                    <Button
                      className="openbitfun-external-sources-config__policy-recovery-action"
                      variant="outline"
                      size="sm"
                      disabled={busyKey !== null || !hostCapabilities.canMutatePolicy}
                      onClick={() => setResetPolicyConfirmation({
                        requestScope,
                        workspaceId: workspace?.id,
                        preferenceRevision: snapshot.preferenceRevision ?? 0,
                      })}
                    >
                      {t('policy.backupAndReset')}
                    </Button>
                  </div>
                ) : null}
                {policyUnknown ? (
                  <div
                    className="openbitfun-external-sources-config__policy-recovery"
                    data-openbitfun-product-component="external-sources-config"
                    data-openbitfun-product-part="policyRecovery"
                    role="alert"
                    data-external-attention="true"
                  >
                    <AlertTriangle size={16} aria-hidden="true" />
                    <span>{t('policy.unknownStatus')}</span>
                  </div>
                ) : null}

                <div className="openbitfun-external-sources-config__scope-bar">
                  <button
                    type="button"
                    className={policyScope === 'user' ? 'is-active' : undefined}
                    aria-pressed={policyScope === 'user'}
                    onClick={() => setPolicyScope('user')}
                  >
                    <Icon name="browser" size="sm" aria-hidden="true" />
                    {t('policy.scope.user')}
                  </button>
                  <Tooltip
                    content={workspacePath
                      ? t('policy.scope.workspaceHint')
                      : t('policy.scope.workspaceUnavailable')}
                    placement="top"
                  >
                    <button
                      type="button"
                      className={policyScope === 'workspace' ? 'is-active' : undefined}
                      aria-pressed={policyScope === 'workspace'}
                      aria-disabled={!workspacePath}
                      aria-describedby={!workspacePath
                        ? 'external-policy-workspace-unavailable'
                        : undefined}
                      onClick={() => {
                        if (workspacePath) setPolicyScope('workspace');
                      }}
                    >
                      <FolderKanban size={14} aria-hidden="true" />
                      {t('policy.scope.workspace')}
                    </button>
                  </Tooltip>
                  {!workspacePath ? (
                    <span id="external-policy-workspace-unavailable" className="sr-only">
                      {t('policy.scope.workspaceUnavailable')}
                    </span>
                  ) : null}
                  {workspacePolicyInherited ? (
                    <span className="openbitfun-external-sources-config__inherited-badge">
                      {t('policy.inherited')}
                    </span>
                  ) : policyScope === 'workspace' ? (
                    <span className="openbitfun-external-sources-config__override-badge">
                      {t('policy.projectOverride')}
                    </span>
                  ) : null}
                  {policyScope === 'workspace' && policy.workspaceOverride ? (
                    <Button
                      className="openbitfun-external-sources-config__scope-reset"
                      variant="outline"
                      size="sm"
                      disabled={busyKey !== null || !policyCompatible
                        || !hostCapabilities.canMutatePolicy}
                      onClick={() => void updatePolicy({ operation: 'reset_workspace' })}
                    >
                      {t('policy.resetWorkspace')}
                    </Button>
                  ) : null}
                </div>

                {ecosystemPolicies.map((ecosystem) => {
                  const isOpencode = ecosystem.descriptor.ecosystemId === 'opencode';
                  if (isOpencode) {
                    return (
                      <React.Fragment key={ecosystem.ecosystemId}>
                        <div
                          className="openbitfun-external-sources-config__opencode-card"
                          data-external-ecosystem={ecosystem.ecosystemId}
                        >
                          <div className="openbitfun-external-sources-config__opencode-summary">
                            <div>
                              <strong>{t('opencode.title')}</strong>
                              <span> · {t('opencode.summary', {
                                agents: opencodeGroups.reduce((sum, g) => sum + g.counts.agents, 0),
                                commands: opencodeGroups.reduce((sum, g) => sum + g.counts.commands, 0),
                                tools: opencodeGroups.reduce((sum, g) => sum + g.counts.tools, 0),
                                mcps: opencodeGroups.reduce((sum, g) => sum + g.counts.mcps, 0),
                              })}</span>
                            </div>
                            <div className="openbitfun-external-sources-config__policy-actions" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="policyActions">
                              <Select
                                className="openbitfun-external-sources-config__policy-select"
                                size="sm"
                                value={selectedPolicyEnabled ? ecosystem.mode : 'disabled'}
                                aria-label={t('policy.modeLabel', {
                                  ecosystem: ecosystem.descriptor.displayName,
                                })}
                                disabled={!policyCompatible || !hostCapabilities.canMutatePolicy
                                  || !selectedPolicyEnabled || busyKey !== null}
                                options={[
                                  { value: 'recommended', label: t('policy.mode.recommended') },
                                  { value: 'discover_only', label: t('policy.mode.discoverOnly') },
                                  { value: 'disabled', label: t('policy.mode.disabled') },
                                  ...(ecosystem.mode === 'custom'
                                    ? [{ value: 'custom', label: t('policy.mode.custom'), disabled: true }]
                                    : []),
                                  ...(!KNOWN_INTEGRATION_MODES.has(ecosystem.mode)
                                    ? [{
                                        value: ecosystem.mode,
                                        label: t('policy.unsupportedSafelyOff'),
                                        disabled: true,
                                      }]
                                    : []),
                                ]}
                                onValueChange={(value) => void updatePolicy({
                                  operation: 'set_ecosystem_mode',
                                  ecosystemId: ecosystem.ecosystemId,
                                  mode: String(Array.isArray(value) ? value[0] : value) as ExternalIntegrationMode,
                                })}
                              />
                              <Tooltip content={t('policy.capabilitiesHint')} placement="top">
                                <IconButton
                                  type="button"
                                  className="openbitfun-external-sources-config__icon-action"
                                  aria-label={t('policy.capabilitiesFor', {
                                    ecosystem: ecosystem.descriptor.displayName,
                                  })}
                                  aria-expanded={expandedEcosystems.has(ecosystem.ecosystemId)}
                                  aria-controls={`external-capabilities-${ecosystem.ecosystemId}`}
                                  onClick={() => setExpandedEcosystems((current) => {
                                    const next = new Set(current);
                                    if (next.has(ecosystem.ecosystemId)) next.delete(ecosystem.ecosystemId);
                                    else next.add(ecosystem.ecosystemId);
                                    return next;
                                  })}
                                  icon={<Icon name="settings" size="md" aria-hidden="true" />}
                                />
                              </Tooltip>
                            </div>
                          </div>
                          {opencodeGroups.length > 0 ? (
                            <div className="openbitfun-external-sources-config__opencode-locations">
                              {opencodeGroups.map((group) => (
                                <div key={group.key}>
                                  <span>{renderPathLink(
                                    group.location,
                                    group.members[0]?.stableKey,
                                  )}</span>
                                  <span>
                                    {group.scopes.map((scope) => sourceScopeLabel(scope, t)).join(' + ')}
                                  </span>
                                  {renderSourceMembers(group)}
                                  {group.diagnostics.length > 0 ? (
                                    <Disclosure
                                      presentation="native"
                                      className="openbitfun-external-sources-config__notice"
                                      data-openbitfun-product-component="external-sources-config"
                                      data-openbitfun-product-part="notice"
                                      data-external-attention="true"
                                      data-external-ecosystem={group.ecosystemId}
                                      summary={t('diagnostics.sourceSummary', {
                                        name: group.displayName,
                                        count: group.diagnostics.length,
                                      })}
                                    >
                                      <ul className="openbitfun-external-sources-config__diagnostics" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="diagnostics">
                                        {group.diagnostics.map((diagnostic) => (
                                            <li key={externalSourceDiagnosticKey(diagnostic)}>
                                              <span>{t(`diagnostics.category.${sourceDiagnosticCategory(diagnostic.code)}`)}</span>
                                            </li>
                                        ))}
                                      </ul>
                                    </Disclosure>
                                  ) : null}
                                </div>
                              ))}
                            </div>
                          ) : null}
                          {expandedEcosystems.has(ecosystem.ecosystemId) ? (
                            <div
                              id={`external-capabilities-${ecosystem.ecosystemId}`}
                              className="openbitfun-external-sources-config__capability-grid"
                            >
                              {ecosystem.descriptor.capabilities.map((capabilityDescriptor) => {
                                const capabilityId = capabilityDescriptor.capabilityId;
                                const limited = ecosystem.effective?.policyLimitedCapabilities
                                  ?.includes(capabilityId);
                                const configuredAccess = ecosystem.capabilityOverrides[capabilityId];
                                const accessKnown = configuredAccess === undefined
                                  || KNOWN_INTEGRATION_ACCESS.has(configuredAccess);
                                const countKey = capabilityId === 'subagent' ? 'agents'
                                  : capabilityId === 'command' ? 'commands'
                                  : capabilityId === 'mcp' ? 'mcps'
                                  : capabilityId === 'tool' ? 'tools'
                                  : capabilityId;
                                const count = opencodeGroups.reduce(
                                  (sum, g) => sum + (g.counts[countKey as keyof typeof g.counts] ?? 0),
                                  0,
                                );
                                const riskKey = `opencode.capability.${capabilityId}.risk`;
                                const riskText = t(riskKey);
                                return (
                                  <div
                                    className="openbitfun-external-sources-config__capability-row"
                                    key={capabilityId}
                                  >
                                    <div>
                                      <span>{t(`policy.capability.${capabilityId}`)}</span>
                                      {limited ? (
                                        <span className="openbitfun-external-sources-config__limited-badge">
                                          {t('policy.safetyLimited')}
                                        </span>
                                      ) : null}
                                      <span className="openbitfun-external-sources-config__candidate-detail">
                                        {t(`opencode.capability.${capabilityId}.description`, {
                                          count,
                                          scope: opencodeScopeLabel,
                                        })}
                                      </span>
                                      <span className="openbitfun-external-sources-config__candidate-detail">
                                        {t(`opencode.capability.${capabilityId}.effect`)}
                                      </span>
                                      {riskText && riskText !== riskKey ? (
                                        <span className="openbitfun-external-sources-config__tool-warning" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="toolWarning">
                                          {riskText}
                                        </span>
                                      ) : null}
                                    </div>
                                    <Select
                                      className="openbitfun-external-sources-config__policy-select"
                                      size="sm"
                                      value={accessKnown
                                        ? selectedCapabilityAccess(ecosystem, capabilityId)
                                        : configuredAccess}
                                      aria-label={t('policy.capabilityAccessLabel', {
                                        ecosystem: ecosystem.descriptor.displayName,
                                        capability: t(`policy.capability.${capabilityId}`),
                                      })}
                                      disabled={!policyCompatible || !hostCapabilities.canMutatePolicy
                                        || !selectedPolicyEnabled || busyKey !== null}
                                      options={[
                                        { value: 'disabled', label: t('policy.access.disabled') },
                                        { value: 'discover_only', label: t('policy.access.discoverOnly') },
                                        { value: 'ask_before_use', label: t('policy.access.askBeforeUse') },
                                        ...(capabilityDescriptor.safetyCeiling === 'auto'
                                          ? [{ value: 'auto', label: t('policy.access.auto') }]
                                          : []),
                                        ...(!accessKnown && configuredAccess
                                          ? [{
                                              value: configuredAccess,
                                              label: t('policy.unsupportedSafelyOff'),
                                              disabled: true,
                                            }]
                                          : []),
                                      ]}
                                      onValueChange={(value) => {
                                        const access = String(
                                          Array.isArray(value) ? value[0] : value,
                                        ) as ExternalIntegrationAccess;
                                        void updateCapabilityAccess(
                                          ecosystem.ecosystemId,
                                          capabilityId,
                                          access,
                                        );
                                      }}
                                    />
                                  </div>
                                );
                              })}
                              {opencodeGroups.length > 0 ? (
                                <div className="openbitfun-external-sources-config__opencode-locations">
                                  <span>{t('opencode.configLocations')}</span>
                                  {opencodeGroups.map((group) => (
                                    <span key={group.key}>{renderPathLink(
                                      group.location,
                                      group.members[0]?.stableKey,
                                    )}</span>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      </React.Fragment>
                    );
                  }
                  return (
                  <React.Fragment key={ecosystem.ecosystemId}>
                <div
                  className="openbitfun-external-sources-config__ecosystem-card"
                  data-openbitfun-product-component="external-sources-config"
                  data-openbitfun-product-part="ecosystemCard"
                  data-external-ecosystem={ecosystem.ecosystemId}
                >
                  <div className="openbitfun-external-sources-config__ecosystem-heading" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="ecosystemHeading">
                    <div>
                      <div className="openbitfun-external-sources-config__ecosystem-name" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="ecosystemName">
                        {ecosystem.descriptor.displayName}
                        <span className={`openbitfun-external-sources-config__ecosystem-state is-${ecosystem.state}`} data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="ecosystemState">
                          {ecosystem.state === 'checking' ? <CircleDashed size={13} aria-hidden="true" /> : null}
                          {ecosystem.state === 'attention' ? <AlertTriangle size={13} aria-hidden="true" /> : null}
                          {ecosystem.state === 'ready' ? <Icon name="check-circle" size="xs" aria-hidden="true" /> : null}
                          {ecosystem.state === 'noConfig' ? <MinusCircle size={13} aria-hidden="true" /> : null}
                          {t(`policy.state.${ecosystem.state}`)}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="openbitfun-external-sources-config__policy-actions" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="policyActions">
                    <Select
                      className="openbitfun-external-sources-config__policy-select"
                      size="sm"
                      value={selectedPolicyEnabled ? ecosystem.mode : 'disabled'}
                      aria-label={t('policy.modeLabel', {
                        ecosystem: ecosystem.descriptor.displayName,
                      })}
                      disabled={!policyCompatible || !hostCapabilities.canMutatePolicy
                        || !selectedPolicyEnabled || busyKey !== null}
                      options={[
                        { value: 'recommended', label: t('policy.mode.recommended') },
                        { value: 'discover_only', label: t('policy.mode.discoverOnly') },
                        { value: 'disabled', label: t('policy.mode.disabled') },
                        ...(ecosystem.mode === 'custom'
                          ? [{ value: 'custom', label: t('policy.mode.custom'), disabled: true }]
                          : []),
                        ...(!KNOWN_INTEGRATION_MODES.has(ecosystem.mode)
                          ? [{
                              value: ecosystem.mode,
                              label: t('policy.unsupportedSafelyOff'),
                              disabled: true,
                            }]
                          : []),
                      ]}
                      onValueChange={(value) => void updatePolicy({
                        operation: 'set_ecosystem_mode',
                        ecosystemId: ecosystem.ecosystemId,
                        mode: String(Array.isArray(value) ? value[0] : value) as ExternalIntegrationMode,
                      })}
                    />
                    <Tooltip content={t('policy.capabilitiesHint')} placement="top">
                      <IconButton
                        type="button"
                        className="openbitfun-external-sources-config__icon-action"
                        aria-label={t('policy.capabilitiesFor', {
                          ecosystem: ecosystem.descriptor.displayName,
                        })}
                        aria-expanded={expandedEcosystems.has(ecosystem.ecosystemId)}
                        aria-controls={`external-capabilities-${ecosystem.ecosystemId}`}
                        onClick={() => setExpandedEcosystems((current) => {
                          const next = new Set(current);
                          if (next.has(ecosystem.ecosystemId)) next.delete(ecosystem.ecosystemId);
                          else next.add(ecosystem.ecosystemId);
                          return next;
                        })}
                        icon={<Icon name="settings" size="md" aria-hidden="true" />}
                      />
                    </Tooltip>
                  </div>
                </div>

                {expandedEcosystems.has(ecosystem.ecosystemId) ? (
                  <div
                    id={`external-capabilities-${ecosystem.ecosystemId}`}
                    className="openbitfun-external-sources-config__capability-grid"
                  >
                    {ecosystem.descriptor.capabilities.map((capabilityDescriptor) => {
                      const capabilityId = capabilityDescriptor.capabilityId;
                      const limited = ecosystem.effective?.policyLimitedCapabilities
                        ?.includes(capabilityId);
                      const configuredAccess = ecosystem.capabilityOverrides[capabilityId];
                      const accessKnown = configuredAccess === undefined
                        || KNOWN_INTEGRATION_ACCESS.has(configuredAccess);
                      return (
                        <div
                          className="openbitfun-external-sources-config__capability-row"
                          key={capabilityId}
                        >
                          <div>
                            <span>{t(`policy.capability.${capabilityId}`)}</span>
                            {limited ? (
                              <span className="openbitfun-external-sources-config__limited-badge">
                                {t('policy.safetyLimited')}
                              </span>
                            ) : null}
                          </div>
                          <Select
                            className="openbitfun-external-sources-config__policy-select"
                            size="sm"
                            value={accessKnown
                              ? selectedCapabilityAccess(ecosystem, capabilityId)
                              : configuredAccess}
                            aria-label={t('policy.capabilityAccessLabel', {
                              ecosystem: ecosystem.descriptor.displayName,
                              capability: t(`policy.capability.${capabilityId}`),
                            })}
                            disabled={!policyCompatible || !hostCapabilities.canMutatePolicy
                              || !selectedPolicyEnabled || busyKey !== null}
                            options={[
                              { value: 'disabled', label: t('policy.access.disabled') },
                              { value: 'discover_only', label: t('policy.access.discoverOnly') },
                              { value: 'ask_before_use', label: t('policy.access.askBeforeUse') },
                              ...(capabilityDescriptor.safetyCeiling === 'auto'
                                ? [{ value: 'auto', label: t('policy.access.auto') }]
                                : []),
                              ...(!accessKnown && configuredAccess
                                ? [{
                                    value: configuredAccess,
                                    label: t('policy.unsupportedSafelyOff'),
                                    disabled: true,
                                  }]
                                : []),
                            ]}
                            onValueChange={(value) => {
                              const access = String(
                                Array.isArray(value) ? value[0] : value,
                              ) as ExternalIntegrationAccess;
                              void updateCapabilityAccess(
                                ecosystem.ecosystemId,
                                capabilityId,
                                access,
                              );
                            }}
                          />
                        </div>
                      );
                    })}
                  </div>
                ) : null}
                  </React.Fragment>
                  );
                })}
              </ConfigPageSection>
            ) : null}
            {agentChangeNotice ? (
              <Alert
                className="openbitfun-external-sources-config__notice"
                data-openbitfun-product-component="external-sources-config"
                data-openbitfun-product-part="notice"
                role="status"
                aria-live="polite"
                showIcon={false}
                message={(
                  <>
                    {agentChangeNotice.message}
                  </>
                )}
              />
            ) : null}
            {catalogDiagnostics.length > 0 ? (
              <Disclosure
                presentation="native"
                className="openbitfun-external-sources-config__notice"
                data-openbitfun-product-component="external-sources-config"
                data-openbitfun-product-part="notice"
                data-external-attention={catalogDiagnostics
                  .some((diagnostic) => diagnostic.severity !== 'info') ? 'true' : undefined}
                summary={t('diagnostics.summary', { count: catalogDiagnostics.length })}
              >
                <ul className="openbitfun-external-sources-config__diagnostics" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="diagnostics">
                  {catalogDiagnostics.map((diagnostic) => (
                    <li key={externalSourceDiagnosticKey(diagnostic)}>
                      <span>{t(`diagnostics.category.${sourceDiagnosticCategory(diagnostic.code)}`)}</span>
                    </li>
                  ))}
                </ul>
              </Disclosure>
            ) : null}
            {snapshot?.discoveryPending ? (
              <Alert
                className="openbitfun-external-sources-config__notice"
                data-openbitfun-product-component="external-sources-config"
                data-openbitfun-product-part="notice"
                role="status"
                showIcon={false}
                message={(
                  <>
                    {t('checkingNonBlocking')}
                  </>
                )}
              />
            ) : null}

            {(snapshot?.mcpApprovalRequests?.length ?? 0) > 0 ? (
              <ConfigPageSection
                title={t('mcpApprovals.title')}
              >
                {snapshot?.mcpApprovalRequests?.map((request) => {
                  const source = snapshot.sources.find((candidate) => (
                    candidate.record.key.providerId === request.definition.id.source.providerId
                    && candidate.record.key.sourceId === request.definition.id.source.sourceId
                  ));
                  const reviewRiskId = `mcp-review-risk-${encodeURIComponent(request.decisionKey)}`;
                  return (
                    <div
                      className="openbitfun-external-sources-config__tool-card"
                      data-openbitfun-product-component="external-sources-config"
                      data-openbitfun-product-part="toolCard"
                      data-external-attention="true"
                      data-external-ecosystem={source?.record.ecosystemId}
                      key={request.decisionKey}
                    >
                    <div className="openbitfun-external-sources-config__conflict-title" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="toolTitle">
                      {request.definition.name}
                    </div>
                    <div className="openbitfun-external-sources-config__tool-detail" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="toolDetail">
                      <span>{t('mcp.source', {
                        source: source?.record.displayName ?? t('mcp.externalSource'),
                      })}</span>
                      <span>{t(`mcp.transport.${request.definition.transport}`)}</span>
                      {request.definition.commandPreview ? (
                        <span>{t('mcp.command', { command: request.definition.commandPreview })}</span>
                      ) : null}
                      {request.definition.remoteUrlPreview ? (
                        <span>{t('mcp.url', { url: request.definition.remoteUrlPreview })}</span>
                      ) : null}
                      <span>{t('mcp.argumentCount', {
                        count: request.definition.argumentCount,
                      })}</span>
                      {request.definition.workingDirectory ? (
                        <span>{t('mcp.workingDirectory', {
                          location: request.definition.workingDirectory,
                        })}</span>
                      ) : null}
                      <McpTimeoutSummary definition={request.definition} t={t} />
                      {(request.definition.environmentKeys?.length ?? 0) > 0 ? (
                        <span>{t('mcp.environmentNames', {
                          names: request.definition.environmentKeys.join(', '),
                        })}</span>
                      ) : null}
                      {(request.definition.environmentReferenceNames?.length ?? 0) > 0 ? (
                        <span>{t('mcp.environmentReads', {
                          names: (request.definition.environmentReferenceNames ?? []).join(', '),
                        })}</span>
                      ) : null}
                      {(request.definition.headerNames?.length ?? 0) > 0 ? (
                        <span>{t('mcp.headerNames', {
                          names: request.definition.headerNames.join(', '),
                        })}</span>
                      ) : null}
                    </div>
                    <div
                      id={reviewRiskId}
                      className="openbitfun-external-sources-config__tool-warning"
                      data-openbitfun-product-component="external-sources-config"
                      data-openbitfun-product-part="toolWarning"
                    >
                      {t('mcpApprovals.warning')}
                    </div>
                    <div className="openbitfun-external-sources-config__tool-actions" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="toolActions">
                      <Button
                        variant="fill"
                        size="sm"
                        disabled={!policyCompatible || busyKey !== null
                          || !hostCapabilities.canApproveRuntime}
                        onClick={() => void decideMcpServer(
                          request.candidateId,
                          request.decisionKey,
                          false,
                        )}
                      >
                        {t('mcpApprovals.keepDisabled')}
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        aria-describedby={reviewRiskId}
                        disabled={!policyCompatible || busyKey !== null
                          || !hostCapabilities.canApproveRuntime}
                        onClick={() => void decideMcpServer(
                          request.candidateId,
                          request.decisionKey,
                          true,
                        )}
                      >
                        {t('mcpApprovals.enable')}
                      </Button>
                    </div>
                    </div>
                  );
                })}
              </ConfigPageSection>
            ) : null}

            {(snapshot?.mcpServers?.length ?? 0) > 0 ? (
              <ConfigPageSection
                title={t('mcp.title')}
                extra={(
                  <div className="openbitfun-external-sources-config__tool-actions" data-openbitfun-bulk-capability="mcp">
                    {(snapshot?.mcpApprovalRequests?.length ?? 0) > 0 ? (
                      <Button variant="primary" size="sm" aria-describedby="external-mcp-bulk-risk" disabled={!policyCompatible || busyKey !== null || !hostCapabilities.canApproveRuntime} onClick={() => void setMcpServersEnabled(true)}>
                        {t('bulkActions.enablePending', { count: snapshot?.mcpApprovalRequests?.length ?? 0 })}
                      </Button>
                    ) : null}
                    <Button variant="outline" size="sm" disabled={!policyCompatible || busyKey !== null || !hostCapabilities.canApproveRuntime} onClick={() => void setMcpServersEnabled(false)}>
                      {t('bulkActions.disableAll')}
                    </Button>
                  </div>
                )}
              >
                {(snapshot?.mcpApprovalRequests?.length ?? 0) > 0 ? (
                  <div id="external-mcp-bulk-risk" className="openbitfun-external-sources-config__tool-warning">
                    {t('bulkActions.enableRisk', { count: snapshot?.mcpApprovalRequests?.length ?? 0 })}
                  </div>
                ) : null}
                {snapshot?.mcpServers?.map((server) => {
                  const state = server.activationState.state;
                  const reviewing = reviewingMcpKey === server.candidateId;
                  const canEnable = state === 'declined' || state === 'configuration_changed';
                  const canDisable = ['starting', 'active', 'runtime_unavailable'].includes(state);
                  const runtimeFailureReason = state === 'runtime_unavailable'
                    && 'reason' in server.activationState
                    ? localizedMcpFailureReason(server.activationState.reason, t)
                    : undefined;
                  const source = snapshot.sources.find((candidate) => (
                    candidate.record.key.providerId === server.definition.id.source.providerId
                    && candidate.record.key.sourceId === server.definition.id.source.sourceId
                  ));
                  return (
                    <React.Fragment key={server.candidateId}>
                      <ConfigPageRow
                        label={server.definition.name}
                        description={[
                          t(`mcp.transport.${server.definition.transport}`),
                          t('mcp.externalSource'),
                          runtimeFailureReason,
                        ].filter(Boolean).join(' · ')}
                        align="center"
                      >
                        <div className="openbitfun-external-sources-config__source-control" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="sourceControl">
                          <span
                            className={`openbitfun-external-sources-config__state is-${state}`}
                            data-openbitfun-product-component="external-sources-config"
                            data-openbitfun-product-part="state"
                            data-external-attention={state === 'approval_required' ? 'true' : undefined}
                            data-external-ecosystem={state === 'approval_required'
                              ? source?.record.ecosystemId
                              : undefined}
                          >
                            {t(`mcpState.${state}`)}
                          </span>
                          <Button
                            variant="outline"
                            size="sm"
                            aria-expanded={reviewing}
                            onClick={() => setReviewingMcpKey(reviewing ? null : server.candidateId)}
                          >
                            {reviewing ? t('common.hideDetails') : t('common.details')}
                          </Button>
                          {canDisable ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={!policyCompatible || busyKey !== null
                                || !hostCapabilities.canApproveRuntime}
                              onClick={() => void decideMcpServer(
                                server.candidateId,
                                server.decisionKey,
                                false,
                              )}
                            >
                              {t('mcp.disable')}
                            </Button>
                          ) : null}
                        </div>
                      </ConfigPageRow>
                      {reviewing ? (
                        <div className="openbitfun-external-sources-config__tool-card" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="toolCard">
                          <div className="openbitfun-external-sources-config__tool-detail" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="toolDetail">
                            <span>{t('mcp.source', {
                              source: source?.record.displayName ?? t('mcp.externalSource'),
                            })}</span>
                            {source ? (
                              <>
                                <span>{t('mcp.sourceLocationLabel')}: {renderPathLink(
                                  source.record.location,
                                  source.stableKey,
                                )}</span>
                                <span>{t('mcp.scope', {
                                  scope: sourceScopeLabel(source.record.scope, t),
                                })}</span>
                              </>
                            ) : null}
                            {server.definition.commandPreview ? (
                              <span>{t('mcp.command', { command: server.definition.commandPreview })}</span>
                            ) : null}
                            {server.definition.remoteUrlPreview ? (
                              <span>{t('mcp.url', { url: server.definition.remoteUrlPreview })}</span>
                            ) : null}
                            {server.definition.workingDirectory ? (
                              <span>{t('mcp.workingDirectory', {
                                location: server.definition.workingDirectory,
                              })}</span>
                            ) : null}
                            <McpTimeoutSummary definition={server.definition} t={t} />
                            <span>{t('mcp.argumentCount', {
                              count: server.definition.argumentCount,
                            })}</span>
                            {(server.definition.environmentReferenceNames?.length ?? 0) > 0 ? (
                              <span>{t('mcp.environmentReads', {
                                names: (server.definition.environmentReferenceNames ?? []).join(', '),
                              })}</span>
                            ) : null}
                            {'reason' in server.activationState ? (
                              <>
                                <span>{t('mcp.failureReason', {
                                  reason: localizedMcpFailureReason(
                                    server.activationState.reason,
                                    t,
                                  ),
                                })}</span>
                                <span>{t(server.activationState.state === 'runtime_unavailable'
                                  ? 'mcp.runtimeUnavailableGuidance'
                                  : 'mcp.unsupportedGuidance')}</span>
                              </>
                            ) : null}
                            <span>{t('mcp.changePolicy')}</span>
                          </div>
                          {canEnable ? (
                            <div className="openbitfun-external-sources-config__tool-actions" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="toolActions">
                              <Button
                                variant="primary"
                                size="sm"
                                disabled={!policyCompatible || busyKey !== null
                                  || !hostCapabilities.canApproveRuntime}
                                onClick={() => void decideMcpServer(
                                  server.candidateId,
                                  server.decisionKey,
                                  true,
                                )}
                              >
                                {t('mcp.enable')}
                              </Button>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </React.Fragment>
                  );
                })}
              </ConfigPageSection>
            ) : null}

            {mcpConflicts.length > 0 ? (
              <ConfigPageSection
                title={t('mcpConflicts.title')}
              >
                {mcpConflicts.map((conflict) => (
                  <div
                    className="openbitfun-external-sources-config__conflict"
                    data-openbitfun-product-component="external-sources-config"
                    data-openbitfun-product-part="conflict"
                    key={conflict.conflictKey}
                    data-external-attention={!conflict.selectedCandidateId ? 'true' : undefined}
                    data-external-ecosystem={onlyEcosystemId(
                      conflict.candidates.map((candidate) => (
                        sourceEcosystemId(snapshot, candidate.source)
                      )),
                    )}
                  >
                    <div className="openbitfun-external-sources-config__conflict-title" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="conflictTitle">
                      {t('mcpConflicts.serverName', { name: conflict.serverName })}
                    </div>
                    <div className="openbitfun-external-sources-config__conflict-options" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="conflictOptions">
                      {conflict.candidates.map((candidate) => {
                        const selected = conflict.selectedCandidateId === candidate.candidateId;
                        const externalServer = candidate.external
                          ? snapshot?.mcpServers?.find((server) => (
                            server.candidateId === candidate.candidateId
                          ))
                          : undefined;
                        const externalSource = externalServer
                          ? snapshot?.sources?.find((source) => (
                            source.record.key.providerId
                              === externalServer.definition.id.source.providerId
                            && source.record.key.sourceId
                              === externalServer.definition.id.source.sourceId
                          ))
                          : undefined;
                        const conflictReviewKey = `${conflict.conflictKey}:${candidate.candidateId}`;
                        const reviewingExternal = reviewingMcpConflictKey === conflictReviewKey;
                        const detailId = `mcp-conflict-detail-${candidate.candidateId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
                        return (
                          <div className="openbitfun-external-sources-config__candidate" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="candidate" key={candidate.candidateId}>
                            <Button
                              variant={selected ? 'fill' : 'outline'}
                              size="sm"
                              disabled={!policyCompatible || busyKey !== null || !candidate.available
                                || !hostCapabilities.canApproveRuntime}
                              aria-pressed={selected}
                              aria-expanded={candidate.external ? reviewingExternal : undefined}
                              aria-controls={candidate.external ? detailId : undefined}
                              onClick={() => {
                                if (candidate.external) {
                                  setReviewingMcpConflictKey(
                                    reviewingExternal ? null : conflictReviewKey,
                                  );
                                } else {
                                  void chooseMcpConflict(
                                    conflict.conflictKey,
                                    candidate.candidateId,
                                    false,
                                  );
                                }
                              }}
                            >
                              {candidate.external
                                ? reviewingExternal
                                  ? t('common.hideDetails')
                                  : t('mcpConflicts.review', { name: candidate.displayName })
                                : candidate.displayName}
                            </Button>
                            <span className="openbitfun-external-sources-config__candidate-state" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="candidateState">
                              {!candidate.available
                                ? t(candidate.external
                                  ? 'mcpConflicts.unavailable'
                                  : 'mcpConflicts.nativeDisabled')
                                : selected
                                  ? t('common.selected')
                                  : t('common.availableChoice')}
                            </span>
                            {!candidate.available && candidate.unavailableReason ? (
                              <span className="openbitfun-external-sources-config__candidate-state" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="candidateState">
                                {candidate.unavailableReason}
                              </span>
                            ) : null}
                            {externalServer && (reviewingExternal || selected) ? (
                              <div
                                className="openbitfun-external-sources-config__tool-detail"
                                data-openbitfun-product-component="external-sources-config"
                                data-openbitfun-product-part="candidateDetail"
                                id={detailId}
                              >
                                <span>{t('mcp.source', {
                                  source: externalSource?.record.displayName
                                    ?? t('mcp.externalSource'),
                                })}</span>
                                {externalSource ? (
                                  <>
                                    <span>{t('mcp.sourceLocation', {
                                      location: externalSource.record.location,
                                    })}</span>
                                    <span>{t('mcp.scope', {
                                      scope: sourceScopeLabel(externalSource.record.scope, t),
                                    })}</span>
                                  </>
                                ) : null}
                                <span>{t(`mcp.transport.${externalServer.definition.transport}`)}</span>
                                {externalServer.definition.commandPreview ? (
                                  <span>{t('mcp.command', {
                                    command: externalServer.definition.commandPreview,
                                  })}</span>
                                ) : null}
                                {externalServer.definition.remoteUrlPreview ? (
                                  <span>{t('mcp.url', {
                                    url: externalServer.definition.remoteUrlPreview,
                                  })}</span>
                                ) : null}
                                <span>{t('mcp.argumentCount', {
                                  count: externalServer.definition.argumentCount,
                                })}</span>
                                {externalServer.definition.workingDirectory ? (
                                  <span>{t('mcp.workingDirectory', {
                                    location: externalServer.definition.workingDirectory,
                                  })}</span>
                                ) : null}
                                <McpTimeoutSummary definition={externalServer.definition} t={t} />
                                {(externalServer.definition.environmentKeys?.length ?? 0) > 0 ? (
                                  <span>{t('mcp.environmentNames', {
                                    names: externalServer.definition.environmentKeys.join(', '),
                                  })}</span>
                                ) : null}
                                {(externalServer.definition.environmentReferenceNames?.length ?? 0) > 0 ? (
                                  <span>{t('mcp.environmentReads', {
                                    names: (externalServer.definition.environmentReferenceNames ?? []).join(', '),
                                  })}</span>
                                ) : null}
                                {(externalServer.definition.headerNames?.length ?? 0) > 0 ? (
                                  <span>{t('mcp.headerNames', {
                                    names: externalServer.definition.headerNames.join(', '),
                                  })}</span>
                                ) : null}
                                <span className="openbitfun-external-sources-config__tool-warning" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="toolWarning">
                                  {t('mcpApprovals.warning')}
                                </span>
                                {reviewingExternal && !selected && candidate.available ? (
                                  <div className="openbitfun-external-sources-config__tool-actions" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="toolActions">
                                    <Button
                                      variant="primary"
                                      size="sm"
                                      disabled={!policyCompatible || busyKey !== null
                                        || !hostCapabilities.canApproveRuntime}
                                      aria-describedby={detailId}
                                      onClick={() => void chooseMcpConflict(
                                        conflict.conflictKey,
                                        candidate.candidateId,
                                        true,
                                      ).then((accepted) => {
                                        if (accepted) setReviewingMcpConflictKey(null);
                                      })}
                                    >
                                      {t('mcpConflicts.approveAndUse', {
                                        name: candidate.displayName,
                                      })}
                                    </Button>
                                  </div>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                    <div className="openbitfun-external-sources-config__conflict-hint" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="conflictHint">
                      {conflict.selectedCandidateId
                        ? t('mcpConflicts.currentSelection')
                        : t('mcpConflicts.pending')}
                    </div>
                  </div>
                ))}
              </ConfigPageSection>
            ) : null}

            {snapshot && (snapshot.mcpServers?.length ?? 0) === 0
              && (snapshot?.mcpApprovalRequests?.length ?? 0) === 0
              && mcpConflicts.length === 0
              && !snapshot?.discoveryPending ? (
              <ConfigPageSection title={t('mcp.title')}>
                <div className="openbitfun-external-sources-config__mcp-empty" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="empty">
                  <span>{t('mcp.empty')}</span>
                  <span>{t('mcp.emptyGuidance')}</span>
                  <span>· {t('mcp.emptyLocation.userGlobal')}</span>
                  <span>· {t('mcp.emptyLocation.project')}</span>
                  <span>· {t('mcp.emptyLocation.envConfig')}</span>
                </div>
              </ConfigPageSection>
            ) : null}

            {(snapshot?.subagentModelBindingGroups?.length ?? 0) > 0 ? (
              <ConfigPageSection title={t('agentModelBindings.title')}>
                {snapshot?.subagentModelBindingGroups?.map((group) => {
                  const targetOptions = snapshot.subagentModelBindingOptions ?? [];
                  const targetsByKey = new Map(targetOptions.map((option) => [
                    externalAgentBindingTargetKey(option.target),
                    option.target,
                  ]));
                  const selectedKey = group.selectedTarget
                    ? externalAgentBindingTargetKey(group.selectedTarget)
                    : 'source';
                  const selectedUnavailable = group.selectedTarget
                    && !targetsByKey.has(selectedKey);
                  const canEdit = group.method === 'binding_required'
                    || group.method === 'explicit'
                    || group.method === 'binding_unavailable';
                  const effective = externalAgentModelLabel(group.effectiveModelLabel, t);
                  const requestedProfile = externalAgentRequestedProfileLabel(
                    group.profileRequest,
                    t,
                  );
                  return (
                    <ConfigPageRow
                      key={group.bindingKey}
                      label={externalAgentRequestedModelLabel(group.request, t)}
                      description={[
                        t('agentModelBindings.affectedAgents', {
                          count: group.affectedCandidateIds.length,
                        }),
                        requestedProfile,
                        t(`agentModelBindings.method.${group.method}`),
                        t('agentModelBindings.effectiveModel', { model: effective }),
                      ].filter(Boolean).join(' · ')}
                      align="center"
                    >
                      {canEdit ? (
                        <Combobox
                          size="sm"
                          value={selectedKey}
                          aria-label={t('agentModelBindings.selectLabel', {
                            request: externalAgentRequestedModelLabel(group.request, t),
                          })}
                          disabled={!policyCompatible || busyKey !== null
                            || !hostCapabilities.canApproveRuntime}
                          options={[
                            {
                              value: 'source',
                              label: t(group.profileRequest
                                ? 'agentModelBindings.target.unbound'
                                : 'agentModelBindings.target.source'),
                            },
                            ...targetOptions.map((option) => ({
                              value: externalAgentBindingTargetKey(option.target),
                              label: option.effectiveModelLabel,
                              description: [
                                t(`agentModelBindings.target.${option.target.kind}`),
                                option.configuredReasoningEffort
                                  ? t('agentModelBindings.configuredEffort', {
                                      value: option.configuredReasoningEffort,
                                    })
                                  : undefined,
                              ].filter(Boolean).join(' · '),
                            })),
                            ...(selectedUnavailable && group.selectedTarget ? [{
                              value: selectedKey,
                              label: t('agentModelBindings.targetUnavailable', {
                                target: externalAgentBindingTargetFallbackLabel(
                                  group.selectedTarget,
                                  t,
                                ),
                              }),
                              disabled: true,
                            }] : []),
                          ]}
                          onValueChange={(value) => {
                            const nextKey = String(Array.isArray(value) ? value[0] : value);
                            if (nextKey === 'source') {
                              void setAgentModelBinding(group, undefined);
                              return;
                            }
                            const target = targetsByKey.get(nextKey);
                            if (target) void setAgentModelBinding(group, target);
                          }}
                        />
                      ) : (
                        <span className="openbitfun-external-sources-config__state is-active">
                          {t('agentModelBindings.automatic')}
                        </span>
                      )}
                    </ConfigPageRow>
                  );
                })}
              </ConfigPageSection>
            ) : null}

            {(snapshot?.subagents?.length ?? 0) > 0 ? (
              <ConfigPageSection
                title={t('agents.title')}
                extra={(
                  <div className="openbitfun-external-sources-config__tool-actions" data-openbitfun-bulk-capability="subagent">
                    {(snapshot?.pendingSubagentApprovals?.length ?? 0) > 0 ? (
                      <Button variant="primary" size="sm" aria-describedby="external-subagent-bulk-risk" disabled={!policyCompatible || busyKey !== null || !hostCapabilities.canApproveRuntime} onClick={() => void setSubagentsEnabled(true)}>
                        {t('bulkActions.enablePending', { count: snapshot?.pendingSubagentApprovals?.length ?? 0 })}
                      </Button>
                    ) : null}
                    <Button variant="outline" size="sm" disabled={!policyCompatible || busyKey !== null || !hostCapabilities.canApproveRuntime} onClick={() => void setSubagentsEnabled(false)}>
                      {t('bulkActions.disableAll')}
                    </Button>
                  </div>
                )}
              >
                {(snapshot?.pendingSubagentApprovals?.length ?? 0) > 0 ? (
                  <div id="external-subagent-bulk-risk" className="openbitfun-external-sources-config__tool-warning">
                    {t('bulkActions.enableRisk', { count: snapshot?.pendingSubagentApprovals?.length ?? 0 })}
                  </div>
                ) : null}
                {snapshot?.subagents?.map((agent) => {
                  const reviewing = reviewingAgentKey === agent.candidateId;
                  const state = agent.activationState.state;
                  const canEnable = state === 'approval_required' || state === 'declined';
                  const canDisable = state === 'active';
                  const matchingSources = Array.from(new Map(
                    snapshot.sources
                      .filter((source) => agent.sourceKeys.some((key) => (
                        key.providerId === source.record.key.providerId
                        && key.sourceId === source.record.key.sourceId
                      )))
                      .map((source) => [source.stableKey, source]),
                  ).values());
                  const sourceLocations = matchingSources.length > 0
                    ? matchingSources.map((source) => ({
                        key: source.stableKey,
                        label: source.record.location,
                        stableKey: source.stableKey,
                      }))
                    : agent.sourceLocationLabels.map((label, index) => ({
                        key: `${index}:${label}`,
                        label,
                        stableKey: undefined,
                      }));
                  return (
                    <React.Fragment key={agent.candidateId}>
                      <ConfigPageRow
                        label={agent.displayName}
                        description={`${agent.providerLabel} · ${agent.logicalId} · ${externalAgentEffectiveModelLabel(agent.effectiveModelLabel, agent.modelBindingMethod, t)} · ${t(`agents.role.${agent.mode ?? 'subagent'}`)}`}
                        align="center"
                      >
                        <div className="openbitfun-external-sources-config__source-control" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="sourceControl">
                          <span
                            className={`openbitfun-external-sources-config__state is-${state}`}
                            data-openbitfun-product-component="external-sources-config"
                            data-openbitfun-product-part="state"
                            data-external-attention={state === 'approval_required' ? 'true' : undefined}
                            data-external-ecosystem={state === 'approval_required'
                              ? agent.sourceKeys
                                  .map((key) => snapshot.sources.find((source) => (
                                    key.providerId === source.record.key.providerId
                                    && key.sourceId === source.record.key.sourceId
                                  ))?.record.ecosystemId)
                                  .find(Boolean)
                              : undefined}
                          >
                            {t(`agentState.${state}`)}
                          </span>
                          <Button
                            variant="outline"
                            size="sm"
                            aria-expanded={reviewing}
                            onClick={() => setReviewingAgentKey(reviewing ? null : agent.candidateId)}
                          >
                            {reviewing ? t('common.hideDetails') : t('common.details')}
                          </Button>
                          {canDisable ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={!policyCompatible || busyKey !== null
                                || !hostCapabilities.canApproveRuntime}
                              onClick={() => void decideAgent(agent.candidateId, agent.decisionKey, false)}
                            >
                              {t('agents.disable')}
                            </Button>
                          ) : null}
                        </div>
                      </ConfigPageRow>
                      {reviewing ? (
                        <div className="openbitfun-external-sources-config__tool-card" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="toolCard">
                          <div className="openbitfun-external-sources-config__conflict-title" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="toolTitle">
                            {t('agents.reviewTitle', { name: agent.displayName })}
                          </div>
                          <div className="openbitfun-external-sources-config__tool-detail" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="toolDetail">
                            <span>{agent.description || t('agents.noDescription')}</span>
                            <span>{t('agents.requestedModel', {
                              model: externalAgentRequestedModelLabel(agent.requestedModel, t),
                            })}</span>
                            {agent.requestedModelProfile ? (
                              <span>{t('agents.requestedModelProfile', {
                                profile: externalAgentRequestedProfileLabel(
                                  agent.requestedModelProfile,
                                  t,
                                ),
                              })}</span>
                            ) : null}
                            <span>{t('agents.modelBindingMethod', {
                              method: t(`agentModelBindings.method.${agent.modelBindingMethod}`),
                            })}</span>
                            <span>{t('agents.model', { model: externalAgentEffectiveModelLabel(agent.effectiveModelLabel, agent.modelBindingMethod, t) })}</span>
                            <span>{t('agents.tools', { tools: agent.effectiveToolLabels.join(', ') || t('agents.noTools') })}</span>
                            <span>{t('agents.executionDomain')}</span>
                            <span>{t('agents.compatibility', { state: t(`agentCompatibility.${agent.compatibilityState}`) })}</span>
                            {sourceLocations.length > 0 ? (
                              <Disclosure
                                presentation="native"
                                className="openbitfun-external-sources-config__source-detail-toggle"
                                summary={t('agents.sourceLocations', { count: sourceLocations.length })}
                              >
                                <div className="openbitfun-external-sources-config__tool-detail">
                                  {sourceLocations.map((location) => (
                                    <span key={location.key}>{renderPathLink(
                                      location.label,
                                      location.stableKey,
                                    )}</span>
                                  ))}
                                </div>
                              </Disclosure>
                            ) : null}
                            {agent.diagnostics.map((diagnostic) => {
                                const category = agentDiagnosticCategory(
                                  diagnostic.code,
                                  diagnostic.blocksActivation,
                                );
                                const params = agentDiagnosticParams(
                                  diagnostic.code,
                                  category,
                                  agent.unavailableToolLabels ?? [],
                                  t,
                                );
                              return (
                                <div key={diagnostic.code}>
                                  <span>{t(`agentDiagnostics.${category}.reason`, params)}</span>
                                  {diagnostic.blocksActivation ? (
                                    <span>{t(`agentDiagnostics.${category}.nextStep`, params)}</span>
                                  ) : null}
                                </div>
                              );
                            })}
                          </div>
                          {canEnable ? (
                            <div className="openbitfun-external-sources-config__tool-warning" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="toolWarning">
                              {t('agents.approvalWarning')}
                            </div>
                          ) : null}
                          <div className="openbitfun-external-sources-config__tool-actions" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="toolActions">
                            <Button
                              variant="fill"
                              size="sm"
                              onClick={() => setReviewingAgentKey(null)}
                            >
                              {t('common.close')}
                            </Button>
                            {canEnable ? (
                              <Button
                                variant="primary"
                                size="sm"
                                disabled={!policyCompatible || busyKey !== null
                                  || !hostCapabilities.canApproveRuntime}
                                onClick={() => void decideAgent(
                                  agent.candidateId,
                                  agent.decisionKey,
                                  true,
                                ).then((applied) => {
                                  if (applied) setReviewingAgentKey(null);
                                })}
                              >
                                {t('agents.enable')}
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </React.Fragment>
                  );
                })}
              </ConfigPageSection>
            ) : null}

            {agentConflicts.length > 0 ? (
              <ConfigPageSection
                title={t('agentConflicts.title')}
              >
                {agentConflicts.map((conflict) => {
                  const selectedExternalAgent = snapshot?.subagents?.find((agent) => (
                    agent.candidateId === conflict.selectedCandidateId
                  ));
                  const selectedChoiceUnavailable = Boolean(
                    selectedExternalAgent
                    && selectedExternalAgent.activationState.state !== 'active',
                  );
                  return (
                    <div
                      className="openbitfun-external-sources-config__conflict"
                      data-openbitfun-product-component="external-sources-config"
                      data-openbitfun-product-part="conflict"
                      key={conflict.conflictKey}
                      data-external-attention={!conflict.selectedCandidateId ? 'true' : undefined}
                    >
                    <div className="openbitfun-external-sources-config__conflict-title" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="conflictTitle">
                      {t('agentConflicts.agentName', { name: conflict.logicalId })}
                    </div>
                    <div className="openbitfun-external-sources-config__conflict-options" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="conflictOptions">
                      {conflict.candidates.map((candidate) => {
                        const selected = conflict.selectedCandidateId === candidate.candidateId;
                        const externalAgent = candidate.external
                          ? snapshot?.subagents?.find((agent) => (
                            agent.candidateId === candidate.candidateId
                          ))
                          : undefined;
                        return (
                          <div className="openbitfun-external-sources-config__candidate" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="candidate" key={candidate.candidateId}>
                            <Button
                              variant={selected ? 'fill' : 'outline'}
                              size="sm"
                              disabled={!policyCompatible || busyKey !== null
                                || !hostCapabilities.canApproveRuntime}
                              aria-pressed={selected}
                              onClick={() => void chooseAgentConflict(
                                conflict.conflictKey,
                                candidate.candidateId,
                                candidate.external,
                              )}
                            >
                              {candidate.displayName}
                              <span className="openbitfun-external-sources-config__ecosystem">
                                {candidate.sourceLabel}
                              </span>
                            </Button>
                            <span className="openbitfun-external-sources-config__candidate-state" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="candidateState">
                              {t(selected
                                ? selectedChoiceUnavailable
                                  ? 'common.selectedUnavailable'
                                  : 'common.selected'
                                : conflict.selectedCandidateId
                                  ? 'common.notSelected'
                                  : 'common.availableChoice')}
                            </span>
                            {externalAgent ? (
                              <div className="openbitfun-external-sources-config__candidate-detail" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="candidateDetail">
                                <span>{t('agents.model', { model: externalAgentEffectiveModelLabel(externalAgent.effectiveModelLabel, externalAgent.modelBindingMethod, t) })}</span>
                                <span>{t('agents.tools', { tools: externalAgent.effectiveToolLabels.join(', ') || t('agents.noTools') })}</span>
                                <span>{t('agents.executionDomain')}</span>
                                <span>{t('agents.compatibility', { state: t(`agentCompatibility.${externalAgent.compatibilityState}`) })}</span>
                                {externalAgent.sourceLocationLabels.map((location) => (
                                  <span key={location}>{abbreviatedLocation(location)}</span>
                                ))}
                                {externalAgent.diagnostics.map((diagnostic) => {
                                  const category = agentDiagnosticCategory(
                                    diagnostic.code,
                                    diagnostic.blocksActivation,
                                  );
                                  const params = agentDiagnosticParams(
                                    diagnostic.code,
                                    category,
                                    externalAgent.unavailableToolLabels ?? [],
                                    t,
                                  );
                                  return (
                                    <span key={diagnostic.code}>
                                      {t(`agentDiagnostics.${category}.reason`, params)}
                                      {diagnostic.blocksActivation ? (
                                        <>
                                          {' '}
                                          {t(`agentDiagnostics.${category}.nextStep`, params)}
                                        </>
                                      ) : null}
                                    </span>
                                  );
                                })}
                                <strong>{t('agentConflicts.selectionApproves')}</strong>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                      <Button
                        variant={conflict.selectedCandidateId === DISABLED_SUBAGENT_CONFLICT_CHOICE
                          ? 'fill'
                          : 'outline'}
                        size="sm"
                        disabled={!policyCompatible || busyKey !== null
                          || !hostCapabilities.canApproveRuntime}
                        aria-pressed={
                          conflict.selectedCandidateId === DISABLED_SUBAGENT_CONFLICT_CHOICE
                        }
                        onClick={() => void chooseAgentConflict(
                          conflict.conflictKey,
                          DISABLED_SUBAGENT_CONFLICT_CHOICE,
                          false,
                        )}
                      >
                        {t('agentConflicts.disableAll')}
                      </Button>
                    </div>
                    <div className="openbitfun-external-sources-config__conflict-hint" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="conflictHint">
                      {conflict.selectedCandidateId === DISABLED_SUBAGENT_CONFLICT_CHOICE
                        ? t('agentConflicts.keptUnavailable')
                        : conflict.selectedCandidateId
                          ? t(selectedChoiceUnavailable
                            ? 'agentConflicts.currentSelectionUnavailable'
                            : 'agentConflicts.currentSelection')
                          : t('agentConflicts.pending')}
                    </div>
                    </div>
                  );
                })}
              </ConfigPageSection>
            ) : null}

            {(snapshot?.toolApprovalRequests?.length ?? 0) > 0 ? (
              <ConfigPageSection
                title={t('toolApprovals.title')}
              >
                {snapshot?.toolApprovalRequests?.map((request) => {
                  const targetTools = (snapshot.tools ?? []).filter((tool) => (
                    tool.definition.id.target.source.providerId === request.targetId.source.providerId
                    && tool.definition.id.target.source.sourceId === request.targetId.source.sourceId
                    && tool.definition.id.target.localId === request.targetId.localId
                  ));
                  const source = snapshot.sources.find((candidate) => (
                    candidate.record.key.providerId === request.targetId.source.providerId
                    && candidate.record.key.sourceId === request.targetId.source.sourceId
                  ));
                  const modulePaths = Array.from(new Set(
                    targetTools.map((tool) => tool.definition.modulePath),
                  ));
                  return (
                    <div
                      className="openbitfun-external-sources-config__tool-card"
                      data-openbitfun-product-component="external-sources-config"
                      data-openbitfun-product-part="toolCard"
                      data-external-attention="true"
                      data-external-ecosystem={source?.record.ecosystemId}
                      key={request.decisionKey}
                    >
                      <div className="openbitfun-external-sources-config__conflict-title" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="toolTitle">
                        {request.sourceDisplayName}: {request.toolNames.join(', ')}
                      </div>
                      <div className="openbitfun-external-sources-config__tool-detail" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="toolDetail">
                        <span title={source?.record.location ?? request.sourceLocation}>
                          {t('toolApprovals.sourceRoot', {
                            location: source?.record.location ?? request.sourceLocation,
                          })}
                        </span>
                        {(modulePaths.length > 0 ? modulePaths : [request.sourceLocation]).map((path) => (
                          <span title={path} key={path}>
                            {t('toolApprovals.modulePath', { location: path })}
                          </span>
                        ))}
                        <span>
                          {t('toolApprovals.scope', {
                            scope: sourceScopeLabel(
                              source?.record.scope ?? request.sourceScope,
                              t,
                            ),
                          })}
                        </span>
                        <span>
                          {t('toolApprovals.executionDomain', {
                            domain: executionLocationLabel(t, source?.record.executionDomainId),
                          })}
                        </span>
                        <span>
                          {t('toolApprovals.runtime', {
                            runtime: t(`runtime.${request.runtimeKind}`),
                          })}
                        </span>
                        <span title={request.workingDirectory}>
                          {t('toolApprovals.workingDirectory', {
                            location: request.workingDirectory,
                          })}
                        </span>
                        <span>
                          {t('toolApprovals.capabilities', {
                            capabilities: request.capabilities
                              .map((capability) => t(`capability.${capability}`))
                              .join(', '),
                          })}
                        </span>
                      </div>
                      <div className="openbitfun-external-sources-config__tool-warning" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="toolWarning">
                        {t('toolApprovals.warning')}
                      </div>
                      <div className="openbitfun-external-sources-config__tool-actions" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="toolActions">
                        <Button
                          variant="fill"
                          size="sm"
                        disabled={!policyCompatible || busyKey === request.decisionKey
                          || !hostCapabilities.canApproveRuntime}
                          onClick={() => void decideToolTarget(
                            request.approvalKey,
                            request.decisionKey,
                            false,
                          )}
                        >
                          {t('toolApprovals.keepDisabled')}
                        </Button>
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={!policyCompatible || busyKey === request.decisionKey
                            || !hostCapabilities.canApproveRuntime}
                          onClick={() => void decideToolTarget(
                            request.approvalKey,
                            request.decisionKey,
                            true,
                          )}
                        >
                          {t('toolApprovals.enable')}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </ConfigPageSection>
            ) : null}

            <ExternalSourceSection
              groups={nonOpencodeGroups}
              t={t}
              renderSourceMembers={renderSourceMembers}
            />

            {(snapshot?.tools?.length ?? 0) > 0 ? (
              <ConfigPageSection
                title={t('tools.title')}
                extra={(
                  <div className="openbitfun-external-sources-config__tool-actions" data-openbitfun-bulk-capability="tool">
                    {(snapshot?.toolApprovalRequests?.length ?? 0) > 0 ? (
                      <Button variant="primary" size="sm" aria-describedby="external-tool-bulk-risk" disabled={!policyCompatible || busyKey !== null || !hostCapabilities.canApproveRuntime} onClick={() => void setToolTargetsEnabled(true)}>
                        {t('bulkActions.enablePending', { count: snapshot?.toolApprovalRequests?.length ?? 0 })}
                      </Button>
                    ) : null}
                    <Button variant="outline" size="sm" disabled={!policyCompatible || busyKey !== null || !hostCapabilities.canApproveRuntime} onClick={() => void setToolTargetsEnabled(false)}>
                      {t('bulkActions.disableAll')}
                    </Button>
                  </div>
                )}
              >
                {(snapshot?.toolApprovalRequests?.length ?? 0) > 0 ? (
                  <div id="external-tool-bulk-risk" className="openbitfun-external-sources-config__tool-warning">
                    {t('bulkActions.enableRisk', { count: snapshot?.toolApprovalRequests?.length ?? 0 })}
                  </div>
                ) : null}
                {snapshot?.tools?.map((tool) => {
                  const toolKey = `${tool.definition.id.target.source.providerId}:${tool.definition.id.target.source.sourceId}:${tool.definition.id.target.localId}:${tool.definition.id.exportId}`;
                  const source = snapshot.sources.find((candidate) => matchesToolSource(candidate, tool));
                  const targetTools = (snapshot.tools ?? []).filter((candidate) => (
                    candidate.definition.id.target.source.providerId
                      === tool.definition.id.target.source.providerId
                    && candidate.definition.id.target.source.sourceId
                      === tool.definition.id.target.source.sourceId
                    && candidate.definition.id.target.localId
                      === tool.definition.id.target.localId
                  ));
                  const firstTargetExport = targetTools[0] === tool;
                  const enableable = ['approval_required', 'declined'].includes(
                    tool.activation.state,
                  );
                  const disableable = firstTargetExport && targetTools.some((candidate) => (
                    ['active', 'conflict', 'load_failed'].includes(candidate.activation.state)
                  ));
                  const reviewing = reviewingToolKey === toolKey;
                  const reason = t(`toolReason.${tool.activation.state}`);
                  return (
                    <React.Fragment key={toolKey}>
                      <ConfigPageRow
                        label={tool.definition.name}
                        description={tool.definition.descriptionPreview
                          || abbreviatedLocation(tool.definition.modulePath)}
                        align="center"
                      >
                        <div className="openbitfun-external-sources-config__source-control" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="sourceControl">
                          <span
                            className={`openbitfun-external-sources-config__state is-${tool.activation.state}`}
                            data-openbitfun-product-component="external-sources-config"
                            data-openbitfun-product-part="state"
                            data-external-attention={tool.activation.state === 'approval_required'
                              ? 'true'
                              : undefined}
                          >
                            {t(`toolState.${tool.activation.state}`)}
                          </span>
                          <Button
                            variant="outline"
                            size="sm"
                            aria-expanded={reviewing}
                            onClick={() => setReviewingToolKey(reviewing ? null : toolKey)}
                          >
                            {reviewing ? t('common.hideDetails') : t('common.details')}
                          </Button>
                          {disableable ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={!policyCompatible || busyKey === tool.decisionKey
                                || !hostCapabilities.canApproveRuntime}
                              onClick={() => void decideToolTarget(
                                tool.approvalKey,
                                tool.decisionKey,
                                false,
                              )}
                            >
                              {t('tools.disable')}
                            </Button>
                          ) : null}
                        </div>
                      </ConfigPageRow>
                      {reviewing ? (
                        <div className="openbitfun-external-sources-config__tool-card" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="toolCard">
                          <div className="openbitfun-external-sources-config__conflict-title" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="toolTitle">
                            {t('tools.reviewTitle', {
                              name: tool.definition.name,
                              source: source?.record.displayName ?? tool.definition.id.target.source.providerId,
                            })}
                          </div>
                          <div className="openbitfun-external-sources-config__tool-detail" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="toolDetail">
                            <span title={source?.record.location}>
                              {t('toolApprovals.sourceRoot', {
                                location: source?.record.location ?? t('common.unknown'),
                              })}
                            </span>
                            <span title={tool.definition.modulePath}>
                              {t('toolApprovals.modulePath', {
                                location: tool.definition.modulePath,
                              })}
                            </span>
                            <span>
                              {t('toolApprovals.scope', {
                                scope: source?.record.scope
                                  ? sourceScopeLabel(source.record.scope, t)
                                  : t('common.unknown'),
                              })}
                            </span>
                            <span>
                              {t('toolApprovals.executionDomain', {
                                domain: executionLocationLabel(t, source?.record.executionDomainId),
                              })}
                            </span>
                            <span>
                              {t('toolApprovals.runtime', {
                                runtime: t(`runtime.${tool.definition.runtimeKind}`),
                              })}
                            </span>
                            <span title={tool.definition.workingDirectory}>
                              {t('toolApprovals.workingDirectory', {
                                location: tool.definition.workingDirectory,
                              })}
                            </span>
                            <span>
                              {t('toolApprovals.capabilities', {
                                capabilities: tool.definition.capabilities
                                  .map((capability) => t(`capability.${capability}`))
                                  .join(', '),
                                })}
                            </span>
                            <span>{t('tools.reason', { reason })}</span>
                            <span>{t('tools.targetScope')}</span>
                            <span>
                              {t('tools.nextStep', {
                                nextStep: t(`toolNextStep.${tool.activation.state}`),
                              })}
                            </span>
                          </div>
                          {enableable ? (
                            <div className="openbitfun-external-sources-config__tool-warning" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="toolWarning">
                              {t('toolApprovals.warning')}
                            </div>
                          ) : null}
                          <div className="openbitfun-external-sources-config__tool-actions" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="toolActions">
                            <Button
                              variant="fill"
                              size="sm"
                              disabled={!policyCompatible || busyKey === tool.decisionKey
                                || !hostCapabilities.canApproveRuntime}
                              onClick={() => setReviewingToolKey(null)}
                            >
                              {t('common.close')}
                            </Button>
                            {enableable ? (
                              <Button
                                variant="primary"
                                size="sm"
                                disabled={!policyCompatible || busyKey === tool.decisionKey
                                  || !hostCapabilities.canApproveRuntime}
                                onClick={() => void decideToolTarget(
                                  tool.approvalKey,
                                  tool.decisionKey,
                                  true,
                                ).then((applied) => {
                                  if (applied) setReviewingToolKey(null);
                                })}
                              >
                                {t('toolApprovals.enable')}
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </React.Fragment>
                  );
                })}
              </ConfigPageSection>
            ) : null}

            <ExternalCommandConflicts
              conflicts={commandConflicts}
              t={t}
              busyKey={busyKey}
              hostCapabilities={hostCapabilities}
              policyCompatible={policyCompatible}
              onChooseConflict={(conflictKey, candidateId) => {
                void chooseConflict(conflictKey, candidateId);
              }}
            />

            {toolConflicts.length > 0 ? (
              <ConfigPageSection
                title={t('toolConflicts.title')}
              >
                {toolConflicts.map((conflict) => {
                  const selectedCandidate = conflict.candidates.find((candidate) => (
                    candidate.candidateId === conflict.selectedCandidateId
                  ));
                  const selectedExternalTool = selectedCandidate?.kind === 'external'
                    ? snapshot?.tools?.find((tool) => (
                      tool.definition.id.target.source.providerId
                        === selectedCandidate.source?.providerId
                      && tool.definition.id.target.source.sourceId
                        === selectedCandidate.source?.sourceId
                      && tool.definition.modulePath === selectedCandidate.sourceLocation
                      && tool.definition.name === conflict.toolName
                      && tool.definition.contentVersion === selectedCandidate.contentVersion
                    ))
                    : undefined;
                  const selectedChoiceUnavailable = selectedCandidate?.kind === 'external'
                    && selectedExternalTool?.activation.state !== 'active';
                  return (
                    <div
                      className="openbitfun-external-sources-config__conflict"
                      data-openbitfun-product-component="external-sources-config"
                      data-openbitfun-product-part="conflict"
                      key={conflict.conflictKey}
                      data-external-attention={!conflict.selectedCandidateId ? 'true' : undefined}
                      data-external-ecosystem={onlyEcosystemId(
                        conflict.candidates.map((candidate) => (
                          sourceEcosystemId(snapshot, candidate.source)
                        )),
                      )}
                    >
                    <div className="openbitfun-external-sources-config__conflict-title" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="conflictTitle">
                      {t('toolConflicts.toolName', { name: conflict.toolName })}
                    </div>
                    <div className="openbitfun-external-sources-config__conflict-options" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="conflictOptions">
                      {conflict.candidates.map((candidate) => {
                        const selected = conflict.selectedCandidateId === candidate.candidateId;
                        return (
                          <div className="openbitfun-external-sources-config__candidate" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="candidate" key={candidate.candidateId}>
                            <Button
                              variant={selected ? 'fill' : 'outline'}
                              size="sm"
                              disabled={!policyCompatible || busyKey === conflict.conflictKey
                                || !hostCapabilities.canApproveRuntime}
                              aria-pressed={selected}
                              onClick={() => void chooseToolConflict(
                                conflict.conflictKey,
                                candidate.candidateId,
                              )}
                            >
                              {candidate.displayName}
                              <span className="openbitfun-external-sources-config__ecosystem">
                                {t(`toolCandidateKind.${candidate.kind}`)}
                              </span>
                            </Button>
                            <span className="openbitfun-external-sources-config__candidate-state" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="candidateState">
                              {t(selected
                                ? selectedChoiceUnavailable
                                  ? 'common.selectedUnavailable'
                                  : 'common.selected'
                                : conflict.selectedCandidateId
                                  ? 'common.notSelected'
                                  : 'common.availableChoice')}
                            </span>
                            <div className="openbitfun-external-sources-config__candidate-detail" data-openbitfun-product-component="external-sources-config" data-openbitfun-product-part="candidateDetail">
                              {candidate.sourceLocation
                                ? abbreviatedLocation(candidate.sourceLocation)
                                : candidate.providerId}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div className="openbitfun-external-sources-config__conflict-hint">
                      {conflict.selectedCandidateId
                        ? t(selectedChoiceUnavailable
                          ? 'toolConflicts.currentSelectionUnavailable'
                          : 'toolConflicts.currentSelection')
                        : t('toolConflicts.pending')}
                    </div>
                    </div>
                  );
                })}
              </ConfigPageSection>
            ) : null}
              </details>
            ) : null}
          </>
        )}
      </ConfigPageContent>
      <ConfirmDialog
        open={resetPolicyConfirmation !== null}
        onOpenChange={() => setResetPolicyConfirmation(null)}
        onConfirm={() => {
          const confirmation = resetPolicyConfirmation;
          setResetPolicyConfirmation(null);
          if (confirmation) void resetIncompatiblePolicy(confirmation);
        }}
        title={t('policy.resetConfirmTitle')}
        message={t('policy.resetConfirmMessage')}
        type="warning"
        confirmDanger
        confirmText={t('policy.backupAndReset')}
      />
    </ConfigPageLayout>
  );
};

export default ExternalSourcesConfig;
