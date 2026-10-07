import {
  Button,
  Dialog,
  DialogBody,
  DialogClose, Icon,
} from '@openbitfun/ui';
import React, { useCallback, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  ReviewStrategyLevel,
  ReviewTeamRunManifest,
} from '@/shared/services/reviewTeamService';
import { getReviewStrategyProfile } from '@/shared/services/reviewTeamService';
import type { DeepReviewSessionConcurrencyGuard } from '../utils/deepReviewCapacityGuard';
import './DeepReviewConsentDialog.scss';

interface PendingConsent {
  resolve: (confirmed: boolean) => void;
  preview?: ReviewTeamRunManifest;
  launchContext?: DeepReviewConsentLaunchContext;
}

export interface DeepReviewConsentLaunchContext {
  sessionConcurrencyGuard?: DeepReviewSessionConcurrencyGuard | null;
}

export interface DeepReviewConsentControls {
  confirmDeepReviewLaunch: (
    preview?: ReviewTeamRunManifest,
    launchContext?: DeepReviewConsentLaunchContext,
  ) => Promise<boolean>;
  deepReviewConsentDialog: React.ReactNode;
}

function getReviewTargetFileCount(preview: ReviewTeamRunManifest): number {
  return preview.target.files.filter((file) => {
    if (typeof file === 'string') {
      return true;
    }
    return !file.excluded;
  }).length;
}

function getReviewTargetSummary(preview: ReviewTeamRunManifest, t: ReturnType<typeof useTranslation>['t']): string {
  const targetFileCount = getReviewTargetFileCount(preview);
  if (targetFileCount > 0) {
    return t('deepReviewConsent.targetFiles', {
      count: targetFileCount,
      defaultValue: targetFileCount === 1 ? '{{count}} file' : '{{count}} files',
    });
  }

  switch (preview.target.source) {
    case 'manual_prompt':
      return t('deepReviewConsent.targetSource.manualPrompt', {
        defaultValue: 'Provided context',
      });
    case 'workspace_diff':
      return t('deepReviewConsent.targetSource.workspaceDiff', {
        defaultValue: 'Workspace changes',
      });
    case 'slash_command_git_ref':
      return t('deepReviewConsent.targetSource.gitRef', {
        defaultValue: 'Git reference',
      });
    case 'slash_command_explicit_files':
    case 'session_files':
      return t('deepReviewConsent.targetSource.selectedContext', {
        defaultValue: 'Selected context',
      });
    case 'unknown':
    default:
      return t('deepReviewConsent.targetSource.reviewTarget', {
        defaultValue: 'Review target',
      });
  }
}

function getStrategyLabel(strategyLevel: ReviewStrategyLevel, t: ReturnType<typeof useTranslation>['t']): string {
  return t(`deepReviewConsent.strategyLabels.${strategyLevel}`, {
    defaultValue: getReviewStrategyProfile(strategyLevel).label,
  });
}

function getStrategySummary(strategyLevel: ReviewStrategyLevel, t: ReturnType<typeof useTranslation>['t']): string {
  return t(`deepReviewConsent.strategySummaries.${strategyLevel}`, {
    defaultValue: getReviewStrategyProfile(strategyLevel).summary,
  });
}

export function useDeepReviewConsent(): DeepReviewConsentControls {
  const { t } = useTranslation('flow-chat');
  const [pendingConsent, setPendingConsent] = useState<PendingConsent | null>(null);

  const confirmDeepReviewLaunch = useCallback(async (
    preview?: ReviewTeamRunManifest,
    launchContext?: DeepReviewConsentLaunchContext,
  ) => {
    return new Promise<boolean>((resolve) => {
      setPendingConsent({ resolve, preview, launchContext });
    });
  }, []);

  const settleConsent = useCallback(async (confirmed: boolean) => {
    const pending = pendingConsent;
    if (!pending) {
      return;
    }

    setPendingConsent(null);
    pending.resolve(confirmed);
  }, [pendingConsent]);

  const renderLaunchSummary = useCallback((preview: ReviewTeamRunManifest) => {
    const skippedReviewers = preview.skippedReviewers;
    const skippedCount = skippedReviewers.length;
    const selectedStrategyLabel = getStrategyLabel(preview.strategyLevel, t);
    const targetSummary = getReviewTargetSummary(preview, t);
    return (
      <div data-openbitfun-component="deep-review-consent-dialog" data-openbitfun-part="summary" className="deep-review-consent__summary">
        <div data-openbitfun-component="deep-review-consent-dialog" data-openbitfun-part="summaryHeader" className="deep-review-consent__summary-header">
          <span className="deep-review-consent__fact-title">
            {t('deepReviewConsent.summaryTitle')}
          </span>
        </div>

        <div data-openbitfun-component="deep-review-consent-dialog" data-openbitfun-part="summaryStats" className="deep-review-consent__summary-stats">
          <span>{targetSummary}</span>
          {skippedCount > 0 && (
            <span className="deep-review-consent__summary-stat--warning">
              {t('deepReviewConsent.skippedReviewers', {
                count: skippedCount,
              })}
            </span>
          )}
        </div>
        <div data-openbitfun-component="deep-review-consent-dialog" data-openbitfun-part="impactGrid" className="deep-review-consent__impact-grid">
          <div>
            <span>{t('deepReviewConsent.costLabel')}</span>
            <strong>{t('deepReviewConsent.cost')}</strong>
          </div>
          <div>
            <span>{t('deepReviewConsent.timeLabel')}</span>
            <strong>{t('deepReviewConsent.time')}</strong>
          </div>
          <div>
            <span>{t('deepReviewConsent.readonlyLabel')}</span>
            <strong>{t('deepReviewConsent.readonly')}</strong>
          </div>
        </div>

        {preview.workspacePath && (
          <div data-openbitfun-component="deep-review-consent-dialog" data-openbitfun-part="strategy" className="deep-review-consent__strategy-control">
            <div className="deep-review-consent__strategy-current">
              <strong>
                {t('deepReviewConsent.runStrategy', {
                  strategy: selectedStrategyLabel,
                })}
              </strong>
              <span>{getStrategySummary(preview.strategyLevel, t)}</span>
            </div>
          </div>
        )}

        {skippedReviewers.length > 0 && (
          <div data-openbitfun-component="deep-review-consent-dialog" data-openbitfun-part="reviewerGroup" className="deep-review-consent__reviewer-group">
            <div className="deep-review-consent__reviewer-group-title deep-review-consent__reviewer-group-title--warning">
              <Icon glyph={AlertTriangle} size="sm" />
              {t('deepReviewConsent.skippedGroupTitle')}
            </div>
            <p className="deep-review-consent__skipped-summary">
              {t('deepReviewConsent.skippedSummary', {
                count: skippedCount,
              })}
            </p>
          </div>
        )}
      </div>
    );
  }, [t]);

  const deepReviewConsentDialog = pendingConsent ? (
    <Dialog
      open
      onOpenChange={(nextOpen) => { if (!nextOpen) void settleConsent(false); }}
      size="lg"
      closeOnPointerOutside={false}
      aria-label={t('deepReviewConsent.windowTitle')}
    >
      <DialogBody inset="none">
        <div className="deep-review-consent-modal">
      <div data-openbitfun-component="deep-review-consent-dialog" data-openbitfun-part="root" className="deep-review-consent">
        <div data-openbitfun-component="deep-review-consent-dialog" data-openbitfun-part="header" className="deep-review-consent__header">
          <div data-openbitfun-component="deep-review-consent-dialog" data-openbitfun-part="heading" className="deep-review-consent__heading">
            <span className="deep-review-consent__eyebrow">
              {t('deepReviewConsent.eyebrow')}
            </span>
            <h3>{t('deepReviewConsent.title')}</h3>
            <p className="deep-review-consent__body">
              {t('deepReviewConsent.body')}
            </p>
          </div>
          <DialogClose
            data-openbitfun-component="deep-review-consent-dialog"
            data-openbitfun-part="close"
            className="deep-review-consent__close"
            aria-label={t('deepReviewConsent.cancel')}
          />
        </div>

        {pendingConsent.launchContext?.sessionConcurrencyGuard?.highActivity && (
          <div data-openbitfun-component="deep-review-consent-dialog" data-openbitfun-part="capacityNote" className="deep-review-consent__capacity-note">
            <div className="deep-review-consent__fact-icon deep-review-consent__fact-icon--warning">
              <Icon glyph={AlertTriangle} size="md" />
            </div>
            <div>
              <span className="deep-review-consent__fact-title">
                {t('deepReviewConsent.sessionConcurrencyTitle')}
              </span>
              <p>
                {t('deepReviewConsent.sessionConcurrencyBody', {
                  count: pendingConsent.launchContext.sessionConcurrencyGuard.activeSubagentCount,
                })}
              </p>
            </div>
          </div>
        )}

        {pendingConsent.preview && renderLaunchSummary(pendingConsent.preview)}

        <div data-openbitfun-component="deep-review-consent-dialog" data-openbitfun-part="footer" className="deep-review-consent__footer">
          <div data-openbitfun-component="deep-review-consent-dialog" data-openbitfun-part="actions" className="deep-review-consent__actions">
            <Button
              variant="fill"
              size="sm"
              onClick={() => void settleConsent(false)}
            >
              {t('deepReviewConsent.cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void settleConsent(true)}
            >
              {t('deepReviewConsent.confirm')}
            </Button>
          </div>
        </div>
      </div>
            </div>
            </DialogBody>
    </Dialog>
  ) : null;

  return {
    confirmDeepReviewLaunch,
    deepReviewConsentDialog,
  };
}
