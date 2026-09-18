import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TauriCommandError } from '@/infrastructure/api/errors/TauriCommandError';
import { resetGitTrustDecisions } from '@/shared/services/gitTrustService';
import type { ReviewTeamRunManifest } from '@/shared/services/reviewTeamService';
import {
  launchPreparedReviewSession,
  prepareReviewLaunchFromPullRequest,
  prepareReviewLaunchFromSessionFiles,
  prepareReviewLaunchFromSlashCommand,
} from './ReviewService';

const mocks = vi.hoisted(() => ({
  buildDeepReviewLaunchFromSessionFiles: vi.fn(),
  buildDeepReviewLaunchFromSlashCommand: vi.fn(),
  launchDeepReviewSession: vi.fn(),
  resolveSlashCommandReviewTarget: vi.fn(),
  resolveCurrentFileReviewSnapshot: vi.fn(),
  createBtwChildSession: vi.fn(),
  createBtwRequestId: vi.fn(),
  sendMessage: vi.fn(),
  insertReviewSessionSummaryMarker: vi.fn(),
  openBtwSessionInAuxPane: vi.fn(),
  closeBtwSessionInAuxPane: vi.fn(),
  deleteSession: vi.fn(),
  discardLocalSession: vi.fn(),
  trustRepository: vi.fn(),
  confirmWarning: vi.fn(),
  sessions: new Map<string, unknown>(),
}));

vi.mock('@/infrastructure/api', () => ({
  agentAPI: {
    deleteSession: (...args: unknown[]) => mocks.deleteSession(...args),
  },
  gitAPI: {
    trustRepository: (...args: unknown[]) => mocks.trustRepository(...args),
  },
}));

// Review drives the real trust recovery; only its user-facing edges are stubbed.
vi.mock('@/infrastructure/confirm-dialog', () => ({
  confirmWarning: (...args: unknown[]) => mocks.confirmWarning(...args),
}));

vi.mock('@/shared/notification-system', () => ({
  notificationService: { warning: vi.fn(), success: vi.fn() },
}));

vi.mock('./DeepReviewService', () => ({
  buildDeepReviewLaunchFromSessionFiles: (...args: unknown[]) =>
    mocks.buildDeepReviewLaunchFromSessionFiles(...args),
  buildDeepReviewLaunchFromSlashCommand: (...args: unknown[]) =>
    mocks.buildDeepReviewLaunchFromSlashCommand(...args),
  launchDeepReviewSession: (...args: unknown[]) => mocks.launchDeepReviewSession(...args),
}));

vi.mock('../deep-review/launch/targetResolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../deep-review/launch/targetResolver')>();
  return {
    ...actual,
    resolveSlashCommandReviewTarget: (...args: unknown[]) =>
      mocks.resolveSlashCommandReviewTarget(...args),
    resolveCurrentFileReviewSnapshot: (...args: unknown[]) =>
      mocks.resolveCurrentFileReviewSnapshot(...args),
  };
});

vi.mock('./BtwThreadService', () => ({
  createBtwChildSession: (...args: unknown[]) => mocks.createBtwChildSession(...args),
  createBtwRequestId: (...args: unknown[]) => mocks.createBtwRequestId(...args),
}));

vi.mock('./FlowChatManager', () => ({
  FlowChatManager: {
    getInstance: () => ({
      sendMessage: mocks.sendMessage,
      discardLocalSession: mocks.discardLocalSession,
    }),
  },
}));

vi.mock('../store/FlowChatStore', () => ({
  flowChatStore: {
    getState: () => ({ sessions: mocks.sessions }),
  },
}));

vi.mock('./ReviewSessionMarkerService', () => ({
  insertReviewSessionSummaryMarker: (...args: unknown[]) =>
    mocks.insertReviewSessionSummaryMarker(...args),
}));

vi.mock('./btwSessionPane', () => ({
  openBtwSessionInAuxPane: (...args: unknown[]) => mocks.openBtwSessionInAuxPane(...args),
  closeBtwSessionInAuxPane: (...args: unknown[]) => mocks.closeBtwSessionInAuxPane(...args),
}));

function runManifest(strategyLevel: 'normal' | 'deep' = 'normal'): ReviewTeamRunManifest {
  return {
    reviewMode: 'deep',
    policySource: 'default-review-team-config',
    target: {
      source: 'session_files',
      resolution: 'resolved',
      tags: ['backend_core'],
      files: [{
        path: 'src/file.ts',
        normalizedPath: 'src/file.ts',
        status: 'modified',
        source: 'session_files',
        tags: ['backend_core'],
      }],
      warnings: [],
    },
    strategyLevel,
    strategyDecision: {} as ReviewTeamRunManifest['strategyDecision'],
    executionPolicy: {} as ReviewTeamRunManifest['executionPolicy'],
    concurrencyPolicy: {} as ReviewTeamRunManifest['concurrencyPolicy'],
    preReviewSummary: {} as ReviewTeamRunManifest['preReviewSummary'],
    sharedContextCache: {} as ReviewTeamRunManifest['sharedContextCache'],
    incrementalReviewCache: {} as ReviewTeamRunManifest['incrementalReviewCache'],
    tokenBudget: {} as ReviewTeamRunManifest['tokenBudget'],
    coreReviewers: [],
    enabledExtraReviewers: [],
    skippedReviewers: [],
  };
}

function targetEvidence() {
  return {
    version: 1 as const,
    source: 'workspace' as const,
    fingerprint: 'abc12345',
    baseRevision: '1'.repeat(40),
    headRevision: 'worktree:abc12345',
    completeness: 'complete' as const,
    workspaceBinding: 'matching_dirty' as const,
    files: [{
      path: 'src/file.ts',
      status: 'modified' as const,
      completeness: 'complete' as const,
    }],
    limitations: ['mutable_workspace_evidence'],
  };
}

describe('ReviewService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetGitTrustDecisions();
    mocks.sessions.clear();
    mocks.createBtwChildSession.mockResolvedValue({
      childSessionId: 'review-child',
      parentDialogTurnId: 'turn-1',
    });
    mocks.createBtwRequestId.mockReturnValue('generated-review-id');
    mocks.sendMessage.mockResolvedValue(undefined);
    mocks.launchDeepReviewSession.mockResolvedValue({ childSessionId: 'strict-child' });
    mocks.deleteSession.mockResolvedValue(undefined);
    mocks.resolveCurrentFileReviewSnapshot.mockImplementation(
      async (_workspacePath, target) => ({
        target,
        changeStats: {
          fileCount: 1,
          lineCountSource: 'unknown',
        },
        targetEvidence: targetEvidence(),
      }),
    );
  });

  it.each(['session files', 'slash command'])('explains a missing Git repository for %s', async (entry) => {
    const error = new TauriCommandError('Internal error', {
      command: 'git_get_status',
      originalError: {
        message: 'Internal error',
        data: "Failed to get Git status: Repository not found: could not find repository at '/workspace'",
      },
    });
    let preparation;
    if (entry === 'session files') {
      mocks.resolveCurrentFileReviewSnapshot.mockRejectedValueOnce(error);
      preparation = prepareReviewLaunchFromSessionFiles(['src/file.ts'], {
        workspaceId: 'workspace-1', workspacePath: '/workspace',
      });
    } else {
      mocks.resolveSlashCommandReviewTarget.mockRejectedValueOnce(error);
      preparation = prepareReviewLaunchFromSlashCommand('/review', '/workspace', undefined, 'workspace-1');
    }

    await expect(preparation).rejects.toMatchObject({
      launchErrorMessageKey: 'deepReviewActionBar.launchError.notGitRepository',
    });
    expect(mocks.createBtwChildSession).not.toHaveBeenCalled();
    expect(mocks.confirmWarning).not.toHaveBeenCalled();
    expect(mocks.trustRepository).not.toHaveBeenCalled();
  });

  it('prepares a small session review without constructing a review team', async () => {
    const prepared = await prepareReviewLaunchFromSessionFiles(
      ['src/small.ts'],
      {
        workspaceId: 'workspace-1', workspacePath: 'D:/workspace/project',
        changeStats: {
          fileCount: 1,
          totalLinesChanged: 4,
          lineCountSource: 'diff_stat',
        },
      },
    );

    expect(prepared.mode).toBe('standard');
    expect(prepared.level).toBe('l1');
    expect(prepared.prompt).toContain('independent adversarial review');
    expect(prepared.prompt).toContain('src/small.ts');
    expect(prepared.runManifest).toMatchObject({
      adaptiveReview: { version: 1, maxFocusedCalls: 2 },
      concurrencyPolicy: { maxParallelInstances: 2 },
      executionPolicy: { maxReviewerCalls: 2, maxRetriesPerRole: 0 },
      enabledExtraReviewers: [],
      workPackets: [],
    });
    expect(mocks.buildDeepReviewLaunchFromSessionFiles).not.toHaveBeenCalled();
  });

  it('measures the current diff for a file-scoped review', async () => {
    mocks.resolveCurrentFileReviewSnapshot.mockImplementationOnce(
      async (_workspacePath, target) => ({
        target,
        changeStats: {
          fileCount: 2,
          totalLinesChanged: 3,
          lineCountSource: 'diff_stat',
        },
        targetEvidence: targetEvidence(),
      }),
    );

    await prepareReviewLaunchFromSessionFiles(
      ['src/auth.ts', 'src/helper.ts'],
      {
        workspaceId: 'workspace-1', workspacePath: 'D:/workspace/project',
        remoteConnectionId: 'remote-connection-1',
      },
    );

    expect(mocks.resolveCurrentFileReviewSnapshot).toHaveBeenCalledWith(
      { workspaceId: 'workspace-1', repositoryPath: 'D:/workspace/project' },
      expect.objectContaining({
        files: expect.arrayContaining([
          expect.objectContaining({ normalizedPath: 'src/auth.ts' }),
          expect.objectContaining({ normalizedPath: 'src/helper.ts' }),
        ]),
      }),
      'remote-connection-1',
    );
    expect(mocks.buildDeepReviewLaunchFromSessionFiles).not.toHaveBeenCalled();
  });

  it('keeps a medium target on the single-agent standard path', async () => {
    const files = Array.from({ length: 6 }, (_, index) => `src/file-${index}.ts`);
    const prepared = await prepareReviewLaunchFromSessionFiles(files, {
      workspaceId: 'workspace-1', workspacePath: 'D:/workspace/project',
      changeStats: {
        fileCount: files.length,
        totalLinesChanged: 20,
        lineCountSource: 'diff_stat',
      },
    });

    expect(prepared).toMatchObject({
      mode: 'standard',
      level: 'l1',
      strategyLevel: 'quick',
      requiresConsent: false,
    });
    expect(mocks.buildDeepReviewLaunchFromSessionFiles).not.toHaveBeenCalled();
  });

  it('uses a managed foreground-waited review plan for a large target', async () => {
    const files = Array.from({ length: 120 }, (_, index) => `src/file-${index}.ts`);
    const manifest = runManifest('deep');
    mocks.resolveCurrentFileReviewSnapshot.mockImplementationOnce(
      async (_workspacePath, target) => ({
        target,
        changeStats: {
          fileCount: files.length,
          totalLinesChanged: 2_400,
          lineCountSource: 'diff_stat' as const,
        },
        targetEvidence: {
          ...targetEvidence(),
          files: files.map((path) => ({
            path,
            status: 'modified' as const,
            completeness: 'complete' as const,
          })),
        },
      }),
    );
    mocks.buildDeepReviewLaunchFromSessionFiles.mockResolvedValue({
      prompt: 'managed review prompt',
      runManifest: manifest,
    });

    const prepared = await prepareReviewLaunchFromSessionFiles(files, {
      workspaceId: 'workspace-1', workspacePath: 'D:/workspace/project',
    });

    expect(prepared).toMatchObject({
      mode: 'managed',
      level: 'l1',
      strategyLevel: 'deep',
      requiresConsent: false,
      runManifest: manifest,
    });
    expect(mocks.buildDeepReviewLaunchFromSessionFiles).toHaveBeenCalledWith(
      files,
      undefined,
      { workspaceId: 'workspace-1', repositoryPath: 'D:/workspace/project' },
      expect.objectContaining({
        strategyOverride: 'deep',
        managedBatching: true,
        includeQualityGate: false,
      }),
    );
  });

  it('maps legacy DeepReview commands to the explicit L3 path', async () => {
    const manifest = runManifest('deep');
    mocks.resolveSlashCommandReviewTarget.mockResolvedValue({
      target: manifest.target,
      changeStats: {
        fileCount: 1,
        totalLinesChanged: 4,
        lineCountSource: 'diff_stat',
      },
      targetEvidence: targetEvidence(),
    });
    mocks.buildDeepReviewLaunchFromSlashCommand.mockResolvedValue({
      prompt: 'strict prompt',
      runManifest: manifest,
    });

    const prepared = await prepareReviewLaunchFromSlashCommand(
      '/DeepReview focus on auth',
      'D:/workspace/project', undefined, 'workspace-1',
    );

    expect(prepared).toMatchObject({
      mode: 'strict',
      level: 'l3',
      strategyLevel: 'deep',
      runManifest: manifest,
      requiresConsent: false,
    });
    expect(mocks.buildDeepReviewLaunchFromSlashCommand).toHaveBeenCalledWith(
      '/DeepReview focus on auth',
      { workspaceId: 'workspace-1', repositoryPath: 'D:/workspace/project' },
      expect.objectContaining({
        strategyOverride: 'deep',
        qualityDecision: { level: 'l3' },
      }),
    );
  });

  it('forces explicit strict session review onto the deep manifest strategy', async () => {
    const manifest = runManifest('deep');
    mocks.buildDeepReviewLaunchFromSessionFiles.mockResolvedValue({
      prompt: 'strict prompt',
      runManifest: manifest,
    });

    const prepared = await prepareReviewLaunchFromSessionFiles(['src/auth.ts'], {
      workspaceId: 'workspace-1', workspacePath: 'D:/workspace/project',
      intent: 'strict',
    });

    expect(prepared).toMatchObject({
      mode: 'strict',
      level: 'l3',
      strategyLevel: 'deep',
      runManifest: manifest,
    });
    expect(mocks.buildDeepReviewLaunchFromSessionFiles).toHaveBeenCalledWith(
      ['src/auth.ts'],
      undefined,
      { workspaceId: 'workspace-1', repositoryPath: 'D:/workspace/project' },
      expect.objectContaining({
        strategyOverride: 'deep',
        qualityDecision: { level: 'l3' },
      }),
    );
  });

  it('reviews partial evidence instead of rejecting an oversized target', async () => {
    const manifest = runManifest('deep');
    mocks.buildDeepReviewLaunchFromSessionFiles.mockResolvedValue({
      prompt: 'managed partial review prompt',
      runManifest: manifest,
    });
    mocks.resolveCurrentFileReviewSnapshot.mockImplementationOnce(
      async (_workspacePath, target) => ({
        target,
        changeStats: { fileCount: 501, lineCountSource: 'unknown' },
        targetEvidence: {
          ...targetEvidence(),
          omittedFileCount: 1,
          completeness: 'partial' as const,
          limitations: ['target_file_limit_exceeded'],
        },
      }),
    );

    await expect(prepareReviewLaunchFromSessionFiles(
      ['src/file.ts'],
      { workspaceId: 'workspace-1', workspacePath: 'D:/workspace/project' },
    )).resolves.toMatchObject({
      mode: 'managed',
      requiresConsent: false,
      runManifest: manifest,
    });
  });

  it('prepares Review after the user grants ownership trust', async () => {
    const untrusted = new TauriCommandError('Command failed', {
      command: 'git_get_status',
      originalError: 'git_repository_untrusted: D:/workspace/project',
    });
    mocks.resolveCurrentFileReviewSnapshot.mockRejectedValueOnce(untrusted);
    mocks.confirmWarning.mockResolvedValue(true);
    mocks.trustRepository.mockResolvedValue({
      state: 'trusted',
      repositoryPath: 'D:/workspace/project',
      alreadyTrusted: false,
      addedEntries: ['D:/workspace/project'],
      detail: null,
      manualCommand: null,
    });

    const prepared = await prepareReviewLaunchFromSessionFiles(['src/small.ts'], {
      workspaceId: 'workspace-1', workspacePath: 'D:/workspace/project',
    });

    expect(prepared.mode).toBe('standard');
    expect(mocks.trustRepository).toHaveBeenCalledWith({ workspaceId: 'workspace-1', repositoryPath: 'D:/workspace/project' });
    expect(mocks.resolveCurrentFileReviewSnapshot).toHaveBeenCalledTimes(2);
  });

  it('names the ownership wall when the user does not grant trust', async () => {
    mocks.resolveCurrentFileReviewSnapshot.mockRejectedValue(
      new TauriCommandError('Command failed', {
        command: 'git_get_status',
        originalError: 'git_repository_untrusted: D:/workspace/project',
      }),
    );
    mocks.confirmWarning.mockResolvedValue(false);

    await expect(prepareReviewLaunchFromSessionFiles(['src/small.ts'], {
      workspaceId: 'workspace-1', workspacePath: 'D:/workspace/project',
    })).rejects.toMatchObject({
      launchErrorMessageKey: 'deepReviewActionBar.launchError.repositoryUntrusted',
    });
    expect(mocks.trustRepository).not.toHaveBeenCalled();
  });

  it('blocks remote Git ranges before spending reviewer capacity', async () => {
    const manifest = runManifest('normal');
    mocks.resolveSlashCommandReviewTarget.mockResolvedValue({
      target: {
        ...manifest.target,
        source: 'slash_command_git_ref',
      },
      changeStats: {
        fileCount: 1,
        lineCountSource: 'diff_stat',
        totalLinesChanged: 4,
      },
      targetEvidence: {
        ...targetEvidence(),
        source: 'git_range',
        headRevision: '2'.repeat(40),
        completeness: 'partial',
        workspaceBinding: 'unavailable',
        limitations: ['remote_exact_diff_unavailable'],
      },
    });

    await expect(prepareReviewLaunchFromSlashCommand(
      '/review main..feature',
      '/remote/workspace',
      'remote-1', 'workspace-1',
    )).rejects.toThrow('Remote Git range Review is not supported yet');
    expect(mocks.buildDeepReviewLaunchFromSlashCommand).not.toHaveBeenCalled();
  });

  it('prepares a provider-bound pull request review without embedding the diff', async () => {
    const prepared = await prepareReviewLaunchFromPullRequest({
      workspaceId: 'workspace-1', workspacePath: 'D:/workspace/project',
      remote: {
        id: 'origin|https://github.com/example/repo.git',
        name: 'origin',
        url: 'https://github.com/example/repo.git',
        platform: 'github',
        host: 'github.com',
        owner: 'example',
        repositoryName: 'repo',
        projectPath: 'example/repo',
        webUrl: 'https://github.com/example/repo',
        supported: true,
        authState: 'connected',
        authSource: 'stored',
      },
      repository: {
        providerId: 'origin|https://github.com/example/repo.git',
        platform: 'github',
        host: 'github.com',
        owner: 'example',
        name: 'repo',
        projectPath: 'example/repo',
        defaultBranch: 'main',
        workspaceId: 'workspace-1', workspacePath: 'D:/workspace/project',
        webUrl: 'https://github.com/example/repo',
      },
      reviewTarget: {
        pullRequest: {
          id: '42',
          number: 42,
          title: 'Fix review target',
          state: 'open',
          author: 'alice',
          sourceBranch: 'feature',
          targetBranch: 'main',
          baseRevision: '1'.repeat(40),
          headRevision: '2'.repeat(40),
          updatedAt: '2026-07-11T00:00:00Z',
          webUrl: 'https://github.com/example/repo/pull/42',
          additions: 3,
          deletions: 1,
          changedFiles: 1,
          comments: 0,
          reviewDecision: 'pending',
          checks: { total: 0, passed: 0, failed: 0, pending: 0 },
        },
        files: [{
          path: 'src/lib.rs',
          status: 'modified',
          additions: 3,
          deletions: 1,
          diffAvailable: true,
        }],
        omittedFileCount: 0,
        limitations: [],
      },
    });

    expect(prepared.mode).toBe('standard');
    expect(prepared.targetEvidence.source).toBe('pull_request');
    expect(prepared.targetEvidence.pullRequest?.pullRequestId).toBe('42');
    expect(prepared.prompt).not.toContain('@@');
    expect(prepared.prompt).not.toContain('Fix review target');
    expect(prepared.prompt).not.toContain('https://github.com/example/repo/pull/42');
  });

  it('blocks remote workspace Review before spending reviewer capacity', async () => {
    const manifest = runManifest('normal');
    mocks.resolveSlashCommandReviewTarget.mockResolvedValue({
      target: { ...manifest.target, source: 'workspace_diff', resolution: 'unknown' },
      changeStats: { fileCount: 0, lineCountSource: 'unknown' },
      targetEvidence: {
        ...targetEvidence(),
        completeness: 'unknown',
        workspaceBinding: 'unavailable',
        files: [],
        limitations: ['remote_workspace_review_unavailable'],
      },
    });

    await expect(prepareReviewLaunchFromSlashCommand(
      '/review',
      '/remote/workspace',
      'remote-1', 'workspace-1',
    )).rejects.toThrow('Remote workspace Review is not supported');
  });

  it('reports a missing explicit file before spending reviewer capacity', async () => {
    const manifest = runManifest('normal');
    mocks.resolveSlashCommandReviewTarget.mockResolvedValue({
      target: {
        ...manifest.target,
        source: 'slash_command_explicit_files',
        files: [{
          ...manifest.target.files[0],
          path: 'tests/missing.ts',
          normalizedPath: 'tests/missing.ts',
          source: 'slash_command_explicit_files',
          status: 'unknown',
        }],
      },
      changeStats: { fileCount: 1, lineCountSource: 'unknown' },
      targetEvidence: {
        ...targetEvidence(),
        completeness: 'unknown',
        workspaceBinding: 'unavailable',
        files: [],
        limitations: ['explicit_target_path_not_found'],
      },
    });

    await expect(prepareReviewLaunchFromSlashCommand(
      '/review tests/missing.ts',
      '/workspace/project', undefined, 'workspace-1',
    )).rejects.toMatchObject({
      message: 'The requested file or directory does not exist in the current workspace.',
      launchErrorMessageKey: 'deepReviewActionBar.launchError.missingExplicitScope',
    });
  });

  it('blocks an empty confirmed workspace snapshot before spending reviewer capacity', async () => {
    const manifest = runManifest('normal');
    mocks.resolveSlashCommandReviewTarget.mockResolvedValue({
      target: {
        ...manifest.target,
        source: 'workspace_diff',
        files: [],
      },
      changeStats: {
        fileCount: 0,
        lineCountSource: 'diff_stat',
        totalLinesChanged: 0,
      },
      targetEvidence: {
        ...targetEvidence(),
        files: [],
      },
    });

    await expect(prepareReviewLaunchFromSlashCommand(
      '/review',
      'D:/workspace/project', undefined, 'workspace-1',
    )).rejects.toThrow('There are no workspace changes to review.');
  });

  it('blocks unresolved workspace evidence before spending reviewer capacity', async () => {
    const manifest = runManifest('normal');
    mocks.resolveSlashCommandReviewTarget.mockResolvedValue({
      target: {
        ...manifest.target,
        source: 'workspace_diff',
        resolution: 'unknown',
        files: [],
      },
      changeStats: { fileCount: 0, lineCountSource: 'unknown' },
      targetEvidence: {
        ...targetEvidence(),
        completeness: 'unknown',
        workspaceBinding: 'unavailable',
        files: [],
        limitations: ['review_target_unresolved'],
      },
    });

    await expect(prepareReviewLaunchFromSlashCommand('/review focus on auth', 'workspace-1'))
      .rejects.toThrow('files or code diff could not be read for Review');
  });

  it('launches standard review as a read-only CodeReview child in the shared pane', async () => {
    const prepared = await prepareReviewLaunchFromSessionFiles(['src/small.ts'], {
      workspaceId: 'workspace-1', workspacePath: 'D:/workspace/project',
      changeStats: {
        fileCount: 1,
        totalLinesChanged: 4,
        lineCountSource: 'diff_stat',
      },
    });

    await launchPreparedReviewSession({
      parentSessionId: 'parent',
      workspaceId: 'workspace-1', workspacePath: 'D:/workspace/project',
      displayMessage: 'Review current changes',
      requestId: 'review-follow-up-1',
      prepared,
    });

    expect(mocks.createBtwChildSession).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionId: 'parent',
      sessionKind: 'review',
      agentType: 'CodeReview',
      childSessionName: 'Review',
      requestId: 'review-follow-up-1',
      reviewTargetEvidence: prepared.targetEvidence,
      deepReviewRunManifest: prepared.runManifest,
    }));
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.any(String),
      'review-child',
      'Review current changes',
      undefined,
      undefined,
      {
        turnId: 'review_turn_review-follow-up-1',
        preserveTurnOnStartError: true,
      },
    );
    expect(mocks.insertReviewSessionSummaryMarker).toHaveBeenCalledWith(expect.objectContaining({
      childSessionId: 'review-child',
      kind: 'review',
    }));
    expect(mocks.openBtwSessionInAuxPane).toHaveBeenCalledWith(expect.objectContaining({
      childSessionId: 'review-child',
      expand: true,
    }));
  });

  it('launches the exact prepared team manifest instead of rebuilding it after consent', async () => {
    const manifest = runManifest('normal');
    const prepared = {
      mode: 'strict' as const,
      level: 'l2' as const,
      strategyLevel: 'normal' as const,
      target: manifest.target,
      requestedFiles: ['src/file.ts'],
      prompt: 'prepared prompt',
      runManifest: manifest,
    };

    await launchPreparedReviewSession({
      parentSessionId: 'parent',
      workspaceId: 'workspace-1', workspacePath: 'D:/workspace/project',
      displayMessage: '/review',
      requestId: 'review-follow-up-2',
      prepared,
    });

    expect(mocks.launchDeepReviewSession).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'prepared prompt',
      runManifest: manifest,
      childSessionName: 'Review',
      requestId: 'review-follow-up-2',
    }));
    expect(mocks.buildDeepReviewLaunchFromSessionFiles).not.toHaveBeenCalled();
    expect(mocks.buildDeepReviewLaunchFromSlashCommand).not.toHaveBeenCalled();
  });

  it('presents a managed L1 runtime as ordinary Review', async () => {
    const manifest = {
      ...runManifest('deep'),
      managedReviewPlan: {
        version: 1,
        totalFileCount: 120,
        plannedFileCount: 120,
        deferredFileCount: 0,
        maxFilesPerBatch: 40,
        maxBatches: 8,
        maxParallelInstances: 2,
        workerTimeoutSeconds: 120,
      },
    };
    const prepared = {
      mode: 'managed' as const,
      level: 'l1' as const,
      strategyLevel: 'deep' as const,
      target: manifest.target,
      targetEvidence: targetEvidence(),
      requestedFiles: ['src/file.ts'],
      prompt: 'managed prompt',
      runManifest: manifest,
      requiresConsent: false,
    };

    await launchPreparedReviewSession({
      parentSessionId: 'parent',
      workspaceId: 'workspace-1', workspacePath: 'D:/workspace/project',
      displayMessage: '/review',
      prepared,
    });

    expect(mocks.launchDeepReviewSession).toHaveBeenCalledWith(expect.objectContaining({
      childSessionName: 'Review',
      presentationKind: 'review',
      runManifest: manifest,
    }));
  });

  it('preserves a standard review child when first-message acceptance is uncertain', async () => {
    const prepared = await prepareReviewLaunchFromSessionFiles(['src/small.ts'], {
      workspaceId: 'workspace-1', workspacePath: 'D:/workspace/project',
      changeStats: {
        fileCount: 1,
        totalLinesChanged: 4,
        lineCountSource: 'diff_stat',
      },
    });
    mocks.sessions.set('review-child', { workspaceId: 'workspace-1', workspacePath: 'D:/workspace/project' });
    mocks.sendMessage.mockRejectedValueOnce(new Error('send failed'));

    await expect(launchPreparedReviewSession({
      parentSessionId: 'parent',
      workspaceId: 'workspace-1', workspacePath: 'D:/workspace/project',
      displayMessage: '/review',
      prepared,
    })).resolves.toEqual({ childSessionId: 'review-child', launchStatus: 'uncertain' });

    expect(mocks.deleteSession).not.toHaveBeenCalled();
    expect(mocks.discardLocalSession).not.toHaveBeenCalled();
    expect(mocks.insertReviewSessionSummaryMarker).toHaveBeenCalledWith(
      expect.objectContaining({ childSessionId: 'review-child', kind: 'review' }),
    );
    expect(mocks.openBtwSessionInAuxPane).toHaveBeenCalledWith(
      expect.objectContaining({ childSessionId: 'review-child', sessionKind: 'review' }),
    );
  });

  it('retries uncertain standard child creation with the same request id', async () => {
    const prepared = await prepareReviewLaunchFromSessionFiles(['src/small.ts'], {
      workspaceId: 'workspace-1', workspacePath: 'D:/workspace/project',
      changeStats: {
        fileCount: 1,
        totalLinesChanged: 4,
        lineCountSource: 'diff_stat',
      },
    });
    mocks.createBtwChildSession
      .mockRejectedValueOnce(new Error('Create acknowledgement lost'))
      .mockResolvedValueOnce({
        childSessionId: 'review-child',
        parentDialogTurnId: 'turn-1',
      });

    await expect(launchPreparedReviewSession({
      parentSessionId: 'parent',
      workspaceId: 'workspace-1', workspacePath: 'D:/workspace/project',
      displayMessage: '/review',
      prepared,
    })).resolves.toEqual({ childSessionId: 'review-child', launchStatus: 'started' });

    expect(mocks.createBtwChildSession).toHaveBeenCalledTimes(2);
    expect(mocks.createBtwChildSession.mock.calls[0][0].requestId).toBe(
      'generated-review-id',
    );
    expect(mocks.createBtwChildSession.mock.calls[1][0].requestId).toBe(
      'generated-review-id',
    );
  });
});
