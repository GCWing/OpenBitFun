import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Checkbox, Icon } from '@openbitfun/ui';
import type { ReviewRemediationItem } from '../../utils/codeReviewRemediation';
import { REMEDIATION_GROUP_ORDER } from '../../utils/codeReviewRemediation';
import type { RemediationGroupId } from '../../utils/codeReviewReport';
import { globalEventBus } from '@/infrastructure/event-bus';
import { DEEP_REVIEW_SCROLL_TO_EVENT } from '../../events/flowchatNavigation';

interface RemediationSelectionPanelProps {
  remediationItems: ReviewRemediationItem[];
  selectedRemediationIds: Set<string>;
  completedRemediationIds: Set<string>;
  fixingRemediationIds?: Set<string>;
  decisionSelections: Record<string, number>;
  showRemediationList: boolean;
  expandedDecisionIds: Set<string>;
  selectionDisabled?: boolean;
  onToggleRemediation: (id: string) => void;
  onToggleAll: () => void;
  onToggleGroup: (groupId: RemediationGroupId | 'ungrouped') => void;
  onToggleList: () => void;
  onToggleDecisionExpansion: (id: string) => void;
  onSetDecisionSelection: (id: string, optionIndex: number) => void;
}

const EMPTY_FIXING_REMEDIATION_IDS = new Set<string>();

const GROUP_PRIORITY_META: Record<RemediationGroupId, { color: string }> = {
  must_fix: { color: 'var(--openbitfun-color-status-danger-content)' },
  should_improve: { color: 'var(--openbitfun-color-status-warning-content)' },
  needs_decision: { color: 'var(--openbitfun-color-accent-default)' },
  verification: { color: 'var(--openbitfun-color-status-success-content)' },
};

const stopNestedScrollPropagation = (event: React.WheelEvent | React.TouchEvent) => {
  event.stopPropagation();
  if ('nativeEvent' in event && typeof event.nativeEvent.stopImmediatePropagation === 'function') {
    event.nativeEvent.stopImmediatePropagation();
  }
};

export const RemediationSelectionPanel: React.FC<RemediationSelectionPanelProps> = ({
  remediationItems,
  selectedRemediationIds,
  completedRemediationIds,
  fixingRemediationIds = EMPTY_FIXING_REMEDIATION_IDS,
  decisionSelections,
  showRemediationList,
  expandedDecisionIds,
  selectionDisabled = false,
  onToggleRemediation,
  onToggleAll,
  onToggleGroup,
  onToggleList,
  onToggleDecisionExpansion,
  onSetDecisionSelection,
}) => {
  const { t } = useTranslation('flow-chat');

  const selectableItems = useMemo(
    () => remediationItems.filter((item) => !completedRemediationIds.has(item.id)),
    [completedRemediationIds, remediationItems],
  );
  const selectedCount = selectableItems.filter((item) => selectedRemediationIds.has(item.id)).length;
  const totalCount = selectableItems.length;
  const allSelected = totalCount > 0 && selectedCount === totalCount;

  const groupedItems = useMemo(() => {
    const groups: Record<string, ReviewRemediationItem[]> = {};
    for (const item of remediationItems) {
      const gid = item.groupId ?? 'ungrouped';
      if (!groups[gid]) groups[gid] = [];
      groups[gid].push(item);
    }
    return groups;
  }, [remediationItems]);

  const groupOrder = useMemo(() => {
    const ordered: Array<RemediationGroupId | 'ungrouped'> = [];
    for (const gid of REMEDIATION_GROUP_ORDER) {
      if (groupedItems[gid]?.length) ordered.push(gid);
    }
    if (groupedItems.ungrouped?.length) ordered.push('ungrouped');
    return ordered;
  }, [groupedItems]);

  return (
    <div className="deep-review-action-bar__remediation">
      <button
        type="button"
        className="deep-review-action-bar__remediation-toggle"
        onClick={onToggleList}
      >
        <span onClick={(event) => event.stopPropagation()}>
          <Checkbox
            checked={allSelected}
            indeterminate={!allSelected && selectedCount > 0}
            onChange={() => {
              if (!selectionDisabled) {
                onToggleAll();
              }
            }}
            disabled={selectionDisabled || totalCount === 0}
            size="sm"
          />
        </span>
        <span className="deep-review-action-bar__remediation-label">
          {t('toolCards.codeReview.remediationActions.selectionCount', {
            selected: selectedCount,
            total: totalCount,
          })}
        </span>
        {showRemediationList ? <Icon name="chevron-up" size="sm" /> : <Icon name="chevron-down" size="sm" />}
      </button>

      {showRemediationList && (
        <div
          className="deep-review-action-bar__remediation-list"
          onWheel={stopNestedScrollPropagation}
          onTouchMove={stopNestedScrollPropagation}
        >
          {groupOrder.map((groupId) => {
            const items = groupedItems[groupId]!;
            const selectableGroupItems = items.filter((item) => !completedRemediationIds.has(item.id));
            const groupSelectedCount = selectableGroupItems.filter((i) => selectedRemediationIds.has(i.id)).length;
            const groupTotalCount = selectableGroupItems.length;
            const groupAllSelected = groupTotalCount > 0 && groupSelectedCount === groupTotalCount;
            const groupPartial = groupSelectedCount > 0 && !groupAllSelected;
            const groupTitle = groupId === 'ungrouped'
              ? t('toolCards.codeReview.remediationActions.ungrouped')
              : t(`toolCards.codeReview.groups.${groupId}`, { defaultValue: groupId });
            const groupMeta = groupId !== 'ungrouped' ? GROUP_PRIORITY_META[groupId as RemediationGroupId] : undefined;

            return (
              <div key={groupId} className="deep-review-action-bar__remediation-group">
                <div
                  className="deep-review-action-bar__remediation-group-header"
                >
                  <Checkbox
                    checked={groupAllSelected}
                    indeterminate={groupPartial}
                    onChange={() => {
                      if (!selectionDisabled) {
                        onToggleGroup(groupId);
                      }
                    }}
                    size="sm"
                    disabled={selectionDisabled || groupTotalCount === 0}
                    label={(
                      <>
                        <span
                          className="deep-review-action-bar__remediation-group-title"
                          style={groupMeta ? { color: groupMeta.color } : undefined}
                        >
                          {groupTitle}
                        </span>
                        <span className="deep-review-action-bar__remediation-group-count">
                          {groupSelectedCount}/{groupTotalCount}
                        </span>
                      </>
                    )}
                  />
                </div>
                <div className="deep-review-action-bar__remediation-group-items">
                  {items.map((item) => {
                    const isCompleted = completedRemediationIds.has(item.id);
                    const isFixing = !isCompleted && fixingRemediationIds.has(item.id);
                    const isLocked = selectionDisabled || isCompleted;
                    return (
                      <label
                        key={item.id}
                        className={`deep-review-action-bar__remediation-item ${
                          isCompleted ? 'deep-review-action-bar__remediation-item--completed' : ''
                        } ${isFixing ? 'deep-review-action-bar__remediation-item--fixing' : ''} ${
                          isLocked ? 'deep-review-action-bar__remediation-item--locked' : ''
                        }`}
                      >
                        <Checkbox
                          checked={isCompleted || selectedRemediationIds.has(item.id)}
                          onChange={() => !isLocked && onToggleRemediation(item.id)}
                          disabled={isLocked}
                          size="sm"
                        />
                        <span
                          className="deep-review-action-bar__remediation-text"
                          title={item.decisionContext ? `${item.decisionContext.question}\n${item.plan}` : item.plan}
                        >
                          {isCompleted && (
                            <Icon name="check-circle" size="xs" className="deep-review-action-bar__completed-icon" />
                          )}
                          {isFixing && (
                            <Icon glyph={Loader2} size="xs" className="deep-review-action-bar__fixing-icon" />
                          )}
                          {(isCompleted || isFixing) && (
                            <span className="deep-review-action-bar__remediation-status">
                              {isCompleted
                                ? t('deepReviewActionBar.remediationStatus.fixed')
                                : t('deepReviewActionBar.remediationStatus.fixing')}
                            </span>
                          )}
                          {item.requiresDecision && (
                            <span className="deep-review-action-bar__remediation-tag">
                              {t('reviewActionBar.needsDecisionTag')}
                            </span>
                          )}
                          {item.groupId === 'verification' ? (
                            <span className="deep-review-action-bar__remediation-text-plain">
                              {item.decisionContext?.question ?? item.plan}
                            </span>
                          ) : (
                            <a
                              className="deep-review-action-bar__remediation-link"
                              href={`#review-remediation-${item.groupId ?? 'ungrouped'}-${item.groupIndex}`}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                if (item.groupId != null) {
                                  globalEventBus.emit(DEEP_REVIEW_SCROLL_TO_EVENT, {
                                    groupId: item.groupId,
                                    groupIndex: item.groupIndex,
                                    issueIndex: item.issueIndex ?? -1,
                                  });
                                }
                              }}
                            >
                              {item.decisionContext?.question ?? item.plan}
                            </a>
                          )}
                          {item.decisionContext?.tradeoffs && (
                            <span className="deep-review-action-bar__remediation-tradeoffs">
                              {item.decisionContext.tradeoffs}
                            </span>
                          )}
                          {item.decisionContext?.options && item.decisionContext.options.length > 0 && (
                            <button
                              type="button"
                              className="deep-review-action-bar__decision-toggle"
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                onToggleDecisionExpansion(item.id);
                              }}
                            >
                              {expandedDecisionIds.has(item.id)
                                ? t('toolCards.codeReview.remediationActions.collapseOptions')
                                : t('toolCards.codeReview.remediationActions.expandOptions')}
                            </button>
                          )}
                          {expandedDecisionIds.has(item.id) && item.decisionContext?.options && (
                            <ul className="deep-review-action-bar__decision-options">
                              {item.decisionContext.options.map((opt, oi) => {
                                const isSelected = decisionSelections[item.id] === oi;
                                const isRecommended = item.decisionContext?.recommendation === oi;
                                return (
                                  <li key={oi} className={`deep-review-action-bar__decision-option ${isSelected ? 'is-selected' : ''} ${isRecommended ? 'is-recommended' : ''}`}>
                                    <button
                                      type="button"
                                      onClick={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        onSetDecisionSelection(item.id, oi);
                                      }}
                                    >
                                      <span className="deep-review-action-bar__decision-option-marker">
                                        {isSelected ? '\u25CF' : '\u25CB'}
                                      </span>
                                      <span className="deep-review-action-bar__decision-option-text">
                                        {opt}
                                        {isRecommended ? ` (${t('toolCards.codeReview.remediationActions.recommended')})` : ''}
                                      </span>
                                    </button>
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!selectionDisabled && totalCount > 0 && selectedCount === 0 && (
        <div className="deep-review-action-bar__empty-selection" role="note">
          <Icon name="info" size="sm" className="deep-review-action-bar__empty-selection-icon" />
          <span>
            {t('toolCards.codeReview.remediationActions.noSelectionHint')}
          </span>
        </div>
      )}
    </div>
  );
};
