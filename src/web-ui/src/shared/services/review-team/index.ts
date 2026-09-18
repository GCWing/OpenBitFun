// Public Review Team service facade over smaller implementation modules.

import { configAPI } from '@/infrastructure/api/service-api/ConfigAPI';
import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import {
  SubagentAPI,
  type SubagentInfo,
} from '@/infrastructure/api/service-api/SubagentAPI';
import {
  classifyReviewTargetFromFiles,
  createUnknownReviewTargetClassification,
  type ReviewTargetClassification,
} from '../reviewTargetClassifier';
import { evaluateReviewSubagentToolReadiness } from '../reviewSubagentCapabilities';
import {
  DEFAULT_REVIEW_MEMBER_STRATEGY_LEVEL,
  CORE_ROLE_IDS,
  DEFAULT_REVIEW_TEAM_CONCURRENCY_POLICY,
  DEFAULT_REVIEW_TEAM_CONFIG_PATH,
  DEFAULT_REVIEW_TEAM_CORE_ROLES,
  DEFAULT_REVIEW_TEAM_EXECUTION_POLICY,
  DEFAULT_REVIEW_TEAM_MODEL,
  DEFAULT_REVIEW_TEAM_RATE_LIMIT_STATUS_CONFIG_PATH,
  DEFAULT_REVIEW_TEAM_STRATEGY_LEVEL,
  DISALLOWED_REVIEW_TEAM_MEMBER_IDS,
  EXTRA_MEMBER_DEFAULTS,
  FALLBACK_REVIEW_TEAM_DEFINITION,
  LEGACY_REVIEW_WORKER_AGENT_IDS,
  MAX_AUTO_RETRY_ELAPSED_GUARD_SECONDS,
  MAX_PARALLEL_REVIEWER_INSTANCES,
  MAX_QUEUE_WAIT_SECONDS,
  REVIEW_STRATEGY_RUNTIME_BUDGETS,
  REVIEW_WORK_PACKET_ALLOWED_TOOLS,
} from './defaults';
import {
  REVIEW_STRATEGY_LEVELS,
  REVIEW_STRATEGY_PROFILES,
} from './strategy';
import { buildPreReviewSummary } from './preReviewSummary';
import { buildDeepReviewEvidencePack } from './evidencePack';
import {
  applyTeamStrategyOverrideToMember,
  toManifestMember,
} from './manifestMembers';
import {
  buildReviewStrategyDecision,
  recommendBackendCompatibleStrategyForTarget,
  recommendReviewStrategyForTarget,
} from './risk';
import { buildDeepReviewScopeProfile } from './scopeProfile';
import {
  buildEffectiveExecutionPolicy,
  buildTokenBudgetPlan,
} from './tokenBudget';
import {
  buildManagedReviewWorkPackets,
  resolveChangeStats,
  resolveMaxExtraReviewers,
} from './workPackets';
import { buildReviewTeamPromptBlockContent } from './promptBlock';
import type {
  ReviewMemberStrategyLevel,
  ReviewModelFallbackReason,
  ReviewStrategyLevel,
  ReviewStrategyProfile,
  ReviewStrategySource,
  ReviewTargetEvidence,
  ReviewTeam,
  ReviewTeamChangeStats,
  ReviewTeamConcurrencyPolicy,
  ReviewTeamCoreRoleDefinition,
  ReviewTeamCoreRoleKey,
  ReviewTeamDefinition,
  ReviewTeamExecutionPolicy,
  ReviewTeamManifestMemberReason,
  ReviewTeamMember,
  ReviewTeamRateLimitStatus,
  ReviewTeamRunManifest,
  ReviewTeamStoredConfig,
  ReviewTeamWorkPacket,
  ReviewTokenBudgetMode,
} from './types';

export * from './types';
export * from './strategy';
export * from './targetEvidence';
export { buildReviewRiskFactors, recommendReviewStrategyForTarget } from './risk';
export {
  DEFAULT_REVIEW_TEAM_ID,
  DEFAULT_REVIEW_TEAM_CONFIG_PATH,
  DEFAULT_REVIEW_TEAM_RATE_LIMIT_STATUS_CONFIG_PATH,
  DEFAULT_REVIEW_TEAM_MODEL,
  DEFAULT_REVIEW_TEAM_STRATEGY_LEVEL,
  DEFAULT_REVIEW_MEMBER_STRATEGY_LEVEL,
  DEFAULT_REVIEW_TEAM_EXECUTION_POLICY,
  DEFAULT_REVIEW_TEAM_CONCURRENCY_POLICY,
  DEFAULT_REVIEW_TEAM_CORE_ROLES,
  REVIEW_TEAM_MEMBER_ACCENT_DEFAULT,
  FALLBACK_REVIEW_TEAM_DEFINITION,
} from './defaults';

function isReviewTeamCoreRoleDefinition(value: unknown): value is ReviewTeamCoreRoleDefinition {
  if (!value || typeof value !== 'object') return false;
  const role = value as Partial<ReviewTeamCoreRoleDefinition>;
  return (
    typeof role.key === 'string' &&
    typeof role.subagentId === 'string' &&
    typeof role.funName === 'string' &&
    typeof role.roleName === 'string' &&
    typeof role.description === 'string' &&
    Array.isArray(role.responsibilities) &&
    role.responsibilities.every((item) => typeof item === 'string') &&
    typeof role.accentColor === 'string'
  );
}

function isReviewStrategyProfile(value: unknown): value is ReviewStrategyProfile {
  if (!value || typeof value !== 'object') return false;
  const profile = value as Partial<ReviewStrategyProfile>;
  return (
    isReviewStrategyLevel(profile.level) &&
    typeof profile.label === 'string' &&
    typeof profile.summary === 'string' &&
    (profile.defaultModelSlot === 'fast' || profile.defaultModelSlot === 'primary') &&
    typeof profile.promptDirective === 'string' &&
    Boolean(profile.roleDirectives) &&
    typeof profile.roleDirectives === 'object'
  );
}

function nonEmptyStringOrFallback(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }

  return value.trim() || fallback;
}

function normalizeReviewTeamDefinition(raw: unknown): ReviewTeamDefinition {
  if (!raw || typeof raw !== 'object') {
    return FALLBACK_REVIEW_TEAM_DEFINITION;
  }

  const source = raw as Partial<ReviewTeamDefinition>;
  const coreRoles = Array.isArray(source.coreRoles)
    ? source.coreRoles.filter(isReviewTeamCoreRoleDefinition)
    : [];
  const strategyProfiles = REVIEW_STRATEGY_LEVELS.reduce<
    Partial<Record<ReviewStrategyLevel, ReviewStrategyProfile>>
  >((profiles, level) => {
    const profile = source.strategyProfiles?.[level];
    profiles[level] = isReviewStrategyProfile(profile)
      ? profile
      : FALLBACK_REVIEW_TEAM_DEFINITION.strategyProfiles[level];
    return profiles;
  }, {}) as Record<ReviewStrategyLevel, ReviewStrategyProfile>;
  const disallowedExtraSubagentIds = Array.isArray(source.disallowedExtraSubagentIds)
    ? dedupeIds(source.disallowedExtraSubagentIds.filter((id): id is string => typeof id === 'string'))
    : [];
  const hiddenAgentIds = Array.isArray(source.hiddenAgentIds)
    ? dedupeIds(source.hiddenAgentIds.filter((id): id is string => typeof id === 'string'))
    : [];

  return {
    id: nonEmptyStringOrFallback(source.id, FALLBACK_REVIEW_TEAM_DEFINITION.id),
    name: nonEmptyStringOrFallback(source.name, FALLBACK_REVIEW_TEAM_DEFINITION.name),
    description: nonEmptyStringOrFallback(
      source.description,
      FALLBACK_REVIEW_TEAM_DEFINITION.description,
    ),
    warning: nonEmptyStringOrFallback(
      source.warning,
      FALLBACK_REVIEW_TEAM_DEFINITION.warning,
    ),
    defaultModel: nonEmptyStringOrFallback(
      source.defaultModel,
      FALLBACK_REVIEW_TEAM_DEFINITION.defaultModel,
    ),
    defaultStrategyLevel: isReviewStrategyLevel(source.defaultStrategyLevel)
      ? source.defaultStrategyLevel
      : FALLBACK_REVIEW_TEAM_DEFINITION.defaultStrategyLevel,
    defaultExecutionPolicy: source.defaultExecutionPolicy
      ? {
        reviewerTimeoutSeconds: clampInteger(
          source.defaultExecutionPolicy.reviewerTimeoutSeconds,
          0,
          3600,
          FALLBACK_REVIEW_TEAM_DEFINITION.defaultExecutionPolicy.reviewerTimeoutSeconds,
        ),
        judgeTimeoutSeconds: clampInteger(
          source.defaultExecutionPolicy.judgeTimeoutSeconds,
          0,
          3600,
          FALLBACK_REVIEW_TEAM_DEFINITION.defaultExecutionPolicy.judgeTimeoutSeconds,
        ),
        reviewerFileSplitThreshold: clampInteger(
          source.defaultExecutionPolicy.reviewerFileSplitThreshold,
          0,
          9999,
          FALLBACK_REVIEW_TEAM_DEFINITION.defaultExecutionPolicy.reviewerFileSplitThreshold,
        ),
        maxSameRoleInstances: clampInteger(
          source.defaultExecutionPolicy.maxSameRoleInstances,
          1,
          8,
          FALLBACK_REVIEW_TEAM_DEFINITION.defaultExecutionPolicy.maxSameRoleInstances,
        ),
        maxRetriesPerRole: clampInteger(
          source.defaultExecutionPolicy.maxRetriesPerRole,
          0,
          3,
          FALLBACK_REVIEW_TEAM_DEFINITION.defaultExecutionPolicy.maxRetriesPerRole,
        ),
      }
      : FALLBACK_REVIEW_TEAM_DEFINITION.defaultExecutionPolicy,
    coreRoles: coreRoles.length > 0 ? coreRoles : FALLBACK_REVIEW_TEAM_DEFINITION.coreRoles,
    strategyProfiles,
    disallowedExtraSubagentIds:
      disallowedExtraSubagentIds.length > 0
        ? disallowedExtraSubagentIds
        : FALLBACK_REVIEW_TEAM_DEFINITION.disallowedExtraSubagentIds,
    hiddenAgentIds:
      hiddenAgentIds.length > 0
        ? hiddenAgentIds
        : FALLBACK_REVIEW_TEAM_DEFINITION.hiddenAgentIds,
  };
}

export async function loadDefaultReviewTeamDefinition(): Promise<ReviewTeamDefinition> {
  try {
    return normalizeReviewTeamDefinition(
      await agentAPI.getDefaultReviewTeamDefinition(),
    );
  } catch {
    return FALLBACK_REVIEW_TEAM_DEFINITION;
  }
}

function dedupeIds(ids: string[]): string[] {
  return Array.from(
    new Set(
      ids
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  );
}

function isReviewStrategyLevel(value: unknown): value is ReviewStrategyLevel {
  return (
    typeof value === 'string' &&
    REVIEW_STRATEGY_LEVELS.includes(value as ReviewStrategyLevel)
  );
}

function normalizeTeamStrategyLevel(value: unknown): ReviewStrategyLevel {
  return isReviewStrategyLevel(value)
    ? value
    : DEFAULT_REVIEW_TEAM_STRATEGY_LEVEL;
}

function normalizeMemberStrategyOverrides(
  raw: unknown,
): Record<string, ReviewStrategyLevel> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  return Object.entries(raw as Record<string, unknown>).reduce<
    Record<string, ReviewStrategyLevel>
  >((result, [subagentId, value]) => {
    const normalizedId = subagentId.trim();
    if (!normalizedId) {
      return result;
    }
    if (isReviewStrategyLevel(value)) {
      result[normalizedId] = value;
    } else {
      console.warn(
        `[ReviewTeamService] Ignoring invalid strategy override for '${normalizedId}': expected one of ${REVIEW_STRATEGY_LEVELS.join(', ')}, got '${value}'`,
      );
    }
    return result;
  }, {});
}

function clampInteger(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.floor(numeric)));
}

function normalizeConcurrencyPolicy(
  raw?: Partial<ReviewTeamConcurrencyPolicy>,
): ReviewTeamConcurrencyPolicy {
  return {
    maxParallelInstances: clampInteger(
      raw?.maxParallelInstances,
      1,
      MAX_PARALLEL_REVIEWER_INSTANCES,
      DEFAULT_REVIEW_TEAM_CONCURRENCY_POLICY.maxParallelInstances,
    ),
    staggerSeconds: clampInteger(
      raw?.staggerSeconds,
      0,
      60,
      DEFAULT_REVIEW_TEAM_CONCURRENCY_POLICY.staggerSeconds,
    ),
    maxQueueWaitSeconds: clampInteger(
      raw?.maxQueueWaitSeconds,
      0,
      MAX_QUEUE_WAIT_SECONDS,
      DEFAULT_REVIEW_TEAM_CONCURRENCY_POLICY.maxQueueWaitSeconds,
    ),
    batchExtrasSeparately:
      typeof raw?.batchExtrasSeparately === 'boolean'
        ? raw.batchExtrasSeparately
        : DEFAULT_REVIEW_TEAM_CONCURRENCY_POLICY.batchExtrasSeparately,
    allowProviderCapacityQueue:
      typeof raw?.allowProviderCapacityQueue === 'boolean'
        ? raw.allowProviderCapacityQueue
        : DEFAULT_REVIEW_TEAM_CONCURRENCY_POLICY.allowProviderCapacityQueue,
    allowBoundedAutoRetry:
      typeof raw?.allowBoundedAutoRetry === 'boolean'
        ? raw.allowBoundedAutoRetry
        : DEFAULT_REVIEW_TEAM_CONCURRENCY_POLICY.allowBoundedAutoRetry,
    autoRetryElapsedGuardSeconds: clampInteger(
      raw?.autoRetryElapsedGuardSeconds,
      30,
      MAX_AUTO_RETRY_ELAPSED_GUARD_SECONDS,
      DEFAULT_REVIEW_TEAM_CONCURRENCY_POLICY.autoRetryElapsedGuardSeconds,
    ),
  };
}

function normalizeStoredConcurrencyPolicy(
  raw: unknown,
): Pick<
  ReviewTeamStoredConfig,
  | 'max_parallel_reviewers'
  | 'max_queue_wait_seconds'
  | 'allow_provider_capacity_queue'
  | 'allow_bounded_auto_retry'
  | 'auto_retry_elapsed_guard_seconds'
> {
  const config = raw as Partial<ReviewTeamStoredConfig> | undefined;

  return {
    max_parallel_reviewers: clampInteger(
      config?.max_parallel_reviewers,
      1,
      MAX_PARALLEL_REVIEWER_INSTANCES,
      DEFAULT_REVIEW_TEAM_CONCURRENCY_POLICY.maxParallelInstances,
    ),
    max_queue_wait_seconds: clampInteger(
      config?.max_queue_wait_seconds,
      0,
      MAX_QUEUE_WAIT_SECONDS,
      DEFAULT_REVIEW_TEAM_CONCURRENCY_POLICY.maxQueueWaitSeconds,
    ),
    allow_provider_capacity_queue:
      typeof config?.allow_provider_capacity_queue === 'boolean'
        ? config.allow_provider_capacity_queue
        : DEFAULT_REVIEW_TEAM_CONCURRENCY_POLICY.allowProviderCapacityQueue,
    allow_bounded_auto_retry:
      typeof config?.allow_bounded_auto_retry === 'boolean'
        ? config.allow_bounded_auto_retry
        : DEFAULT_REVIEW_TEAM_CONCURRENCY_POLICY.allowBoundedAutoRetry,
    auto_retry_elapsed_guard_seconds: clampInteger(
      config?.auto_retry_elapsed_guard_seconds,
      30,
      MAX_AUTO_RETRY_ELAPSED_GUARD_SECONDS,
      DEFAULT_REVIEW_TEAM_CONCURRENCY_POLICY.autoRetryElapsedGuardSeconds,
    ),
  };
}

function applyRateLimitToConcurrencyPolicy(
  policy: ReviewTeamConcurrencyPolicy,
  rateLimitStatus?: ReviewTeamRateLimitStatus | null,
): ReviewTeamConcurrencyPolicy {
  const remaining = Math.floor(Number(rateLimitStatus?.remaining));
  if (!Number.isFinite(remaining)) {
    return policy;
  }

  if (remaining > policy.maxParallelInstances * 2) {
    return policy;
  }

  if (remaining > policy.maxParallelInstances) {
    return {
      ...policy,
      staggerSeconds: Math.max(policy.staggerSeconds, 5),
    };
  }

  return {
    ...policy,
    maxParallelInstances: Math.max(
      1,
      Math.min(policy.maxParallelInstances, Math.max(2, remaining)),
    ),
    staggerSeconds: Math.max(policy.staggerSeconds, 10),
  };
}

function normalizeRateLimitStatus(raw: unknown): ReviewTeamRateLimitStatus | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const remaining = Math.floor(Number((raw as { remaining?: unknown }).remaining));
  if (!Number.isFinite(remaining)) {
    return null;
  }

  return {
    remaining: Math.max(0, remaining),
  };
}

function normalizeExecutionPolicy(
  raw: unknown,
): Pick<
  ReviewTeamStoredConfig,
  | 'reviewer_timeout_seconds'
  | 'judge_timeout_seconds'
  | 'reviewer_file_split_threshold'
  | 'max_same_role_instances'
  | 'max_retries_per_role'
> {
  const config = raw as Partial<ReviewTeamStoredConfig> | undefined;

  return {
    reviewer_timeout_seconds: clampInteger(
      config?.reviewer_timeout_seconds,
      0,
      3600,
      DEFAULT_REVIEW_TEAM_EXECUTION_POLICY.reviewerTimeoutSeconds,
    ),
    judge_timeout_seconds: clampInteger(
      config?.judge_timeout_seconds,
      0,
      3600,
      DEFAULT_REVIEW_TEAM_EXECUTION_POLICY.judgeTimeoutSeconds,
    ),
    reviewer_file_split_threshold: clampInteger(
      config?.reviewer_file_split_threshold,
      0,
      9999,
      DEFAULT_REVIEW_TEAM_EXECUTION_POLICY.reviewerFileSplitThreshold,
    ),
    max_same_role_instances: clampInteger(
      config?.max_same_role_instances,
      1,
      8,
      DEFAULT_REVIEW_TEAM_EXECUTION_POLICY.maxSameRoleInstances,
    ),
    max_retries_per_role: clampInteger(
      config?.max_retries_per_role,
      0,
      3,
      DEFAULT_REVIEW_TEAM_EXECUTION_POLICY.maxRetriesPerRole,
    ),
  };
}

function executionPolicyFromStoredConfig(
  config: ReviewTeamStoredConfig,
): ReviewTeamExecutionPolicy {
  return {
    reviewerTimeoutSeconds: config.reviewer_timeout_seconds,
    judgeTimeoutSeconds: config.judge_timeout_seconds,
    reviewerFileSplitThreshold: config.reviewer_file_split_threshold,
    maxSameRoleInstances: config.max_same_role_instances,
    maxRetriesPerRole: config.max_retries_per_role,
  };
}

function concurrencyPolicyFromStoredConfig(
  config: ReviewTeamStoredConfig,
): ReviewTeamConcurrencyPolicy {
  return normalizeConcurrencyPolicy({
    maxParallelInstances: config.max_parallel_reviewers,
    staggerSeconds: DEFAULT_REVIEW_TEAM_CONCURRENCY_POLICY.staggerSeconds,
    maxQueueWaitSeconds: config.max_queue_wait_seconds,
    batchExtrasSeparately: DEFAULT_REVIEW_TEAM_CONCURRENCY_POLICY.batchExtrasSeparately,
    allowProviderCapacityQueue: config.allow_provider_capacity_queue,
    allowBoundedAutoRetry: config.allow_bounded_auto_retry,
    autoRetryElapsedGuardSeconds: config.auto_retry_elapsed_guard_seconds,
  });
}

function normalizeStoredConfig(raw: unknown): ReviewTeamStoredConfig {
  const extraIds = Array.isArray((raw as { extra_subagent_ids?: unknown })?.extra_subagent_ids)
    ? (raw as { extra_subagent_ids: unknown[] }).extra_subagent_ids
      .filter((value): value is string => typeof value === 'string')
    : [];
  const executionPolicy = normalizeExecutionPolicy(raw);
  const concurrencyPolicy = normalizeStoredConcurrencyPolicy(raw);
  const config = raw as Partial<ReviewTeamStoredConfig> | undefined;

  return {
    extra_subagent_ids: dedupeIds(extraIds).filter((id) => !DISALLOWED_REVIEW_TEAM_MEMBER_IDS.has(id)),
    strategy_level: normalizeTeamStrategyLevel(config?.strategy_level),
    member_strategy_overrides: normalizeMemberStrategyOverrides(
      config?.member_strategy_overrides,
    ),
    ...executionPolicy,
    ...concurrencyPolicy,
  };
}

function isMissingDefaultReviewTeamConfigError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  const quotedDefaultPath = `'${DEFAULT_REVIEW_TEAM_CONFIG_PATH.toLowerCase()}'`;
  return (
    normalized.includes('config path') &&
    normalized.includes(quotedDefaultPath) &&
    normalized.includes('not found')
  );
}

export async function loadDefaultReviewTeamConfig(): Promise<ReviewTeamStoredConfig> {
  let raw: unknown;
  try {
    raw = await configAPI.getConfig(DEFAULT_REVIEW_TEAM_CONFIG_PATH);
  } catch (error) {
    if (!isMissingDefaultReviewTeamConfigError(error)) {
      throw error;
    }
  }
  return normalizeStoredConfig(raw);
}

export async function saveDefaultReviewTeamConfig(
  config: ReviewTeamStoredConfig,
): Promise<void> {
  const normalizedConfig = normalizeStoredConfig(config);

  await configAPI.setConfig(DEFAULT_REVIEW_TEAM_CONFIG_PATH, {
    extra_subagent_ids: dedupeIds(normalizedConfig.extra_subagent_ids)
      .filter((id) => !DISALLOWED_REVIEW_TEAM_MEMBER_IDS.has(id)),
    strategy_level: normalizedConfig.strategy_level,
    member_strategy_overrides: normalizedConfig.member_strategy_overrides,
    reviewer_timeout_seconds: normalizedConfig.reviewer_timeout_seconds,
    judge_timeout_seconds: normalizedConfig.judge_timeout_seconds,
    reviewer_file_split_threshold: normalizedConfig.reviewer_file_split_threshold,
    max_same_role_instances: normalizedConfig.max_same_role_instances,
    max_retries_per_role: normalizedConfig.max_retries_per_role,
    max_parallel_reviewers: normalizedConfig.max_parallel_reviewers,
    max_queue_wait_seconds: normalizedConfig.max_queue_wait_seconds,
    allow_provider_capacity_queue: normalizedConfig.allow_provider_capacity_queue,
    allow_bounded_auto_retry: normalizedConfig.allow_bounded_auto_retry,
    auto_retry_elapsed_guard_seconds: normalizedConfig.auto_retry_elapsed_guard_seconds,
  });
}

export async function loadReviewTeamRateLimitStatus(): Promise<ReviewTeamRateLimitStatus | null> {
  try {
    const raw = await configAPI.getConfig(
      DEFAULT_REVIEW_TEAM_RATE_LIMIT_STATUS_CONFIG_PATH,
      { skipRetryOnNotFound: true },
    );
    return normalizeRateLimitStatus(raw);
  } catch (error) {
    console.warn('[ReviewTeamService] Failed to load review team rate limit status', error);
    return null;
  }
}

export async function addDefaultReviewTeamMember(subagentId: string): Promise<void> {
  const current = await loadDefaultReviewTeamConfig();
  await saveDefaultReviewTeamConfig({
    ...current,
    extra_subagent_ids: [...current.extra_subagent_ids, subagentId],
  });
}

export async function removeDefaultReviewTeamMember(subagentId: string): Promise<void> {
  const current = await loadDefaultReviewTeamConfig();
  await saveDefaultReviewTeamConfig({
    ...current,
    extra_subagent_ids: current.extra_subagent_ids.filter((id) => id !== subagentId),
  });
}

export async function saveDefaultReviewTeamExecutionPolicy(
  policy: ReviewTeamExecutionPolicy,
): Promise<void> {
  const current = await loadDefaultReviewTeamConfig();
  await saveDefaultReviewTeamConfig({
    ...current,
    reviewer_timeout_seconds: policy.reviewerTimeoutSeconds,
    judge_timeout_seconds: policy.judgeTimeoutSeconds,
    reviewer_file_split_threshold: policy.reviewerFileSplitThreshold,
    max_same_role_instances: policy.maxSameRoleInstances,
    max_retries_per_role: policy.maxRetriesPerRole,
  });
}

export async function saveDefaultReviewTeamConcurrencyPolicy(
  policy: ReviewTeamConcurrencyPolicy,
): Promise<void> {
  const current = await loadDefaultReviewTeamConfig();
  const normalizedPolicy = normalizeConcurrencyPolicy(policy);
  await saveDefaultReviewTeamConfig({
    ...current,
    max_parallel_reviewers: normalizedPolicy.maxParallelInstances,
    max_queue_wait_seconds: normalizedPolicy.maxQueueWaitSeconds,
    allow_provider_capacity_queue: normalizedPolicy.allowProviderCapacityQueue,
    allow_bounded_auto_retry: normalizedPolicy.allowBoundedAutoRetry,
    auto_retry_elapsed_guard_seconds: normalizedPolicy.autoRetryElapsedGuardSeconds,
  });
}

export async function saveDefaultReviewTeamStrategyLevel(
  strategyLevel: ReviewStrategyLevel,
): Promise<void> {
  const current = await loadDefaultReviewTeamConfig();
  await saveDefaultReviewTeamConfig({
    ...current,
    strategy_level: normalizeTeamStrategyLevel(strategyLevel),
  });
}

export async function saveDefaultReviewTeamMemberStrategyOverride(
  subagentId: string,
  strategyLevel: ReviewMemberStrategyLevel,
): Promise<void> {
  const normalizedId = subagentId.trim();
  if (!normalizedId) {
    return;
  }

  const current = await loadDefaultReviewTeamConfig();
  const nextOverrides = { ...current.member_strategy_overrides };
  if (strategyLevel === DEFAULT_REVIEW_MEMBER_STRATEGY_LEVEL) {
    delete nextOverrides[normalizedId];
  } else if (isReviewStrategyLevel(strategyLevel)) {
    nextOverrides[normalizedId] = strategyLevel;
  }

  await saveDefaultReviewTeamConfig({
    ...current,
    member_strategy_overrides: nextOverrides,
  });
}

export interface ResolveDefaultReviewTeamOptions {
  availableModelIds?: string[];
  definition?: ReviewTeamDefinition;
}

function extractAvailableModelIds(rawModels: unknown): string[] | undefined {
  if (!Array.isArray(rawModels)) {
    return undefined;
  }

  return rawModels
    .map((model) => {
      if (typeof model === 'string') {
        return model.trim();
      }
      if (model && typeof model === 'object') {
        const value = (model as { id?: unknown }).id;
        return typeof value === 'string' ? value.trim() : '';
      }
      return '';
    })
    .filter(Boolean);
}

function resolveMemberStrategy(
  storedConfig: ReviewTeamStoredConfig,
  subagentId: string,
): {
  strategyOverride: ReviewMemberStrategyLevel;
  strategyLevel: ReviewStrategyLevel;
  strategySource: ReviewStrategySource;
} {
  const override = storedConfig.member_strategy_overrides[subagentId];
  if (override) {
    return {
      strategyOverride: override,
      strategyLevel: override,
      strategySource: 'member',
    };
  }

  return {
    strategyOverride: DEFAULT_REVIEW_MEMBER_STRATEGY_LEVEL,
    strategyLevel: storedConfig.strategy_level,
    strategySource: 'team',
  };
}

function migrateLegacyWorkerStrategyOverride(
  storedConfig: ReviewTeamStoredConfig,
  subagentsById: ReadonlyMap<string, SubagentInfo>,
  definition: ReviewTeamDefinition,
): ReviewTeamStoredConfig {
  const overrides = storedConfig.member_strategy_overrides;
  if (
    overrides.ReviewWorker ||
    !definition.coreRoles.some((role) => role.subagentId === 'ReviewWorker')
  ) {
    return storedConfig;
  }

  const definedRoleIds = new Set(definition.coreRoles.map((role) => role.subagentId));
  const legacyStrategies = LEGACY_REVIEW_WORKER_AGENT_IDS
    .filter((id) => !subagentsById.has(id) && !definedRoleIds.has(id))
    .map((id) => overrides[id])
    .filter((level): level is ReviewStrategyLevel => Boolean(level));
  if (legacyStrategies.length === 0) {
    return storedConfig;
  }

  // Several historical roles can collapse into one worker. Preserve the
  // strongest requested coverage level instead of depending on object order.
  const workerStrategy = legacyStrategies.reduce((strongest, candidate) =>
    REVIEW_STRATEGY_LEVELS.indexOf(candidate) > REVIEW_STRATEGY_LEVELS.indexOf(strongest)
      ? candidate
      : strongest
  );
  return {
    ...storedConfig,
    member_strategy_overrides: {
      ...overrides,
      ReviewWorker: workerStrategy,
    },
  };
}

function resolveMemberModel(
  configuredModel: string | undefined,
  strategyLevel: ReviewStrategyLevel,
  availableModelIds?: Set<string>,
  strategyProfiles: Record<ReviewStrategyLevel, ReviewStrategyProfile> = REVIEW_STRATEGY_PROFILES,
): {
  model: string;
  configuredModel: string;
  modelFallbackReason?: ReviewModelFallbackReason;
} {
  const normalizedConfiguredModel = configuredModel?.trim() || '';
  const defaultModelSlot = strategyProfiles[strategyLevel].defaultModelSlot;

  if (
    !normalizedConfiguredModel ||
    normalizedConfiguredModel === 'fast' ||
    normalizedConfiguredModel === 'primary'
  ) {
    return {
      model: defaultModelSlot,
      configuredModel: normalizedConfiguredModel || defaultModelSlot,
    };
  }

  if (availableModelIds && !availableModelIds.has(normalizedConfiguredModel)) {
    return {
      model: defaultModelSlot,
      configuredModel: normalizedConfiguredModel,
      modelFallbackReason: 'model_removed',
    };
  }

  return {
    model: normalizedConfiguredModel,
    configuredModel: normalizedConfiguredModel,
  };
}

function buildCoreMember(
  definition: ReviewTeamCoreRoleDefinition,
  info: SubagentInfo | undefined,
  storedConfig: ReviewTeamStoredConfig,
  availableModelIds?: Set<string>,
  strategyProfiles: Record<ReviewStrategyLevel, ReviewStrategyProfile> = REVIEW_STRATEGY_PROFILES,
): ReviewTeamMember {
  const strategy = resolveMemberStrategy(storedConfig, definition.subagentId);
  const model = resolveMemberModel(
    info?.model || DEFAULT_REVIEW_TEAM_MODEL,
    strategy.strategyLevel,
    availableModelIds,
    strategyProfiles,
  );
  const strategyProfile = strategyProfiles[strategy.strategyLevel];

  return {
    id: `core:${definition.subagentId}`,
    subagentId: definition.subagentId,
    definitionKey: definition.key,
    conditional: definition.conditional,
    displayName: definition.funName,
    roleName: definition.roleName,
    description: definition.description,
    responsibilities: definition.responsibilities,
    model: model.model,
    configuredModel: model.configuredModel,
    ...(model.modelFallbackReason
      ? { modelFallbackReason: model.modelFallbackReason }
      : {}),
    ...strategy,
    enabled: info?.effectiveEnabled ?? true,
    available: Boolean(info),
    locked: true,
    source: 'core',
    subagentSource: info?.subagentSource ?? 'builtin',
    accentColor: definition.accentColor,
    allowedTools: resolveReviewWorkPacketAllowedTools(info?.defaultTools),
    defaultModelSlot: strategyProfile.defaultModelSlot,
    strategyDirective:
      strategyProfile.roleDirectives[definition.subagentId] ||
      strategyProfile.promptDirective,
  };
}

function buildExtraMember(
  info: SubagentInfo,
  storedConfig: ReviewTeamStoredConfig,
  availableModelIds?: Set<string>,
  options: {
    available?: boolean;
    skipReason?: ReviewTeamManifestMemberReason;
    strategyProfiles?: Record<ReviewStrategyLevel, ReviewStrategyProfile>;
  } = {},
): ReviewTeamMember {
  const strategy = resolveMemberStrategy(storedConfig, info.id);
  const strategyProfiles = options.strategyProfiles ?? REVIEW_STRATEGY_PROFILES;
  const model = resolveMemberModel(
    info.model || DEFAULT_REVIEW_TEAM_MODEL,
    strategy.strategyLevel,
    availableModelIds,
    strategyProfiles,
  );
  const strategyProfile = strategyProfiles[strategy.strategyLevel];

  return {
    id: `extra:${info.id}`,
    subagentId: info.id,
    displayName: info.name,
    roleName: EXTRA_MEMBER_DEFAULTS.roleName,
    description: info.description?.trim() || EXTRA_MEMBER_DEFAULTS.description,
    responsibilities: EXTRA_MEMBER_DEFAULTS.responsibilities,
    model: model.model,
    configuredModel: model.configuredModel,
    ...(model.modelFallbackReason
      ? { modelFallbackReason: model.modelFallbackReason }
      : {}),
    ...strategy,
    enabled: info.effectiveEnabled,
    available: options.available ?? true,
    locked: false,
    source: 'extra',
    subagentSource: info.subagentSource ?? 'builtin',
    accentColor: EXTRA_MEMBER_DEFAULTS.accentColor,
    allowedTools: resolveReviewWorkPacketAllowedTools(info.defaultTools),
    defaultModelSlot: strategyProfile.defaultModelSlot,
    strategyDirective: strategyProfile.promptDirective,
    ...(options.skipReason ? { skipReason: options.skipReason } : {}),
  };
}

function buildUnavailableExtraMember(
  subagentId: string,
  storedConfig: ReviewTeamStoredConfig,
  availableModelIds?: Set<string>,
  strategyProfiles: Record<ReviewStrategyLevel, ReviewStrategyProfile> = REVIEW_STRATEGY_PROFILES,
): ReviewTeamMember {
  const strategy = resolveMemberStrategy(storedConfig, subagentId);
  const model = resolveMemberModel(
    DEFAULT_REVIEW_TEAM_MODEL,
    strategy.strategyLevel,
    availableModelIds,
    strategyProfiles,
  );
  const strategyProfile = strategyProfiles[strategy.strategyLevel];

  return {
    id: `extra:${subagentId}`,
    subagentId,
    displayName: subagentId,
    roleName: EXTRA_MEMBER_DEFAULTS.roleName,
    description: EXTRA_MEMBER_DEFAULTS.description,
    responsibilities: EXTRA_MEMBER_DEFAULTS.responsibilities,
    model: model.model,
    configuredModel: model.configuredModel,
    ...(model.modelFallbackReason
      ? { modelFallbackReason: model.modelFallbackReason }
      : {}),
    ...strategy,
    enabled: true,
    available: false,
    locked: false,
    source: 'extra',
    subagentSource: 'user',
    accentColor: EXTRA_MEMBER_DEFAULTS.accentColor,
    allowedTools: [],
    defaultModelSlot: strategyProfile.defaultModelSlot,
    strategyDirective: strategyProfile.promptDirective,
    skipReason: 'unavailable',
  };
}

/**
 * Context information shown in the reviewer task card instead of the raw prompt.
 * Keeps internal prompt directives private while giving the user a clear picture
 * of what each reviewer is doing.
 */
export interface ReviewerContext {
  definitionKey: ReviewTeamCoreRoleKey;
  roleName: string;
  description: string;
  responsibilities: string[];
  accentColor: string;
}

/**
 * If `subagentId` belongs to a built-in review-team role, return the
 * user-facing context for that role.  Otherwise return `null`.
 */
export function getReviewerContextBySubagentId(
  subagentId: string,
): ReviewerContext | null {
  const coreRole = DEFAULT_REVIEW_TEAM_CORE_ROLES.find(
    (role) => role.subagentId === subagentId,
  );
  if (!coreRole) return null;
  return {
    definitionKey: coreRole.key,
    roleName: coreRole.roleName,
    description: coreRole.description,
    responsibilities: coreRole.responsibilities,
    accentColor: coreRole.accentColor,
  };
}

export function isReviewTeamCoreSubagent(subagentId: string): boolean {
  return CORE_ROLE_IDS.has(subagentId);
}

export function canAddSubagentToReviewTeam(subagentId: string): boolean {
  return !DISALLOWED_REVIEW_TEAM_MEMBER_IDS.has(subagentId);
}

function hasReviewTeamExtraMemberShape(
  subagent: Pick<SubagentInfo, 'id' | 'isReadonly' | 'isReview'>,
): boolean {
  return (
    subagent.isReview &&
    subagent.isReadonly &&
    canAddSubagentToReviewTeam(subagent.id)
  );
}

export function canUseSubagentAsReviewTeamMember(
  subagent: Pick<SubagentInfo, 'id' | 'isReadonly' | 'isReview' | 'defaultTools'>,
): boolean {
  return (
    hasReviewTeamExtraMemberShape(subagent) &&
    evaluateReviewSubagentToolReadiness(subagent.defaultTools ?? []).readiness !== 'invalid'
  );
}

export function resolveDefaultReviewTeam(
  subagents: SubagentInfo[],
  storedConfig: ReviewTeamStoredConfig,
  options: ResolveDefaultReviewTeamOptions = {},
): ReviewTeam {
  const definition = options.definition ?? FALLBACK_REVIEW_TEAM_DEFINITION;
  const byId = new Map(subagents.map((subagent) => [subagent.id, subagent]));
  const effectiveStoredConfig = migrateLegacyWorkerStrategyOverride(
    storedConfig,
    byId,
    definition,
  );
  const availableModelIds = options.availableModelIds
    ? new Set(options.availableModelIds)
    : undefined;
  const coreMembers = definition.coreRoles.map((roleDefinition) =>
    buildCoreMember(
      roleDefinition,
      byId.get(roleDefinition.subagentId),
      effectiveStoredConfig,
      availableModelIds,
      definition.strategyProfiles,
    ),
  );
  const disallowedExtraSubagentIds = new Set(definition.disallowedExtraSubagentIds);
  const extraMembers = effectiveStoredConfig.extra_subagent_ids
    .filter((subagentId) => !disallowedExtraSubagentIds.has(subagentId))
    .map((subagentId) => {
    const subagent = byId.get(subagentId);
    if (!subagent) {
      return buildUnavailableExtraMember(
        subagentId,
        effectiveStoredConfig,
        availableModelIds,
        definition.strategyProfiles,
      );
    }
    if (!hasReviewTeamExtraMemberShape(subagent)) {
      return buildExtraMember(subagent, effectiveStoredConfig, availableModelIds, {
        available: false,
        skipReason: 'invalid_tooling',
        strategyProfiles: definition.strategyProfiles,
      });
    }
    const toolingReadiness = evaluateReviewSubagentToolReadiness(
      subagent.defaultTools ?? [],
    );
    return buildExtraMember(
      subagent,
      effectiveStoredConfig,
      availableModelIds,
      toolingReadiness.readiness === 'invalid'
        ? {
          available: false,
          skipReason: 'invalid_tooling',
          strategyProfiles: definition.strategyProfiles,
        }
        : { strategyProfiles: definition.strategyProfiles },
    );
  });

  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    warning: definition.warning,
    strategyLevel: effectiveStoredConfig.strategy_level,
    memberStrategyOverrides: effectiveStoredConfig.member_strategy_overrides,
    executionPolicy: executionPolicyFromStoredConfig(effectiveStoredConfig),
    concurrencyPolicy: concurrencyPolicyFromStoredConfig(effectiveStoredConfig),
    definition,
    members: [...coreMembers, ...extraMembers],
    coreMembers,
    extraMembers,
  };
}

export async function loadDefaultReviewTeam(
  workspaceId?: string,
): Promise<ReviewTeam> {
  const [definition, storedConfig, subagents, rawModels] = await Promise.all([
    loadDefaultReviewTeamDefinition(),
    loadDefaultReviewTeamConfig(),
    SubagentAPI.listVisibleSubagents({ workspaceId, parentAgentType: 'DeepReview' }),
    configAPI.getConfig('ai.models').catch(() => undefined),
  ]);

  return resolveDefaultReviewTeam(subagents, storedConfig, {
    definition,
    availableModelIds: extractAvailableModelIds(rawModels),
  });
}

interface ReviewTeamLaunchOptions {
  target?: ReviewTargetClassification;
  reviewTargetFilePaths?: string[];
}

interface ReviewTeamManifestOptions {
  workspacePath?: string;
  policySource?: ReviewTeamRunManifest['policySource'];
  target?: ReviewTargetClassification;
  changeStats?: Partial<ReviewTeamChangeStats>;
  tokenBudgetMode?: ReviewTokenBudgetMode;
  concurrencyPolicy?: Partial<ReviewTeamConcurrencyPolicy>;
  rateLimitStatus?: ReviewTeamRateLimitStatus | null;
  strategyOverride?: ReviewStrategyLevel;
  qualityDecision?: ReviewTeamRunManifest['qualityDecision'];
  reviewTargetFilePaths?: string[];
  maxCoreReviewers?: number;
  maxExtraReviewers?: number;
  includeQualityGate?: boolean;
  targetEvidence?: ReviewTargetEvidence;
  managedBatching?: boolean;
  maxFocusedCalls?: number;
}

// Provider-backed PR diffs are acquired per file by the runtime. Keep this
// aligned with REVIEW_PROVIDER_DIFF_MAX_ACQUISITIONS_PER_TURN without adding a
// second public budget contract to the manifest.
const PROVIDER_REVIEW_MAX_PLANNED_FILES = 128;

const REVIEW_WORK_PACKET_ALLOWED_TOOL_SET = new Set<string>(
  REVIEW_WORK_PACKET_ALLOWED_TOOLS,
);

function resolveReviewWorkPacketAllowedTools(defaultTools?: string[]): string[] {
  const registeredTools = defaultTools?.length
    ? defaultTools
    : REVIEW_WORK_PACKET_ALLOWED_TOOLS;
  return registeredTools.filter((tool) => REVIEW_WORK_PACKET_ALLOWED_TOOL_SET.has(tool));
}

function coreReviewerPriority(
  member: ReviewTeamMember,
  _target: ReviewTargetClassification,
): number {
  return member.definitionKey === 'worker' ? 100 : 0;
}

function hasExplicitReviewTarget(filePaths?: string[]): boolean {
  return Boolean(filePaths?.some((filePath) => filePath.trim().length > 0));
}

function resolveReviewTargetForOptions(
  target: ReviewTargetClassification | undefined,
  reviewTargetFilePaths: string[] | undefined,
  fallbackSource: Parameters<typeof createUnknownReviewTargetClassification>[0],
): ReviewTargetClassification {
  if (target) {
    return target;
  }
  if (hasExplicitReviewTarget(reviewTargetFilePaths)) {
    return classifyReviewTargetFromFiles(reviewTargetFilePaths ?? [], 'session_files');
  }
  return createUnknownReviewTargetClassification(fallbackSource);
}

export async function prepareDefaultReviewTeamForLaunch(
  workspaceId?: string,
  _options: ReviewTeamLaunchOptions = {},
): Promise<ReviewTeam> {
  const team = await loadDefaultReviewTeam(workspaceId);
  const missingCoreMembers = team.coreMembers.filter((member) => !member.available);

  if (missingCoreMembers.length > 0) {
    throw new Error(
      `Required strict Review coverage reviewers are unavailable: ${missingCoreMembers
        .map((member) => member.subagentId)
        .join(', ')}`,
    );
  }

  const coreMembersToEnable = team.coreMembers.filter(
    (member) => member.available && !member.enabled,
  );

  if (coreMembersToEnable.length > 0) {
    await Promise.all(
      coreMembersToEnable.map((member) =>
        SubagentAPI.updateSubagentConfig({
          subagentId: member.subagentId,
          parentAgentType: 'DeepReview',
          enabled: true,
          workspaceId,
        }),
      ),
    );

    // Update local team state to reflect enabled status without re-fetching
    for (const member of team.members) {
      if (coreMembersToEnable.some((m) => m.subagentId === member.subagentId)) {
        member.enabled = true;
      }
    }
    for (const member of team.coreMembers) {
      if (coreMembersToEnable.some((m) => m.subagentId === member.subagentId)) {
        member.enabled = true;
      }
    }
  }

  return team;
}

function shouldRunCoreReviewerForStrategy(
  _member: ReviewTeamMember,
  _target: ReviewTargetClassification,
  _strategyLevel: ReviewStrategyLevel,
): boolean {
  return true;
}

export function buildEffectiveReviewTeamManifest(
  team: ReviewTeam,
  options: ReviewTeamManifestOptions = {},
): ReviewTeamRunManifest {
  const target = resolveReviewTargetForOptions(
    options.target,
    options.reviewTargetFilePaths,
    'unknown',
  );
  const changeStats = resolveChangeStats(target, options.changeStats);
  const baseConcurrencyPolicy = normalizeConcurrencyPolicy(team.concurrencyPolicy);
  const resolvedConcurrencyPolicy = applyRateLimitToConcurrencyPolicy(
    normalizeConcurrencyPolicy({
      ...baseConcurrencyPolicy,
      ...options.concurrencyPolicy,
    }),
    options.rateLimitStatus,
  );
  const concurrencyPolicy = {
    ...resolvedConcurrencyPolicy,
    maxParallelInstances: Math.min(2, resolvedConcurrencyPolicy.maxParallelInstances),
  };
  const strategyLevel = options.strategyOverride ?? team.strategyLevel;
  const maxFocusedCalls = Math.max(
    0,
    Math.min(3, options.maxFocusedCalls ?? (strategyLevel === 'deep' ? 3 : 2)),
  );
  const strategyBudget = REVIEW_STRATEGY_RUNTIME_BUDGETS[strategyLevel];
  const tokenBudgetMode = options.tokenBudgetMode ?? strategyBudget.tokenBudgetMode;
  const scopeProfile = buildDeepReviewScopeProfile(strategyLevel);
  const strategyRecommendation = recommendReviewStrategyForTarget(target, changeStats);
  const backendStrategyRecommendation = recommendBackendCompatibleStrategyForTarget(
    target,
    changeStats,
  );
  const strategyDecision = buildReviewStrategyDecision({
    teamDefaultStrategy: team.strategyLevel,
    finalStrategy: strategyLevel,
    ...(options.strategyOverride ? { userOverride: options.strategyOverride } : {}),
    frontendRecommendation: strategyRecommendation,
    backendRecommendation: backendStrategyRecommendation,
  });
  const preReviewSummary = buildPreReviewSummary(target, changeStats);
  const coreMembers = team.coreMembers.map((member) =>
    applyTeamStrategyOverrideToMember(member, strategyLevel),
  );
  const availableCoreMembers = coreMembers.filter((member) => member.available);
  const unavailableCoreMembers = coreMembers.filter((member) => !member.available);
  const notApplicableCoreMembers = availableCoreMembers.filter(
    (member) =>
      member.definitionKey !== 'judge' &&
      !shouldRunCoreReviewerForStrategy(member, target, strategyLevel),
  );
  const applicableCoreReviewerMembers = availableCoreMembers
    .filter((member) => member.definitionKey !== 'judge')
    .filter((member) =>
      shouldRunCoreReviewerForStrategy(member, target, strategyLevel)
    );
  const prioritizedCoreReviewerMembers = options.maxCoreReviewers === undefined
    ? applicableCoreReviewerMembers
    : [...applicableCoreReviewerMembers].sort((left, right) =>
      coreReviewerPriority(right, target) - coreReviewerPriority(left, target)
    );
  const maxCoreReviewers = options.maxCoreReviewers ?? Number.MAX_SAFE_INTEGER;
  const coreReviewerMembers = prioritizedCoreReviewerMembers.slice(0, maxCoreReviewers);
  const budgetLimitedCoreMembers = prioritizedCoreReviewerMembers.slice(maxCoreReviewers);
  const coreReviewers = coreReviewerMembers.map((member) => toManifestMember(member));
  const qualityGateReviewerMember = options.includeQualityGate === false
    ? undefined
    : availableCoreMembers.find((member) => member.definitionKey === 'judge');
  const qualityGateReviewer = qualityGateReviewerMember
    ? toManifestMember(qualityGateReviewerMember)
    : undefined;
  // New adaptive manifests discover configured read-only reviewers as
  // capability guidance. They are not a fixed roster and must not appear as
  // enabled or budget-skipped members, including new managed file packets.
  // Persisted historical manifests retain their own member ids at runtime.
  const manifestExtraMembers: ReviewTeamMember[] = [];
  const eligibleExtraMembers = manifestExtraMembers
    .filter((member) => member.available && member.enabled);
  const strategyMaxExtraReviewers = resolveMaxExtraReviewers(
    tokenBudgetMode,
    eligibleExtraMembers.length,
    strategyBudget.maxExtraReviewers,
  );
  const maxExtraReviewers = Math.min(
    strategyMaxExtraReviewers,
    options.maxExtraReviewers ?? Number.MAX_SAFE_INTEGER,
  );
  const enabledExtraMembers = eligibleExtraMembers.slice(0, maxExtraReviewers);
  const budgetLimitedExtraMembers = eligibleExtraMembers.slice(maxExtraReviewers);
  const enabledExtraReviewers = enabledExtraMembers
    .map((member) => toManifestMember(member));
  const baseExecutionPolicy = {
    ...buildEffectiveExecutionPolicy({
      basePolicy: team.executionPolicy,
      strategyLevel,
      target,
      changeStats,
    }),
    // The owner reviews directly. Spawned checks are admitted only for
    // concrete target-bound questions and share this explicit allowance.
    reviewerFileSplitThreshold: 0,
    maxSameRoleInstances: 1,
    maxRetriesPerRole: 0,
    maxReviewerCalls: maxFocusedCalls,
  };
  const prioritizedEvidenceFiles = options.targetEvidence
    ? [
      ...options.targetEvidence.files.filter((file) => file.completeness === 'complete'),
      ...options.targetEvidence.files.filter((file) => file.completeness !== 'complete'),
    ].map((file) => file.path)
    : undefined;
  const workPackets: ReviewTeamWorkPacket[] = options.managedBatching
    ? buildManagedReviewWorkPackets({
      target,
      model: DEFAULT_REVIEW_TEAM_MODEL,
      maxFilesPerBatch: 40,
      maxBatches: 8,
      maxParallelInstances: concurrencyPolicy.maxParallelInstances,
      maxPlannedFiles: resolveManagedPlanFileLimit(options, target),
      timeoutSeconds: 120,
      eligibleFilePaths: prioritizedEvidenceFiles,
    })
    : [];
  const plannedFileCount = workPackets.reduce(
    (total, packet) => total + packet.assignedScope.files.length,
    0,
  );
  const knownIncludedFileCount = target.files.filter((file) => !file.excluded).length;
  const evidenceFileCount = options.targetEvidence?.files.length ?? 0;
  const omittedFileCount = options.targetEvidence?.omittedFileCount ?? 0;
  const totalReviewFileCount = Math.max(
    knownIncludedFileCount,
    evidenceFileCount + omittedFileCount,
    changeStats.fileCount,
  );
  const executionPolicy: ReviewTeamExecutionPolicy = options.managedBatching
    ? {
      reviewerTimeoutSeconds: 120,
      judgeTimeoutSeconds: baseExecutionPolicy.judgeTimeoutSeconds,
      reviewerFileSplitThreshold: 40,
      maxSameRoleInstances: Math.max(1, workPackets.length),
      maxRetriesPerRole: 0,
      maxReviewerCalls: Math.max(1, workPackets.length),
    }
    : baseExecutionPolicy;
  const evidencePack = buildDeepReviewEvidencePack({
    target,
    changeStats,
    scopeProfile,
    targetEvidence: options.targetEvidence,
    workPackets,
  });
  const tokenBudget = buildTokenBudgetPlan({
    mode: tokenBudgetMode,
    activeReviewerCalls: options.managedBatching ? workPackets.length : 1,
    maxReviewerCalls: options.managedBatching
      ? workPackets.length
      : 1 + maxFocusedCalls,
    eligibleExtraReviewerCount: eligibleExtraMembers.length,
    maxExtraReviewers,
    skippedReviewerIds: budgetLimitedExtraMembers.map((member) => member.subagentId),
    target,
    changeStats,
    executionPolicy,
    workPackets,
  });
  const skippedReviewers = [
    ...manifestExtraMembers
      .filter((member) => !member.available || !member.enabled)
      .map((member) =>
        toManifestMember(
          member,
          member.skipReason ?? (member.available ? 'disabled' : 'unavailable'),
        ),
      ),
    ...budgetLimitedExtraMembers.map((member) =>
      toManifestMember(member, 'budget_limited'),
    ),
    ...budgetLimitedCoreMembers.map((member) =>
      toManifestMember(member, 'budget_limited'),
    ),
    ...unavailableCoreMembers.map((member) =>
      toManifestMember(member, 'unavailable'),
    ),
    ...notApplicableCoreMembers.map((member) =>
      toManifestMember(member, 'not_applicable'),
    ),
  ];

  return {
    reviewMode: 'deep',
    adaptiveReview: {
      version: 1,
      maxFocusedCalls,
    },
    ...(options.workspacePath ? { workspacePath: options.workspacePath } : {}),
    policySource: options.policySource ?? 'default-review-team-config',
    target,
    strategyLevel,
    scopeProfile,
    strategyRecommendation,
    ...(options.qualityDecision ? { qualityDecision: options.qualityDecision } : {}),
    strategyDecision,
    executionPolicy,
    concurrencyPolicy,
    changeStats,
    preReviewSummary,
    evidencePack,
    tokenBudget,
    coreReviewers,
    ...(qualityGateReviewer ? { qualityGateReviewer } : {}),
    enabledExtraReviewers,
    skippedReviewers,
    workPackets,
    ...(options.managedBatching
      ? {
        managedReviewPlan: {
          version: 1 as const,
          totalFileCount: totalReviewFileCount,
          plannedFileCount,
          deferredFileCount: Math.max(0, totalReviewFileCount - plannedFileCount),
          maxFilesPerBatch: 40,
          maxBatches: 8,
          maxParallelInstances: concurrencyPolicy.maxParallelInstances,
          workerTimeoutSeconds: 120,
        },
      }
      : {}),
  };
}

/**
 * Builds the ordinary Review manifest without registry or configuration I/O.
 * The owner is CodeReview; ReviewWorker is only a runtime target for admitted
 * focused questions, so launch latency must not depend on loading a full team.
 */
export function buildAdaptiveStandardReviewManifest(options: {
  workspacePath?: string;
  target: ReviewTargetClassification;
  changeStats: ReviewTeamChangeStats;
  targetEvidence: ReviewTargetEvidence;
}): ReviewTeamRunManifest {
  const storedConfig = normalizeStoredConfig(undefined);
  const workerDefinition = DEFAULT_REVIEW_TEAM_CORE_ROLES.find(
    (role) => role.key === 'worker',
  );
  if (!workerDefinition) {
    throw new Error('Default ReviewWorker definition is unavailable');
  }
  const workerInfo: SubagentInfo = {
    key: 'builtin::builtin::ReviewWorker',
    id: 'ReviewWorker',
    name: workerDefinition.funName,
    description: workerDefinition.description,
    isReadonly: true,
    isReview: true,
    toolCount: REVIEW_WORK_PACKET_ALLOWED_TOOLS.length,
    defaultTools: [...REVIEW_WORK_PACKET_ALLOWED_TOOLS],
    defaultEnabled: true,
    effectiveEnabled: true,
    source: 'builtin',
    subagentSource: 'builtin',
  };
  const worker = buildCoreMember(
    workerDefinition,
    workerInfo,
    storedConfig,
    undefined,
    FALLBACK_REVIEW_TEAM_DEFINITION.strategyProfiles,
  );
  const team: ReviewTeam = {
    id: FALLBACK_REVIEW_TEAM_DEFINITION.id,
    name: FALLBACK_REVIEW_TEAM_DEFINITION.name,
    description: FALLBACK_REVIEW_TEAM_DEFINITION.description,
    warning: FALLBACK_REVIEW_TEAM_DEFINITION.warning,
    strategyLevel: 'quick',
    memberStrategyOverrides: {},
    executionPolicy: executionPolicyFromStoredConfig(storedConfig),
    concurrencyPolicy: concurrencyPolicyFromStoredConfig(storedConfig),
    definition: FALLBACK_REVIEW_TEAM_DEFINITION,
    members: [worker],
    coreMembers: [worker],
    extraMembers: [],
  };
  return buildEffectiveReviewTeamManifest(team, {
    workspacePath: options.workspacePath,
    target: options.target,
    changeStats: options.changeStats,
    targetEvidence: options.targetEvidence,
    strategyOverride: 'quick',
    includeQualityGate: false,
    maxCoreReviewers: 1,
    maxExtraReviewers: 0,
    maxFocusedCalls: 2,
  });
}

function resolveManagedPlanFileLimit(
  options: ReviewTeamManifestOptions,
  target: ReviewTargetClassification,
): number | undefined {
  return target.source === 'pull_request' || options.targetEvidence?.source === 'pull_request'
    ? PROVIDER_REVIEW_MAX_PLANNED_FILES
    : undefined;
}

export function buildReviewTeamPromptBlock(
  team: ReviewTeam,
  manifest = buildEffectiveReviewTeamManifest(team),
): string {
  return buildReviewTeamPromptBlockContent(team, manifest);
}
