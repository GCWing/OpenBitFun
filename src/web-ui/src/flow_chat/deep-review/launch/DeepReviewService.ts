import type { GitWorkspaceScope } from '@/infrastructure/api/service-api/GitAPI';
import { agentAPI } from '@/infrastructure/api';
import { createLogger } from '@/shared/utils/logger';
import { createBtwChildSession, createBtwRequestId } from '../../services/BtwThreadService';
import { closeBtwSessionInAuxPane, openBtwSessionInAuxPane } from '../../services/btwSessionPane';
import { FlowChatManager } from '../../services/FlowChatManager';
import { flowChatStore } from '../../store/FlowChatStore';
import { insertReviewSessionSummaryMarker } from '../../services/ReviewSessionMarkerService';
import {
  buildEffectiveReviewTeamManifest,
  buildReviewTeamPromptBlock,
  loadDefaultReviewTeam,
  loadReviewTeamRateLimitStatus,
  prepareDefaultReviewTeamForLaunch,
  type ReviewTeamRunManifest,
  type ReviewStrategyLevel,
  type ReviewTeamChangeStats,
  type ReviewTargetEvidence,
} from '@/shared/services/reviewTeamService';
import { classifyReviewTargetFromFiles } from '@/shared/services/reviewTargetClassifier';
import {
  getDeepReviewCommandFocus,
} from './commandParser';
import {
  buildUnknownChangeStats,
  resolveCurrentFileReviewSnapshot,
  resolveSlashCommandReviewTarget,
} from './targetResolver';
import {
  formatSessionFilesLaunchPrompt,
  formatSlashCommandLaunchPrompt,
} from './launchPrompt';
import {
  buildLaunchCleanupError,
  createDeepReviewLaunchError,
  isSessionMissingError,
  normalizeErrorMessage,
  type DeepReviewLaunchStep,
  type FailedDeepReviewCleanupResult,
} from './launchErrors';

export {
  DEEP_REVIEW_SLASH_COMMAND,
  isDeepReviewSlashCommand,
} from './commandParser';
export { getDeepReviewLaunchErrorMessage } from './launchErrors';

const log = createLogger('DeepReviewService');

interface LaunchDeepReviewSessionParams {
  parentSessionId: string;
  workspacePath?: string;
  prompt: string;
  displayMessage: string;
  childSessionName?: string;
  requestedFiles?: string[];
  runManifest?: ReviewTeamRunManifest;
  requestId?: string;
  presentationKind?: 'review' | 'deep_review';
}

export interface DeepReviewLaunchBuildOptions {
  strategyOverride?: ReviewStrategyLevel;
  qualityDecision?: ReviewTeamRunManifest['qualityDecision'];
  changeStats?: ReviewTeamChangeStats;
  targetEvidence?: ReviewTargetEvidence;
  resolvedTarget?: {
    target: ReviewTeamRunManifest['target'];
    changeStats: ReviewTeamChangeStats;
    targetEvidence: ReviewTargetEvidence;
  };
  maxCoreReviewers?: number;
  maxExtraReviewers?: number;
  includeQualityGate?: boolean;
  managedBatching?: boolean;
  maxFocusedCalls?: number;
}

export interface DeepReviewLaunchPrompt {
  prompt: string;
  runManifest: ReviewTeamRunManifest;
}

async function cleanupFailedDeepReviewLaunch(
  childSessionId: string,
  launchStep: DeepReviewLaunchStep,
): Promise<FailedDeepReviewCleanupResult> {
  const cleanupIssues: string[] = [];
  const childSession = flowChatStore.getState().sessions.get(childSessionId);
  const workspaceId = childSession?.workspaceId || childSession?.config.workspaceId;

  try {
    closeBtwSessionInAuxPane(childSessionId);
  } catch (error) {
    const message = `Failed to close the Review pane during cleanup: ${normalizeErrorMessage(error)}`;
    cleanupIssues.push(message);
    log.warn(message, { childSessionId, launchStep, error });
  }

  let backendSessionRemoved = false;
  if (!workspaceId) {
    const message = 'Workspace ID is missing, so backend Review session cleanup could not run.';
    cleanupIssues.push(message);
    log.warn(message, { childSessionId, launchStep });
  } else {
    try {
      await agentAPI.deleteSession(
        childSessionId,
        workspaceId,
      );
      backendSessionRemoved = true;
    } catch (error) {
      if (isSessionMissingError(error)) {
        backendSessionRemoved = true;
      } else {
        const message = `Failed to delete the backend Review session: ${normalizeErrorMessage(error)}`;
        cleanupIssues.push(message);
        log.warn(message, { childSessionId, launchStep, error });
      }
    }
  }

  if (backendSessionRemoved) {
    try {
      const flowChatManager = FlowChatManager.getInstance();
      flowChatManager.discardLocalSession(childSessionId);
    } catch (error) {
      const message = `Failed to remove the local Review session state: ${normalizeErrorMessage(error)}`;
      cleanupIssues.push(message);
      log.warn(message, { childSessionId, launchStep, error });
    }
  }

  return {
    cleanupCompleted: cleanupIssues.length === 0,
    cleanupIssues,
  };
}

async function buildReviewTeamManifestWithRuntimeSignals(
  team: Parameters<typeof buildEffectiveReviewTeamManifest>[0],
  options: Parameters<typeof buildEffectiveReviewTeamManifest>[1],
): Promise<ReviewTeamRunManifest> {
  const manifestOptions = options ?? {};
  const rateLimitStatus = await loadReviewTeamRateLimitStatus().catch((error) => {
    log.warn('Failed to load strict review rate limit status', { error });
    return null;
  });

  return buildEffectiveReviewTeamManifest(team, {
    ...manifestOptions,
    ...(rateLimitStatus ? { rateLimitStatus } : {}),
    ...(manifestOptions.strategyOverride
      ? { strategyOverride: manifestOptions.strategyOverride }
      : {}),
  });
}

export async function buildDeepReviewLaunchFromSessionFiles(
  filePaths: string[],
  extraContext?: string,
  workspace?: GitWorkspaceScope,
  options: DeepReviewLaunchBuildOptions = {},
): Promise<DeepReviewLaunchPrompt> {
  const workspacePath = workspace?.repositoryPath;
  const initialTarget = classifyReviewTargetFromFiles(filePaths, 'session_files');
  const resolved = options.resolvedTarget ?? (
    options.targetEvidence
      ? undefined
      : await resolveCurrentFileReviewSnapshot(workspace, initialTarget)
  );
  const target = resolved?.target ?? initialTarget;
  const changeStats = options.changeStats ?? resolved?.changeStats ?? buildUnknownChangeStats(target);
  const targetEvidence = options.targetEvidence ?? resolved?.targetEvidence;
  const team = await loadDefaultReviewTeam(workspace?.workspaceId);
  const manifest = await buildReviewTeamManifestWithRuntimeSignals(team, {
    workspacePath,
    target,
    changeStats,
    targetEvidence,
    ...(options.strategyOverride
      ? { strategyOverride: options.strategyOverride }
      : {}),
    ...(options.qualityDecision
      ? { qualityDecision: options.qualityDecision }
      : {}),
    ...(options.maxCoreReviewers !== undefined
      ? { maxCoreReviewers: options.maxCoreReviewers }
      : {}),
    ...(options.maxExtraReviewers !== undefined
      ? { maxExtraReviewers: options.maxExtraReviewers }
      : {}),
    ...(options.includeQualityGate !== undefined
      ? { includeQualityGate: options.includeQualityGate }
      : {}),
    ...(options.managedBatching !== undefined
      ? { managedBatching: options.managedBatching }
      : {}),
    ...(options.maxFocusedCalls !== undefined
      ? { maxFocusedCalls: options.maxFocusedCalls }
      : {}),
  });
  const prompt = formatSessionFilesLaunchPrompt({
    extraContext,
    reviewTeamPromptBlock: buildReviewTeamPromptBlock(team, manifest),
  });

  return { prompt, runManifest: manifest };
}

export async function buildDeepReviewPreviewFromSessionFiles(
  filePaths: string[],
  workspace?: GitWorkspaceScope,
): Promise<ReviewTeamRunManifest> {
  const workspacePath = workspace?.repositoryPath;
  const team = await loadDefaultReviewTeam(workspace?.workspaceId);
  const initialTarget = classifyReviewTargetFromFiles(filePaths, 'session_files');
  const snapshot = await resolveCurrentFileReviewSnapshot(
    workspace,
    initialTarget,
  );
  return buildReviewTeamManifestWithRuntimeSignals(team, {
    workspacePath,
    target: snapshot.target,
    changeStats: snapshot.changeStats,
    targetEvidence: snapshot.targetEvidence,
  });
}

export async function buildDeepReviewPromptFromSessionFiles(
  filePaths: string[],
  extraContext?: string,
  workspace?: GitWorkspaceScope,
): Promise<string> {
  return (await buildDeepReviewLaunchFromSessionFiles(
    filePaths,
    extraContext,
    workspace,
  )).prompt;
}

export async function buildDeepReviewLaunchFromSlashCommand(
  commandText: string,
  workspace?: GitWorkspaceScope,
  options: DeepReviewLaunchBuildOptions = {},
): Promise<DeepReviewLaunchPrompt> {
  const workspacePath = workspace?.repositoryPath;
  const team = await loadDefaultReviewTeam(workspace?.workspaceId);
  const trimmed = commandText.trim();
  const extraContext = getDeepReviewCommandFocus(trimmed);
  const { target, changeStats, targetEvidence } = options.resolvedTarget ??
    await resolveSlashCommandReviewTarget(extraContext, workspace);
  const manifest = await buildReviewTeamManifestWithRuntimeSignals(team, {
    workspacePath,
    target,
    changeStats,
    targetEvidence,
    ...(options.strategyOverride
      ? { strategyOverride: options.strategyOverride }
      : {}),
    ...(options.qualityDecision
      ? { qualityDecision: options.qualityDecision }
      : {}),
    ...(options.maxCoreReviewers !== undefined
      ? { maxCoreReviewers: options.maxCoreReviewers }
      : {}),
    ...(options.maxExtraReviewers !== undefined
      ? { maxExtraReviewers: options.maxExtraReviewers }
      : {}),
    ...(options.includeQualityGate !== undefined
      ? { includeQualityGate: options.includeQualityGate }
      : {}),
    ...(options.managedBatching !== undefined
      ? { managedBatching: options.managedBatching }
      : {}),
    ...(options.maxFocusedCalls !== undefined
      ? { maxFocusedCalls: options.maxFocusedCalls }
      : {}),
  });
  const prompt = formatSlashCommandLaunchPrompt({
    extraContext,
    reviewTeamPromptBlock: buildReviewTeamPromptBlock(team, manifest),
  });

  return { prompt, runManifest: manifest };
}

export async function buildDeepReviewPreviewFromSlashCommand(
  commandText: string,
  workspace?: GitWorkspaceScope,
): Promise<ReviewTeamRunManifest> {
  const workspacePath = workspace?.repositoryPath;
  const team = await loadDefaultReviewTeam(workspace?.workspaceId);
  const trimmed = commandText.trim();
  const extraContext = getDeepReviewCommandFocus(trimmed);
  const { target, changeStats, targetEvidence } = await resolveSlashCommandReviewTarget(extraContext, workspace);
  return buildReviewTeamManifestWithRuntimeSignals(team, {
    workspacePath,
    target,
    changeStats,
    targetEvidence,
  });
}

export async function buildDeepReviewPromptFromSlashCommand(
  commandText: string,
  workspace?: GitWorkspaceScope,
): Promise<string> {
  return (await buildDeepReviewLaunchFromSlashCommand(commandText, workspace)).prompt;
}

export async function launchDeepReviewSession({
  parentSessionId,
  workspacePath,
  prompt,
  displayMessage,
  childSessionName = 'Review: Strict',
  requestedFiles = [],
  runManifest,
  requestId,
  presentationKind = 'deep_review',
}: LaunchDeepReviewSessionParams): Promise<{
  childSessionId: string;
  launchStatus: 'started' | 'uncertain';
}> {
  let childSessionId: string | null = null;
  let parentDialogTurnId: string | undefined;
  let launchStep: DeepReviewLaunchStep = 'prepare_review_team';
  const effectiveRequestId = requestId ?? createBtwRequestId('deep_review');

  try {
    if (!runManifest?.managedReviewPlan) {
      const parentSession = flowChatStore.getState().sessions.get(parentSessionId);
      if (!parentSession?.workspaceId) throw new Error('Parent session workspace ID is unavailable');
      await prepareDefaultReviewTeamForLaunch(parentSession.workspaceId, {
        reviewTargetFilePaths: requestedFiles,
        target: runManifest?.target,
      });
    }

    launchStep = 'create_child_session';
    const createParams = {
      parentSessionId,
      workspacePath,
      childSessionName,
      sessionKind: presentationKind,
      agentType: 'DeepReview',
      enableTools: true,
      safeMode: true,
      autoCompact: true,
      enableContextCompression: true,
      addMarker: false,
      deepReviewRunManifest: runManifest,
      reviewTargetFilePaths: requestedFiles,
      requestId: effectiveRequestId,
    } as const;
    let created: Awaited<ReturnType<typeof createBtwChildSession>>;
    try {
      created = await createBtwChildSession(createParams);
    } catch (firstCreateError) {
      log.warn('Strict review child creation was uncertain; retrying idempotently', {
        parentSessionId,
        requestId: effectiveRequestId,
        error: firstCreateError,
      });
      created = await createBtwChildSession(createParams);
    }
    childSessionId = created.childSessionId;
    parentDialogTurnId = created.parentDialogTurnId;

    launchStep = 'send_start_message';
    const flowChatManager = FlowChatManager.getInstance();
    if (runManifest) {
      await flowChatManager.sendMessage(
        prompt,
        childSessionId,
        displayMessage,
        undefined,
        undefined,
        {
          turnId: `review_turn_${effectiveRequestId}`,
          preserveTurnOnStartError: true,
          userMessageMetadata: {
            deepReviewRunManifest: runManifest,
          },
        },
      );
    } else {
      await flowChatManager.sendMessage(
        prompt,
        childSessionId,
        displayMessage,
        undefined,
        undefined,
        {
          turnId: `review_turn_${effectiveRequestId}`,
          preserveTurnOnStartError: true,
        },
      );
    }

    insertReviewSessionSummaryMarker({
      parentSessionId,
      childSessionId,
      kind: presentationKind,
      title: childSessionName,
      requestedFiles,
      parentDialogTurnId,
    });

    return { childSessionId, launchStatus: 'started' };
  } catch (error) {
    if (!childSessionId) {
      throw createDeepReviewLaunchError(launchStep, error);
    }

    if (launchStep === 'send_start_message') {
      insertReviewSessionSummaryMarker({
        parentSessionId,
        childSessionId,
        kind: presentationKind,
        title: childSessionName,
        requestedFiles,
        parentDialogTurnId,
      });
      openBtwSessionInAuxPane({
        childSessionId,
        parentSessionId,
        workspacePath,
        expand: true,
        sessionKind: presentationKind,
        sessionTitle: childSessionName,
        agentType: 'DeepReview',
      });
      log.warn('Strict review start acknowledgement was uncertain; preserving the child session', {
        parentSessionId,
        childSessionId,
        requestId: effectiveRequestId,
        error,
      });
      return { childSessionId, launchStatus: 'uncertain' };
    }

    const cleanupResult = await cleanupFailedDeepReviewLaunch(childSessionId, launchStep);
    const wrappedError = buildLaunchCleanupError(
      launchStep,
      childSessionId,
      error,
      cleanupResult,
    );

    log.error('Strict review launch failed', {
      parentSessionId,
      childSessionId,
      launchStep,
      cleanupCompleted: cleanupResult.cleanupCompleted,
      cleanupIssues: cleanupResult.cleanupIssues,
      error,
    });

    throw wrappedError;
  }
}
