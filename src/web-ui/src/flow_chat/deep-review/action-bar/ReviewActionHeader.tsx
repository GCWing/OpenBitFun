import React from 'react';
import { Minus } from 'lucide-react';
import { CodeReviewReportExportActions } from '../../tool-cards/CodeReviewReportExportActions';
import { Icon, type IconSource } from '@openbitfun/ui';

type ExportableReviewData = React.ComponentProps<typeof CodeReviewReportExportActions>['reviewData'];

interface ReviewActionHeaderProps {
  reviewData?: ExportableReviewData | null;
  isReviewRunning?: boolean;
  phaseIcon: IconSource;
  phaseIconClass: string;
  phaseTitle: string;
  errorMessage?: string | null;
  errorSummary?: string;
  errorDetailsLabel?: string;
  minimizeLabel: string;
  onMinimize: () => void;
}

export const ReviewActionHeader: React.FC<ReviewActionHeaderProps> = ({
  reviewData,
  isReviewRunning = false,
  phaseIcon,
  phaseIconClass,
  phaseTitle,
  errorMessage,
  errorSummary,
  errorDetailsLabel,
  minimizeLabel,
  onMinimize,
}) => (
  <>
    <div className="deep-review-action-bar__controls">
      {(reviewData || isReviewRunning) && (
        <CodeReviewReportExportActions
          reviewData={reviewData}
          actions={['copy', 'save']}
        />
      )}
      <span className="deep-review-action-bar__controls-divider" />
      <button
        type="button"
        className="deep-review-action-bar__controls-btn"
        onClick={onMinimize}
        aria-label={minimizeLabel}
      >
        <Icon glyph={Minus} size="sm" />
      </button>
    </div>

    <div className="deep-review-action-bar__status" role="status" aria-live="polite">
      <Icon {...phaseIcon}
        size="md"
        className={`deep-review-action-bar__icon ${phaseIconClass}`}
      />
      <span className="deep-review-action-bar__status-title">{phaseTitle}</span>
    </div>
    {errorMessage && (
      <div className="deep-review-action-bar__error-message" role="status">
        {errorSummary && errorSummary !== errorMessage && (
          <div>{errorSummary}</div>
        )}
        {errorDetailsLabel && <div>{errorDetailsLabel}</div>}
        <div>{errorMessage}</div>
      </div>
    )}
  </>
);
