import { Button } from '@openbitfun/ui';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Play, RotateCcw } from 'lucide-react';
import { Tooltip, Icon } from '@openbitfun/ui';
import type { ReviewActionPhase } from '../../store/deepReviewActionBarStore';
import { CodeReviewReportExportActions } from '../../tool-cards/CodeReviewReportExportActions';

type ExportableReviewData = React.ComponentProps<typeof CodeReviewReportExportActions>['reviewData'];
export type FollowUpReviewState =
  | 'none'
  | 'launching'
  | 'running'
  | 'available'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'retry';

interface ReviewActionControlsProps {
  phase: ReviewActionPhase;
  isDeepReview: boolean;
  retryableSliceCount: number;
  remediationItemCount: number;
  hasInterruption: boolean;
  partialResultsAvailable: boolean;
  activeAction: 'fix' | 'fix-review' | 'review' | 'resume' | 'retry' | null;
  followUpReviewState: FollowUpReviewState;
  canLaunchFollowUpReview: boolean;
  isFixDisabled: boolean;
  isResumeRunning: boolean;
  remainingFixIds: string[];
  modelRecoveryAction: 'switch_model' | 'open_model_settings' | null;
  reviewData?: ExportableReviewData | null;
  onRetryIncompleteSlices: () => void | Promise<void>;
  onStartFixing: () => void | Promise<void>;
  onReviewFixes: () => void | Promise<void>;
  onOpenFollowUpReview: () => void;
  onFillBackInput: () => void | Promise<void>;
  onContinueReview: () => void | Promise<void>;
  onOpenModelSettings: () => void | Promise<void>;
  onCopyDiagnostics: () => void | Promise<void>;
  onViewPartialResults: () => void;
  onContinueFix: () => void | Promise<void>;
  onSkipRemainingFixes: () => void;
  onMinimize: () => void;
}

export const ReviewActionControls: React.FC<ReviewActionControlsProps> = ({
  phase,
  isDeepReview,
  retryableSliceCount,
  remediationItemCount,
  hasInterruption,
  partialResultsAvailable,
  activeAction,
  followUpReviewState,
  canLaunchFollowUpReview,
  isFixDisabled,
  isResumeRunning,
  remainingFixIds,
  modelRecoveryAction,
  reviewData,
  onRetryIncompleteSlices,
  onStartFixing,
  onReviewFixes,
  onOpenFollowUpReview,
  onFillBackInput,
  onContinueReview,
  onOpenModelSettings,
  onCopyDiagnostics,
  onViewPartialResults,
  onContinueFix,
  onSkipRemainingFixes,
  onMinimize,
}) => {
  const { t } = useTranslation('flow-chat');

  return (
    <div className="deep-review-action-bar__actions">
      {phase === 'review_completed' && isDeepReview && retryableSliceCount > 0 && (
        <Button
          variant="outline"
          size="sm"
          loading={activeAction === 'retry'}
          disabled={activeAction !== null}
          onClick={() => void onRetryIncompleteSlices()}
          leadingIcon={<RotateCcw size={14} />}
        >

          {t('deepReviewActionBar.retryIncompleteSlices', {
            count: retryableSliceCount,
          })}
        </Button>
      )}
      {phase === 'review_completed' && remediationItemCount > 0 && (
        <>
          <Button
            variant="primary"
            size="sm"
            loading={activeAction === 'fix'}
            disabled={isFixDisabled}
            onClick={() => void onStartFixing()}
          >
            {t('toolCards.codeReview.remediationActions.startFix')}
          </Button>
          <Tooltip content={t('deepReviewActionBar.fillBackInputHint')}>
            <Button
              variant="outline"
              size="sm"
              disabled={isFixDisabled}
              onClick={() => void onFillBackInput()}
            >
              {t('deepReviewActionBar.fillBackInput')}
            </Button>
          </Tooltip>
        </>
      )}

      {phase === 'fix_completed' && (
        canLaunchFollowUpReview ||
        followUpReviewState === 'running' ||
        followUpReviewState === 'available' ||
        followUpReviewState === 'completed' ||
        followUpReviewState === 'failed' ||
        followUpReviewState === 'cancelled'
      ) && (
        <>
          {(
            followUpReviewState === 'running' ||
            followUpReviewState === 'available' ||
            followUpReviewState === 'completed' ||
            followUpReviewState === 'failed' ||
            followUpReviewState === 'cancelled'
          ) && (
            <Button
              variant={followUpReviewState === 'running' || followUpReviewState === 'completed'
                ? 'fill'
                : 'outline'}
              size="sm"
              onClick={onOpenFollowUpReview}
              leadingIcon={<Icon name="eye" size="sm" />}
            >

              {t(followUpReviewState === 'running'
                ? 'deepReviewActionBar.reviewFixesInProgress'
                : followUpReviewState === 'available'
                  ? 'deepReviewActionBar.openFollowUpReview'
                : followUpReviewState === 'completed'
                  ? 'deepReviewActionBar.viewFollowUpReview'
                  : followUpReviewState === 'failed'
                    ? 'deepReviewActionBar.viewFailedFollowUpReview'
                    : 'deepReviewActionBar.viewCancelledFollowUpReview')}
            </Button>
          )}
          {canLaunchFollowUpReview &&
            followUpReviewState !== 'running' &&
            followUpReviewState !== 'available' &&
            followUpReviewState !== 'completed' && (
            <Button
              variant="primary"
              size="sm"
              loading={activeAction === 'review' || followUpReviewState === 'launching'}
              disabled={activeAction !== null || followUpReviewState === 'launching'}
              onClick={() => void onReviewFixes()}
              leadingIcon={<RotateCcw size={14} />}
            >

              {t(followUpReviewState === 'retry' ||
                followUpReviewState === 'failed' ||
                followUpReviewState === 'cancelled'
                ? 'deepReviewActionBar.retryFollowUpReview'
                : 'deepReviewActionBar.reviewFixes')}
            </Button>
          )}
        </>
      )}

      {phase === 'review_completed' && reviewData && (
        <CodeReviewReportExportActions
          reviewData={reviewData}
          actions={['open']}
          variant="footer"
        />
      )}

      {hasInterruption && (
        <>
          <Button
            variant="primary"
            size="sm"
            loading={activeAction === 'resume'}
            disabled={activeAction !== null || isResumeRunning}
            onClick={() => void onContinueReview()}
            leadingIcon={<Play size={14} />}
          >

            {t('deepReviewActionBar.resumeReview')}
          </Button>
          {modelRecoveryAction && (
            <Button
              variant="outline"
              size="sm"
              disabled={activeAction !== null}
              onClick={() => void onOpenModelSettings()}
            >
              {modelRecoveryAction === 'switch_model'
                ? t('deepReviewActionBar.switchModel')
                : t('deepReviewActionBar.openModelSettings')}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void onCopyDiagnostics()}
            leadingIcon={<Icon name="duplicate" size="sm" />}
          >

            {t('deepReviewActionBar.copyDiagnostics')}
          </Button>
          {partialResultsAvailable && (
            <Button
              variant="outline"
              size="sm"
              onClick={onViewPartialResults}
              leadingIcon={<Icon name="eye" size="sm" />}
            >

              {t('deepReviewActionBar.viewPartialResults')}
            </Button>
          )}
        </>
      )}

      {phase === 'fix_interrupted' && (
        <>
          <div className="deep-review-action-bar__interruption-notice">
            <Icon glyph={AlertTriangle} size="md" className="deep-review-action-bar__interruption-icon" />
            <span>
              {t('deepReviewActionBar.fixInterrupted', {
                count: remainingFixIds.length,
              })}
            </span>
          </div>
          {remainingFixIds.length > 0 && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => void onContinueFix()}
              leadingIcon={<Play size={14} />}
            >

              {t('deepReviewActionBar.continueFix', {
                count: remainingFixIds.length,
              })}
            </Button>
          )}
          <Button
            variant="fill"
            size="sm"
            onClick={onSkipRemainingFixes}
          >
            {t('deepReviewActionBar.skipRemaining')}
          </Button>
        </>
      )}

      {(phase === 'fix_completed' || phase === 'fix_failed' || phase === 'fix_timeout' || phase === 'review_error') && (
        <Button
          variant="outline"
          size="sm"
          onClick={onMinimize}
        >
          {t('deepReviewActionBar.minimize')}
        </Button>
      )}
    </div>
  );
};
