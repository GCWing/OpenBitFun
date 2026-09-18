import { workspaceIdRequest } from './legacyWorkspaceCompatibility';
import { api } from './ApiClient';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { notifyMcpConfigChanged } from '@/infrastructure/mcp/configEvents';
import { globalEventBus } from '@/infrastructure/event-bus';

export type ExternalSourceScope =
  | 'user_global'
  | 'project'
  | 'workspace_local'
  | 'remote_user'
  | 'remote_project';

export type ExternalSourceLifecycle =
  | 'available'
  | 'restricted'
  | 'degraded'
  | 'unavailable'
  | 'removed'
  | 'suppressed'
  | 'using_last_valid_version';

export type ExternalIntegrationMode =
  | 'recommended'
  | 'discover_only'
  | 'disabled'
  | 'custom'
  | (string & {});

export type ExternalIntegrationAccess =
  | 'disabled'
  | 'discover_only'
  | 'ask_before_use'
  | 'auto'
  | (string & {});

export interface ExternalEcosystemPolicy {
  mode: ExternalIntegrationMode;
  capabilityOverrides?: Record<string, ExternalIntegrationAccess>;
}

export interface ExternalEcosystemPolicyOverride {
  mode?: ExternalIntegrationMode;
  capabilityOverrides?: Record<string, ExternalIntegrationAccess>;
}

export interface ExternalIntegrationPolicySnapshot {
  schemaMajor: number;
  status: 'compatible' | 'incompatible_schema' | (string & {});
  userDefaults: {
    enabled: boolean;
    ecosystems?: Record<string, ExternalEcosystemPolicy>;
  };
  workspaceOverride?: {
    enabled?: boolean;
    ecosystems?: Record<string, ExternalEcosystemPolicyOverride>;
  };
  globalEffective: EffectiveExternalIntegrationPolicy;
  effective: EffectiveExternalIntegrationPolicy;
  registeredEcosystems: Array<{
    ecosystemId: string;
    displayName: string;
    adapterRevision: string;
    capabilities: Array<{
      capabilityId: string;
      recommendedAccess: ExternalIntegrationAccess;
      safetyCeiling: ExternalIntegrationAccess;
    }>;
  }>;
}

export interface EffectiveExternalIntegrationPolicy {
    enabled: boolean;
    ecosystems: Record<
      string,
      {
        ecosystemId: string;
        mode: ExternalIntegrationMode;
        capabilities: Record<string, ExternalIntegrationAccess>;
        policyLimitedCapabilities?: string[];
      }
    >;
}

export type ExternalIntegrationPolicyMutation = {
  expectedPreferenceRevision: number;
  scope: 'user' | 'workspace';
  change:
    | { operation: 'set_automatic_discovery'; enabled: boolean }
    | { operation: 'set_enabled'; enabled: boolean }
    | {
        operation: 'set_ecosystem_mode';
        ecosystemId: string;
        mode: ExternalIntegrationMode;
      }
    | {
        operation: 'set_capability_access';
        ecosystemId: string;
        capabilityId: string;
        access: ExternalIntegrationAccess;
      }
    | { operation: 'reset_workspace' }
    | { operation: 'reset_incompatible_policy' };
};

export type PromptCommandAvailability =
  | { state: 'available' }
  | { state: 'restricted'; reason: string; required_capabilities: string[] }
  | { state: 'invalid'; reason: string };

export interface ExternalSourceRecord {
  key: { providerId: string; sourceId: string };
  ecosystemId: string;
  displayName: string;
  sourceKind: string;
  scope: ExternalSourceScope;
  location: string;
  executionDomainId: string;
  health: 'available' | 'partial' | 'degraded' | 'unavailable';
  contentVersion: string;
  diagnostics?: Array<{
    severity: string;
    assetKind?: 'source' | 'command' | 'tool' | 'subagent' | 'mcp' | 'reference';
    code: string;
    message: string;
  }>;
}

export interface ExternalSourceCatalogSnapshot {
  /** Present only on the negotiated catalog discovery endpoint. */
  discovery?: {
    enabled: boolean;
    canChange: boolean;
    hasScanned: boolean;
    discoverableCapabilities?: Record<string, string[]>;
    /** View-only retained results; never sent to the host as authorization. */
    retainedKinds?: string[];
    preferenceRevision: number;
  };
  hostCapabilities: {
    canRefresh: boolean;
    canMutatePolicy: boolean;
    canManageSources: boolean;
    canApproveRuntime: boolean;
    canExecuteExternalAssets: boolean;
    canSetSafeMode: boolean;
    canRevealSourceLocation: boolean;
  };
  generation: number;
  discoveryPending: boolean;
  sources: Array<{
    stableKey: string;
    presentationGroupId?: string;
    record: ExternalSourceRecord;
    lifecycle: ExternalSourceLifecycle;
  }>;
  commands: Array<{
    /** Opaque host identity used for guarded expansion; absent on legacy hosts. */
    candidateId?: string;
    definition: {
      id: {
        source: { providerId: string; sourceId: string };
        localId: string;
      };
      name: string;
      description: string;
      availability: PromptCommandAvailability;
      contentVersion: string;
    };
  }>;
  commandConflicts?: Array<{
    conflictKey: string;
    commandName: string;
    selectedCandidateId?: string;
    candidates: Array<{
      candidateId: string;
      source: { providerId: string; sourceId: string };
      sourceDisplayName: string;
      ecosystemId: string;
      contentVersion: string;
      commandDescription: string;
      sourceScope: ExternalSourceScope;
      sourceLocation: string;
      executionTarget?: PromptCommandExecutionTarget;
      availability: PromptCommandAvailability;
    }>;
  }>;
  tools?: ExternalToolCatalogEntry[];
  toolApprovalRequests?: ExternalToolApprovalRequest[];
  toolConflicts?: ExternalToolConflict[];
  mcpGeneration?: number;
  mcpServers?: ExternalMcpCatalogEntry[];
  mcpApprovalRequests?: ExternalMcpApprovalRequest[];
  mcpConflicts?: ExternalMcpConflict[];
  subagentGeneration?: number;
  preferenceRevision?: number;
  subagents?: ExternalSubagentSummary[];
  subagentModelBindingGroups?: ExternalSubagentModelBindingGroup[];
  subagentModelBindingOptions?: ExternalSubagentModelBindingOption[];
  subagentConflicts?: ExternalSubagentConflict[];
  pendingSubagentApprovals?: string[];
  integrationPolicy: ExternalIntegrationPolicySnapshot;
  diagnostics?: Array<{
    severity: string;
    assetKind?: 'source' | 'command' | 'tool' | 'subagent' | 'mcp' | 'reference';
    code: string;
    message: string;
  }>;
  /** Frontend view of the atomic control+catalog response. Legacy hosts omit it. */
  control?: ExternalSourceControlSnapshot;
}

export interface PromptCommandShellReviewPlan {
  schemaVersion: number;
  planFingerprint: string;
  sourceDisplayName: string;
  workingDirectory: string;
  shellDisplayName: string;
  shellExecutable: string;
  commands: string[];
  canRemember: boolean;
  preferenceRevision: number;
}

export interface PromptCommandShellReviewDecision {
  planFingerprint: string;
  mode: 'run_once' | 'remember';
  expectedPreferenceRevision: number;
}

export type PromptCommandExecutionTarget =
  | { kind: 'inline' }
  | {
      kind: 'fresh_external_subagent';
      ecosystemId: string;
      logicalId: string;
    };

export type ExternalPromptCommandInvocationOutcome =
  | {
      state: 'ready';
      content: string;
      executionTarget: PromptCommandExecutionTarget;
    }
  | { state: 'review_required'; review: PromptCommandShellReviewPlan };

export type ExternalSubagentActivation =
  | { state: 'approval_required' }
  | { state: 'declined' }
  | { state: 'disabled' }
  | { state: 'active' }
  | { state: 'conflict' }
  | { state: 'blocked' }
  | { state: 'unavailable' };

export type ExternalSubagentModelRequest =
  | { kind: 'default' }
  | { kind: 'inherit' }
  | { kind: 'reference'; providerHint?: string; modelName: string };

export type ExternalSubagentModelProfileRequest =
  | { kind: 'named_variant'; name: string }
  | { kind: 'reasoning_effort'; value: string };

export type ExternalSubagentModelBindingTarget =
  | { kind: 'primary' }
  | { kind: 'fast' }
  | { kind: 'model'; modelId: string };

export type ExternalSubagentModelBindingMethod =
  | 'default'
  | 'inherit'
  | 'exact'
  | 'explicit'
  | 'binding_required'
  | 'binding_unavailable';

export interface ExternalSubagentModelBindingOption {
  target: ExternalSubagentModelBindingTarget;
  effectiveModelLabel: string;
  configuredReasoningEffort?: string;
}

export interface ExternalSubagentModelBindingGroup {
  bindingKey: string;
  request: ExternalSubagentModelRequest;
  profileRequest?: ExternalSubagentModelProfileRequest;
  scope: ExternalSourceScope;
  method: ExternalSubagentModelBindingMethod;
  selectedTarget?: ExternalSubagentModelBindingTarget;
  effectiveModelLabel?: string;
  affectedCandidateIds: string[];
}

export interface ExternalSubagentSummary {
  candidateId: string;
  logicalId: string;
  displayName: string;
  description: string;
  providerLabel: string;
  scope: ExternalSourceScope;
  sourceKeys: Array<{ providerId: string; sourceId: string }>;
  sourceLocationLabels: string[];
  sourceCount: number;
  mode: 'primary' | 'subagent' | 'all';
  requestedModel: ExternalSubagentModelRequest;
  requestedModelProfile?: ExternalSubagentModelProfileRequest;
  modelBindingMethod: ExternalSubagentModelBindingMethod;
  modelBindingKey?: string;
  effectiveModelLabel?: string;
  effectiveToolLabels: string[];
  unavailableToolLabels: string[];
  supportsFollowUp: boolean;
  compatibilityState: 'ready' | 'ready_with_degradation' | 'blocked' | 'invalid';
  diagnostics: Array<{ code: string; blocksActivation: boolean }>;
  activationState: ExternalSubagentActivation;
  decisionKey: string;
}

export interface ExternalSubagentConflict {
  conflictKey: string;
  logicalId: string;
  selectedCandidateId?: string;
  candidates: Array<{
    candidateId: string;
    displayName: string;
    sourceLabel: string;
    external: boolean;
  }>;
}

export type ExternalToolCapability = 'file_system' | 'network' | 'process' | 'environment';
export type ExternalToolActivation =
  | { state: 'approval_required' }
  | { state: 'declined' }
  | { state: 'disabled' }
  | { state: 'active' }
  | { state: 'conflict' }
  | { state: 'unsupported'; reason: string }
  | { state: 'runtime_unavailable'; reason: string }
  | { state: 'load_failed'; reason: string };

export interface ExternalToolDefinition {
  id: {
    target: {
      source: { providerId: string; sourceId: string };
      localId: string;
    };
    exportId: string;
  };
  name: string;
  descriptionPreview: string;
  modulePath: string;
  workingDirectory: string;
  runtimeKind: 'java_script' | 'type_script';
  capabilities: ExternalToolCapability[];
  contentVersion: string;
  staticStatus:
    | { state: 'ready' }
    | { state: 'unsupported'; reason: string }
    | { state: 'invalid'; reason: string };
}

export interface ExternalToolCatalogEntry {
  definition: ExternalToolDefinition;
  approvalKey: string;
  decisionKey: string;
  activation: ExternalToolActivation;
}

export interface ExternalToolApprovalRequest {
  approvalKey: string;
  decisionKey: string;
  targetId: {
    source: { providerId: string; sourceId: string };
    localId: string;
  };
  sourceDisplayName: string;
  sourceScope: ExternalSourceScope;
  sourceLocation: string;
  workingDirectory: string;
  runtimeKind: 'java_script' | 'type_script';
  capabilities: ExternalToolCapability[];
  contentVersion: string;
  toolNames: string[];
}

export interface ExternalToolConflict {
  conflictKey: string;
  toolName: string;
  selectedCandidateId?: string;
  candidates: Array<{
    candidateId: string;
    displayName: string;
    kind: 'built_in' | 'mcp' | 'external';
    providerId: string;
    contentVersion: string;
    source?: { providerId: string; sourceId: string };
    sourceLocation?: string;
  }>;
}

export type ExternalMcpActivation =
  | { state: 'approval_required' }
  | { state: 'starting' }
  | { state: 'active' }
  | { state: 'declined' }
  | { state: 'conflict' }
  | { state: 'covered'; selected_candidate_id: string }
  | { state: 'source_disabled' }
  | { state: 'configuration_changed' }
  | { state: 'unsupported'; reason: string }
  | { state: 'runtime_unavailable'; reason: string }
  | { state: 'removed' };

export interface ExternalMcpTimeouts {
  startupMs?: number;
  catalogMs?: number;
  executionMs?: number;
}

export interface ExternalMcpDefinition {
  id: {
    source: { providerId: string; sourceId: string };
    localId: string;
  };
  provenance: Array<{ providerId: string; sourceId: string }>;
  name: string;
  transport: 'local_stdio' | 'streamable_http';
  commandPreview?: string;
  argumentCount: number;
  workingDirectory?: string;
  environmentKeys: string[];
  environmentReferenceNames?: string[];
  remoteUrlPreview?: string;
  headerNames: string[];
  timeouts?: ExternalMcpTimeouts;
  sourceEnabled: boolean;
  behaviorVersion: string;
  staticStatus:
    | { state: 'ready' }
    | { state: 'disabled_by_source' }
    | { state: 'unsupported'; reason: string }
    | { state: 'invalid'; reason: string };
}

export interface ExternalMcpCatalogEntry {
  candidateId: string;
  definition: ExternalMcpDefinition;
  approvalKey: string;
  decisionKey: string;
  runtimeId?: string;
  activationState: ExternalMcpActivation;
}

export type ExternalMcpImportDispositionV1 =
  | 'eligible'
  | 'automatic_rename'
  | 'already_imported'
  | 'unavailable';

export interface ExternalMcpImportPlanV1 {
  schemaVersion: 1;
  planFingerprint: string;
  items: Array<{
    candidateId: string;
    displayName: string;
    transport: 'local_stdio' | 'streamable_http';
    proposedNativeId?: string;
    disposition: ExternalMcpImportDispositionV1;
    reasonCode?: string;
  }>;
}

export interface ExternalMcpImportSelectionV1 {
  candidateId: string;
  requestedNativeId?: string;
}

export interface ExternalMcpImportApplyResultV1 {
  schemaVersion: 1;
  outcome:
    | { status: 'applied'; imported: Array<{ candidateId: string; nativeId: string }> }
    | { status: 'stale'; refreshedPlan: ExternalMcpImportPlanV1 };
}

export interface ExternalMcpApprovalRequest {
  candidateId: string;
  approvalKey: string;
  decisionKey: string;
  definition: ExternalMcpDefinition;
}

export interface ExternalMcpConflict {
  conflictKey: string;
  serverName: string;
  selectedCandidateId?: string;
  candidates: Array<{
    candidateId: string;
    displayName: string;
    external: boolean;
    source?: { providerId: string; sourceId: string };
    behaviorVersion: string;
    available: boolean;
    unavailableReason?: string;
  }>;
}

export type ExternalSourceOperationStage =
  | 'validate_request'
  | 'discover'
  | 'reconcile'
  | 'apply_preference'
  | 'activate_runtime'
  | 'project_response'
  | 'execute_remote';

export type ExternalSourceRecoveryActionType =
  | 'refresh'
  | 'retry'
  | 'review'
  | 'resolve_conflict'
  | 'install_runtime'
  | 'reconnect_host'
  | 'exit_safe_mode';

export interface ExternalSourceRecoveryAction {
  type: ExternalSourceRecoveryActionType;
}

export type ExternalSourceControlAction =
  | { type: 'refresh' }
  | { type: 'set_source_enabled'; sourceKey: string; enabled: boolean }
  | { type: 'set_safe_mode'; enabled: boolean };

export interface ExternalSourceControlRequest {
  schemaVersion: 1;
  operationId: string;
  expectedPreferenceRevision?: number;
  action: ExternalSourceControlAction;
}

export type ExternalSourceRuntimeState =
  | 'not_applicable'
  | 'inactive'
  | 'starting'
  | 'active'
  | 'degraded'
  | 'quarantined'
  | 'unsupported';

export interface ExternalSourceControlSnapshot {
  schemaVersion: 1;
  executionDomainId: string;
  refreshGeneration: number;
  preferenceRevision: number;
  safeMode: boolean;
  hostCapabilities: ExternalSourceCatalogSnapshot['hostCapabilities'];
  sources: Array<{
    stableKey: string;
    ecosystemId: string;
    displayName: string;
    scope: ExternalSourceScope;
    contentVersion: string;
    discovery: 'pending' | 'current' | 'last_known_good' | 'failed' | 'removed';
    desired: 'enabled' | 'disabled';
    review:
      | { state: 'not_required' }
      | { state: 'required'; contentVersion: string };
    runtime: ExternalSourceRuntimeState;
    support: 'supported' | 'partial' | 'unsupported' | 'unavailable';
    effectiveStatus:
      | 'discovering'
      | 'disabled'
      | 'review_required'
      | 'conflict'
      | 'active'
      | 'degraded'
      | 'unsupported'
      | 'available'
      | 'removed';
  }>;
  capabilities: Array<{
    kind: 'command' | 'tool' | 'subagent' | 'mcp';
    revision: number;
    itemCount: number;
    pendingReviewCount: number;
    unresolvedConflictCount: number;
    runtime: ExternalSourceRuntimeState;
    support: 'supported' | 'partial' | 'unsupported' | 'unavailable';
  }>;
  diagnostics: NonNullable<ExternalSourceCatalogSnapshot['diagnostics']>;
  recoveryActions: ExternalSourceRecoveryAction[];
}

export interface ExternalSourceSurfaceSnapshot {
  control: ExternalSourceControlSnapshot;
  catalog: ExternalSourceCatalogSnapshot;
}

export type ExternalSourceOperationErrorCode =
  | 'invalid_request'
  | 'host_unavailable'
  | 'host_capability_unavailable'
  | 'trust_required'
  | 'policy_incompatible'
  | 'policy_limited'
  | 'stale_revision'
  | 'conflict'
  | 'not_found'
  | 'unavailable'
  | 'runtime_unavailable'
  | 'unsupported'
  | 'incompatible_version'
  | 'dependency_failed'
  | 'timeout'
  | 'cancelled'
  | 'overloaded'
  | 'process_lost'
  | 'invalid_response'
  | 'temporarily_unavailable'
  | 'internal';

export class ExternalSourceApiError extends Error {
  constructor(
    public readonly code: ExternalSourceOperationErrorCode,
    public readonly detail: string,
    public readonly retryable: boolean,
    public readonly correlationId?: string,
    public readonly causationId?: string,
    public readonly stage?: ExternalSourceOperationStage,
    public readonly recoveryActions: ExternalSourceRecoveryAction[] = [],
  ) {
    super(detail);
    this.name = 'ExternalSourceApiError';
  }
}

function normalizePromptCommandInvocationOutcome(
  value: unknown,
): ExternalPromptCommandInvocationOutcome {
  if (!value || typeof value !== 'object') {
    throw new ExternalSourceApiError(
      'invalid_response',
      'Prompt command expansion response was invalid',
      false,
    );
  }
  const outcome = value as Record<string, unknown>;
  if (outcome.state === 'review_required' && outcome.review && typeof outcome.review === 'object') {
    return value as ExternalPromptCommandInvocationOutcome;
  }
  if (outcome.state !== 'ready' || typeof outcome.content !== 'string') {
    throw new ExternalSourceApiError(
      'invalid_response',
      'Prompt command expansion response was invalid',
      false,
    );
  }
  const target = outcome.executionTarget;
  if (!target || typeof target !== 'object') {
    throw new ExternalSourceApiError(
      'invalid_response',
      'Prompt command expansion execution target was invalid',
      false,
    );
  }
  const targetRecord = target as Record<string, unknown>;
  const validInline = targetRecord.kind === 'inline';
  const validExternalSubagent = targetRecord.kind === 'fresh_external_subagent'
    && typeof targetRecord.ecosystemId === 'string'
    && targetRecord.ecosystemId.trim().length > 0
    && typeof targetRecord.logicalId === 'string'
    && targetRecord.logicalId.trim().length > 0;
  if (!validInline && !validExternalSubagent) {
    throw new ExternalSourceApiError(
      'invalid_response',
      'Prompt command expansion execution target was invalid',
      false,
    );
  }
  return value as ExternalPromptCommandInvocationOutcome;
}

export interface NativePromptCommandDescriptor {
  commandName: string;
  candidateId: string;
  behaviorVersion: string;
}

export interface NativePromptCommandConflictSnapshot {
  preferenceRevision: number;
  conflicts: Array<{
    commandName: string;
    externalCandidateId: string;
    conflictKey: string;
    selectedCandidateId?: string;
  }>;
  reconfirmations?: Array<{
    commandName: string;
    nativeCandidateId: string;
  }>;
}

export interface WorkspaceReferenceEntry {
  stableKey: string;
  alias?: string;
  path: string;
  description?: string;
  hidden: boolean;
  origin: 'native' | 'external';
  ecosystemId?: string;
  sourceDisplayName?: string;
  sourceScope?: ExternalSourceScope;
}

export interface WorkspaceReferenceSnapshot {
  generation: number;
  discoveryPending: boolean;
  references: WorkspaceReferenceEntry[];
  diagnostics?: Array<{
    severity: string;
    assetKind?: 'reference';
    code: string;
    message: string;
  }>;
}

const READ_ONLY_HOST_CAPABILITIES: ExternalSourceCatalogSnapshot['hostCapabilities'] = {
  canRefresh: false,
  canMutatePolicy: false,
  canManageSources: false,
  canApproveRuntime: false,
  canExecuteExternalAssets: false,
  canSetSafeMode: false,
  canRevealSourceLocation: false,
};

const CONTROL_DISCOVERY_STATES = new Set(['pending', 'current', 'last_known_good', 'failed', 'removed']);
const CONTROL_DESIRED_STATES = new Set(['enabled', 'disabled']);
const CONTROL_RUNTIME_STATES = new Set<ExternalSourceRuntimeState>([
  'not_applicable', 'inactive', 'starting', 'active', 'degraded', 'quarantined', 'unsupported',
]);
const CONTROL_SUPPORT_STATES = new Set(['supported', 'partial', 'unsupported', 'unavailable']);
const CONTROL_EFFECTIVE_STATUSES = new Set([
  'discovering', 'disabled', 'review_required', 'conflict', 'active', 'degraded', 'unsupported', 'available', 'removed',
]);
const CONTROL_CAPABILITY_KINDS = new Set(['command', 'tool', 'subagent', 'mcp']);
const EXTERNAL_SOURCE_SCOPES = new Set<ExternalSourceScope>([
  'user_global', 'project', 'workspace_local', 'remote_user', 'remote_project',
]);
const OPERATION_STAGES = new Set<ExternalSourceOperationStage>([
  'validate_request', 'discover', 'reconcile', 'apply_preference', 'activate_runtime', 'project_response', 'execute_remote',
]);
const RECOVERY_ACTION_TYPES = new Set<ExternalSourceRecoveryActionType>([
  'refresh', 'retry', 'review', 'resolve_conflict', 'install_runtime', 'reconnect_host', 'exit_safe_mode',
]);
const HOST_CAPABILITY_KEYS = [
  'canRefresh',
  'canMutatePolicy',
  'canManageSources',
  'canApproveRuntime',
  'canExecuteExternalAssets',
  'canSetSafeMode',
  'canRevealSourceLocation',
] as const;
const REQUIRED_HOST_CAPABILITY_KEYS = HOST_CAPABILITY_KEYS.filter(
  (key) => key !== 'canRevealSourceLocation',
);

function isOneOf<T extends string>(value: unknown, values: ReadonlySet<T>): value is T {
  return typeof value === 'string' && values.has(value as T);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isHostCapabilities(
  value: unknown,
): value is ExternalSourceCatalogSnapshot['hostCapabilities'] {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).every(
    (key) => (HOST_CAPABILITY_KEYS as readonly string[]).includes(key),
  )
    && REQUIRED_HOST_CAPABILITY_KEYS.every((key) => typeof record[key] === 'boolean')
    && (record.canRevealSourceLocation === undefined
      || typeof record.canRevealSourceLocation === 'boolean');
}

function hostCapabilitiesEqual(
  left: ExternalSourceCatalogSnapshot['hostCapabilities'],
  right: ExternalSourceCatalogSnapshot['hostCapabilities'],
): boolean {
  return HOST_CAPABILITY_KEYS.every((key) => left[key] === right[key]);
}

function normalizeHostCapabilities(
  value: unknown,
): ExternalSourceCatalogSnapshot['hostCapabilities'] {
  const capabilities = value && typeof value === 'object'
    ? value as Partial<ExternalSourceCatalogSnapshot['hostCapabilities']>
    : undefined;
  return {
    ...READ_ONLY_HOST_CAPABILITIES,
    canRefresh: capabilities?.canRefresh === true,
    canMutatePolicy: capabilities?.canMutatePolicy === true,
    canManageSources: capabilities?.canManageSources === true,
    canApproveRuntime: capabilities?.canApproveRuntime === true,
    canExecuteExternalAssets: capabilities?.canExecuteExternalAssets === true,
    canSetSafeMode: capabilities?.canSetSafeMode === true,
    canRevealSourceLocation: capabilities?.canRevealSourceLocation === true,
  };
}

function isRecoveryAction(value: unknown): value is ExternalSourceRecoveryAction {
  return Boolean(value)
    && typeof value === 'object'
    && isOneOf((value as { type?: unknown }).type, RECOVERY_ACTION_TYPES);
}

function normalizeRecoveryActions(value: unknown, strict: boolean): ExternalSourceRecoveryAction[] {
  const actions = normalizeOptionalArray<unknown>(value);
  if (strict && !actions.every(isRecoveryAction)) {
    throw new ExternalSourceApiError(
      'invalid_response',
      'External source recovery actions were invalid',
      false,
    );
  }
  return actions.filter(isRecoveryAction);
}

function isControlReview(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const review = value as Record<string, unknown>;
  switch (review.state) {
    case 'not_required':
      return true;
    case 'required':
      return typeof review.contentVersion === 'string';
    default:
      return false;
  }
}

function isControlSource(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const source = value as Record<string, unknown>;
  return typeof source.stableKey === 'string'
    && typeof source.ecosystemId === 'string'
    && typeof source.displayName === 'string'
    && isOneOf(source.scope, EXTERNAL_SOURCE_SCOPES)
    && typeof source.contentVersion === 'string'
    && isOneOf(source.discovery, CONTROL_DISCOVERY_STATES)
    && isOneOf(source.desired, CONTROL_DESIRED_STATES)
    && isControlReview(source.review)
    && isOneOf(source.runtime, CONTROL_RUNTIME_STATES)
    && isOneOf(source.support, CONTROL_SUPPORT_STATES)
    && isOneOf(source.effectiveStatus, CONTROL_EFFECTIVE_STATUSES);
}

function isCapabilityControl(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const capability = value as Record<string, unknown>;
  return isOneOf(capability.kind, CONTROL_CAPABILITY_KINDS)
    && isNonNegativeInteger(capability.revision)
    && isNonNegativeInteger(capability.itemCount)
    && isNonNegativeInteger(capability.pendingReviewCount)
    && isNonNegativeInteger(capability.unresolvedConflictCount)
    && isOneOf(capability.runtime, CONTROL_RUNTIME_STATES)
    && isOneOf(capability.support, CONTROL_SUPPORT_STATES);
}

function safePolicySnapshot(
  status: ExternalIntegrationPolicySnapshot['status'] = 'unknown',
  schemaMajor = 0,
): ExternalIntegrationPolicySnapshot {
  const safelyOff: EffectiveExternalIntegrationPolicy = {
    enabled: false,
    ecosystems: {},
  };
  return {
    schemaMajor,
    status,
    userDefaults: { enabled: false, ecosystems: {} },
    globalEffective: safelyOff,
    effective: safelyOff,
    registeredEcosystems: [],
  };
}

function normalizeOptionalArray<T>(value: unknown): T[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  throw new ExternalSourceApiError(
    'internal',
    'External source response included an invalid collection',
    true,
  );
}

function normalizePolicySnapshot(value: unknown): ExternalIntegrationPolicySnapshot {
  if (!value || typeof value !== 'object') return safePolicySnapshot();
  const candidate = value as Partial<ExternalIntegrationPolicySnapshot>;
  const schemaMajor = typeof candidate.schemaMajor === 'number' ? candidate.schemaMajor : 0;
  if (candidate.status === 'incompatible_schema') {
    return safePolicySnapshot('incompatible_schema', schemaMajor);
  }
  if (
    candidate.status !== 'compatible'
    || !candidate.userDefaults
    || typeof candidate.userDefaults.enabled !== 'boolean'
    || !candidate.globalEffective
    || typeof candidate.globalEffective.enabled !== 'boolean'
    || !candidate.globalEffective.ecosystems
    || !candidate.effective
    || typeof candidate.effective.enabled !== 'boolean'
    || !candidate.effective.ecosystems
    || !Array.isArray(candidate.registeredEcosystems)
  ) {
    return safePolicySnapshot(
      typeof candidate.status === 'string' ? candidate.status : 'unknown',
      schemaMajor,
    );
  }
  return {
    ...candidate,
    registeredEcosystems: candidate.registeredEcosystems.map((ecosystem) => ({
      ...ecosystem,
      capabilities: normalizeOptionalArray(ecosystem.capabilities),
    })),
  } as ExternalIntegrationPolicySnapshot;
}

function normalizeMcpDefinition(definition: ExternalMcpDefinition): ExternalMcpDefinition {
  const rawTimeouts = definition.timeouts;
  const timeouts = rawTimeouts && typeof rawTimeouts === 'object'
    ? Object.fromEntries(
      (['startupMs', 'catalogMs', 'executionMs'] as const)
        .map((key) => [key, rawTimeouts[key]] as const)
        .filter(([, value]) => Number.isSafeInteger(value) && (value ?? 0) > 0),
    ) as ExternalMcpTimeouts
    : undefined;
  return {
    ...definition,
    provenance: normalizeOptionalArray(definition.provenance),
    environmentKeys: normalizeOptionalArray(definition.environmentKeys),
    environmentReferenceNames: normalizeOptionalArray(definition.environmentReferenceNames),
    headerNames: normalizeOptionalArray(definition.headerNames),
    timeouts: timeouts && Object.keys(timeouts).length > 0 ? timeouts : undefined,
  };
}

function normalizeSnapshot(value: unknown): ExternalSourceCatalogSnapshot {
  if (!value || typeof value !== 'object') {
    throw new ExternalSourceApiError('internal', 'External source response was not usable', true);
  }
  const candidate = value as ExternalSourceCatalogSnapshot & {
    hostCapabilities?: Partial<ExternalSourceCatalogSnapshot['hostCapabilities']>;
    integrationPolicy?: unknown;
  };
  const capabilities = candidate.hostCapabilities;
  return {
    ...candidate,
    generation: typeof candidate.generation === 'number' ? candidate.generation : 0,
    discoveryPending: candidate.discoveryPending === true,
    sources: normalizeOptionalArray<ExternalSourceCatalogSnapshot['sources'][number]>(candidate.sources).map((source) => ({
      ...source,
      record: {
        ...source.record,
        diagnostics: normalizeOptionalArray(source.record.diagnostics),
      },
    })),
    commands: normalizeOptionalArray<ExternalSourceCatalogSnapshot['commands'][number]>(candidate.commands),
    commandConflicts: normalizeOptionalArray<NonNullable<ExternalSourceCatalogSnapshot['commandConflicts']>[number]>(candidate.commandConflicts).map((conflict) => ({
      ...conflict,
      candidates: normalizeOptionalArray(conflict.candidates),
    })),
    tools: normalizeOptionalArray<ExternalToolCatalogEntry>(candidate.tools).map((entry) => ({
      ...entry,
      definition: {
        ...entry.definition,
        capabilities: normalizeOptionalArray(entry.definition.capabilities),
      },
    })),
    toolApprovalRequests: normalizeOptionalArray<ExternalToolApprovalRequest>(candidate.toolApprovalRequests).map((request) => ({
      ...request,
      capabilities: normalizeOptionalArray(request.capabilities),
      toolNames: normalizeOptionalArray(request.toolNames),
    })),
    toolConflicts: normalizeOptionalArray<ExternalToolConflict>(candidate.toolConflicts).map((conflict) => ({
      ...conflict,
      candidates: normalizeOptionalArray(conflict.candidates),
    })),
    mcpServers: normalizeOptionalArray<ExternalMcpCatalogEntry>(candidate.mcpServers).map((entry) => ({
      ...entry,
      definition: normalizeMcpDefinition(entry.definition),
    })),
    mcpApprovalRequests: normalizeOptionalArray<ExternalMcpApprovalRequest>(candidate.mcpApprovalRequests).map((request) => ({
      ...request,
      definition: normalizeMcpDefinition(request.definition),
    })),
    mcpConflicts: normalizeOptionalArray<ExternalMcpConflict>(candidate.mcpConflicts).map((conflict) => ({
      ...conflict,
      candidates: normalizeOptionalArray(conflict.candidates),
    })),
    subagents: normalizeOptionalArray<ExternalSubagentSummary>(candidate.subagents).map((subagent) => ({
      ...subagent,
      mode: subagent.mode ?? 'subagent',
      requestedModel: subagent.requestedModel ?? { kind: 'default' },
      modelBindingMethod: subagent.modelBindingMethod ?? 'default',
      sourceKeys: normalizeOptionalArray(subagent.sourceKeys),
      sourceLocationLabels: normalizeOptionalArray(subagent.sourceLocationLabels),
      effectiveToolLabels: normalizeOptionalArray(subagent.effectiveToolLabels),
      unavailableToolLabels: normalizeOptionalArray(subagent.unavailableToolLabels),
      diagnostics: normalizeOptionalArray(subagent.diagnostics),
    })),
    subagentModelBindingGroups: normalizeOptionalArray<ExternalSubagentModelBindingGroup>(
      candidate.subagentModelBindingGroups,
    ).map((group) => ({
      ...group,
      affectedCandidateIds: normalizeOptionalArray(group.affectedCandidateIds),
    })),
    subagentModelBindingOptions: normalizeOptionalArray<ExternalSubagentModelBindingOption>(
      candidate.subagentModelBindingOptions,
    ),
    subagentConflicts: normalizeOptionalArray<ExternalSubagentConflict>(candidate.subagentConflicts).map((conflict) => ({
      ...conflict,
      candidates: normalizeOptionalArray(conflict.candidates),
    })),
    pendingSubagentApprovals: normalizeOptionalArray(candidate.pendingSubagentApprovals),
    diagnostics: normalizeOptionalArray(candidate.diagnostics),
    hostCapabilities: normalizeHostCapabilities(capabilities),
    integrationPolicy: normalizePolicySnapshot(candidate.integrationPolicy),
  };
}

function normalizeControlSnapshot(value: unknown): ExternalSourceControlSnapshot {
  if (!value || typeof value !== 'object') {
    throw new ExternalSourceApiError('invalid_response', 'External source control response was not usable', true);
  }
  const candidate = value as Partial<ExternalSourceControlSnapshot>;
  if (candidate.schemaVersion !== 1
    || typeof candidate.executionDomainId !== 'string'
    || !isNonNegativeInteger(candidate.refreshGeneration)
    || !isNonNegativeInteger(candidate.preferenceRevision)
    || typeof candidate.safeMode !== 'boolean'
    || !isHostCapabilities(candidate.hostCapabilities)
    || !Array.isArray(candidate.sources)
    || !Array.isArray(candidate.capabilities)
    || !candidate.sources.every(isControlSource)
    || !candidate.capabilities.every(isCapabilityControl)) {
    throw new ExternalSourceApiError('invalid_response', 'External source control schema was invalid', false);
  }
  return {
    ...candidate,
    hostCapabilities: normalizeHostCapabilities(candidate.hostCapabilities),
    diagnostics: normalizeOptionalArray(candidate.diagnostics),
    recoveryActions: normalizeRecoveryActions(candidate.recoveryActions, true),
  } as ExternalSourceControlSnapshot;
}

function normalizeSurfaceSnapshot(value: unknown): ExternalSourceSurfaceSnapshot {
  if (!value || typeof value !== 'object') {
    throw new ExternalSourceApiError('invalid_response', 'External source surface response was not usable', true);
  }
  const candidate = value as Partial<ExternalSourceSurfaceSnapshot>;
  const control = normalizeControlSnapshot(candidate.control);
  const rawCatalog = candidate.catalog;
  const catalog = normalizeSnapshot(candidate.catalog);
  if (catalog.generation !== control.refreshGeneration) {
    throw new ExternalSourceApiError(
      'invalid_response',
      'External source control and catalog generations did not match',
      true,
    );
  }
  if ((catalog.preferenceRevision ?? 0) !== control.preferenceRevision) {
    throw new ExternalSourceApiError(
      'invalid_response',
      'External source control and catalog preference revisions did not match',
      true,
    );
  }
  if (rawCatalog && typeof rawCatalog === 'object'
    && Object.prototype.hasOwnProperty.call(rawCatalog, 'hostCapabilities')) {
    const rawCapabilities = (rawCatalog as { hostCapabilities?: unknown }).hostCapabilities;
    if (!isHostCapabilities(rawCapabilities)
      || !hostCapabilitiesEqual(
        control.hostCapabilities,
        normalizeHostCapabilities(rawCapabilities),
      )) {
      throw new ExternalSourceApiError(
        'invalid_response',
        'External source control and catalog Host capabilities did not match',
        false,
      );
    }
  }
  return { control, catalog: { ...catalog, control } };
}

const OPERATION_ERROR_CODES = new Set<ExternalSourceOperationErrorCode>([
  'invalid_request',
  'host_unavailable',
  'host_capability_unavailable',
  'trust_required',
  'policy_incompatible',
  'policy_limited',
  'stale_revision',
  'conflict',
  'not_found',
  'unavailable',
  'runtime_unavailable',
  'unsupported',
  'incompatible_version',
  'dependency_failed',
  'timeout',
  'cancelled',
  'overloaded',
  'process_lost',
  'invalid_response',
  'temporarily_unavailable',
  'internal',
]);

function normalizeOperationReference(value: unknown): string | undefined {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 160
    || value.trim() !== value
    || Array.from(value).some(isControlCharacter)) {
    return undefined;
  }
  return value;
}

function normalizeOperationDetail(value: string): string {
  const bounded = Array.from(value)
    .slice(0, 4096)
    .map((character) => isControlCharacter(character) ? ' ' : character)
    .join('');
  return bounded.trim() ? bounded : 'External source operation failed';
}

function isControlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return codePoint !== undefined && (
    codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
  );
}

function parseOperationError(value: unknown, visited = new Set<unknown>()): ExternalSourceApiError | null {
  if (value === null || value === undefined || visited.has(value)) return null;
  visited.add(value);
  if (typeof value === 'string') {
    try {
      return parseOperationError(JSON.parse(value), visited);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.code === 'string' &&
    OPERATION_ERROR_CODES.has(record.code as ExternalSourceOperationErrorCode) &&
    typeof record.detail === 'string'
  ) {
    return new ExternalSourceApiError(
      record.code as ExternalSourceOperationErrorCode,
      normalizeOperationDetail(record.detail),
      record.retryable === true,
      normalizeOperationReference(record.correlationId),
      normalizeOperationReference(record.causationId),
      isOneOf(record.stage, OPERATION_STAGES) ? record.stage : undefined,
      normalizeRecoveryActions(record.recoveryActions, false),
    );
  }
  for (const candidate of [
    record.originalError,
    record.error,
    record.data,
    record.details,
    (record.context as Record<string, unknown> | undefined)?.originalError,
    (record.details as Record<string, unknown> | undefined)?.originalError,
  ]) {
    const parsed = parseOperationError(candidate, visited);
    if (parsed) return parsed;
  }
  return null;
}

export async function invokeExternalSourceCommand<T>(
  command: string,
  args: Record<string, unknown>,
): Promise<T> {
  try {
    const request = args.request as Record<string, unknown> | undefined;
    if (typeof request?.workspaceId === 'string') {
      const { workspaceId, ...rest } = request;
      const reference = await workspaceIdRequest(workspaceId, 'workspacePath');
      // Old external-source DTOs reject extra SSH fields. Remote workspaces
      // are unsupported by this local discovery surface on both versions.
      const wire = 'workspaceId' in reference ? { workspaceId } : { workspacePath: reference.workspacePath };
      args = { ...args, request: { ...rest, ...wire } };
    }
    return await api.invoke<T>(command, args);
  } catch (error) {
    const parsed = parseOperationError(error);
    let raw = typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : '';
    if (!raw) {
      try {
        raw = JSON.stringify(error) ?? '';
      } catch {
        raw = '';
      }
    }
    const normalized = raw.toLowerCase();
    const legacyPeerMissingCommand = raw.includes(command)
      && normalized.includes('not supported on cli peer host');
    const legacyServerMissingCommand = parsed?.code === 'host_capability_unavailable'
      && parsed.detail === 'Unknown Server Host operation';
    if (legacyPeerMissingCommand
      || legacyServerMissingCommand
      || (raw.includes(command)
      && (normalized.includes('unknown command')
        || normalized.includes('not found')
        || normalized.includes('not registered')))) {
      throw new ExternalSourceApiError(
        'incompatible_version',
        'The connected Host does not support this external source command',
        false,
      );
    }
    throw parsed ?? new ExternalSourceApiError(
      'internal',
      'External source operation failed',
      false,
    );
  }
}

async function invokeSnapshot(
  command: string,
  args: Record<string, unknown>,
): Promise<ExternalSourceCatalogSnapshot> {
  await invokeExternalSourceCommand<unknown>(command, args);
  const request = args.request && typeof args.request === 'object'
    ? args.request as Record<string, unknown>
    : {};
  return (await invokeCompatibleSurfaceSnapshot({
    request: {
      workspaceId: request.workspaceId,
      forceRefresh: false,
    },
  })).catalog;
}

async function invokeSurfaceSnapshot(
  command: string,
  args: Record<string, unknown>,
): Promise<ExternalSourceSurfaceSnapshot> {
  return normalizeSurfaceSnapshot(await invokeExternalSourceCommand<unknown>(command, args));
}

function legacySurfaceSnapshot(catalog: ExternalSourceCatalogSnapshot): ExternalSourceSurfaceSnapshot {
  const hostCapabilities = {
    ...catalog.hostCapabilities,
    canSetSafeMode: false,
    canRevealSourceLocation: false,
  };
  const control: ExternalSourceControlSnapshot = {
    schemaVersion: 1,
    executionDomainId: catalog.sources[0]?.record.executionDomainId ?? 'legacy-host',
    refreshGeneration: catalog.generation,
    preferenceRevision: catalog.preferenceRevision ?? 0,
    safeMode: false,
    hostCapabilities,
    sources: [],
    capabilities: [],
    diagnostics: catalog.diagnostics ?? [],
    recoveryActions: [{ type: 'reconnect_host' }],
  };
  return {
    control,
    catalog: { ...catalog, hostCapabilities, control },
  };
}

async function invokeCompatibleSurfaceSnapshot(
  args: Record<string, unknown>,
): Promise<ExternalSourceSurfaceSnapshot> {
  try {
    return await invokeSurfaceSnapshot('get_external_source_control_snapshot', args);
  } catch (error) {
    if (!(error instanceof ExternalSourceApiError) || error.code !== 'incompatible_version') {
      throw error;
    }
    const catalog = normalizeSnapshot(await invokeExternalSourceCommand<unknown>(
      'get_external_source_snapshot',
      args,
    ));
    return legacySurfaceSnapshot(catalog);
  }
}

export function normalizeOptionalWorkspaceId(
  workspaceId: string | undefined,
): string | undefined {
  if (workspaceId === undefined) return undefined;
  const normalized = workspaceId.trim();
  if (!normalized) throw new Error('Workspace identity is unresolved');
  return normalized;
}

let operationSequence = 0;

function nextOperationId(action: ExternalSourceControlAction['type']): string {
  operationSequence += 1;
  return `web-${action}-${Date.now().toString(36)}-${operationSequence.toString(36)}`;
}

function controlRequest(
  action: ExternalSourceControlAction,
  expectedPreferenceRevision?: number,
): ExternalSourceControlRequest {
  return {
    schemaVersion: 1,
    operationId: nextOperationId(action.type),
    ...(expectedPreferenceRevision === undefined ? {} : { expectedPreferenceRevision }),
    action,
  };
}

function emitExternalAgentCatalogUpdated(workspaceId?: string) {
  globalEventBus.emit('mode:config:updated', {
    reason: 'external-agent-catalog-updated',
    workspaceId: normalizeOptionalWorkspaceId(workspaceId),
  });
}

export const externalSourcesAPI = {
  planMcpImport(workspaceId?: string) {
    return invokeExternalSourceCommand<ExternalMcpImportPlanV1>(
      'plan_external_mcp_import_command',
      { request: { workspaceId: normalizeOptionalWorkspaceId(workspaceId) } },
    );
  },

  async applyMcpImport(
    workspaceId: string | undefined,
    plan: ExternalMcpImportPlanV1,
    selections: ExternalMcpImportSelectionV1[],
  ) {
    const scope = getActiveSurfaceScope();
    const result = await invokeExternalSourceCommand<ExternalMcpImportApplyResultV1>(
      'apply_external_mcp_import_command',
      {
        request: {
          workspaceId: normalizeOptionalWorkspaceId(workspaceId),
          importRequest: {
            schemaVersion: 1,
            planFingerprint: plan.planFingerprint,
            selections,
          },
        },
      },
    );
    scope.assertCurrent('confirm MCP import');
    if (result.outcome.status === 'applied') notifyMcpConfigChanged(scope);
    return result;
  },

  async getControlSnapshot(workspaceId?: string, forceRefresh = false) {
    return invokeCompatibleSurfaceSnapshot({
      request: { workspaceId: normalizeOptionalWorkspaceId(workspaceId), forceRefresh },
    });
  },

  revealSourceLocation(workspaceId: string | undefined, sourceKey: string) {
    return invokeExternalSourceCommand<void>('reveal_external_source_location', {
      request: {
        workspaceId: normalizeOptionalWorkspaceId(workspaceId),
        sourceKey,
      },
    });
  },

  async getDiscoverySnapshot(workspaceId?: string, forceRefresh = false): Promise<ExternalSourceCatalogSnapshot> {
    try {
      const value = await invokeExternalSourceCommand<{
        schemaVersion: number;
        automaticDiscovery: boolean;
        canChangeAutomaticDiscovery: boolean;
        hasScanned: boolean;
        discoverableCapabilities: Record<string, string[]>;
        preferenceRevision: number;
        catalog: unknown;
      }>('get_external_source_discovery_snapshot', {
        request: { workspaceId: normalizeOptionalWorkspaceId(workspaceId), forceRefresh },
      });
      if (!value || typeof value !== 'object') {
        throw new ExternalSourceApiError('invalid_response', 'Invalid discovery snapshot', false);
      }
      if (value.schemaVersion !== 1) {
        throw new ExternalSourceApiError('incompatible_version', 'Unsupported discovery snapshot version', false);
      }
      if (typeof value.automaticDiscovery !== 'boolean'
        || typeof value.canChangeAutomaticDiscovery !== 'boolean' || typeof value.hasScanned !== 'boolean'
        || !isNonNegativeInteger(value.preferenceRevision)
        || !value.discoverableCapabilities || typeof value.discoverableCapabilities !== 'object'
        || Array.isArray(value.discoverableCapabilities)
        || !Object.values(value.discoverableCapabilities).every((ids) => Array.isArray(ids) && ids.every((id) => typeof id === 'string'))) {
        throw new ExternalSourceApiError('invalid_response', 'Invalid discovery snapshot', false);
      }
      return {
        ...normalizeSnapshot(value.catalog),
        preferenceRevision: value.preferenceRevision,
        discovery: {
          enabled: value.automaticDiscovery,
          canChange: value.canChangeAutomaticDiscovery,
          hasScanned: value.hasScanned,
          discoverableCapabilities: value.discoverableCapabilities,
          preferenceRevision: value.preferenceRevision,
        },
      };
    } catch (error) {
      if (!(error instanceof ExternalSourceApiError) || error.code !== 'incompatible_version') throw error;
      // Old hosts remain viewable, but never receive the new mutation.
      return this.getSnapshot(workspaceId, forceRefresh);
    }
  },

  async setAutomaticDiscovery(workspaceId: string | undefined, enabled: boolean, expectedPreferenceRevision: number) {
    const path = normalizeOptionalWorkspaceId(workspaceId);
    await invokeExternalSourceCommand('update_external_integration_policy_command', {
      request: {
        workspaceId: normalizeOptionalWorkspaceId(workspaceId),
        mutation: { expectedPreferenceRevision, scope: path ? 'workspace' : 'user',
          change: { operation: 'set_automatic_discovery', enabled } },
      },
    });
    return this.getDiscoverySnapshot(workspaceId);
  },

  async getSnapshot(workspaceId?: string, forceRefresh = false) {
    return (await invokeCompatibleSurfaceSnapshot({
      request: { workspaceId: normalizeOptionalWorkspaceId(workspaceId), forceRefresh },
    })).catalog;
  },

  async getWorkspaceReferences(
    workspaceId: string,
    forceRefresh = false,
  ) {
    const snapshot = await invokeExternalSourceCommand<WorkspaceReferenceSnapshot>(
      'get_workspace_reference_snapshot',
      {
        request: {
          workspaceId: normalizeOptionalWorkspaceId(workspaceId),
          forceRefresh,
        },
      },
    );
    return {
      ...snapshot,
      references: normalizeOptionalArray<WorkspaceReferenceEntry>(snapshot.references),
      diagnostics: normalizeOptionalArray<NonNullable<WorkspaceReferenceSnapshot['diagnostics']>[number]>(
        snapshot.diagnostics,
      ),
    };
  },

  async expandPromptCommand(
    workspaceId: string | undefined,
    name: string,
    argumentsText: string,
    candidateId: string,
    expectedContentVersion: string,
    nativeCommands: NativePromptCommandDescriptor[],
    nativeConflictGuard?: {
      conflictKey: string;
      expectedPreferenceRevision: number;
    },
    shellReviewDecision?: PromptCommandShellReviewDecision,
  ) {
    const outcome = await invokeExternalSourceCommand<unknown>(
      'expand_external_prompt_command_command',
      {
        request: {
          workspaceId: normalizeOptionalWorkspaceId(workspaceId),
          name,
          arguments: argumentsText,
          nativeCommands,
          candidateId,
          expectedContentVersion,
          ...(nativeConflictGuard ? {
            expectedNativeConflictKey: nativeConflictGuard.conflictKey,
            expectedPreferenceRevision: nativeConflictGuard.expectedPreferenceRevision,
          } : {}),
          ...(shellReviewDecision ? { shellReviewDecision } : {}),
        },
      },
    );
    return normalizePromptCommandInvocationOutcome(outcome);
  },

  getNativePromptCommandConflicts(
    workspaceId: string | undefined,
    nativeCommands: NativePromptCommandDescriptor[],
  ) {
    return invokeExternalSourceCommand<NativePromptCommandConflictSnapshot>(
      'get_native_prompt_command_conflicts_command',
      {
        request: {
          workspaceId: normalizeOptionalWorkspaceId(workspaceId),
          nativeCommands,
        },
      },
    );
  },

  setNativePromptCommandConflictChoice(
    workspaceId: string | undefined,
    nativeCommands: NativePromptCommandDescriptor[],
    selectedCandidateId: string,
    expectedPreferenceRevision: number,
  ) {
    return invokeExternalSourceCommand<NativePromptCommandConflictSnapshot>(
      'set_native_prompt_command_conflict_choice_command',
      {
        request: {
          workspaceId: normalizeOptionalWorkspaceId(workspaceId),
          nativeCommands,
          selectedCandidateId,
          expectedPreferenceRevision,
        },
      },
    );
  },

  async setSourceEnabled(
    workspaceId: string | undefined,
    sourceKey: string,
    enabled: boolean,
    expectedPreferenceRevision: number,
  ) {
    const normalizedWorkspaceId = normalizeOptionalWorkspaceId(workspaceId);
    try {
      const surface = await invokeSurfaceSnapshot('apply_external_source_control_action_command', {
        request: {
          workspaceId: normalizedWorkspaceId,
          control: controlRequest(
            { type: 'set_source_enabled', sourceKey, enabled },
            expectedPreferenceRevision,
          ),
        },
      });
      emitExternalAgentCatalogUpdated(workspaceId);
      return surface.catalog;
    } catch (error) {
      if (!(error instanceof ExternalSourceApiError) || error.code !== 'incompatible_version') {
        throw error;
      }
      const catalog = await invokeSnapshot('set_external_source_enabled_command', {
        request: {
          workspaceId: normalizedWorkspaceId,
          sourceKey,
          enabled,
          expectedPreferenceRevision,
        },
      });
      emitExternalAgentCatalogUpdated(workspaceId);
      return catalog;
    }
  },

  async setSafeMode(
    workspaceId: string | undefined,
    enabled: boolean,
    expectedPreferenceRevision: number,
  ) {
    const surface = await invokeSurfaceSnapshot('apply_external_source_control_action_command', {
      request: {
        workspaceId: normalizeOptionalWorkspaceId(workspaceId),
        control: controlRequest(
          { type: 'set_safe_mode', enabled },
          expectedPreferenceRevision,
        ),
      },
    });
    return surface.catalog;
  },

  setConflictChoice(
    workspaceId: string | undefined,
    conflictKey: string,
    candidateId: string,
    expectedPreferenceRevision: number,
  ) {
    return invokeSnapshot('set_external_source_conflict_choice_command', {
      request: {
        workspaceId: normalizeOptionalWorkspaceId(workspaceId),
        conflictKey,
        candidateId,
        expectedPreferenceRevision,
      },
    });
  },

  setToolTargetDecision(
    workspaceId: string | undefined,
    approvalKey: string,
    decisionKey: string,
    approved: boolean,
    expectedPreferenceRevision: number,
  ) {
    return invokeSnapshot('set_external_tool_target_decision_command', {
      request: {
        workspaceId: normalizeOptionalWorkspaceId(workspaceId),
        approvalKey,
        decisionKey,
        approved,
        expectedPreferenceRevision,
      },
    });
  },

  setToolTargetsEnabled(
    workspaceId: string | undefined,
    decisions: Array<{ approvalKey: string; decisionKey: string }>,
    enabled: boolean,
    expectedCatalogGeneration: number,
    expectedPreferenceRevision: number,
  ) {
    return invokeSnapshot('set_external_tool_targets_enabled_command', {
      request: {
        workspaceId: normalizeOptionalWorkspaceId(workspaceId),
        decisions,
        enabled,
        expectedCatalogGeneration,
        expectedPreferenceRevision,
      },
    });
  },

  setToolConflictChoice(
    workspaceId: string | undefined,
    conflictKey: string,
    candidateId: string,
    expectedPreferenceRevision: number,
  ) {
    return invokeSnapshot('set_external_tool_conflict_choice_command', {
      request: {
        workspaceId: normalizeOptionalWorkspaceId(workspaceId),
        conflictKey,
        candidateId,
        expectedPreferenceRevision,
      },
    });
  },

  async setSubagentActivation(
    workspaceId: string | undefined,
    candidateId: string,
    approved: boolean,
    expectedSubagentGeneration: number,
    expectedPreferenceRevision: number,
    decisionKey: string,
  ) {
    const catalog = await invokeSnapshot('set_external_subagent_activation_command', {
      request: {
        workspaceId: normalizeOptionalWorkspaceId(workspaceId),
        candidateId,
        approved,
        expectedSubagentGeneration,
        expectedPreferenceRevision,
        decisionKey,
      },
    });
    emitExternalAgentCatalogUpdated(workspaceId);
    return catalog;
  },

  async setSubagentsEnabled(
    workspaceId: string | undefined,
    decisions: Array<{ candidateId: string; decisionKey: string }>,
    enabled: boolean,
    expectedSubagentGeneration: number,
    expectedPreferenceRevision: number,
  ) {
    const catalog = await invokeSnapshot('set_external_subagents_enabled_command', {
      request: {
        workspaceId: normalizeOptionalWorkspaceId(workspaceId),
        decisions,
        enabled,
        expectedSubagentGeneration,
        expectedPreferenceRevision,
      },
    });
    emitExternalAgentCatalogUpdated(workspaceId);
    return catalog;
  },

  async setSubagentModelBinding(
    workspaceId: string | undefined,
    bindingKey: string,
    target: ExternalSubagentModelBindingTarget | undefined,
    expectedSubagentGeneration: number,
    expectedPreferenceRevision: number,
  ) {
    const catalog = await invokeSnapshot('set_external_subagent_model_binding_command', {
      request: {
        workspaceId: normalizeOptionalWorkspaceId(workspaceId),
        bindingKey,
        target,
        expectedSubagentGeneration,
        expectedPreferenceRevision,
      },
    });
    emitExternalAgentCatalogUpdated(workspaceId);
    return catalog;
  },

  async chooseSubagentConflict(
    workspaceId: string | undefined,
    conflictKey: string,
    candidateId: string,
    approveExternal: boolean,
    expectedSubagentGeneration: number,
    expectedPreferenceRevision: number,
  ) {
    const catalog = await invokeSnapshot('choose_external_subagent_conflict_command', {
      request: {
        workspaceId: normalizeOptionalWorkspaceId(workspaceId),
        conflictKey,
        candidateId,
        approveExternal,
        expectedSubagentGeneration,
        expectedPreferenceRevision,
      },
    });
    emitExternalAgentCatalogUpdated(workspaceId);
    return catalog;
  },

  setMcpServerDecision(
    workspaceId: string | undefined,
    candidateId: string,
    decisionKey: string,
    approved: boolean,
    expectedMcpGeneration: number,
    expectedPreferenceRevision: number,
  ) {
    return invokeSnapshot('set_external_mcp_server_decision_command', {
      request: {
        workspaceId: normalizeOptionalWorkspaceId(workspaceId),
        candidateId,
        decisionKey,
        approved,
        expectedMcpGeneration,
        expectedPreferenceRevision,
      },
    });
  },

  setMcpServersEnabled(
    workspaceId: string | undefined,
    decisions: Array<{ candidateId: string; decisionKey: string }>,
    enabled: boolean,
    expectedMcpGeneration: number,
    expectedPreferenceRevision: number,
  ) {
    return invokeSnapshot('set_external_mcp_servers_enabled_command', {
      request: {
        workspaceId: normalizeOptionalWorkspaceId(workspaceId),
        decisions,
        enabled,
        expectedMcpGeneration,
        expectedPreferenceRevision,
      },
    });
  },

  chooseMcpConflict(
    workspaceId: string | undefined,
    conflictKey: string,
    candidateId: string,
    approveExternal: boolean,
    expectedMcpGeneration: number,
    expectedPreferenceRevision: number,
  ) {
    return invokeSnapshot('choose_external_mcp_conflict_command', {
      request: {
        workspaceId: normalizeOptionalWorkspaceId(workspaceId),
        conflictKey,
        candidateId,
        approveExternal,
        expectedMcpGeneration,
        expectedPreferenceRevision,
      },
    });
  },

  async updateIntegrationPolicy(
    workspaceId: string | undefined,
    mutation: ExternalIntegrationPolicyMutation,
  ) {
    const catalog = await invokeSnapshot(
      'update_external_integration_policy_command',
      { request: { workspaceId: normalizeOptionalWorkspaceId(workspaceId), mutation } },
    );
    emitExternalAgentCatalogUpdated(workspaceId);
    return catalog;
  },

  /**
   * External applications found on this host that the user has never been told
   * about. The host owns this derivation so the desktop and the TUI cannot
   * disagree about what counts as new.
   */
  async getEcosystemAwareness(workspaceId?: string): Promise<string[]> {
    const response = await invokeExternalSourceCommand<{
      unacknowledgedEcosystemIds?: unknown;
    }>('get_external_ecosystem_awareness_command', {
      request: { workspaceId: normalizeOptionalWorkspaceId(workspaceId) },
    });
    return normalizeOptionalArray<string>(response.unacknowledgedEcosystemIds)
      .filter((ecosystemId): ecosystemId is string => typeof ecosystemId === 'string');
  },

  /** Clears the "new external application" hint for these ecosystems. */
  acknowledgeEcosystems(workspaceId: string | undefined, ecosystemIds: string[]) {
    return invokeExternalSourceCommand<void>('acknowledge_external_ecosystems_command', {
      request: {
        workspaceId: normalizeOptionalWorkspaceId(workspaceId),
        ecosystemIds,
      },
    });
  },
};
