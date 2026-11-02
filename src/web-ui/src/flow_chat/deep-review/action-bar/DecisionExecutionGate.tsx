import { ActionCard, Button, Textarea, Icon } from '@openbitfun/ui';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import type { ReviewRemediationItem } from '../../utils/codeReviewRemediation';

interface DecisionExecutionGateProps {
  items: ReviewRemediationItem[];
  decisionSelections: Record<string, number>;
  customInstructions: string;
  confirmDisabled: boolean;
  onSelectDecision: (itemId: string, optionIndex: number) => void;
  onCustomInstructionsChange: (value: string) => void;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export const DecisionExecutionGate: React.FC<DecisionExecutionGateProps> = ({
  items,
  decisionSelections,
  customInstructions,
  confirmDisabled,
  onSelectDecision,
  onCustomInstructionsChange,
  onConfirm,
  onCancel,
}) => {
  const { t } = useTranslation('flow-chat');

  return (
    <div className="deep-review-action-bar__decision-gate" role="dialog" aria-modal="false">
      <div className="deep-review-action-bar__decision-gate-header">
        <Icon glyph={AlertTriangle} size="md" className="deep-review-action-bar__decision-gate-icon" />
        <div>
          <div className="deep-review-action-bar__decision-gate-title">
            {t('deepReviewActionBar.decisionGate.title')}
          </div>
          <div className="deep-review-action-bar__decision-gate-desc">
            {t('deepReviewActionBar.decisionGate.description')}
          </div>
        </div>
      </div>

      <div className="deep-review-action-bar__decision-gate-items">
        {items.map((item) => {
          const decision = item.decisionContext;
          const options = decision?.options ?? [];
          const selectedOption = decisionSelections[item.id];

          return (
            <section key={item.id} className="deep-review-action-bar__decision-card">
              <div className="deep-review-action-bar__decision-question">
                {decision?.question ?? item.plan}
              </div>
              {decision?.plan && decision.plan !== decision.question && (
                <div className="deep-review-action-bar__decision-plan">
                  {decision.plan}
                </div>
              )}
              {decision?.tradeoffs && (
                <div className="deep-review-action-bar__decision-tradeoffs">
                  {decision.tradeoffs}
                </div>
              )}
              {options.length > 0 ? (
                <div className="deep-review-action-bar__decision-gate-options">
                  {options.map((option, optionIndex) => {
                    const isSelected = selectedOption === optionIndex;
                    const isRecommended = decision?.recommendation === optionIndex;
                    return (
                      <ActionCard
                        key={optionIndex}
                        type="button"
                        className="deep-review-action-bar__decision-gate-card"
                        selected={isSelected}
                        aria-pressed={isSelected}
                        triggerClassName={`deep-review-action-bar__decision-gate-option ${
                          isSelected ? 'is-selected' : ''
                        } ${isRecommended ? 'is-recommended' : ''}`}
                        onClick={() => onSelectDecision(item.id, optionIndex)}
                        body={(
                          <>
                            <span className="deep-review-action-bar__decision-gate-option-marker">
                              {isSelected ? '\u25CF' : '\u25CB'}
                            </span>
                            <span className="deep-review-action-bar__decision-gate-option-text">
                              {option}
                              {isRecommended ? ` (${t('toolCards.codeReview.remediationActions.recommended')})` : ''}
                            </span>
                          </>
                        )}
                      />
                    );
                  })}
                </div>
              ) : (
                <div className="deep-review-action-bar__decision-gate-note">
                  {t('deepReviewActionBar.decisionGate.noOptionsHint')}
                </div>
              )}
            </section>
          );
        })}
      </div>

      <label className="deep-review-action-bar__decision-gate-supplement">
        <span>
          {t('deepReviewActionBar.decisionGate.supplementLabel')}
        </span>
        <Textarea
          value={customInstructions}
          onChange={(event) => onCustomInstructionsChange(event.target.value)}
          placeholder={t('deepReviewActionBar.decisionGate.supplementPlaceholder')}
          rows={2}
        />
      </label>

      {confirmDisabled && (
        <div className="deep-review-action-bar__decision-gate-warning" role="note">
          {t('deepReviewActionBar.decisionGate.missingSelection')}
        </div>
      )}

      <div className="deep-review-action-bar__decision-gate-actions">
        <Button
          variant="primary"
          size="sm"
          disabled={confirmDisabled}
          onClick={() => void onConfirm()}
        >
          {t('deepReviewActionBar.decisionGate.confirmFix')}
        </Button>
        <Button
          variant="fill"
          size="sm"
          onClick={onCancel}
        >
          {t('deepReviewActionBar.decisionGate.cancel')}
        </Button>
      </div>
    </div>
  );
};
