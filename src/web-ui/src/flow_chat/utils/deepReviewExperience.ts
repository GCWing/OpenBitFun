/**
 * Deep Review experience utilities.
 *
 * Aggregates raw session/tool state into user-friendly experience data
 * such as reviewer progress, error attribution, partial results, and
 * degradation options. All functions are pure and side-effect free.
 */

import { getAiErrorPresentation } from '@/shared/ai-errors/aiErrorPresenter';
import type { Session } from '../types/flow-chat';
import type { CodeReviewRemediationData } from './codeReviewRemediation';
import type { DeepReviewInterruption, DeepReviewReviewerProgress } from './deepReviewContinuation';
import { collectReviewerProgress } from './deepReviewContinuation';
import { getEffectiveToolName } from './toolInvocationIdentity';

// ---------------------------------------------------------------------------
// Reviewer progress
// ---------------------------------------------------------------------------

export interface ReviewerProgressItem extends DeepReviewReviewerProgress {
  /** Human-readable display name */
  displayName: string;
}

export interface ReviewerProgressSummary {
  completed: number;
  failed: number;
  timedOut: number;
  running: number;
  skipped: number;
  unknown: number;
  handled: number;
  total: number;
  /** Fallback short text, e.g. "4/5 handled" */
  text: string;
}

/**
 * Aggregate reviewer progress from a live session.
 * Reuses the existing `collectReviewerProgress` logic.
 */
export function aggregateReviewerProgress(
  session: Session,
): ReviewerProgressItem[] {
  const progress = collectReviewerProgress(session);
  return progress.map((p) => ({
    ...p,
    displayName: p.reviewer,
  }));
}

export function buildReviewerProgressSummary(
  progress: ReviewerProgressItem[],
): ReviewerProgressSummary {
  const completed = progress.filter((p) => p.status === 'completed').length;
  const failed = progress.filter((p) => p.status === 'failed').length;
  const timedOut = progress.filter((p) => (
    p.status === 'timed_out' || p.status === 'partial_timeout'
  )).length;
  const running = progress.filter((p) => p.status === 'unknown').length;
  const skipped = progress.filter((p) => (
    p.status === 'cancelled' || p.status === 'skipped'
  )).length;
  const unknown = progress.filter((p) => p.status === 'unknown').length;
  const handled = completed + failed + timedOut + skipped;
  const total = progress.length;

  return {
    completed,
    failed,
    timedOut,
    running,
    skipped,
    unknown,
    handled,
    total,
    text: `${handled}/${total} handled`,
  };
}

// ---------------------------------------------------------------------------
// Partial results extraction
// ---------------------------------------------------------------------------

export interface PartialReviewData {
  /** Whether any reviewer completed successfully */
  hasPartialResults: boolean;
  /** Number of completed reviewers */
  completedReviewerCount: number;
  /** Total reviewer count */
  totalReviewerCount: number;
  /** Issues found by completed reviewers */
  completedIssues: NonNullable<CodeReviewRemediationData['issues']>;
  /** Remediation items from completed reviewers */
  completedRemediationItems: string[];
  /** Summaries from completed reviewers */
  completedReviewerSummaries: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function extractSummaryText(summary: unknown): string | null {
  if (typeof summary === 'string') {
    const trimmed = summary.trim();
    return trimmed || null;
  }

  if (!isRecord(summary)) {
    return null;
  }

  const assessment = summary.overall_assessment;
  if (typeof assessment === 'string' && assessment.trim()) {
    return assessment.trim();
  }

  return null;
}

function extractTextField(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function appendPartialReviewResult(
  result: unknown,
  completedIssues: NonNullable<CodeReviewRemediationData['issues']>,
  completedRemediationItems: string[],
  completedReviewerSummaries: string[],
): void {
  if (!result) {
    return;
  }

  if (typeof result === 'string') {
    const trimmed = result.trim();
    if (!trimmed) {
      return;
    }

    try {
      appendPartialReviewResult(
        JSON.parse(trimmed),
        completedIssues,
        completedRemediationItems,
        completedReviewerSummaries,
      );
    } catch {
      completedReviewerSummaries.push(trimmed);
    }
    return;
  }

  if (!isRecord(result)) {
    return;
  }

  if (Array.isArray(result.issues)) {
    completedIssues.push(
      ...(result.issues.filter(isRecord) as NonNullable<CodeReviewRemediationData['issues']>),
    );
  }

  if (Array.isArray(result.remediation_plan)) {
    completedRemediationItems.push(
      ...result.remediation_plan.filter((item): item is string => (
        typeof item === 'string' && item.trim().length > 0
      )),
    );
  }

  const summaryText =
    extractSummaryText(result.summary) ??
    extractTextField(result.partial_output) ??
    extractTextField(result.partialOutput);
  if (summaryText) {
    completedReviewerSummaries.push(summaryText);
  }
}

/**
 * Extract partial review data from a session that may have been
 * interrupted before all reviewers finished.
 */
export function extractPartialReviewData(
  session: Session,
): PartialReviewData | null {
  const progress = collectReviewerProgress(session);
  const completedReviewers = progress.filter((p) => p.status === 'completed');

  if (completedReviewers.length === 0) {
    return null;
  }

  const completedIssues: NonNullable<CodeReviewRemediationData['issues']> = [];
  const completedRemediationItems: string[] = [];
  const completedReviewerSummaries: string[] = [];

  for (const turn of session.dialogTurns) {
    for (const round of turn.modelRounds) {
      for (const item of round.items) {
        if (item.type !== 'tool' || !['Task', 'AgentSpawn', 'LaunchReviewAgent'].includes(getEffectiveToolName(item))) {
          continue;
        }
        const reviewer = String(
          (item.toolCall.input as Record<string, unknown>)?.subagent_type ??
            (item.toolCall.input as Record<string, unknown>)?.subagentType ??
            '',
        ).trim();

        const isCompleted = completedReviewers.some(
          (p) => p.reviewer === reviewer,
        );
        if (!isCompleted || !item.toolResult?.success) {
          continue;
        }

        appendPartialReviewResult(
          item.toolResult.result,
          completedIssues,
          completedRemediationItems,
          completedReviewerSummaries,
        );
      }
    }
  }

  const hasExtractedDetails =
    completedIssues.length > 0 ||
    completedRemediationItems.length > 0 ||
    completedReviewerSummaries.length > 0;
  if (!hasExtractedDetails) {
    return null;
  }

  return {
    hasPartialResults: true,
    completedReviewerCount: completedReviewers.length,
    totalReviewerCount: progress.length,
    completedIssues,
    completedRemediationItems,
    completedReviewerSummaries,
  };
}

// ---------------------------------------------------------------------------
// Error attribution
// ---------------------------------------------------------------------------

export interface ErrorAttribution {
  category: string;
  title: string;
  description: string;
  severity: 'warning' | 'error';
  actions: Array<{ code: string; labelKey: string }>;
}

/**
 * Build a user-friendly error attribution from an interruption.
 * Leverages the existing `getAiErrorPresentation` system.
 */
export function buildErrorAttribution(
  interruption: DeepReviewInterruption,
): ErrorAttribution {
  if (interruption.interruptionReason === 'manual_cancelled') {
    return {
      category: 'manual_cancelled',
      title: 'deepReviewActionBar.manualCancel.title',
      description: 'deepReviewActionBar.manualCancel.description',
      severity: 'warning',
      actions: interruption.recommendedActions.map((a) => ({
        code: a.code,
        labelKey: a.labelKey,
      })),
    };
  }

  if (interruption.resultRecoveryReason) {
    const descriptionByReason: Record<
      NonNullable<DeepReviewInterruption['resultRecoveryReason']>,
      string
    > = {
      missing_submit_code_review: 'deepReviewActionBar.resultRecovery.missingSubmitCodeReview',
      invalid_submit_code_review: 'deepReviewActionBar.resultRecovery.invalidSubmitCodeReview',
      wrong_review_mode: 'deepReviewActionBar.resultRecovery.wrongReviewMode',
    };

    return {
      category: 'result_recovery',
      title: 'deepReviewActionBar.resultRecovery.title',
      description: descriptionByReason[interruption.resultRecoveryReason],
      severity: 'warning',
      actions: interruption.recommendedActions.map((a) => ({
        code: a.code,
        labelKey: a.labelKey,
      })),
    };
  }

  const presentation = getAiErrorPresentation(interruption.errorDetail);

  return {
    category: presentation.category,
    title: presentation.titleKey,
    description: presentation.messageKey,
    severity: presentation.severity,
    actions: presentation.actions.map((a) => ({
      code: a.code,
      labelKey: a.labelKey,
    })),
  };
}

// ---------------------------------------------------------------------------
// Recovery plan
// ---------------------------------------------------------------------------

export interface RecoveryPlan {
  willRerun: string[];
  willPreserve: string[];
  willSkip: string[];
  summaryText: string;
}

/**
 * Build a recovery plan that describes what will happen when the user
 * chooses to continue an interrupted deep review.
 */
export function buildRecoveryPlan(
  interruption: DeepReviewInterruption,
): RecoveryPlan {
  const reviewers = interruption.reviewers;

  const willPreserve = reviewers
    .filter((r) => r.status === 'completed')
    .map((r) => r.reviewer);

  const willRerun = reviewers
    .filter(
      (r) =>
        r.status === 'failed' ||
        r.status === 'timed_out' ||
        r.status === 'cancelled' ||
        r.status === 'unknown',
    )
    .map((r) => r.reviewer);

  const willSkip = reviewers
    .filter((r) => r.status === 'skipped')
    .map((r) => r.reviewer);

  const parts: string[] = [];
  if (willPreserve.length > 0) {
    parts.push(`${willPreserve.length} completed reviewers will be preserved`);
  }
  if (willRerun.length > 0) {
    parts.push(`${willRerun.length} reviewers will be rerun`);
  }
  if (willSkip.length > 0) {
    parts.push(`${willSkip.length} reviewers will be skipped`);
  }

  return {
    willRerun,
    willPreserve,
    willSkip,
    summaryText: parts.join('; ') || 'No recovery plan available.',
  };
}

// ---------------------------------------------------------------------------
// Degradation options
// ---------------------------------------------------------------------------

export interface DegradationOption {
  type: 'view_partial';
  labelKey: string;
  descriptionKey: string;
  enabled: boolean;
}

/**
 * Evaluate available degradation options when a deep review fails
 * (especially for context_overflow).
 */
export function evaluateDegradationOptions(
  interruption: DeepReviewInterruption,
): DegradationOption[] {
  const hasPartialResults = interruption.reviewers.some(
    (r) => r.status === 'completed',
  );

  return hasPartialResults
    ? [{
      type: 'view_partial',
      labelKey: 'deepReviewActionBar.degradation.viewPartial',
      descriptionKey: 'deepReviewActionBar.degradation.viewPartialDesc',
      enabled: true,
    }]
    : [];
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

export interface TokenEstimate {
  min: number;
  max: number;
}

const BASE_TOKENS = 5000;
const PER_REVIEWER_MIN = 8000;
const PER_REVIEWER_MAX = 25000;

/**
 * Rough token consumption estimate for a deep review run.
 */
export function estimateTokenConsumption(
  reviewerCount: number,
): TokenEstimate {
  return {
    min: BASE_TOKENS + reviewerCount * PER_REVIEWER_MIN,
    max: BASE_TOKENS + reviewerCount * PER_REVIEWER_MAX,
  };
}

export function formatTokenCount(count: number): string {
  if (count >= 1000000) {
    return `${(count / 1000000).toFixed(1)}M`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(0)}k`;
  }
  return String(count);
}

// ---------------------------------------------------------------------------
// Launch error classification
// ---------------------------------------------------------------------------

export interface LaunchErrorInfo {
  step: string;
  category: 'model_config' | 'network' | 'unknown';
  messageKey: string;
  actions: Array<'retry' | 'open_model_settings'>;
}

/**
 * Classify a launch failure into a user-friendly error description.
 */
export function classifyLaunchError(
  step: string,
  error: unknown,
): LaunchErrorInfo {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (step === 'create_child_session') {
    if (/model|provider|api key|authentication|unauthorized/i.test(lower)) {
      return {
        step,
        category: 'model_config',
        messageKey: 'deepReviewActionBar.launchError.modelConfig',
        actions: ['open_model_settings', 'retry'],
      };
    }
    return {
      step,
      category: 'unknown',
      messageKey: 'deepReviewActionBar.launchError.unknown',
      actions: ['retry'],
    };
  }

  if (step === 'send_start_message') {
    if (/network|timeout|connection|sse|stream/i.test(lower)) {
      return {
        step,
        category: 'network',
        messageKey: 'deepReviewActionBar.launchError.network',
        actions: ['retry'],
      };
    }
    return {
      step,
      category: 'unknown',
      messageKey: 'deepReviewActionBar.launchError.unknown',
      actions: ['retry'],
    };
  }

  return {
    step,
    category: 'unknown',
    messageKey: 'deepReviewActionBar.launchError.unknown',
    actions: ['retry'],
  };
}
