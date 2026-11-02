import { Icon } from '@openbitfun/ui';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCcw, SkipForward } from 'lucide-react';
import type { RecoveryPlan } from '../../utils/deepReviewExperience';

interface RecoveryPlanPreviewProps {
  recoveryPlan: RecoveryPlan;
}

export const RecoveryPlanPreview: React.FC<RecoveryPlanPreviewProps> = ({
  recoveryPlan,
}) => {
  const { t } = useTranslation('flow-chat');

  return (
    <div className="deep-review-action-bar__recovery-plan">
      <div className="deep-review-action-bar__recovery-plan-detail">
        {recoveryPlan.willPreserve.length > 0 && (
          <div className="deep-review-action-bar__recovery-item">
            <Icon name="check-circle" size="xs" className="deep-review-action-bar__recovery-icon--preserve" />
            <span>
              {t('deepReviewActionBar.recoveryPreserve', {
                count: recoveryPlan.willPreserve.length,
              })}
            </span>
          </div>
        )}
        {recoveryPlan.willRerun.length > 0 && (
          <div className="deep-review-action-bar__recovery-item">
            <Icon glyph={RotateCcw} size="xs" className="deep-review-action-bar__recovery-icon--rerun" />
            <span>
              {t('deepReviewActionBar.recoveryRerun', {
                count: recoveryPlan.willRerun.length,
              })}
            </span>
          </div>
        )}
        {recoveryPlan.willSkip.length > 0 && (
          <div className="deep-review-action-bar__recovery-item">
            <Icon glyph={SkipForward} size="xs" className="deep-review-action-bar__recovery-icon--skip" />
            <span>
              {t('deepReviewActionBar.recoverySkip', {
                count: recoveryPlan.willSkip.length,
              })}
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
