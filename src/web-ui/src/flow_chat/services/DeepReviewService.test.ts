import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  DEEP_REVIEW_SLASH_COMMAND,
  buildDeepReviewLaunchFromSlashCommand,
  buildDeepReviewPreviewFromSessionFiles,
  buildDeepReviewPromptFromSessionFiles,
  buildDeepReviewPromptFromSlashCommand,
  getDeepReviewLaunchErrorMessage,
  isDeepReviewSlashCommand,
  launchDeepReviewSession,
} from './DeepReviewService';
import { buildEffectiveReviewTeamManifest } from '@/shared/services/reviewTeamService';

const mockDeleteSession = vi.fn();
const mockCreateBtwChildSession = vi.fn();
const mockCreateBtwRequestId = vi.fn(() => 'generated-review-id');
const mockOpenBtwSessionInAuxPane = vi.fn();
const mockCloseBtwSessionInAuxPane = vi.fn();
const mockSendMessage = vi.fn();
const mockDiscardLocalSession = vi.fn();
const mockInsertReviewSessionSummaryMarker = vi.fn();
const mockGitGetStatus = vi.fn();
const mockGitGetChangedFiles = vi.fn();
const mockGitGetDiff = vi.fn();
const mockGitResolveRevision = vi.fn();
const mockWorkspaceReadFile = vi.fn();
const mockLoadDefaultReviewTeam = vi.fn();
const mockPrepareDefaultReviewTeamForLaunch = vi.fn();
const mockLoadReviewTeamRateLimitStatus = vi.fn();

vi.mock('@/infrastructure/api', () => ({
  agentAPI: {
    deleteSession: (...args: any[]) => mockDeleteSession(...args),
  },
  gitAPI: {
    getStatus: (...args: any[]) => mockGitGetStatus(...args),
    getChangedFiles: (...args: any[]) => mockGitGetChangedFiles(...args),
    getDiff: (...args: any[]) => mockGitGetDiff(...args),
    resolveRevision: (...args: any[]) => mockGitResolveRevision(...args),
  },
  workspaceAPI: {
    readFileContent: (...args: any[]) => mockWorkspaceReadFile(...args),
  },
}));

vi.mock('./BtwThreadService', () => ({
  createBtwChildSession: (...args: any[]) => mockCreateBtwChildSession(...args),
  createBtwRequestId: (...args: any[]) => mockCreateBtwRequestId(...args),
}));

vi.mock('./btwSessionPane', () => ({
  closeBtwSessionInAuxPane: (...args: any[]) => mockCloseBtwSessionInAuxPane(...args),
  openBtwSessionInAuxPane: (...args: any[]) => mockOpenBtwSessionInAuxPane(...args),
}));

vi.mock('./FlowChatManager', () => ({
  FlowChatManager: {
    getInstance: () => ({
      sendMessage: (...args: any[]) => mockSendMessage(...args),
      discardLocalSession: (...args: any[]) => mockDiscardLocalSession(...args),
    }),
  },
}));

const mockSessionsMap = new Map();
vi.mock('../store/FlowChatStore', () => ({
  flowChatStore: {
    getState: () => ({ sessions: mockSessionsMap }),
  },
}));

vi.mock('./ReviewSessionMarkerService', () => ({
  insertReviewSessionSummaryMarker: (...args: any[]) => mockInsertReviewSessionSummaryMarker(...args),
}));

vi.mock('@/shared/services/reviewTeamService', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/shared/services/reviewTeamService')>(),
  loadDefaultReviewTeam: (...args: any[]) => mockLoadDefaultReviewTeam(...args),
  prepareDefaultReviewTeamForLaunch: (...args: any[]) => mockPrepareDefaultReviewTeamForLaunch(...args),
  loadReviewTeamRateLimitStatus: (...args: any[]) => mockLoadReviewTeamRateLimitStatus(...args),
  buildEffectiveReviewTeamManifest: vi.fn(() => ({ reviewers: [] })),
  buildReviewTeamPromptBlock: vi.fn(() => 'Review team manifest.'),
}));

describe('DeepReviewService slash command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadDefaultReviewTeam.mockResolvedValue({ members: [] });
    mockPrepareDefaultReviewTeamForLaunch.mockResolvedValue({ members: [] });
    mockLoadReviewTeamRateLimitStatus.mockResolvedValue(null);
    mockGitGetStatus.mockResolvedValue({
      staged: [],
      unstaged: [],
      untracked: [],
      conflicts: [],
      current_branch: 'main',
      ahead: 0,
      behind: 0,
    });
    mockGitGetChangedFiles.mockResolvedValue([]);
    mockGitGetDiff.mockResolvedValue('');
    mockGitResolveRevision.mockImplementation(async (_workspacePath: string, revision: string) => (
      revision === 'main' || revision.endsWith('^')
        ? '1'.repeat(40)
        : '2'.repeat(40)
    ));
    mockWorkspaceReadFile.mockResolvedValue('untracked content');
  });

  it('uses /review strict as the canonical typed command', () => {
    expect(DEEP_REVIEW_SLASH_COMMAND).toBe('/review strict');
  });

  it('recognizes strict Review typed commands and compatibility aliases', () => {
    expect(isDeepReviewSlashCommand('/review strict')).toBe(true);
    expect(isDeepReviewSlashCommand('/review strict commit abc123')).toBe(true);
    expect(isDeepReviewSlashCommand('/review deep commit abc123')).toBe(false);
    expect(isDeepReviewSlashCommand('/DeepReview')).toBe(true);
    expect(isDeepReviewSlashCommand('/DeepReview review commit abc123')).toBe(true);
    expect(isDeepReviewSlashCommand('/deepreview review commit abc123')).toBe(true);
    expect(isDeepReviewSlashCommand('/review')).toBe(false);
    expect(isDeepReviewSlashCommand('/DeepReviewer review commit abc123')).toBe(false);
  });

  it('strips the canonical command before building the focus block', async () => {
    const prompt = await buildDeepReviewPromptFromSlashCommand(
      '/review strict commit abc123 for security',
      { workspaceId: 'workspace-1', repositoryPath: 'D:\\workspace\\repo' },
    );

    expect(prompt).toContain('The slash-command target is already resolved.');
    expect(prompt).toContain('User-provided focus:\ncommit abc123 for security');
    expect(prompt).not.toContain('Original command:');
  });

  it('classifies explicit slash-command file paths before building the review team manifest', async () => {
    await buildDeepReviewPromptFromSlashCommand(
      '/DeepReview src/web-ui/src/App.tsx src/crates/assembly/core/src/service/config/types.rs for regressions',
      { workspaceId: 'workspace-1', repositoryPath: 'D:\\workspace\\repo' },
    );

    expect(buildEffectiveReviewTeamManifest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspacePath: 'D:\\workspace\\repo',
        target: expect.objectContaining({
          source: 'slash_command_explicit_files',
          resolution: 'resolved',
          tags: expect.arrayContaining(['frontend_ui', 'backend_core']),
        }),
      }),
    );
  });

  it('classifies workspace diff files for a slash command without an explicit target', async () => {
    mockGitGetStatus.mockResolvedValueOnce({
      staged: [{ path: 'src/web-ui/src/App.tsx', status: 'modified' }],
      unstaged: [{ path: 'src/crates/assembly/core/src/service/config/types.rs', status: 'modified' }],
      untracked: ['src/web-ui/src/newFeature.tsx'],
      conflicts: [],
      current_branch: 'main',
      ahead: 0,
      behind: 0,
    });

    await buildDeepReviewPromptFromSlashCommand(
      '/DeepReview',
      { workspaceId: 'workspace-1', repositoryPath: 'D:\\workspace\\repo' },
    );

    expect(mockGitGetStatus).toHaveBeenCalledWith({ workspaceId: 'workspace-1', repositoryPath: 'D:\\workspace\\repo' }, 'deep_review_target_resolver');
    expect(buildEffectiveReviewTeamManifest).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspacePath: 'D:\\workspace\\repo',
        target: expect.objectContaining({
          source: 'workspace_diff',
          resolution: 'resolved',
          tags: expect.arrayContaining(['frontend_ui', 'backend_core']),
        }),
      }),
    );
  });

  it('passes workspace diff line stats into the review manifest', async () => {
    mockGitGetStatus.mockResolvedValueOnce({
      staged: [{ path: 'src/web-ui/src/App.tsx', status: 'modified' }],
      unstaged: [{ path: 'src/crates/assembly/core/src/service/config/types.rs', status: 'modified' }],
      untracked: [],
      conflicts: [],
      current_branch: 'main',
      ahead: 0,
      behind: 0,
    });
    mockGitGetDiff.mockResolvedValueOnce([
      'diff --git a/src/crates/assembly/core/src/service/config/types.rs b/src/crates/assembly/core/src/service/config/types.rs',
      '@@ -1,2 +1,3 @@',
      '-old core line',
      '+new core line',
      '+another core line',
      'diff --git a/src/web-ui/src/App.tsx b/src/web-ui/src/App.tsx',
      '@@ -5,3 +5,2 @@',
      '-removed ui line',
      '+added ui line',
    ].join('\n'));

    await buildDeepReviewPromptFromSlashCommand(
      '/DeepReview',
      { workspaceId: 'workspace-1', repositoryPath: 'D:\\workspace\\repo' },
    );

    expect(mockGitGetDiff).toHaveBeenCalledWith({ workspaceId: 'workspace-1', repositoryPath: 'D:\\workspace\\repo' }, {
      source: 'HEAD',
      files: [
        'src/web-ui/src/App.tsx',
        'src/crates/assembly/core/src/service/config/types.rs',
      ],
      reviewSafe: true,
    });
    expect(buildEffectiveReviewTeamManifest).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        changeStats: expect.objectContaining({
          fileCount: 2,
          totalLinesChanged: 5,
          lineCountSource: 'diff_stat',
        }),
      }),
    );
  });

  it('passes cached rate limit status into slash-command launch manifests', async () => {
    mockLoadReviewTeamRateLimitStatus.mockResolvedValueOnce({ remaining: 2 });

    await buildDeepReviewLaunchFromSlashCommand(
      '/DeepReview',
      { workspaceId: 'workspace-1', repositoryPath: 'D:\\workspace\\repo' },
    );

    expect(mockLoadReviewTeamRateLimitStatus).toHaveBeenCalled();
    expect(buildEffectiveReviewTeamManifest).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspacePath: 'D:\\workspace\\repo',
        rateLimitStatus: { remaining: 2 },
      }),
    );
  });

  it('does not block slash-command launch manifests when rate limit status is unavailable', async () => {
    mockLoadReviewTeamRateLimitStatus.mockRejectedValueOnce(new Error('rate status unavailable'));

    await buildDeepReviewLaunchFromSlashCommand(
      '/DeepReview',
      { workspaceId: 'workspace-1', repositoryPath: 'D:\\workspace\\repo' },
    );

    const lastCall = vi.mocked(buildEffectiveReviewTeamManifest).mock.calls.at(-1);
    expect(lastCall?.[1]).not.toHaveProperty('rateLimitStatus');
  });

  it('classifies commit target files through the git changed-files API', async () => {
    mockGitGetChangedFiles.mockResolvedValueOnce([
      {
        path: 'src/web-ui/src/App.tsx',
        old_path: undefined,
        status: 'modified',
      },
    ]);

    await buildDeepReviewPromptFromSlashCommand(
      '/DeepReview review commit abc123',
      { workspaceId: 'workspace-1', repositoryPath: 'D:\\workspace\\repo' },
    );

    expect(mockGitGetChangedFiles).toHaveBeenCalledWith({ workspaceId: 'workspace-1', repositoryPath: 'D:\\workspace\\repo' }, {
      source: '1'.repeat(40),
      target: '2'.repeat(40),
      reviewSafe: true,
    });
    expect(buildEffectiveReviewTeamManifest).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        target: expect.objectContaining({
          source: 'slash_command_git_ref',
          resolution: 'resolved',
          tags: expect.arrayContaining(['frontend_ui']),
        }),
      }),
    );
  });

  it('passes git ref diff line stats into the review manifest', async () => {
    mockGitGetChangedFiles.mockResolvedValueOnce([
      {
        path: 'src/web-ui/src/App.tsx',
        old_path: undefined,
        status: 'modified',
      },
    ]);
    mockGitGetDiff.mockResolvedValueOnce([
      'diff --git a/src/web-ui/src/App.tsx b/src/web-ui/src/App.tsx',
      '--- a/src/web-ui/src/App.tsx',
      '+++ b/src/web-ui/src/App.tsx',
      '@@ -10,2 +10,3 @@',
      '-old line',
      '+new line',
      '+new second line',
    ].join('\n'));

    await buildDeepReviewPromptFromSlashCommand(
      '/DeepReview review commit abc123',
      { workspaceId: 'workspace-1', repositoryPath: 'D:\\workspace\\repo' },
    );

    expect(mockGitGetDiff).toHaveBeenCalledWith({ workspaceId: 'workspace-1', repositoryPath: 'D:\\workspace\\repo' }, {
      source: '1'.repeat(40),
      target: '2'.repeat(40),
      reviewSafe: true,
    });
    expect(buildEffectiveReviewTeamManifest).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        changeStats: expect.objectContaining({
          fileCount: 1,
          totalLinesChanged: 3,
          lineCountSource: 'diff_stat',
        }),
      }),
    );
  });

  it('keeps line stats unknown when git diff stats fail', async () => {
    mockGitGetChangedFiles.mockResolvedValueOnce([
      {
        path: 'src/web-ui/src/App.tsx',
        old_path: undefined,
        status: 'modified',
      },
    ]);
    mockGitGetDiff.mockRejectedValueOnce(new Error('diff unavailable'));

    await buildDeepReviewPromptFromSlashCommand(
      '/DeepReview review commit abc123',
      { workspaceId: 'workspace-1', repositoryPath: 'D:\\workspace\\repo' },
    );

    expect(buildEffectiveReviewTeamManifest).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        changeStats: expect.objectContaining({
          fileCount: 1,
          lineCountSource: 'unknown',
        }),
      }),
    );
  });

  it('classifies explicit ref ranges through the git changed-files API', async () => {
    mockGitGetChangedFiles.mockResolvedValueOnce([
      {
        path: 'src/crates/assembly/core/src/service/config/types.rs',
        old_path: undefined,
        status: 'modified',
      },
    ]);

    await buildDeepReviewPromptFromSlashCommand(
      '/DeepReview review main..feature/deep-review',
      { workspaceId: 'workspace-1', repositoryPath: 'D:\\workspace\\repo' },
    );

    expect(mockGitGetChangedFiles).toHaveBeenCalledWith({ workspaceId: 'workspace-1', repositoryPath: 'D:\\workspace\\repo' }, {
      source: '1'.repeat(40),
      target: '2'.repeat(40),
      reviewSafe: true,
    });
    expect(buildEffectiveReviewTeamManifest).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        target: expect.objectContaining({
          source: 'slash_command_git_ref',
          resolution: 'resolved',
          tags: expect.arrayContaining(['backend_core']),
        }),
      }),
    );
  });

  it('keeps git targets conservative when no workspace is available', async () => {
    await buildDeepReviewPromptFromSlashCommand(
      '/DeepReview review commit abc123',
    );

    expect(mockGitGetChangedFiles).not.toHaveBeenCalled();
    expect(buildEffectiveReviewTeamManifest).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        target: expect.objectContaining({
          source: 'slash_command_git_ref',
          resolution: 'unknown',
          tags: ['unknown'],
        }),
      }),
    );
  });

  it('returns the run manifest with the slash-command launch prompt', async () => {
    const runManifest = { reviewMode: 'deep', skippedReviewers: [] };
    vi.mocked(buildEffectiveReviewTeamManifest).mockReturnValueOnce(runManifest as any);

    const result = await buildDeepReviewLaunchFromSlashCommand(
      '/DeepReview review commit abc123',
      { workspaceId: 'workspace-1', repositoryPath: 'D:\\workspace\\repo' },
    );

    expect(result.prompt).toContain('User-provided focus:\nreview commit abc123');
    expect(result.prompt).not.toContain('Original command:');
    expect(result.runManifest).toBe(runManifest);
  });

  it('classifies session files before building the review team manifest', async () => {
    await buildDeepReviewPromptFromSessionFiles(
      ['src/web-ui/src/App.tsx'],
      undefined,
      { workspaceId: 'workspace-1', repositoryPath: 'D:\\workspace\\repo' },
    );

    expect(buildEffectiveReviewTeamManifest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspacePath: 'D:\\workspace\\repo',
        target: expect.objectContaining({
          resolution: 'resolved',
          tags: expect.arrayContaining(['frontend_ui']),
        }),
      }),
    );
  });

  it('builds a read-only session-file preview without preparing launch state', async () => {
    const runManifest = {
      reviewMode: 'deep',
      skippedReviewers: [{ subagentId: 'ReviewFrontend', reason: 'not_applicable' }],
    };
    vi.mocked(buildEffectiveReviewTeamManifest).mockReturnValueOnce(runManifest as any);

    const result = await buildDeepReviewPreviewFromSessionFiles(
      ['src/crates/assembly/core/src/service/config/types.rs'],
      { workspaceId: 'workspace-1', repositoryPath: 'D:\\workspace\\repo' },
    );

    expect(result).toBe(runManifest);
    expect(mockLoadDefaultReviewTeam).toHaveBeenCalledWith('workspace-1');
    expect(mockPrepareDefaultReviewTeamForLaunch).not.toHaveBeenCalled();
    expect(buildEffectiveReviewTeamManifest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspacePath: 'D:\\workspace\\repo',
        target: expect.objectContaining({
          source: 'session_files',
          resolution: 'resolved',
          tags: expect.arrayContaining(['backend_core']),
        }),
      }),
    );
  });
});

describe('launchDeepReviewSession', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockSessionsMap.clear();
    mockSessionsMap.set('parent-123', { workspaceId: 'workspace-1' });
  });

  it('does not choose a workspace from the path when the parent has no workspace ID', async () => {
    mockSessionsMap.set('parent-123', { workspacePath: '/same/path' });
    await expect(launchDeepReviewSession({
      parentSessionId: 'parent-123', workspacePath: '/same/path',
      prompt: 'Review files', displayMessage: 'Review started',
    })).rejects.toMatchObject({ originalMessage: 'Parent session workspace ID is unavailable' });
    expect(mockCreateBtwChildSession).not.toHaveBeenCalled();
    expect(mockPrepareDefaultReviewTeamForLaunch).not.toHaveBeenCalled();
  });

  it('returns child session ID on successful launch', async () => {
    mockCreateBtwChildSession.mockResolvedValue({
      childSessionId: 'child-123',
      parentDialogTurnId: 'turn-456',
    });
    mockSendMessage.mockResolvedValue(undefined);

    const result = await launchDeepReviewSession({
      parentSessionId: 'parent-123',
      workspacePath: 'D:\\workspace\\repo',
      prompt: 'Review these files',
      displayMessage: 'Strict review started',
      requestId: 'review-follow-up-3',
    });

    expect(result.childSessionId).toBe('child-123');
    expect(mockCreateBtwChildSession).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: 'parent-123',
        workspacePath: 'D:\\workspace\\repo',
        sessionKind: 'deep_review',
        agentType: 'DeepReview',
        requestId: 'review-follow-up-3',
      }),
    );
    expect(mockOpenBtwSessionInAuxPane).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledWith(
      'Review these files',
      'child-123',
      'Strict review started',
      undefined,
      undefined,
      expect.objectContaining({
        turnId: 'review_turn_review-follow-up-3',
        preserveTurnOnStartError: true,
      }),
    );
    expect(mockInsertReviewSessionSummaryMarker).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: 'parent-123',
        childSessionId: 'child-123',
        kind: 'deep_review',
      }),
    );
  });

  it('keeps managed execution internal while presenting an ordinary Review child', async () => {
    mockCreateBtwChildSession.mockResolvedValue({
      childSessionId: 'child-managed',
      parentDialogTurnId: 'turn-managed',
    });
    mockSendMessage.mockResolvedValue(undefined);

    await launchDeepReviewSession({
      parentSessionId: 'parent-123',
      workspacePath: 'D:\\workspace\\repo',
      prompt: 'Run managed packets',
      displayMessage: 'Review started',
      presentationKind: 'review',
    });

    expect(mockCreateBtwChildSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKind: 'review',
        agentType: 'DeepReview',
      }),
    );
    expect(mockInsertReviewSessionSummaryMarker).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'review' }),
    );
  });

  it('passes the run manifest into child session creation', async () => {
    const runManifest = { reviewMode: 'deep', skippedReviewers: [] };
    mockCreateBtwChildSession.mockResolvedValue({
      childSessionId: 'child-123',
      parentDialogTurnId: 'turn-456',
    });
    mockSendMessage.mockResolvedValue(undefined);

    await launchDeepReviewSession({
      parentSessionId: 'parent-123',
      workspacePath: 'D:\\workspace\\repo',
      prompt: 'Review these files',
      displayMessage: 'Strict review started',
      runManifest: runManifest as any,
    });

    expect(mockCreateBtwChildSession).toHaveBeenCalledWith(
      expect.objectContaining({
        deepReviewRunManifest: runManifest,
      }),
    );
    expect(mockCreateBtwChildSession.mock.calls[0][0].reviewTargetEvidence).toBeUndefined();
  });

  it('passes the run manifest as first-turn message metadata', async () => {
    const runManifest = { reviewMode: 'deep', skippedReviewers: [] };
    mockCreateBtwChildSession.mockResolvedValue({
      childSessionId: 'child-123',
      parentDialogTurnId: 'turn-456',
    });
    mockSendMessage.mockResolvedValue(undefined);

    await launchDeepReviewSession({
      parentSessionId: 'parent-123',
      workspacePath: 'D:\\workspace\\repo',
      prompt: 'Review these files',
      displayMessage: 'Strict review started',
      runManifest: runManifest as any,
    });

    expect(mockSendMessage).toHaveBeenCalledWith(
      'Review these files',
      'child-123',
      'Strict review started',
      undefined,
      undefined,
      {
        turnId: 'review_turn_generated-review-id',
        preserveTurnOnStartError: true,
        userMessageMetadata: {
          deepReviewRunManifest: runManifest,
        },
      },
    );
  });

  it('retries child creation once with the same request id before failing', async () => {
    mockCreateBtwChildSession.mockRejectedValue(new Error('Session creation failed'));

    let caughtError: unknown;
    try {
      await launchDeepReviewSession({
        parentSessionId: 'parent-123',
        workspacePath: 'D:\\workspace\\repo',
        prompt: 'Review these files',
        displayMessage: 'Strict review started',
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error).message).toBe('Review failed to start. Please try again.');
    expect((caughtError as { launchErrorMessageKey?: string }).launchErrorMessageKey).toBe(
      'deepReviewActionBar.launchError.unknown',
    );
    expect(
      getDeepReviewLaunchErrorMessage(caughtError, (key: string) => `translated:${key}`),
    ).toBe('translated:deepReviewActionBar.launchError.unknown');

    expect(mockCloseBtwSessionInAuxPane).not.toHaveBeenCalled();
    expect(mockDeleteSession).not.toHaveBeenCalled();
    expect(mockDiscardLocalSession).not.toHaveBeenCalled();
    expect(mockCreateBtwChildSession).toHaveBeenCalledTimes(2);
    expect(mockCreateBtwChildSession.mock.calls[0][0].requestId).toBe('generated-review-id');
    expect(mockCreateBtwChildSession.mock.calls[1][0].requestId).toBe('generated-review-id');
  });

  it('recovers an uncertain create with an idempotent retry', async () => {
    mockCreateBtwChildSession
      .mockRejectedValueOnce(new Error('Create acknowledgement lost'))
      .mockResolvedValueOnce({
        childSessionId: 'child-123',
        parentDialogTurnId: 'turn-456',
      });
    mockSendMessage.mockResolvedValue(undefined);

    const result = await launchDeepReviewSession({
      parentSessionId: 'parent-123',
      workspacePath: 'D:\\workspace\\repo',
      prompt: 'Review these files',
      displayMessage: 'Strict review started',
      requestId: 'stable-request-id',
    });

    expect(result).toEqual({ childSessionId: 'child-123', launchStatus: 'started' });
    expect(mockCreateBtwChildSession).toHaveBeenCalledTimes(2);
    expect(mockCreateBtwChildSession.mock.calls[0][0].requestId).toBe('stable-request-id');
    expect(mockCreateBtwChildSession.mock.calls[1][0].requestId).toBe('stable-request-id');
  });

  it('preserves the strict review session when sendMessage acceptance is uncertain', async () => {
    mockCreateBtwChildSession.mockResolvedValue({
      childSessionId: 'child-123',
      parentDialogTurnId: 'turn-456',
    });
    mockSendMessage.mockRejectedValue(new Error('SSE stream connection timeout'));
    mockDeleteSession.mockResolvedValue(undefined);
    mockSessionsMap.set('child-123', { workspacePath: 'D:\\workspace\\repo' });

    await expect(launchDeepReviewSession({
      parentSessionId: 'parent-123',
      workspacePath: 'D:\\workspace\\repo',
      prompt: 'Review these files',
      displayMessage: 'Strict review started',
    })).resolves.toEqual({ childSessionId: 'child-123', launchStatus: 'uncertain' });

    expect(mockCloseBtwSessionInAuxPane).not.toHaveBeenCalled();
    expect(mockDeleteSession).not.toHaveBeenCalled();
    expect(mockDiscardLocalSession).not.toHaveBeenCalled();
    expect(mockOpenBtwSessionInAuxPane).toHaveBeenCalledWith(
      expect.objectContaining({ childSessionId: 'child-123', sessionKind: 'deep_review' }),
    );
    expect(mockInsertReviewSessionSummaryMarker).toHaveBeenCalledWith(
      expect.objectContaining({
        childSessionId: 'child-123',
        parentDialogTurnId: 'turn-456',
      }),
    );
  });

  it('preserves an uncertain strict review even when workspace metadata is missing', async () => {
    mockCreateBtwChildSession.mockResolvedValue({
      childSessionId: 'child-123',
      parentDialogTurnId: 'turn-456',
    });
    mockSendMessage.mockRejectedValue(new Error('SSE stream connection timeout'));
    // No workspacePath in session
    mockSessionsMap.set('child-123', {});

    await expect(launchDeepReviewSession({
        parentSessionId: 'parent-123',
        workspacePath: 'D:\\workspace\\repo',
        prompt: 'Review these files',
        displayMessage: 'Strict review started',
      })).resolves.toEqual({ childSessionId: 'child-123', launchStatus: 'uncertain' });

    expect(mockCloseBtwSessionInAuxPane).not.toHaveBeenCalled();
    expect(mockDeleteSession).not.toHaveBeenCalled();
    expect(mockDiscardLocalSession).not.toHaveBeenCalled();
    expect(mockOpenBtwSessionInAuxPane).toHaveBeenCalled();
  });

  it('does not probe deletion for an uncertain accepted strict review', async () => {
    mockCreateBtwChildSession.mockResolvedValue({
      childSessionId: 'child-123',
      parentDialogTurnId: 'turn-456',
    });
    mockSendMessage.mockRejectedValue(new Error('SSE stream connection timeout'));
    mockDeleteSession.mockRejectedValue(new Error('Session does not exist'));
    mockSessionsMap.set('child-123', { workspacePath: 'D:\\workspace\\repo' });

    await expect(launchDeepReviewSession({
        parentSessionId: 'parent-123',
        workspacePath: 'D:\\workspace\\repo',
        prompt: 'Review these files',
        displayMessage: 'Strict review started',
      })).resolves.toEqual({ childSessionId: 'child-123', launchStatus: 'uncertain' });

    expect(mockDeleteSession).not.toHaveBeenCalled();
    expect(mockDiscardLocalSession).not.toHaveBeenCalled();
  });
});
