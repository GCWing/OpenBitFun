import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configAPI } from '@/infrastructure/api/service-api/ConfigAPI';
import { APPEARANCE_DOMAIN_TOKENS } from '@/infrastructure/appearance/appearanceDomainTokens';
import {
  DEFAULT_REVIEW_TEAM_CONCURRENCY_POLICY,
  DEFAULT_REVIEW_TEAM_EXECUTION_POLICY,
  DEFAULT_REVIEW_TEAM_STRATEGY_LEVEL,
  FALLBACK_REVIEW_TEAM_DEFINITION,
  REVIEW_TEAM_MEMBER_ACCENT_DEFAULT,
  REVIEW_STRATEGY_DEFINITIONS,
  buildEffectiveReviewTeamManifest,
  canAddSubagentToReviewTeam,
  buildReviewTeamPromptBlock,
  canUseSubagentAsReviewTeamMember,
  loadDefaultReviewTeamDefinition,
  loadDefaultReviewTeamConfig,
  loadReviewTeamRateLimitStatus,
  prepareDefaultReviewTeamForLaunch,
  resolveDefaultReviewTeam,
  saveDefaultReviewTeamConcurrencyPolicy,
  type ReviewTeamStoredConfig,
} from './reviewTeamService';
import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import {
  SubagentAPI,
  type SubagentInfo,
} from '@/infrastructure/api/service-api/SubagentAPI';
import {
  classifyReviewTargetFromFiles,
  createUnknownReviewTargetClassification,
} from './reviewTargetClassifier';

vi.mock('@/infrastructure/api/service-api/ConfigAPI', () => ({
  configAPI: {
    getConfig: vi.fn(),
    setConfig: vi.fn(),
  },
}));

vi.mock('@/infrastructure/api/service-api/SubagentAPI', () => ({
  SubagentAPI: {
    listSubagents: vi.fn(),
    listVisibleSubagents: vi.fn(),
    updateSubagentConfig: vi.fn(),
  },
}));

vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({
  agentAPI: {
    getDefaultReviewTeamDefinition: vi.fn(),
  },
}));

describe('reviewTeamService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const WORKSPACE_PATH = '/test-fixtures/project-a';

  const storedConfigWithExtra = (
    extraSubagentIds: string[] = [],
    overrides: Partial<ReviewTeamStoredConfig> = {},
  ): ReviewTeamStoredConfig => ({
    extra_subagent_ids: extraSubagentIds,
    strategy_level: DEFAULT_REVIEW_TEAM_STRATEGY_LEVEL,
    member_strategy_overrides: {},
    reviewer_timeout_seconds: DEFAULT_REVIEW_TEAM_EXECUTION_POLICY.reviewerTimeoutSeconds,
    judge_timeout_seconds: DEFAULT_REVIEW_TEAM_EXECUTION_POLICY.judgeTimeoutSeconds,
    reviewer_file_split_threshold: DEFAULT_REVIEW_TEAM_EXECUTION_POLICY.reviewerFileSplitThreshold,
    max_same_role_instances: DEFAULT_REVIEW_TEAM_EXECUTION_POLICY.maxSameRoleInstances,
    max_retries_per_role: DEFAULT_REVIEW_TEAM_EXECUTION_POLICY.maxRetriesPerRole,
    max_parallel_reviewers: DEFAULT_REVIEW_TEAM_CONCURRENCY_POLICY.maxParallelInstances,
    max_queue_wait_seconds: DEFAULT_REVIEW_TEAM_CONCURRENCY_POLICY.maxQueueWaitSeconds,
    allow_provider_capacity_queue: DEFAULT_REVIEW_TEAM_CONCURRENCY_POLICY.allowProviderCapacityQueue,
    allow_bounded_auto_retry: DEFAULT_REVIEW_TEAM_CONCURRENCY_POLICY.allowBoundedAutoRetry,
    auto_retry_elapsed_guard_seconds:
      DEFAULT_REVIEW_TEAM_CONCURRENCY_POLICY.autoRetryElapsedGuardSeconds,
    ...overrides,
  });

  const subagent = (
    id: string,
    enabled = true,
    subagentSource: SubagentInfo['subagentSource'] = 'builtin',
    model = 'fast',
    isReadonly = true,
    isReview = id.startsWith('Review'),
    defaultTools = ['GetFileDiff', 'Read', 'Grep', 'Glob', 'LS'],
  ): SubagentInfo => ({
    key: `test::${id}`,
    id,
    name: id,
    description: `${id} description`,
    isReadonly,
    isReview,
    toolCount: defaultTools.length,
    defaultTools,
    defaultEnabled: enabled,
    effectiveEnabled: enabled,
    subagentSource,
    model,
  });

  const coreSubagents = (enabled = true): SubagentInfo[] => [
    subagent('ReviewWorker', enabled),
    subagent('ReviewJudge', enabled),
  ];

  it('uses one dynamic built-in worker instead of fixed review-domain agents', () => {
    expect(FALLBACK_REVIEW_TEAM_DEFINITION.coreRoles.map((role) => role.subagentId)).toEqual([
      'ReviewWorker',
      'ReviewJudge',
    ]);
    expect(FALLBACK_REVIEW_TEAM_DEFINITION.hiddenAgentIds).not.toEqual(
      expect.arrayContaining([
        'ReviewBusinessLogic',
        'ReviewPerformance',
        'ReviewSecurity',
        'ReviewArchitecture',
        'ReviewFrontend',
        'ReviewGeneral',
      ]),
    );
  });

  it('uses bounded review team defaults', () => {
    expect(DEFAULT_REVIEW_TEAM_EXECUTION_POLICY).toMatchObject({
      reviewerTimeoutSeconds: 3600,
      judgeTimeoutSeconds: 2400,
      reviewerFileSplitThreshold: 20,
      maxSameRoleInstances: 3,
      maxRetriesPerRole: 1,
    });
    expect(DEFAULT_REVIEW_TEAM_CONCURRENCY_POLICY).toMatchObject({
      maxParallelInstances: 2,
      staggerSeconds: 0,
      maxQueueWaitSeconds: 1200,
      batchExtrasSeparately: true,
      allowProviderCapacityQueue: true,
      allowBoundedAutoRetry: false,
      autoRetryElapsedGuardSeconds: 180,
    });
  });

  it('falls back to defaults when the persisted review team path is missing', async () => {
    vi.mocked(configAPI.getConfig).mockRejectedValueOnce(
      new Error("Config path 'ai.review_teams.default' not found"),
    );

    await expect(loadDefaultReviewTeamConfig()).resolves.toEqual({
      extra_subagent_ids: [],
      strategy_level: 'normal',
      member_strategy_overrides: {},
      reviewer_timeout_seconds: DEFAULT_REVIEW_TEAM_EXECUTION_POLICY.reviewerTimeoutSeconds,
      judge_timeout_seconds: DEFAULT_REVIEW_TEAM_EXECUTION_POLICY.judgeTimeoutSeconds,
      reviewer_file_split_threshold: DEFAULT_REVIEW_TEAM_EXECUTION_POLICY.reviewerFileSplitThreshold,
      max_same_role_instances: DEFAULT_REVIEW_TEAM_EXECUTION_POLICY.maxSameRoleInstances,
      max_retries_per_role: DEFAULT_REVIEW_TEAM_EXECUTION_POLICY.maxRetriesPerRole,
      max_parallel_reviewers: DEFAULT_REVIEW_TEAM_CONCURRENCY_POLICY.maxParallelInstances,
      max_queue_wait_seconds: DEFAULT_REVIEW_TEAM_CONCURRENCY_POLICY.maxQueueWaitSeconds,
      allow_provider_capacity_queue: DEFAULT_REVIEW_TEAM_CONCURRENCY_POLICY.allowProviderCapacityQueue,
      allow_bounded_auto_retry: DEFAULT_REVIEW_TEAM_CONCURRENCY_POLICY.allowBoundedAutoRetry,
      auto_retry_elapsed_guard_seconds:
        DEFAULT_REVIEW_TEAM_CONCURRENCY_POLICY.autoRetryElapsedGuardSeconds,
    });
  });

  it('defaults deep review launches to read-only mode without automatic fixing', async () => {
    vi.mocked(configAPI.getConfig).mockRejectedValueOnce(
      new Error("Config path 'ai.review_teams.default' not found"),
    );

    const config = await loadDefaultReviewTeamConfig();

    expect(config.strategy_level).toBe('normal');
  });

  it('normalizes team strategy and member strategy overrides', async () => {
    vi.mocked(configAPI.getConfig).mockResolvedValueOnce({
      extra_subagent_ids: ['ExtraOne'],
      strategy_level: 'deep',
      member_strategy_overrides: {
        ReviewSecurity: 'quick',
        ReviewJudge: 'deep',
        ExtraOne: 'normal',
        ExtraTwo: 'invalid',
      },
    });

    await expect(loadDefaultReviewTeamConfig()).resolves.toMatchObject({
      strategy_level: 'deep',
      member_strategy_overrides: {
        ReviewSecurity: 'quick',
        ReviewJudge: 'deep',
        ExtraOne: 'normal',
      },
    });
  });

  it('normalizes persisted capacity and retry settings into the team concurrency policy', async () => {
    vi.mocked(configAPI.getConfig).mockResolvedValueOnce({
      extra_subagent_ids: [],
      strategy_level: 'normal',
      member_strategy_overrides: {},
      max_parallel_reviewers: 99,
      max_queue_wait_seconds: 9999,
      allow_provider_capacity_queue: false,
      allow_bounded_auto_retry: true,
      auto_retry_elapsed_guard_seconds: 1,
    });

    const config = await loadDefaultReviewTeamConfig();
    const team = resolveDefaultReviewTeam(coreSubagents(), config);

    expect(team.concurrencyPolicy).toEqual({
      maxParallelInstances: 2,
      staggerSeconds: 0,
      maxQueueWaitSeconds: 3600,
      batchExtrasSeparately: true,
      allowProviderCapacityQueue: false,
      allowBoundedAutoRetry: true,
      autoRetryElapsedGuardSeconds: 30,
    });
  });

  it('saves capacity and retry settings without changing unrelated review team config', async () => {
    vi.mocked(configAPI.getConfig).mockResolvedValueOnce(
      storedConfigWithExtra(['ExtraReviewer'], {
        strategy_level: 'deep',
        member_strategy_overrides: { ReviewSecurity: 'quick' },
        reviewer_timeout_seconds: 300,
      }),
    );

    await saveDefaultReviewTeamConcurrencyPolicy({
      maxParallelInstances: 2,
      staggerSeconds: 20,
      maxQueueWaitSeconds: 45,
      batchExtrasSeparately: false,
      allowProviderCapacityQueue: false,
      allowBoundedAutoRetry: true,
      autoRetryElapsedGuardSeconds: 240,
    });

    expect(configAPI.setConfig).toHaveBeenCalledWith(
      'ai.review_teams.default',
      expect.objectContaining({
        extra_subagent_ids: ['ExtraReviewer'],
        strategy_level: 'deep',
        member_strategy_overrides: { ReviewSecurity: 'quick' },
        reviewer_timeout_seconds: 300,
        max_parallel_reviewers: 2,
        max_queue_wait_seconds: 45,
        allow_provider_capacity_queue: false,
        allow_bounded_auto_retry: true,
        auto_retry_elapsed_guard_seconds: 240,
      }),
    );
  });

  it('propagates config errors that are not missing review team config paths', async () => {
    const error = new Error('Config service unavailable');
    vi.mocked(configAPI.getConfig).mockRejectedValueOnce(error);

    await expect(loadDefaultReviewTeamConfig()).rejects.toThrow(error.message);
  });

  it('loads cached review team rate limit status when available', async () => {
    vi.mocked(configAPI.getConfig).mockResolvedValueOnce({
      remaining: 3.8,
    });

    await expect(loadReviewTeamRateLimitStatus()).resolves.toEqual({
      remaining: 3,
    });
    expect(configAPI.getConfig).toHaveBeenCalledWith(
      'ai.review_team_rate_limit_status',
      { skipRetryOnNotFound: true },
    );
  });

  it('ignores missing or invalid cached review team rate limit status', async () => {
    vi.mocked(configAPI.getConfig)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ remaining: 'not-a-number' })
      .mockRejectedValueOnce(new Error('rate status unavailable'));

    await expect(loadReviewTeamRateLimitStatus()).resolves.toBeNull();
    await expect(loadReviewTeamRateLimitStatus()).resolves.toBeNull();
    await expect(loadReviewTeamRateLimitStatus()).resolves.toBeNull();
  });

  it('only force-enables locked core members before launch', async () => {
    vi.mocked(configAPI.getConfig).mockResolvedValue(
      storedConfigWithExtra(['ExtraEnabled', 'ExtraDisabled']),
    );
    vi.mocked(SubagentAPI.listVisibleSubagents).mockResolvedValue([
      ...coreSubagents(false),
      subagent('ExtraEnabled', true, 'user', 'fast', true, true),
      subagent('ExtraDisabled', false, 'project', 'fast', true, true),
    ]);

    await prepareDefaultReviewTeamForLaunch('workspace-1');

    expect(SubagentAPI.updateSubagentConfig).toHaveBeenCalledTimes(2);
    expect(SubagentAPI.updateSubagentConfig).toHaveBeenCalledWith({
      parentAgentType: 'DeepReview',
      subagentId: 'ReviewWorker',
      enabled: true,
      workspaceId: 'workspace-1',
    });
    expect(SubagentAPI.updateSubagentConfig).toHaveBeenCalledWith({
      parentAgentType: 'DeepReview',
      subagentId: 'ReviewJudge',
      enabled: true,
      workspaceId: 'workspace-1',
    });
    expect(SubagentAPI.updateSubagentConfig).not.toHaveBeenCalledWith(
      expect.objectContaining({ subagentId: 'ExtraEnabled' }),
    );
    expect(SubagentAPI.updateSubagentConfig).not.toHaveBeenCalledWith(
      expect.objectContaining({ subagentId: 'ExtraDisabled' }),
    );
  });

  it('excludes disabled extra members from the launch prompt', () => {
    const team = resolveDefaultReviewTeam(
      [
        ...coreSubagents(),
        subagent('ExtraEnabled', true, 'user', 'fast', true, true),
        subagent('ExtraDisabled', false, 'project', 'fast', true, true),
      ],
      storedConfigWithExtra(['ExtraEnabled', 'ExtraDisabled']),
    );

    const promptBlock = buildReviewTeamPromptBlock(team);

    expect(promptBlock).not.toContain('ExtraEnabled');
    expect(promptBlock).not.toContain('ExtraDisabled');
    expect(promptBlock).toContain('concise capability catalog');
  });

  it('can resolve the team from a backend-provided reviewer definition', () => {
    const team = resolveDefaultReviewTeam(
      [
        ...coreSubagents(),
        subagent('ReviewDocs'),
      ],
      storedConfigWithExtra(['ReviewDocs']),
      {
        definition: {
          id: 'default-review-team',
          name: 'Strict Review Coverage',
          description: 'Backend-defined team',
          warning: 'Review may take longer.',
          defaultModel: 'fast',
          defaultStrategyLevel: 'normal',
          defaultExecutionPolicy: {
            reviewerTimeoutSeconds: 300,
            judgeTimeoutSeconds: 240,
            reviewerFileSplitThreshold: 20,
            maxSameRoleInstances: 3,
            maxRetriesPerRole: 1,
          },
          disallowedExtraSubagentIds: [
            'ReviewBusinessLogic',
            'ReviewPerformance',
            'ReviewSecurity',
            'ReviewArchitecture',
            'ReviewFrontend',
            'ReviewDocs',
            'ReviewJudge',
            'DeepReview',
            'ReviewFixer',
          ],
          hiddenAgentIds: [
            'DeepReview',
            'ReviewBusinessLogic',
            'ReviewPerformance',
            'ReviewSecurity',
            'ReviewArchitecture',
            'ReviewFrontend',
            'ReviewDocs',
            'ReviewJudge',
          ],
          coreRoles: [
            ...[
              'ReviewBusinessLogic',
              'ReviewPerformance',
              'ReviewSecurity',
              'ReviewArchitecture',
              'ReviewFrontend',
              'ReviewJudge',
            ].map((id) => ({
              key: id === 'ReviewJudge' ? 'judge' : id.replace(/^Review/, '').replace(/^BusinessLogic$/, 'businessLogic').toLowerCase(),
              subagentId: id,
              funName: id,
              roleName: id,
              description: `${id} description`,
              responsibilities: [`${id} responsibility`],
              accentColor: REVIEW_TEAM_MEMBER_ACCENT_DEFAULT,
              conditional: id === 'ReviewFrontend',
            })),
            {
              key: 'docs',
              subagentId: 'ReviewDocs',
              funName: 'Docs Reviewer',
              roleName: 'Documentation Reviewer',
              description: 'Checks docs and release notes.',
              responsibilities: ['Verify documentation stays aligned.'],
              accentColor: '#0f766e',
            },
          ],
          strategyProfiles: {
            ...REVIEW_STRATEGY_DEFINITIONS,
            quick: {
              ...REVIEW_STRATEGY_DEFINITIONS.quick,
              roleDirectives: {
                ...REVIEW_STRATEGY_DEFINITIONS.quick.roleDirectives,
                ReviewDocs: 'Only check changed docs.',
              },
            },
          },
        },
      },
    );

    expect(team.coreMembers.map((member) => member.subagentId)).toContain('ReviewDocs');
    expect(team.extraMembers.map((member) => member.subagentId)).not.toContain('ReviewDocs');

    const manifest = buildEffectiveReviewTeamManifest(team, {
      tokenBudgetMode: 'balanced',
    });
    expect(manifest.coreReviewers).toContainEqual(
      expect.objectContaining({
        subagentId: 'ReviewDocs',
        strategyDirective: REVIEW_STRATEGY_DEFINITIONS.normal.promptDirective,
      }),
    );
  });

  it('falls back safely when backend reviewer definition fields are malformed', async () => {
    vi.mocked(agentAPI.getDefaultReviewTeamDefinition).mockResolvedValue({
      id: 42,
      name: null,
      description: ['bad'],
      warning: {},
      defaultModel: 99,
      defaultStrategyLevel: 'normal',
      defaultExecutionPolicy: {
        reviewerTimeoutSeconds: 300,
        judgeTimeoutSeconds: 240,
        reviewerFileSplitThreshold: 20,
        maxSameRoleInstances: 3,
        maxRetriesPerRole: 1,
      },
      coreRoles: [],
      strategyProfiles: {},
      disallowedExtraSubagentIds: ['ReviewDocs', 42],
      hiddenAgentIds: ['ReviewDocs', null],
    });

    await expect(loadDefaultReviewTeamDefinition()).resolves.toMatchObject({
      id: FALLBACK_REVIEW_TEAM_DEFINITION.id,
      name: FALLBACK_REVIEW_TEAM_DEFINITION.name,
      description: FALLBACK_REVIEW_TEAM_DEFINITION.description,
      warning: FALLBACK_REVIEW_TEAM_DEFINITION.warning,
      defaultModel: FALLBACK_REVIEW_TEAM_DEFINITION.defaultModel,
      disallowedExtraSubagentIds: ['ReviewDocs'],
      hiddenAgentIds: ['ReviewDocs'],
    });
  });

  it('keeps the fallback definition aligned with the backend-owned dynamic team contract', async () => {
    vi.mocked(agentAPI.getDefaultReviewTeamDefinition).mockRejectedValue(
      new Error('backend unavailable'),
    );

    await expect(loadDefaultReviewTeamDefinition()).resolves.toMatchObject({
      name: 'Code Review',
      description:
        'One review that can add checks when a specific concern needs more evidence.',
      coreRoles: [
        expect.objectContaining({
          subagentId: 'ReviewWorker',
          accentColor: APPEARANCE_DOMAIN_TOKENS.reviewTeam.worker,
        }),
        expect.objectContaining({
          subagentId: 'ReviewJudge',
          accentColor: APPEARANCE_DOMAIN_TOKENS.reviewTeam.judge,
        }),
      ],
      strategyProfiles: {
        normal: expect.objectContaining({ label: 'Normal' }),
        deep: expect.objectContaining({ label: 'Deep' }),
      },
      hiddenAgentIds: ['DeepReview', 'ReviewWorker', 'ReviewJudge'],
      disallowedExtraSubagentIds: [
        'DeepReview',
        'ReviewArchitecture',
        'ReviewBusinessLogic',
        'ReviewFixer',
        'ReviewFrontend',
        'ReviewGeneral',
        'ReviewJudge',
        'ReviewPerformance',
        'ReviewSecurity',
        'ReviewWorker',
      ],
    });
  });

  it('keeps invalid configured capability sources out of the adaptive manifest', () => {
    const readonlyReviewExtra = subagent('ExtraReadonlyReview', true, 'user', 'fast', true, true);
    const readonlyPlainExtra = subagent('ExtraReadonlyPlain', true, 'user', 'fast', true, false);
    const writableReviewExtra = subagent('ExtraWritableReview', true, 'project', 'fast', false, true);

    expect(canUseSubagentAsReviewTeamMember(readonlyReviewExtra)).toBe(true);
    expect(canUseSubagentAsReviewTeamMember(readonlyPlainExtra)).toBe(false);
    expect(canUseSubagentAsReviewTeamMember(writableReviewExtra)).toBe(false);

    const team = resolveDefaultReviewTeam(
      [
        ...coreSubagents(),
        readonlyReviewExtra,
        readonlyPlainExtra,
        writableReviewExtra,
      ],
      storedConfigWithExtra([
        'ExtraReadonlyReview',
        'ExtraReadonlyPlain',
        'ExtraWritableReview',
        'ExtraMissingReviewer',
      ]),
    );

    expect(
      team.extraMembers
        .filter((member) => member.available)
        .map((member) => member.subagentId),
    ).toEqual(['ExtraReadonlyReview']);

    const manifest = buildEffectiveReviewTeamManifest(team);

    expect(manifest.enabledExtraReviewers).toEqual([]);
    expect(manifest.skippedReviewers).toEqual([]);

    const promptBlock = buildReviewTeamPromptBlock(team, manifest);
    expect(promptBlock).not.toContain('ExtraReadonlyReview');
    expect(promptBlock).not.toContain('ExtraReadonlyPlain');
    expect(promptBlock).not.toContain('ExtraWritableReview');
    expect(promptBlock).not.toContain('ExtraMissingReviewer');
  });

  it('requires configured capability sources to have the minimum review tools', () => {
    const readyReviewExtra = subagent('ExtraReadyReview', true, 'user', 'fast', true, true);
    const missingDiffExtra = subagent(
      'ExtraMissingDiff',
      true,
      'user',
      'fast',
      true,
      true,
      ['Read', 'Grep'],
    );
    const missingReadExtra = subagent(
      'ExtraMissingRead',
      true,
      'project',
      'fast',
      true,
      true,
      ['GetFileDiff', 'Grep'],
    );

    expect(canUseSubagentAsReviewTeamMember(readyReviewExtra)).toBe(true);
    expect(canUseSubagentAsReviewTeamMember(missingDiffExtra)).toBe(false);
    expect(canUseSubagentAsReviewTeamMember(missingReadExtra)).toBe(false);

    const team = resolveDefaultReviewTeam(
      [
        ...coreSubagents(),
        readyReviewExtra,
        missingDiffExtra,
        missingReadExtra,
      ],
      storedConfigWithExtra(['ExtraReadyReview', 'ExtraMissingDiff', 'ExtraMissingRead']),
    );

    expect(
      team.extraMembers
        .filter((member) => member.available)
        .map((member) => member.subagentId),
    ).toEqual(['ExtraReadyReview']);

    const manifest = buildEffectiveReviewTeamManifest(team);

    expect(manifest.enabledExtraReviewers).toEqual([]);
    expect(manifest.skippedReviewers).toEqual([]);

    const promptBlock = buildReviewTeamPromptBlock(team, manifest);
    expect(promptBlock).not.toContain('ExtraMissingDiff');
    expect(promptBlock).not.toContain('ExtraMissingRead');
  });

  it('builds an adaptive manifest without a fixed custom reviewer roster', () => {
    const team = resolveDefaultReviewTeam(
      [
        ...coreSubagents(),
        subagent('ExtraEnabled', true, 'user', 'fast', true, true),
        subagent('ExtraDisabled', false, 'project', 'fast', true, true),
      ],
      storedConfigWithExtra(['ExtraEnabled', 'ExtraDisabled']),
    );

    const manifest = buildEffectiveReviewTeamManifest(team, {
      workspacePath: WORKSPACE_PATH,
      policySource: 'default-review-team-config',
    });

    expect(manifest.reviewMode).toBe('deep');
    expect(manifest.strategyLevel).toBe('normal');
    expect(manifest.workspacePath).toBe(WORKSPACE_PATH);
    expect(manifest.policySource).toBe('default-review-team-config');
    expect(manifest.coreReviewers.map((member) => member.subagentId)).toEqual([
      'ReviewWorker',
    ]);
    expect(manifest.qualityGateReviewer?.subagentId).toBe('ReviewJudge');
    expect(manifest.enabledExtraReviewers).toEqual([]);
    expect(manifest.skippedReviewers).toEqual([]);
  });

  it('maps review strategies to explicit scope profiles in the run manifest', () => {
    const team = resolveDefaultReviewTeam(
      coreSubagents(),
      storedConfigWithExtra(),
    );

    expect(buildEffectiveReviewTeamManifest(team, { strategyOverride: 'quick' }).scopeProfile)
      .toMatchObject({
        reviewDepth: 'high_risk_only',
        maxDependencyHops: 0,
        optionalReviewerPolicy: 'risk_matched_only',
        allowBroadToolExploration: false,
      });
    expect(buildEffectiveReviewTeamManifest(team, { strategyOverride: 'normal' }).scopeProfile)
      .toMatchObject({
        reviewDepth: 'risk_expanded',
        maxDependencyHops: 1,
        optionalReviewerPolicy: 'configured',
        allowBroadToolExploration: false,
      });
    expect(buildEffectiveReviewTeamManifest(team, { strategyOverride: 'deep' }).scopeProfile)
      .toMatchObject({
        reviewDepth: 'full_depth',
        maxDependencyHops: 'policy_limited',
        optionalReviewerPolicy: 'full',
        allowBroadToolExploration: true,
      });
  });

  it('keeps the explicit strict contract bound to a deep L3 manifest', () => {
    const team = resolveDefaultReviewTeam(
      coreSubagents(),
      storedConfigWithExtra(),
    );

    const manifest = buildEffectiveReviewTeamManifest(team, {
      strategyOverride: 'deep',
      qualityDecision: { level: 'l3' },
      includeQualityGate: true,
    });

    expect(manifest.strategyLevel).toBe('deep');
    expect(manifest.qualityDecision).toEqual({ level: 'l3' });
    expect(manifest.qualityGateReviewer?.subagentId).toBe('ReviewJudge');
    expect(manifest.workPackets).toEqual([]);
    expect(manifest.executionPolicy).toMatchObject({
      reviewerFileSplitThreshold: 0,
      maxSameRoleInstances: 1,
      maxRetriesPerRole: 0,
      maxReviewerCalls: 3,
    });
    expect(manifest.tokenBudget).toMatchObject({
      estimatedReviewerCalls: 1,
      maxReviewerCalls: 4,
    });

    const promptBlock = buildReviewTeamPromptBlock(team, manifest);
    expect(promptBlock).toContain('Review the prepared target directly before considering delegation.');
    expect(promptBlock).toContain('Use spawned checks only for concrete unresolved questions');
    expect(promptBlock).toContain('Run the quality inspector only');
    expect(promptBlock).toContain('"max_review_agent_executions": 4');
    expect(promptBlock).not.toContain('max_total_model_calls');
    expect(promptBlock).not.toContain('Launch only active_packets');
  });

  it('keeps historical packet dispatch while applying the adaptive concurrency ceiling', () => {
    const team = resolveDefaultReviewTeam(coreSubagents(), storedConfigWithExtra());
    const manifest = buildEffectiveReviewTeamManifest(team, {
      strategyOverride: 'deep',
      qualityDecision: { level: 'l3' },
    });
    const assignedScope = {
      kind: 'review_target' as const,
      targetSource: 'workspace_diff' as const,
      targetResolution: 'resolved' as const,
      targetTags: [],
      fileCount: 1,
      files: ['src/lib.rs'],
      excludedFileCount: 0,
    };
    manifest.executionPolicy.maxRetriesPerRole = 1;
    manifest.workPackets = [
      {
        packetId: 'legacy-logic',
        phase: 'reviewer',
        launchBatch: 0,
        subagentId: 'ReviewBusinessLogic',
        displayName: 'Logic reviewer',
        roleName: 'Business Logic Reviewer',
        assignedScope,
        allowedTools: ['GetFileDiff'],
        timeoutSeconds: 1200,
        requiredOutputFields: ['issues'],
        strategyLevel: 'deep',
        strategyDirective: 'Review behavior.',
        model: 'fast',
      },
      {
        packetId: 'legacy-security',
        phase: 'reviewer',
        launchBatch: 0,
        subagentId: 'ReviewSecurity',
        displayName: 'Security reviewer',
        roleName: 'Security Reviewer',
        assignedScope,
        allowedTools: ['GetFileDiff'],
        timeoutSeconds: 1200,
        requiredOutputFields: ['issues'],
        strategyLevel: 'deep',
        strategyDirective: 'Review trust boundaries.',
        model: 'fast',
      },
    ];

    const promptBlock = buildReviewTeamPromptBlock(team, manifest);

    expect(promptBlock).toContain('Launch only active_packets');
    expect(promptBlock).toContain('"max_parallel_instances": 2');
    expect(promptBlock).toContain('"max_retries_per_role": 1');
    expect(promptBlock).toContain('"packet_id": "legacy-logic"');
    expect(promptBlock).toContain('"packet_id": "legacy-security"');
    expect(promptBlock).not.toContain('Launch at most one specialist');
    expect(promptBlock).not.toContain('Do not use a specialist to repeat');
  });

  it('keeps changed-file coverage metadata visible for focused-scope profiles', () => {
    const team = resolveDefaultReviewTeam(
      coreSubagents(),
      storedConfigWithExtra([], { strategy_level: 'quick' }),
    );
    const files = [
      'src/crates/assembly/core/src/agentic/deep_review/report.rs',
      'src/apps/desktop/src/api/agentic_api.rs',
      'src/web-ui/src/flow_chat/deep-review/action-bar/CapacityQueueNotice.tsx',
    ];

    const manifest = buildEffectiveReviewTeamManifest(team, {
      target: classifyReviewTargetFromFiles(files, 'workspace_diff'),
    });

    expect(manifest.scopeProfile.reviewDepth).toBe('high_risk_only');
    expect(manifest.target.files.map((file) => file.normalizedPath)).toEqual(files);
    expect(manifest.evidencePack?.changedFiles).toEqual(files);
    expect(manifest.workPackets).toEqual([]);
  });

  it('includes focused-scope profile guidance in the prompt block', () => {
    const team = resolveDefaultReviewTeam(
      coreSubagents(),
      storedConfigWithExtra([], { strategy_level: 'quick' }),
    );

    const promptBlock = buildReviewTeamPromptBlock(team);

    expect(promptBlock).toContain('"review_depth": "high_risk_only"');
    expect(promptBlock).toContain('"max_dependency_hops": 0');
    expect(promptBlock).toContain('"coverage_expectation": "High-risk-only pass.');
    expect(promptBlock).not.toContain('optional_reviewer_policy');
    expect(promptBlock).not.toContain('allow_broad_tool_exploration');
    expect(promptBlock).toContain('evidence must remain an explicit coverage limitation');
  });

  it('intersects extra reviewer tools with the read-only review tool set', () => {
    const team = resolveDefaultReviewTeam(
      [
        ...coreSubagents(),
        subagent(
          'ExtraEnabled',
          true,
          'user',
          'fast',
          true,
          true,
          ['Read', 'Grep', 'Git', 'Edit', 'Exec'],
        ),
      ],
      storedConfigWithExtra(['ExtraEnabled']),
    );

    expect(team.members.find((member) => member.subagentId === 'ExtraEnabled')?.allowedTools)
      .toEqual(['Read', 'Grep']);
  });

  it('adds a locale-only guardrail for i18n-only frontend review targets', () => {
    const team = resolveDefaultReviewTeam(
      coreSubagents(),
      storedConfigWithExtra(),
    );
    const target = classifyReviewTargetFromFiles(
      [
        'src/web-ui/src/locales/zh-TW/flow-chat.json',
        'src/crates/assembly/core/locales/zh-TW.ftl',
        'OpenBitFun-Installer/src/i18n/locales/zh-TW.json',
      ],
      'session_files',
    );

    const manifest = buildEffectiveReviewTeamManifest(team, {
      workspacePath: WORKSPACE_PATH,
      target,
    });
    const promptBlock = buildReviewTeamPromptBlock(team, manifest);

    expect(promptBlock).not.toContain('Locale-only review guardrail:');
    expect(promptBlock).not.toContain('placeholder parity');
    expect(promptBlock).not.toContain('Do not broaden into React performance');
    expect(promptBlock).toContain('OpenBitFun-Installer/src/i18n/locales/zh-TW.json');
    expect(promptBlock.match(/OpenBitFun-Installer\/src\/i18n\/locales\/zh-TW\.json/g)).toHaveLength(1);
    expect(promptBlock).not.toContain('OpenBitFun-Installer/src/i18n/OpenBitFun-Installer/src/i18n/locales/zh-TW.json');
  });

  it('does not add the locale-only guardrail for mixed locale and component targets', () => {
    const team = resolveDefaultReviewTeam(
      coreSubagents(),
      storedConfigWithExtra(),
    );
    const target = classifyReviewTargetFromFiles(
      [
        'src/web-ui/src/locales/zh-TW/flow-chat.json',
        'src/web-ui/src/flow_chat/deep-review/action-bar/CapacityQueueNotice.tsx',
      ],
      'session_files',
    );

    const manifest = buildEffectiveReviewTeamManifest(team, {
      workspacePath: WORKSPACE_PATH,
      target,
    });
    const promptBlock = buildReviewTeamPromptBlock(team, manifest);

    expect(promptBlock).not.toContain('Locale-only review guardrail:');
  });

  it('pre-generates a compact diff summary for reviewer orientation', () => {
    const team = resolveDefaultReviewTeam(
      coreSubagents(),
      storedConfigWithExtra(),
    );
    const target = classifyReviewTargetFromFiles(
      [
        'src/web-ui/src/shared/services/reviewTeamService.ts',
        'src/web-ui/src/flow_chat/deep-review/action-bar/CapacityQueueNotice.tsx',
        'src/web-ui/src/locales/en-US/scenes/agents.json',
        'src/crates/assembly/core/src/agentic/deep_review_policy.rs',
        'src/crates/assembly/core/src/agentic/tools/implementations/task_tool.rs',
      ],
      'session_files',
    );

    const manifest = buildEffectiveReviewTeamManifest(team, {
      target,
      changeStats: {
        totalLinesChanged: 420,
        lineCountSource: 'diff_stat',
      },
    });

    expect(manifest.preReviewSummary).toMatchObject({
      source: 'target_manifest',
      fileCount: 5,
      lineCount: 420,
      lineCountSource: 'diff_stat',
      workspaceAreas: [
        {
          key: 'web-ui',
          fileCount: 3,
          sampleFiles: [
            'src/web-ui/src/shared/services/reviewTeamService.ts',
            'src/web-ui/src/flow_chat/deep-review/action-bar/CapacityQueueNotice.tsx',
            'src/web-ui/src/locales/en-US/scenes/agents.json',
          ],
        },
        {
          key: 'crate:core',
          fileCount: 2,
          sampleFiles: [
            'src/crates/assembly/core/src/agentic/deep_review_policy.rs',
            'src/crates/assembly/core/src/agentic/tools/implementations/task_tool.rs',
          ],
        },
      ],
    });
    expect(manifest.preReviewSummary.summary).toContain(
      '5 files, 420 changed lines across 2 workspace areas',
    );

    const promptBlock = buildReviewTeamPromptBlock(team, manifest);
    expect(promptBlock).not.toContain('Pre-generated diff summary:');
    expect(promptBlock).not.toContain('"key": "web-ui"');
    expect(promptBlock).toContain('"changed_line_count": 420');
  });

  it('does not serialize speculative shared-context cache metadata', () => {
    const team = resolveDefaultReviewTeam(
      coreSubagents(),
      storedConfigWithExtra(),
    );
    const target = classifyReviewTargetFromFiles(
      [
        'src/web-ui/src/shared/services/reviewTeamService.ts',
        'src/crates/assembly/core/src/agentic/deep_review_policy.rs',
      ],
      'session_files',
    );

    const manifest = buildEffectiveReviewTeamManifest(team, { target });
    expect(manifest.sharedContextCache).toBeUndefined();
    const promptBlock = buildReviewTeamPromptBlock(team, manifest);
    expect(promptBlock).not.toContain('Shared context cache plan:');
    expect(promptBlock).not.toContain('shared_context_cache');
  });

  it('builds a metadata-only evidence pack without source, diff, or model output', () => {
    const team = resolveDefaultReviewTeam(
      [
        ...coreSubagents(),
        subagent('ExtraEnabled', true, 'user', 'fast', true, true),
      ],
      storedConfigWithExtra(['ExtraEnabled']),
    );
    const files = [
      'src/web-ui/src/locales/en-US/flow-chat.json',
      'src/apps/desktop/src/api/agentic_api.rs',
      'src/crates/adapters/api-layer/src/review.rs',
      'package.json',
    ];

    const manifest = buildEffectiveReviewTeamManifest(team, {
      target: classifyReviewTargetFromFiles(files, 'workspace_diff'),
      changeStats: {
        fileCount: files.length,
        totalLinesChanged: 120,
        lineCountSource: 'diff_stat',
      },
      strategyOverride: 'quick',
    });

    expect(manifest.evidencePack).toMatchObject({
      version: 1,
      source: 'target_manifest',
      changedFiles: files,
      diffStat: {
        fileCount: files.length,
        totalChangedLines: 120,
        lineCountSource: 'diff_stat',
      },
      riskFocusTags: manifest.scopeProfile?.riskFocusTags,
      packetIds: [],
      privacy: {
        content: 'metadata_only',
      },
    });
    expect(manifest.evidencePack?.contractHints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'i18n_key',
          filePath: 'src/web-ui/src/locales/en-US/flow-chat.json',
        }),
        expect.objectContaining({
          kind: 'tauri_command',
          filePath: 'src/apps/desktop/src/api/agentic_api.rs',
        }),
        expect.objectContaining({
          kind: 'api_contract',
          filePath: 'src/crates/adapters/api-layer/src/review.rs',
        }),
        expect.objectContaining({
          kind: 'config_key',
          filePath: 'package.json',
        }),
      ]),
    );
    expect(manifest.evidencePack?.hunkHints).toEqual(
      files.map((filePath) => ({
        filePath,
        changedLineCount: 30,
        lineCountSource: 'diff_stat',
      })),
    );

    const serializedEvidencePack = JSON.stringify(manifest.evidencePack);
    expect(serializedEvidencePack).not.toContain('promptDirective');
    expect(serializedEvidencePack).not.toContain('allowedTools');
    expect(serializedEvidencePack).not.toContain('fullDiff');
    expect(serializedEvidencePack).not.toContain('sourceText');
    expect(serializedEvidencePack).not.toContain('modelOutput');
  });

  it('keeps the evidence pack out of the repeated launch prompt', () => {
    const team = resolveDefaultReviewTeam(
      coreSubagents(),
      storedConfigWithExtra(),
    );
    const files = [
      'src/web-ui/src/locales/en-US/flow-chat.json',
      'src/crates/adapters/api-layer/src/review.rs',
    ];
    const manifest = buildEffectiveReviewTeamManifest(team, {
      target: classifyReviewTargetFromFiles(files, 'workspace_diff'),
      changeStats: {
        fileCount: files.length,
        totalLinesChanged: 20,
        lineCountSource: 'diff_stat',
      },
    });

    const promptBlock = buildReviewTeamPromptBlock(team, manifest);

    expect(promptBlock).not.toContain('Evidence pack:');
    expect(promptBlock).not.toContain('"content": "metadata_only"');
    expect(promptBlock).not.toContain('"contract_hints"');
    expect(promptBlock).not.toContain('"Git"');
    expect(promptBlock).not.toContain('sourceText');
    expect(promptBlock).not.toContain('fullDiff');
    expect(promptBlock).not.toContain('modelOutput');
  });

  it('does not write a speculative incremental review cache plan', () => {
    const team = resolveDefaultReviewTeam(
      coreSubagents(),
      storedConfigWithExtra(),
    );
    const target = classifyReviewTargetFromFiles(
      [
        'src/web-ui/src/shared/services/reviewTeamService.ts',
        'src/crates/assembly/core/src/agentic/deep_review_policy.rs',
      ],
      'session_files',
    );

    const manifest = buildEffectiveReviewTeamManifest(team, {
      target,
      changeStats: {
        totalLinesChanged: 128,
        lineCountSource: 'diff_stat',
      },
    });

    expect(manifest.incrementalReviewCache).toBeUndefined();
    const promptBlock = buildReviewTeamPromptBlock(team, manifest);
    expect(promptBlock).not.toContain('Incremental review cache plan:');
    expect(promptBlock).not.toContain('incremental_review_cache');
  });

  it('keeps the dynamic worker available for a resolved backend target', () => {
    const team = resolveDefaultReviewTeam(
      coreSubagents(),
      storedConfigWithExtra(),
    );

    const manifest = buildEffectiveReviewTeamManifest(team, {
      target: classifyReviewTargetFromFiles(
        ['src/crates/assembly/core/src/service/config/types.rs'],
        'session_files',
      ),
    });

    expect(manifest.target.resolution).toBe('resolved');
    expect(manifest.target.tags).toEqual(['backend_core']);
    expect(manifest.coreReviewers.map((member) => member.subagentId)).toEqual([
      'ReviewWorker',
    ]);
    expect(manifest.skippedReviewers).toEqual([]);
  });

  it('keeps explicit file-path targets compatible with the dynamic worker', () => {
    const team = resolveDefaultReviewTeam(
      coreSubagents(),
      storedConfigWithExtra(),
    );

    const manifest = buildEffectiveReviewTeamManifest(team, {
      workspacePath: WORKSPACE_PATH,
      reviewTargetFilePaths: ['src/crates/assembly/core/src/agentic/deep_review_policy.rs'],
    });

    expect(manifest.coreReviewers.map((member) => member.subagentId)).toEqual([
      'ReviewWorker',
    ]);
    expect(manifest.skippedReviewers).toEqual([]);
  });

  it('uses the same dynamic worker for frontend and contract targets', () => {
    const team = resolveDefaultReviewTeam(
      coreSubagents(),
      storedConfigWithExtra(),
    );

    const manifest = buildEffectiveReviewTeamManifest(team, {
      target: classifyReviewTargetFromFiles(
        ['src/apps/desktop/src/api/agentic_api.rs'],
        'session_files',
      ),
    });

    expect(manifest.target.tags).toEqual(
      expect.arrayContaining(['desktop_contract', 'frontend_contract']),
    );
    expect(manifest.coreReviewers.map((member) => member.subagentId)).toEqual([
      'ReviewWorker',
    ]);
  });

  it('keeps the dynamic worker available for unknown targets', () => {
    const team = resolveDefaultReviewTeam(
      coreSubagents(),
      storedConfigWithExtra(),
    );

    const manifest = buildEffectiveReviewTeamManifest(team, {
      target: createUnknownReviewTargetClassification('manual_prompt'),
    });

    expect(manifest.target.resolution).toBe('unknown');
    expect(manifest.coreReviewers.map((member) => member.subagentId)).toEqual([
      'ReviewWorker',
    ]);
  });

  it('adds a balanced token budget to the run manifest by default', () => {
    const team = resolveDefaultReviewTeam(
      [
        ...coreSubagents(),
        subagent('ExtraEnabled', true, 'user', 'fast', true, true),
      ],
      storedConfigWithExtra(['ExtraEnabled']),
    );

    const manifest = buildEffectiveReviewTeamManifest(team);

    expect(manifest.tokenBudget).toMatchObject({
      mode: 'balanced',
      estimatedReviewerCalls: 1,
      maxReviewerCalls: 3,
      maxExtraReviewers: 0,
      skippedReviewerIds: [],
    });
    expect(manifest.tokenBudget.estimatedPromptBytesTotal).toBeUndefined();
    expect(manifest.tokenBudget.estimatedPromptBytesPerReviewer).toBeUndefined();
  });

  it('keeps quick strategy bounded and reduced-scope for slow-model friendly launches', () => {
    const team = resolveDefaultReviewTeam(
      [
        ...coreSubagents(),
        subagent('ExtraEnabled', true, 'user', 'fast', true, true),
      ],
      storedConfigWithExtra(['ExtraEnabled']),
    );
    const target = classifyReviewTargetFromFiles(
      [
        'src/crates/assembly/core/src/service/auth/token_store.rs',
        'src/crates/adapters/api-layer/src/review.rs',
        'src/web-ui/src/components/ReviewPanel.tsx',
      ],
      'workspace_diff',
    );

    const manifest = buildEffectiveReviewTeamManifest(team, {
      target,
      strategyOverride: 'quick',
      changeStats: {
        fileCount: 3,
        totalLinesChanged: 220,
        lineCountSource: 'diff_stat',
      },
    });

    expect(manifest.tokenBudget).toMatchObject({
      mode: 'economy',
      maxExtraReviewers: 0,
      skippedReviewerIds: [],
    });
    expect(manifest.tokenBudget.maxReviewerCalls).toBe(3);
    expect(manifest.enabledExtraReviewers).toEqual([]);
    expect(manifest.executionPolicy).toMatchObject({
      reviewerTimeoutSeconds: 1200,
      judgeTimeoutSeconds: 900,
      reviewerFileSplitThreshold: 0,
      maxSameRoleInstances: 1,
    });
    expect(manifest.coreReviewers.map((member) => member.subagentId)).toEqual([
      'ReviewWorker',
    ]);
    expect(manifest.scopeProfile).toMatchObject({
      reviewDepth: 'high_risk_only',
      optionalReviewerPolicy: 'risk_matched_only',
    });
    expect(manifest.workPackets.every((packet) =>
      packet.phase === 'judge' || packet.timeoutSeconds === 1200
    )).toBe(true);

    const promptBlock = buildReviewTeamPromptBlock(team, manifest);
    expect(promptBlock).toContain('"review_depth": "high_risk_only"');
    expect(promptBlock).toContain('evidence must remain an explicit coverage limitation');
  });

  it('keeps normal strategy from expanding into long split-heavy launches on large targets', () => {
    const team = resolveDefaultReviewTeam(
      [
        ...coreSubagents(),
        subagent('ExtraOne', true, 'user', 'fast', true, true),
        subagent('ExtraTwo', true, 'user', 'fast', true, true),
      ],
      storedConfigWithExtra(['ExtraOne', 'ExtraTwo']),
    );
    const files = Array.from(
      { length: 48 },
      (_, index) => `src/crates/assembly/core/src/agentic/large_change_${index}.rs`,
    );
    const target = classifyReviewTargetFromFiles(files, 'workspace_diff');

    const manifest = buildEffectiveReviewTeamManifest(team, {
      target,
      strategyOverride: 'normal',
      concurrencyPolicy: {
        maxParallelInstances: 16,
      },
      changeStats: {
        fileCount: files.length,
        totalLinesChanged: 3200,
        lineCountSource: 'diff_stat',
      },
    });

    expect(manifest.tokenBudget).toMatchObject({
      mode: 'balanced',
      maxExtraReviewers: 0,
      skippedReviewerIds: [],
      largeDiffSummaryFirst: false,
    });
    expect(manifest.enabledExtraReviewers).toEqual([]);
    expect(manifest.executionPolicy).toMatchObject({
      reviewerTimeoutSeconds: 1800,
      judgeTimeoutSeconds: 1200,
      reviewerFileSplitThreshold: 0,
      maxSameRoleInstances: 1,
    });
    expect(manifest.workPackets).toEqual([]);
  });

  it('builds a bounded managed plan only when explicitly requested by Review', () => {
    const team = resolveDefaultReviewTeam(coreSubagents(), storedConfigWithExtra([]));
    const files = Array.from(
      { length: 360 },
      (_, index) => `src/crates/services/example-${index}.rs`,
    );
    const target = classifyReviewTargetFromFiles(files, 'workspace_diff');

    const manifest = buildEffectiveReviewTeamManifest(team, {
      target,
      strategyOverride: 'deep',
      managedBatching: true,
      maxCoreReviewers: 0,
      maxExtraReviewers: 0,
      includeQualityGate: false,
      targetEvidence: {
        version: 1,
        source: 'workspace',
        fingerprint: 'managed-partial-target',
        completeness: 'partial',
        workspaceBinding: 'matching_clean',
        files: files.map((path) => ({
          path,
          status: 'modified',
          completeness: 'complete',
        })),
        omittedFileCount: 7,
        limitations: ['provider_file_list_incomplete'],
      },
    });

    expect(manifest.workPackets).toHaveLength(8);
    expect(manifest.workPackets?.every((packet) =>
      packet.subagentId === 'ReviewWorker' && packet.launchBatch <= 4
    )).toBe(true);
    expect(manifest.managedReviewPlan).toMatchObject({
      totalFileCount: 367,
      plannedFileCount: 320,
      deferredFileCount: 47,
      maxParallelInstances: 2,
      workerTimeoutSeconds: 120,
    });
    expect(manifest.concurrencyPolicy.maxParallelInstances).toBe(2);
    expect(manifest.executionPolicy.maxReviewerCalls).toBe(8);
    const promptBlock = buildReviewTeamPromptBlock(team, manifest);
    expect(promptBlock).toContain('"display_name": "Review batch 1"');
    expect(promptBlock).toContain(
      'Never convert managed packets to background Task calls.',
    );
    expect(promptBlock).toContain('Prepared packet execution:');
    expect(promptBlock).toContain('capacity groups, not runtime completion barriers');
    expect(promptBlock).not.toContain('in launch_batch order');
    expect(promptBlock).not.toContain('Legacy packet compatibility:');
    expect(promptBlock).not.toContain('historical packet plan');
  });

  it('aligns pull-request managed coverage with the provider diff acquisition ceiling', () => {
    const team = resolveDefaultReviewTeam(coreSubagents(), storedConfigWithExtra([]));
    const files = Array.from({ length: 500 }, (_, index) => `src/file-${index}.ts`);
    const target = {
      ...classifyReviewTargetFromFiles(files, 'workspace_diff'),
      source: 'pull_request' as const,
    };
    const incompleteFiles = files.slice(0, 250);
    const completeFiles = files.slice(250);

    const manifest = buildEffectiveReviewTeamManifest(team, {
      target,
      strategyOverride: 'deep',
      managedBatching: true,
      maxCoreReviewers: 0,
      maxExtraReviewers: 0,
      includeQualityGate: false,
      targetEvidence: {
        version: 1,
        source: 'pull_request',
        fingerprint: 'provider-budget-target',
        completeness: 'partial',
        workspaceBinding: 'matching_clean',
        files: [
          ...incompleteFiles.map((path) => ({
            path,
            status: 'modified' as const,
            completeness: 'unavailable' as const,
          })),
          ...completeFiles.map((path) => ({
            path,
            status: 'modified' as const,
            completeness: 'complete' as const,
          })),
        ],
        omittedFileCount: 0,
        limitations: ['provider_file_diff_unavailable'],
      },
    });

    const plannedFiles = manifest.workPackets?.flatMap(
      (packet) => packet.assignedScope.files,
    ) ?? [];
    expect(manifest.managedReviewPlan).toMatchObject({
      totalFileCount: 500,
      plannedFileCount: 128,
      deferredFileCount: 372,
    });
    expect(plannedFiles).toHaveLength(128);
    expect(plannedFiles.every((path) => completeFiles.includes(path))).toBe(true);
  });

  it('keeps the internal managed worker out of configurable review-team members', () => {
    const internalWorker = subagent('ReviewGeneral', true, 'project', 'fast', true, true);

    expect(canAddSubagentToReviewTeam('ReviewGeneral')).toBe(false);
    expect(canUseSubagentAsReviewTeamMember(internalWorker)).toBe(false);
  });

  it('does not double-count or schedule files beyond the evidence manifest budget', () => {
    const team = resolveDefaultReviewTeam(coreSubagents(), storedConfigWithExtra([]));
    const files = Array.from(
      { length: 5_000 },
      (_, index) => index < 4_500
        ? `src/web-ui/src/feature-${index}.ts`
        : `src/crates/services/example-${index}.rs`,
    );
    const target = classifyReviewTargetFromFiles(files, 'workspace_diff');
    const evidenceFiles = files.slice(0, 4_096);

    const manifest = buildEffectiveReviewTeamManifest(team, {
      target,
      strategyOverride: 'deep',
      managedBatching: true,
      maxCoreReviewers: 0,
      maxExtraReviewers: 0,
      includeQualityGate: false,
      targetEvidence: {
        version: 1,
        source: 'workspace',
        fingerprint: 'manifest-budget-target',
        completeness: 'partial',
        workspaceBinding: 'matching_clean',
        files: evidenceFiles.map((path) => ({
          path,
          status: 'modified',
          completeness: 'complete',
        })),
        omittedFileCount: 904,
        limitations: ['target_manifest_file_budget_exhausted'],
      },
    });

    expect(manifest.managedReviewPlan).toMatchObject({
      totalFileCount: 5_000,
      plannedFileCount: 320,
      deferredFileCount: 4_680,
    });
    const plannedFiles = manifest.workPackets?.flatMap(
      (packet) => packet.assignedScope.files,
    ) ?? [];
    expect(plannedFiles.every((file) => evidenceFiles.includes(file))).toBe(true);
  });

  it('keeps deep strategy thorough without automatic reviewer fan-out', () => {
    const team = resolveDefaultReviewTeam(
      coreSubagents(),
      storedConfigWithExtra(),
    );
    const target = classifyReviewTargetFromFiles(
      Array.from(
        { length: 25 },
        (_, index) => `src/web-ui/src/components/ReviewPanel${index}.tsx`,
      ),
      'workspace_diff',
    );

    const manifest = buildEffectiveReviewTeamManifest(team, {
      target,
      strategyOverride: 'deep',
      tokenBudgetMode: undefined,
      concurrencyPolicy: {
        maxParallelInstances: 16,
      },
      changeStats: {
        fileCount: 25,
        totalLinesChanged: 800,
        lineCountSource: 'diff_stat',
      },
    });

    expect(manifest.tokenBudget).toMatchObject({
      mode: 'thorough',
      maxExtraReviewers: 0,
    });
    expect(manifest.executionPolicy).toMatchObject({
      reviewerTimeoutSeconds: 3600,
      judgeTimeoutSeconds: 2400,
      reviewerFileSplitThreshold: 0,
      maxSameRoleInstances: 1,
      maxRetriesPerRole: 0,
      maxReviewerCalls: 3,
    });
    expect(manifest.workPackets).toEqual([]);
  });

  it('does not invent prompt-byte pressure or hide assigned files', () => {
    const team = resolveDefaultReviewTeam(
      coreSubagents(),
      storedConfigWithExtra(),
    );
    const files = Array.from(
      { length: 6 },
      (_, index) => `src/crates/assembly/core/src/agentic/large_change_${index}.rs`,
    );
    const target = classifyReviewTargetFromFiles(files, 'workspace_diff');

    const manifest = buildEffectiveReviewTeamManifest(team, {
      target,
      changeStats: {
        fileCount: files.length,
        totalLinesChanged: 5000,
        lineCountSource: 'diff_stat',
      },
    });

    expect(manifest.tokenBudget).toMatchObject({
      largeDiffSummaryFirst: false,
    });
    expect(manifest.tokenBudget.maxPromptBytesPerReviewer).toBeUndefined();
    expect(manifest.tokenBudget.estimatedPromptBytesPerReviewer).toBeUndefined();
    expect(manifest.tokenBudget.promptByteEstimateSource).toBeUndefined();
    expect(manifest.tokenBudget.promptByteLimitExceeded).toBeUndefined();
    expect(manifest.tokenBudget.decisions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'summary_first_full_scope' }),
      ]),
    );
    expect(manifest.workPackets).toEqual([]);

    const promptBlock = buildReviewTeamPromptBlock(team, manifest);
    for (const file of files) {
      expect(promptBlock).toContain(file);
    }
    expect(promptBlock).not.toContain('token_budget_decisions');
    expect(promptBlock).not.toContain('prompt_byte');
  });

  it('keeps normal manifest timeouts bounded for resolved target size', () => {
    const team = resolveDefaultReviewTeam(
      coreSubagents(),
      storedConfigWithExtra(),
    );
    const target = classifyReviewTargetFromFiles(
      Array.from(
        { length: 25 },
        (_, index) => `src/web-ui/src/components/ReviewPanel${index}.tsx`,
      ),
      'session_files',
    );

    const manifest = buildEffectiveReviewTeamManifest(team, { target });

    expect(manifest.changeStats).toMatchObject({
      fileCount: 25,
      lineCountSource: 'unknown',
    });
    expect(manifest.executionPolicy).toMatchObject({
      reviewerTimeoutSeconds: 1800,
      judgeTimeoutSeconds: 1200,
    });

    const promptBlock = buildReviewTeamPromptBlock(team, manifest);
    expect(promptBlock).toContain('"file_count": 25');
    expect(promptBlock).toContain('"changed_line_count": null');
    expect(promptBlock).toContain('"specialist_timeout_seconds": 1800');
    expect(promptBlock).toContain('"quality_inspector_timeout_seconds": 1200');
  });

  it('keeps normal manifest timeouts bounded even with diff line stats', () => {
    const team = resolveDefaultReviewTeam(
      coreSubagents(),
      storedConfigWithExtra(),
    );
    const target = classifyReviewTargetFromFiles(
      Array.from(
        { length: 25 },
        (_, index) => `src/web-ui/src/components/ReviewPanel${index}.tsx`,
      ),
      'workspace_diff',
    );

    const manifest = buildEffectiveReviewTeamManifest(team, {
      target,
      changeStats: {
        fileCount: 25,
        totalLinesChanged: 800,
        lineCountSource: 'diff_stat',
      },
    });

    expect(manifest.changeStats).toMatchObject({
      fileCount: 25,
      totalLinesChanged: 800,
      lineCountSource: 'diff_stat',
    });
    expect(manifest.executionPolicy).toMatchObject({
      reviewerTimeoutSeconds: 1800,
      judgeTimeoutSeconds: 1200,
    });

    const promptBlock = buildReviewTeamPromptBlock(team, manifest);
    expect(promptBlock).toContain('"changed_line_count": 800');
    expect(promptBlock).toContain('"changed_line_count_source": "diff_stat"');
    expect(promptBlock).toContain('"specialist_timeout_seconds": 1800');
    expect(promptBlock).toContain('"quality_inspector_timeout_seconds": 1200');
  });

  it('keeps advisory risk recommendations in the manifest but out of the launch prompt', () => {
    const team = resolveDefaultReviewTeam(
      coreSubagents(),
      storedConfigWithExtra(),
    );
    const target = classifyReviewTargetFromFiles(
      [
        'src/crates/assembly/core/src/service/auth/token_store.rs',
        'src/apps/desktop/src/api/agentic_api.rs',
        ...Array.from(
          { length: 18 },
          (_, index) => `src/web-ui/src/components/ReviewPanel${index}.tsx`,
        ),
      ],
      'workspace_diff',
    );

    const manifest = buildEffectiveReviewTeamManifest(team, {
      target,
      changeStats: {
        fileCount: 20,
        totalLinesChanged: 1400,
        lineCountSource: 'diff_stat',
      },
    });

    expect(manifest.strategyLevel).toBe('normal');
    expect(manifest.strategyRecommendation).toMatchObject({
      strategyLevel: 'deep',
      factors: {
        fileCount: 20,
        totalLinesChanged: 1400,
        securityFileCount: 1,
      },
    });
    expect(manifest.strategyRecommendation?.rationale).toContain('Large/high-risk change');
    expect(manifest.strategyDecision).toMatchObject({
      authority: 'mismatch_warning',
      teamDefaultStrategy: 'normal',
      finalStrategy: 'normal',
      mismatch: true,
      mismatchSeverity: 'medium',
      frontendRecommendation: {
        strategyLevel: 'deep',
      },
      backendRecommendation: {
        strategyLevel: 'deep',
        factors: {
          fileCount: 20,
          totalLinesChanged: 1400,
          filesInSecurityPaths: 1,
          maxCyclomaticComplexityDelta: 0,
          maxCyclomaticComplexityDeltaSource: 'not_measured',
        },
      },
    });

    const promptBlock = buildReviewTeamPromptBlock(team, manifest);
    expect(promptBlock).toContain('"selected_strategy": "normal"');
    expect(promptBlock).not.toContain('recommended_strategy');
    expect(promptBlock).not.toContain('strategy_mismatch');
    expect(promptBlock).not.toContain('max_cyclomatic_complexity_delta_source');
    expect(promptBlock).not.toContain('Large/high-risk change');
  });

  it('records explicit strategy override as final strategy metadata without expanding reviewer roster', () => {
    const team = resolveDefaultReviewTeam(
      [
        ...coreSubagents(),
        subagent('ExtraEnabled', true, 'user', 'fast', true, true),
      ],
      storedConfigWithExtra(['ExtraEnabled']),
    );
    const target = classifyReviewTargetFromFiles(
      [
        ...Array.from(
          { length: 24 },
          (_, index) => `src/crates/assembly/core/src/review/module_${index}.rs`,
        ),
      ],
      'workspace_diff',
    );

    const manifest = buildEffectiveReviewTeamManifest(team, {
      target,
      strategyOverride: 'quick',
      changeStats: {
        fileCount: 24,
        totalLinesChanged: 1800,
        lineCountSource: 'diff_stat',
      },
    });

    expect(manifest.strategyDecision).toMatchObject({
      authority: 'mismatch_warning',
      teamDefaultStrategy: 'normal',
      userOverride: 'quick',
      finalStrategy: 'quick',
      mismatch: true,
      mismatchSeverity: 'high',
      backendRecommendation: {
        strategyLevel: 'deep',
      },
    });
    expect(manifest.coreReviewers.map((member) => member.subagentId)).toEqual([
      'ReviewWorker',
    ]);
    expect(manifest.enabledExtraReviewers).toEqual([]);
    expect(manifest.tokenBudget).toMatchObject({
      mode: 'economy',
      skippedReviewerIds: [],
    });

    const promptBlock = buildReviewTeamPromptBlock(team, manifest);
    expect(promptBlock).toContain('"selected_strategy": "quick"');
    expect(promptBlock).not.toContain('strategy_user_override');
    expect(promptBlock).not.toContain('strategy_mismatch');
  });

  it('keeps unknown targets at a conservative normal recommendation', () => {
    const team = resolveDefaultReviewTeam(
      coreSubagents(),
      storedConfigWithExtra(),
    );

    const manifest = buildEffectiveReviewTeamManifest(team, {
      target: createUnknownReviewTargetClassification('manual_prompt'),
    });

    expect(manifest.strategyRecommendation).toMatchObject({
      strategyLevel: 'normal',
      score: 0,
    });
    expect(manifest.strategyRecommendation?.rationale).toContain('unresolved target');

    const promptBlock = buildReviewTeamPromptBlock(team, manifest);
    expect(promptBlock).toContain('"selected_strategy": "normal"');
    expect(promptBlock).not.toContain('recommended_strategy');
  });

  it('preserves explicit zero timeout policy when predicting manifest timeouts', () => {
    const team = resolveDefaultReviewTeam(
      coreSubagents(),
      storedConfigWithExtra([], {
        reviewer_timeout_seconds: 0,
        judge_timeout_seconds: 0,
      }),
    );
    const target = classifyReviewTargetFromFiles(
      ['src/web-ui/src/components/ReviewPanel.tsx'],
      'session_files',
    );

    const manifest = buildEffectiveReviewTeamManifest(team, { target });

    expect(manifest.executionPolicy).toMatchObject({
      reviewerTimeoutSeconds: 0,
      judgeTimeoutSeconds: 0,
    });
  });

  it('does not report capability sources as budget-limited reviewers', () => {
    const team = resolveDefaultReviewTeam(
      [
        ...coreSubagents(),
        subagent('ExtraOne', true, 'user', 'fast', true, true),
        subagent('ExtraTwo', true, 'user', 'fast', true, true),
      ],
      storedConfigWithExtra(['ExtraOne', 'ExtraTwo']),
    );

    const manifest = buildEffectiveReviewTeamManifest(team, {
      tokenBudgetMode: 'economy',
    });

    expect(manifest.enabledExtraReviewers).toEqual([]);
    expect(manifest.skippedReviewers).toEqual([]);
    expect(manifest.tokenBudget).toMatchObject({
      mode: 'economy',
      maxExtraReviewers: 0,
      skippedReviewerIds: [],
    });
  });

  it('applies per-member strategy overrides in the launch manifest and prompt', () => {
    const team = resolveDefaultReviewTeam(
      [
        ...coreSubagents(),
        subagent('ExtraEnabled', true, 'user', 'fast', true, true),
      ],
      storedConfigWithExtra(['ExtraEnabled'], {
        strategy_level: 'quick',
        member_strategy_overrides: {
          ReviewWorker: 'deep',
          ExtraEnabled: 'normal',
        },
      }),
    );

    const manifest = buildEffectiveReviewTeamManifest(team, {
      workspacePath: WORKSPACE_PATH,
    });

    expect(manifest.strategyLevel).toBe('quick');
    expect(manifest.coreReviewers).toEqual([
      expect.objectContaining({
        subagentId: 'ReviewWorker',
        strategyLevel: 'deep',
        strategySource: 'member',
        model: 'primary',
        defaultModelSlot: 'primary',
        strategyDirective: REVIEW_STRATEGY_DEFINITIONS.deep.roleDirectives.ReviewWorker,
      }),
    ]);
    expect(manifest.enabledExtraReviewers).toEqual([]);
    expect(manifest.skippedReviewers).toEqual([]);

    const promptBlock = buildReviewTeamPromptBlock(team, manifest);
    expect(promptBlock).toContain('"selected_strategy": "quick"');
    expect(promptBlock).toContain('Prepared Review execution plan');
    expect(promptBlock).toContain('Execution rules:');
    expect(promptBlock).toContain('"max_focused_questions": 2');
    expect(promptBlock).not.toContain('"subagent_type": "ReviewWorker"');
    expect(promptBlock).not.toContain('prompt_directive');
    expect(promptBlock).not.toContain('Token/time impact');
  });

  it('migrates a historical reviewer strategy override to the dynamic worker', () => {
    const team = resolveDefaultReviewTeam(
      coreSubagents(),
      storedConfigWithExtra([], {
        strategy_level: 'deep',
        member_strategy_overrides: { ReviewSecurity: 'quick' },
      }),
    );
    const manifest = buildEffectiveReviewTeamManifest(team, {
      workspacePath: WORKSPACE_PATH,
    });

    expect(team.memberStrategyOverrides.ReviewWorker).toBe('quick');
    expect(manifest.coreReviewers).toEqual([
      expect.objectContaining({
        subagentId: 'ReviewWorker',
        strategyLevel: 'quick',
        strategySource: 'member',
      }),
    ]);
  });

  it('does not fold an exact custom historical id into the dynamic worker', () => {
    const team = resolveDefaultReviewTeam(
      [...coreSubagents(), subagent('ReviewSecurity', true, 'user')],
      storedConfigWithExtra([], {
        strategy_level: 'deep',
        member_strategy_overrides: { ReviewSecurity: 'quick' },
      }),
    );

    expect(team.memberStrategyOverrides.ReviewWorker).toBeUndefined();
    expect(team.coreMembers.find((member) => member.subagentId === 'ReviewWorker')).toMatchObject({
      strategyLevel: 'deep',
      strategySource: 'team',
    });
  });

  it('prefers the deepest legacy worker override when historical roles conflict', () => {
    const team = resolveDefaultReviewTeam(
      coreSubagents(),
      storedConfigWithExtra([], {
        member_strategy_overrides: {
          ReviewSecurity: 'quick',
          ReviewArchitecture: 'deep',
        },
      }),
    );

    expect(team.memberStrategyOverrides.ReviewWorker).toBe('deep');
  });

  it('applies a project strategy override to the launch manifest without changing member overrides', () => {
    const team = resolveDefaultReviewTeam(
      [
        ...coreSubagents(),
        subagent('ExtraEnabled', true, 'user', 'fast', true, true),
      ],
      storedConfigWithExtra(['ExtraEnabled'], {
        strategy_level: 'normal',
        member_strategy_overrides: {
          ReviewWorker: 'quick',
        },
      }),
    );

    const manifest = buildEffectiveReviewTeamManifest(team, {
      workspacePath: WORKSPACE_PATH,
      strategyOverride: 'deep',
    });

    expect(manifest.strategyLevel).toBe('deep');
    expect(manifest.coreReviewers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subagentId: 'ReviewWorker',
          strategyLevel: 'quick',
          strategySource: 'member',
          defaultModelSlot: 'fast',
        }),
      ]),
    );
    expect(manifest.enabledExtraReviewers).toEqual([]);

    const promptBlock = buildReviewTeamPromptBlock(team, manifest);
    expect(promptBlock).toContain('"selected_strategy": "deep"');
    expect(promptBlock).toContain('"max_focused_questions": 3');
    expect(promptBlock).not.toContain('"subagent_type": "ReviewWorker"');
    expect(promptBlock).not.toContain('prompt_directive');
  });

  it('does not project configured reviewer model details into adaptive manifests', () => {
    const team = resolveDefaultReviewTeam(
      [
        ...coreSubagents(),
        subagent('ExtraDeletedModel', true, 'user', 'deleted-model', true, true),
        subagent('ExtraCustomModel', true, 'user', 'model-kept', true, true),
      ],
      storedConfigWithExtra(['ExtraDeletedModel', 'ExtraCustomModel'], {
        strategy_level: 'deep',
      }),
      { availableModelIds: ['model-kept'] },
    );

    const manifest = buildEffectiveReviewTeamManifest(team);
    expect(manifest.enabledExtraReviewers).toEqual([]);
    expect(manifest.skippedReviewers).toEqual([]);
  });

  it('renders the run manifest without scheduling disabled extra reviewers', () => {
    const team = resolveDefaultReviewTeam(
      [
        ...coreSubagents(),
        subagent('ExtraEnabled', true, 'user', 'fast', true, true),
        subagent('ExtraDisabled', false, 'project', 'fast', true, true),
      ],
      storedConfigWithExtra(['ExtraEnabled', 'ExtraDisabled']),
    );

    const promptBlock = buildReviewTeamPromptBlock(
      team,
      buildEffectiveReviewTeamManifest(team, {
        workspacePath: WORKSPACE_PATH,
      }),
    );

    expect(promptBlock).toContain('Prepared Review execution plan');
    expect(promptBlock).toContain('"resolution": "unknown"');
    expect(promptBlock).toContain('"selected_strategy": "normal"');
    expect(promptBlock).not.toContain(WORKSPACE_PATH);
    expect(promptBlock).not.toContain('ExtraEnabled');
    expect(promptBlock).not.toContain('ExtraDisabled');
    expect(promptBlock).toContain('concise capability catalog');
    expect(promptBlock).not.toContain('Configured code review team:');
    expect(promptBlock).not.toContain('Team execution rules:');
    expect(promptBlock).not.toContain('run it in parallel with the locked reviewers whenever the change contains frontend files');
  });

  it('distinguishes immutable Git ranges from mutable workspace evidence', () => {
    const team = resolveDefaultReviewTeam(coreSubagents(), storedConfigWithExtra());
    const target = classifyReviewTargetFromFiles(['src/lib.rs'], 'session_files');
    const baseEvidence = {
      version: 1 as const,
      fingerprint: '0123456789abcdef',
      completeness: 'complete' as const,
      workspaceBinding: 'matching_clean' as const,
      files: [{
        path: 'src/lib.rs',
        status: 'modified' as const,
        completeness: 'complete' as const,
      }],
      limitations: [],
    };

    const workspacePrompt = buildReviewTeamPromptBlock(
      team,
      buildEffectiveReviewTeamManifest(team, {
        workspacePath: WORKSPACE_PATH,
        target,
        targetEvidence: { ...baseEvidence, source: 'workspace' },
      }),
    );
    const gitRangePrompt = buildReviewTeamPromptBlock(
      team,
      buildEffectiveReviewTeamManifest(team, {
        workspacePath: WORKSPACE_PATH,
        target,
        targetEvidence: {
          ...baseEvidence,
          source: 'git_range',
          baseRevision: '1'.repeat(40),
          headRevision: '2'.repeat(40),
        },
      }),
    );

    expect(workspacePrompt).toContain('"source": "workspace"');
    expect(workspacePrompt).not.toContain('immutable');
    expect(gitRangePrompt).toContain('"source": "git_range"');
    expect(gitRangePrompt).toContain(`"base_revision": "${'1'.repeat(40)}"`);
    expect(gitRangePrompt).toContain(`"head_revision": "${'2'.repeat(40)}"`);
    expect(workspacePrompt).toContain('Do not reinterpret, widen, or replace the prepared target.');
    expect(gitRangePrompt).toContain('Do not reinterpret, widen, or replace the prepared target.');
  });

  it('tells DeepReview to wait for user approval before running ReviewFixer', () => {
    const team = resolveDefaultReviewTeam(
      coreSubagents(),
      storedConfigWithExtra(),
    );

    const promptBlock = buildReviewTeamPromptBlock(team);

    expect(promptBlock).toContain('Remain read-only. Do not launch ReviewFixer or start remediation without explicit user approval.');
  });
});
