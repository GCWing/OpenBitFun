import { useToolCardDisclosure, useToolCardValue } from '../timeline/readerState';
/**
 * CodeReview tool display component
 * Displays structured code review results with collapsible/expandable details
 * Uses the shared prominent FlowChat framework.
 */

import { OverflowText, Icon } from '@openbitfun/ui';
import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { Loader2, AlertTriangle, AlertCircle, SearchCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getToolCardStatus } from './toolCardStatus';
import type { ToolCardProps } from '../types/flow-chat';
import { flowChatStore } from '../store/FlowChatStore';
import {
  ProminentToolCard,
  ProminentToolCardSummary,
  ToolCardDisclosure,
  ToolProcessingDots,
} from '@openbitfun/ui/flow-chat';
import { createLogger } from '@/shared/utils/logger';
import { useToolCardHeightContract } from './useToolCardHeightContract';
import {
  buildReviewRemediationItems,
} from '../utils/codeReviewRemediation';
import {
  buildCodeReviewReliabilityNotices,
  buildCodeReviewReportSections,
  getDefaultExpandedCodeReviewSectionIds,
  formatReviewCoverageSource,
  type CodeReviewReportData,
  type ReviewEvidenceStatus,
  type ReviewReliabilityNotice,
  type RemediationGroupId,
  type ReviewReportGroup,
  type ReviewSectionId,
  type StrengthGroupId,
} from '../utils/codeReviewReport';
import { CodeReviewReportExportActions } from './CodeReviewReportExportActions';
import { DEEP_REVIEW_SCROLL_TO_EVENT, type DeepReviewScrollToRequest } from '../events/flowchatNavigation';
import { globalEventBus } from '@/infrastructure/event-bus';
import { normalizeDecisionEntry, type DecisionContext } from '../utils/codeReviewReport';
import { getMotionAwareScrollBehavior } from '../utils/motionPreference';
import type { ReviewTeamRunManifest } from '@/shared/services/reviewTeamService';
import './CodeReviewToolCard.scss';

const EVIDENCE_STATUS_LABEL_KEYS: Record<ReviewEvidenceStatus, string> = {
  complete: 'toolCards.codeReview.evidenceStatuses.complete',
  limited: 'toolCards.codeReview.evidenceStatuses.limited',
  stale: 'toolCards.codeReview.evidenceStatuses.stale',
  failed: 'shared:statuses.failed',
};

const log = createLogger('CodeReviewToolCard');

const riskLevelColors: Record<string, string> = {
  low: 'var(--openbitfun-color-status-success-content)',
  medium: 'var(--openbitfun-color-status-warning-content)',
  high: 'color-mix(in srgb, var(--openbitfun-color-status-warning-content) 55%, var(--openbitfun-color-status-danger-content))',
  critical: 'var(--openbitfun-color-status-danger-content)',
};

type Translate = (key: string, options?: Record<string, unknown>) => string;

interface ReviewReportSectionProps {
  title: string;
  summary?: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

const ReviewReportSection: React.FC<ReviewReportSectionProps> = ({
  title,
  summary,
  expanded,
  onToggle,
  children,
}) => (
  <section
    className={`review-report-section ${expanded ? 'is-expanded' : ''}`}
    data-openbitfun-component="code-review-tool-card"
    data-openbitfun-part="group"
    data-openbitfun-state={expanded ? 'expanded' : undefined}
  >
    <ToolCardDisclosure
      summary={title}
      description={summary}
      open={expanded}
      onOpenChange={onToggle}
      onClick={(event) => event.stopPropagation()}
      unmountOnClose
    >
      {children}
    </ToolCardDisclosure>
  </section>
);

function getRemediationGroupTitle(id: RemediationGroupId, t: Translate): string {
  return t(`toolCards.codeReview.groups.${id}`, {
    defaultValue: id,
  });
}

function getStrengthGroupTitle(id: StrengthGroupId, t: Translate): string {
  return t(`toolCards.codeReview.groups.${id}`, {
    defaultValue: id,
  });
}

function getCoverageSourceLabel(sourceReviewer: string | undefined, t: Translate): string | null {
  return formatReviewCoverageSource(sourceReviewer, {
    businessLogic: t('toolCards.codeReview.coverageSources.businessLogic', {
      defaultValue: 'Logic coverage',
    }),
    performance: t('toolCards.codeReview.coverageSources.performance', {
      defaultValue: 'Performance coverage',
    }),
    security: t('toolCards.codeReview.coverageSources.security', {
      defaultValue: 'Security coverage',
    }),
    architecture: t('toolCards.codeReview.coverageSources.architecture', {
      defaultValue: 'Architecture coverage',
    }),
    frontend: t('toolCards.codeReview.coverageSources.frontend', {
      defaultValue: 'Frontend coverage',
    }),
    focusedCheck: t('toolCards.codeReview.coverageSources.focusedCheck', {
      defaultValue: 'Additional check',
    }),
    qualityGate: t('toolCards.codeReview.coverageSources.qualityGate', {
      defaultValue: 'Quality check',
    }),
  });
}

function formatIssueStats(stats: { critical: number; high: number; medium: number; low: number; info: number; total: number }, t: Translate): string {
  if (stats.total === 0) {
    return t('toolCards.codeReview.noIssues', { defaultValue: 'No issues' });
  }

  return (['critical', 'high', 'medium', 'low', 'info'] as const)
    .filter((severity) => stats[severity] > 0)
    .map((severity) => `${stats[severity]} ${t(`toolCards.codeReview.severities.${severity}`, { defaultValue: severity })}`)
    .join(' / ');
}

function getReliabilityNoticeLabel(notice: ReviewReliabilityNotice, t: Translate): string {
  return t(`toolCards.codeReview.reliabilityStatus.${notice.kind}.label`, {
    defaultValue: {
      context_pressure: 'Context pressure rising',
      compression_preserved: 'Compression preserved key facts',
      cache_hit: 'Incremental cache reused review output',
      cache_miss: 'Incremental cache missed or refreshed',
      concurrency_limited: 'Review launch was concurrency-limited',
      partial_reviewer: 'Review returned partial result',
      target_evidence_limited: 'Target evidence limited',
      reduced_scope: 'Limited review scope',
      retry_guidance: 'Retry guidance emitted',
      skipped_reviewers: 'Review scope tailored',
      token_budget_limited: 'Token budget limited review coverage',
      user_decision: 'User decision needed',
    }[notice.kind],
  });
}

function getReliabilityNoticeDetail(notice: ReviewReliabilityNotice, t: Translate): string {
  if (notice.detail?.trim()) {
    return notice.detail.trim();
  }

  return t(`toolCards.codeReview.reliabilityStatus.${notice.kind}.detail`, {
    count: notice.count ?? 0,
    defaultValue: {
      context_pressure: 'A large or constrained target has {{count}} planned review work items.',
      compression_preserved: 'Coverage notes include preserved context from compression.',
      cache_hit: '{{count}} previous review result reused matching cached output.',
      cache_miss: '{{count}} review result ran fresh or refreshed stale cache.',
      concurrency_limited: '{{count}} review launch hit a concurrency cap.',
      partial_reviewer: '{{count}} review result is partial; confidence is limited.',
      target_evidence_limited: 'Prepared target evidence could not safely cover every requested change.',
      reduced_scope: 'This review used a limited scope.',
      retry_guidance: '{{count}} retry guidance item was emitted for partial review coverage.',
      skipped_reviewers: 'Optional review work not run: {{count}} (applicability, configuration, or budget).',
      token_budget_limited: 'Optional review work not run due to token budget: {{count}}.',
      user_decision: '{{count}} review item needs your decision before fixing.',
    }[notice.kind],
  });
}

function getReliabilityNoticeIcon(notice: ReviewReliabilityNotice): React.ReactNode {
  if (
    notice.kind === 'partial_reviewer' ||
    notice.kind === 'retry_guidance'
  ) {
    return <Icon name="clock" size="sm" />;
  }
  if (
    notice.kind === 'user_decision' ||
    notice.kind === 'concurrency_limited' ||
    notice.kind === 'token_budget_limited' ||
    notice.kind === 'target_evidence_limited'
  ) {
    return <Icon glyph={AlertTriangle} size="sm" />;
  }
  return <Icon name="info" size="sm" />;
}

function getDeepReviewRunManifestForSession(sessionId?: string): ReviewTeamRunManifest | undefined {
  if (!sessionId) {
    return undefined;
  }

  return flowChatStore.getState().sessions.get(sessionId)?.deepReviewRunManifest;
}

function renderReportGroupList<TId extends RemediationGroupId | StrengthGroupId>(
  groups: Array<ReviewReportGroup<TId>>,
  titleForGroup: (id: TId) => string,
): React.ReactNode {
  return groups.map((group) => (
    <div key={group.id} id={`review-remediation-group-${group.id}`} className="review-report-group" data-openbitfun-component="code-review-tool-card" data-openbitfun-part="group">
      <div className="review-report-group__title">{titleForGroup(group.id)}</div>
      <ul className="review-report-group__list">
        {group.items.map((item, index) => (
          <li key={`${group.id}-${index}`} id={`review-remediation-${group.id}-${index}`}>{item}</li>
        ))}
      </ul>
    </div>
  ));
}

export const CodeReviewToolCard: React.FC<ToolCardProps> = React.memo(({
  toolItem,
  sessionId,
}) => {
  const { t } = useTranslation('flow-chat');
  const { toolResult } = toolItem;
  const status = getToolCardStatus(toolItem);
  const [isExpanded, setIsExpanded] = useToolCardDisclosure('isExpanded');
  const [remediationChoices, setRemediationChoices] = useToolCardValue<string>('remediations', '[]');
  const [sectionChoices, setSectionChoices] = useToolCardValue<string>('reportSections', '{}');
  const expandedRemediationIds = useMemo(() => new Set<string>(JSON.parse(remediationChoices)), [remediationChoices]);
  const reportSectionChoices = useMemo(() => JSON.parse(sectionChoices) as Partial<Record<ReviewSectionId, boolean>>, [sectionChoices]);
  const setExpandedRemediationIds = useCallback((update: (previous: Set<string>) => Set<string>) => {
    setRemediationChoices(previous => JSON.stringify([...update(new Set<string>(JSON.parse(previous)))]));
  }, [setRemediationChoices]);
  const setReportSectionChoices = useCallback((update: (previous: Partial<Record<ReviewSectionId, boolean>>) => Partial<Record<ReviewSectionId, boolean>>) => {
    setSectionChoices(previous => JSON.stringify(update(JSON.parse(previous))));
  }, [setSectionChoices]);
  const toolId = toolItem.id ?? toolItem.toolCall?.id;
  const { cardRootRef, applyExpandedState, dispatchToolCardToggle } = useToolCardHeightContract({
    toolId,
    toolName: toolItem.toolName,
  });
  const [sessionRunManifest, setSessionRunManifest] = useState<ReviewTeamRunManifest | undefined>(
    () => getDeepReviewRunManifestForSession(sessionId),
  );

  useEffect(() => {
    setSessionRunManifest(getDeepReviewRunManifestForSession(sessionId));

    if (!sessionId) {
      return undefined;
    }

    return flowChatStore.subscribe((state) => {
      setSessionRunManifest(state.sessions.get(sessionId)?.deepReviewRunManifest);
    });
  }, [sessionId]);

  const getStatusIcon = () => {
    switch (status) {
      case 'running':
      case 'streaming':
        return <Icon glyph={Loader2} size="xs" className="animate-spin" />;
      case 'completed':
        return null;
      case 'pending':
      default:
        return <ToolProcessingDots size={12} />;
    }
  };

  const reviewData = useMemo<CodeReviewReportData | null>(() => {
    if (!toolResult?.result) return null;

    try {
      const result = toolResult.result;

      if (typeof result === 'string') {
        const parsed = JSON.parse(result);
        return parsed;
      }

      if (typeof result === 'object' && result.summary) {
        return result as CodeReviewReportData;
      }

      return null;
    } catch (error) {
      log.error('Failed to parse result', error);
      return null;
    }
  }, [toolResult?.result]);

  const expandedReportSectionIds = useMemo(() => {
    const expanded = new Set(reviewData ? getDefaultExpandedCodeReviewSectionIds(reviewData) : []);
    for (const [id, open] of Object.entries(reportSectionChoices)) {
      if (open) expanded.add(id as ReviewSectionId);
      else expanded.delete(id as ReviewSectionId);
    }
    return expanded;
  }, [reportSectionChoices, reviewData]);

  const issueStats = useMemo(() => {
    if (!reviewData) return null;

    const stats = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
      total: 0,
    };

    (reviewData.issues ?? []).forEach(issue => {
      stats[issue.severity ?? 'info']++;
      stats.total++;
    });

    return stats;
  }, [reviewData]);

  const getSeverityIcon = (severity: string) => {
    switch (severity) {
      case 'critical':
        return <Icon glyph={AlertCircle} size="sm" style={{ color: riskLevelColors.critical }} />;
      case 'high':
        return <Icon glyph={AlertTriangle} size="sm" style={{ color: riskLevelColors.high }} />;
      case 'medium':
        return <Icon glyph={AlertTriangle} size="sm" style={{ color: riskLevelColors.medium }} />;
      case 'low':
        return <Icon name="info" size="sm" style={{ color: riskLevelColors.low }} />;
      case 'info':
        return <Icon name="info" size="sm" style={{ color: 'var(--openbitfun-color-content-muted)' }} />;
      default:
        return <Icon name="info" size="sm" style={{ color: 'var(--openbitfun-color-content-muted)' }} />;
    }
  };

  const getSeverityClass = (severity: string) => {
    switch (severity) {
      case 'critical':
        return 'critical';
      case 'high':
        return 'high';
      case 'medium':
        return 'medium';
      case 'low':
        return 'low';
      case 'info':
      default:
        return 'info';
    }
  };

  const hasIssues = issueStats && issueStats.total > 0;
  const hasData = reviewData !== null;
  const remediationItems = useMemo(
    () => reviewData ? buildReviewRemediationItems(reviewData) : [],
    [reviewData],
  );

  const toggleExpanded = useCallback(() => {
    applyExpandedState(isExpanded, !isExpanded, setIsExpanded);
  }, [applyExpandedState, isExpanded, setIsExpanded]);

  const handleCardClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.preview-toggle-btn')) {
      return;
    }

    if (hasData) {
      toggleExpanded();
    }
  }, [hasData, toggleExpanded]);

  const handleToggleRemediationDetails = useCallback((itemId: string) => {
    setExpandedRemediationIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  }, [setExpandedRemediationIds]);

  const handleToggleReportSection = useCallback((sectionId: ReviewSectionId) => () => {
    dispatchToolCardToggle();
    setReportSectionChoices(current => ({ ...current, [sectionId]: !expandedReportSectionIds.has(sectionId) }));
  }, [dispatchToolCardToggle, expandedReportSectionIds, setReportSectionChoices]);

  // Listen for scroll-to events from the review action bar
  useEffect(() => {
    const handler = (request: DeepReviewScrollToRequest) => {
      // Ensure the card is expanded
      if (!isExpanded) {
        setIsExpanded(true);
      }

      // Ensure both issues and remediation sections are expanded
      setReportSectionChoices(current => ({ ...current, remediation: true, issues: true }));

      // Double rAF: wait for React state update + DOM render before scrolling
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          // Prefer scrolling to the matching issue (has title + description)
          // Fall back to the remediation plan item
          let anchor: HTMLElement | null = null;
          if (request.issueIndex >= 0) {
            anchor = document.getElementById(`review-issue-${request.issueIndex}`);
          }
          if (!anchor) {
            anchor = document.getElementById(`review-remediation-${request.groupId}-${request.groupIndex}`);
          }
          if (anchor) {
            anchor.scrollIntoView({
              behavior: getMotionAwareScrollBehavior('smooth'),
              block: 'center',
            });
            anchor.classList.add('is-highlighted');
            setTimeout(() => anchor!.classList.remove('is-highlighted'), 2000);
          }
        });
      });
    };

    globalEventBus.on(DEEP_REVIEW_SCROLL_TO_EVENT, handler);
    return () => {
      globalEventBus.off(DEEP_REVIEW_SCROLL_TO_EVENT, handler);
    };
  }, [isExpanded, setIsExpanded, setReportSectionChoices]);

  const renderContent = () => {
    if (status === 'cancelled') return t('toolCards.default.cancelled');
    if (status === 'rejected') return t('toolCards.default.rejected');
    if (status === 'completed' && reviewData) {
      const riskLevel = reviewData.summary?.risk_level;
      const reviewLabel = reviewData.review_mode === 'deep'
        ? t('toolCards.codeReview.deepReviewResult')
        : t('toolCards.codeReview.reviewResult');

      if (hasIssues) {
        const parts: React.ReactNode[] = [];
        if (issueStats!.critical > 0) {
          parts.push(
            <span key="critical" style={{ color: riskLevelColors.critical }}>
              {issueStats!.critical} {t('toolCards.codeReview.severities.critical')}
            </span>,
          );
        }
        if (issueStats!.high > 0) {
          parts.push(
            <span key="high" style={{ color: riskLevelColors.high }}>
              {issueStats!.high} {t('toolCards.codeReview.severities.high')}
            </span>,
          );
        }
        if (issueStats!.medium > 0) {
          parts.push(
            <span key="medium" style={{ color: riskLevelColors.medium }}>
              {issueStats!.medium} {t('toolCards.codeReview.severities.medium')}
            </span>,
          );
        }
        if (issueStats!.low > 0) {
          parts.push(
            <span key="low" style={{ color: riskLevelColors.low }}>
              {issueStats!.low} {t('toolCards.codeReview.severities.low')}
            </span>,
          );
        }

        return (
          <>
            {reviewLabel} -{' '}
            {parts.reduce<React.ReactNode[]>((acc, part, i) => {
              if (i > 0) acc.push(<span key={`sep-${i}`}>, </span>);
              acc.push(part);
              return acc;
            }, [])}
          </>
        );
      }

      return riskLevel
        ? <>{reviewLabel} - {t(`toolCards.codeReview.riskLevels.${riskLevel}`)}</>
        : <>{reviewLabel}</>;
    }

    if (status === 'running' || status === 'streaming') {
      return <>{t('toolCards.codeReview.reviewingCode')}</>;
    }

    if (status === 'pending') {
      return <>{t('toolCards.codeReview.preparingReview')}</>;
    }

    if (status === 'error') {
      return <>{t('toolCards.codeReview.reviewFailed', { error: toolResult?.error || t('toolCards.codeReview.unknownError') })}</>;
    }

    return null;
  };

  const renderSummary = () => {
    return (
      <ProminentToolCardSummary
        icon={<Icon glyph={SearchCheck} size="md" aria-hidden="true" />}
        content={renderContent()}
        actions={hasData && reviewData ? (
          <CodeReviewReportExportActions
            reviewData={reviewData}
            runManifest={sessionRunManifest}
          />
        ) : undefined}
        statusIcon={getStatusIcon()}
      />
    );
  };

  const expandedContent = useMemo(() => {
    if (!reviewData) return null;

    const summary = reviewData.summary ?? {};
    const issues = reviewData.issues ?? [];
    const review_mode = reviewData.review_mode;
    const review_scope = reviewData.review_scope;
    const runManifest = review_mode === 'deep'
      ? sessionRunManifest
      : undefined;
    const reportSections = buildCodeReviewReportSections(reviewData);
    const reliabilityNotices = buildCodeReviewReliabilityNotices(reviewData, runManifest);
    const riskLevel = summary.risk_level;
    const recommendedAction = summary.recommended_action;
    const remediationItemCount = reportSections.remediationGroups
      .reduce((total, group) => total + group.items.length, 0);
    const strengthItemCount = reportSections.strengthGroups
      .reduce((total, group) => total + group.items.length, 0);
    const remediationExpanded = expandedReportSectionIds.has('remediation');
    const issuesExpanded = expandedReportSectionIds.has('issues');
    const strengthsExpanded = expandedReportSectionIds.has('strengths');
    const coverageExpanded = expandedReportSectionIds.has('coverage');

    return (
      <div className="code-review-details" data-openbitfun-component="code-review-tool-card" data-openbitfun-part="details">
        {reliabilityNotices.length > 0 && (
          <div
            className="review-reliability-status"
            data-openbitfun-component="code-review-tool-card"
            data-openbitfun-part="reliability"
            aria-label={t('toolCards.codeReview.reliabilityStatus.title')}
          >
            <div className="review-reliability-status__title">
              {t('toolCards.codeReview.reliabilityStatus.title')}
            </div>
            <div className="review-reliability-status__items">
              {reliabilityNotices.map((notice) => (
                <div
                  key={notice.kind}
                  className={`review-reliability-status__item review-reliability-status__item--${notice.severity}`}
                  data-openbitfun-component="code-review-tool-card"
                  data-openbitfun-part="reliabilityItem"
                >
                  <span className="review-reliability-status__icon">
                    {getReliabilityNoticeIcon(notice)}
                  </span>
                  <span className="review-reliability-status__text">
                    <span className="review-reliability-status__label">
                      {getReliabilityNoticeLabel(notice, t)}
                    </span>
                    <span className="review-reliability-status__detail">
                      {getReliabilityNoticeDetail(notice, t)}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="review-summary" data-openbitfun-component="code-review-tool-card" data-openbitfun-part="summary">
          <div className="summary-header">{t('toolCards.codeReview.overallAssessment')}</div>
          <div className="summary-rows">
            {riskLevel && (
              <div className="summary-row">
                <span className="summary-label">{t('toolCards.codeReview.riskLevel')}</span>
                <span
                  className="summary-value risk-level"
                  style={{ color: riskLevelColors[riskLevel] }}
                >
                  {getSeverityIcon(riskLevel)}
                  <span>{t(`toolCards.codeReview.riskLevels.${riskLevel}`)}</span>
                </span>
              </div>
            )}
            {recommendedAction && (
              <div className="summary-row">
                <span className="summary-label">{t('toolCards.codeReview.recommendedAction')}</span>
                <span className="summary-value">{t(`toolCards.codeReview.actions.${recommendedAction}`)}</span>
              </div>
            )}
            {reviewData.evidence_status && (
              <div className="summary-row">
                <span className="summary-label">
                  {t('toolCards.codeReview.evidenceStatus')}
                </span>
                <span className="summary-value">
                  {t(EVIDENCE_STATUS_LABEL_KEYS[reviewData.evidence_status])}
                </span>
              </div>
            )}
            {review_mode && (
              <div className="summary-row">
                <span className="summary-label">{t('shared:modes.review')}</span>
                <span className="summary-value">{t(`toolCards.codeReview.reviewModes.${review_mode}`, { defaultValue: review_mode })}</span>
              </div>
            )}
            {review_scope && (
              <div className="summary-row summary-row--full">
                <span className="summary-label">{t('toolCards.codeReview.reviewScope')}</span>
                <span className="summary-value">{review_scope}</span>
              </div>
            )}
            {reportSections.executiveSummary.length > 0 && (
              <div className="summary-row summary-row--full">
                <span className="summary-label">
                  {t('toolCards.codeReview.sections.summary')}
                </span>
                <span className="summary-value">
                  {reportSections.executiveSummary.join(' ')}
                </span>
              </div>
            )}
            {summary.confidence_note && (
              <div className="summary-row summary-row--full">
                <span className="summary-label">{t('toolCards.codeReview.contextLimitations')}</span>
                <span className="summary-value note">{summary.confidence_note}</span>
              </div>
            )}
          </div>
        </div>

        {issues.length > 0 && (
          <ReviewReportSection
            title={t('toolCards.codeReview.issuesCount', { count: issues.length })}
            summary={formatIssueStats(reportSections.issueStats, t)}
            expanded={issuesExpanded}
            onToggle={handleToggleReportSection('issues')}
          >
            <div className="issues-list" data-openbitfun-component="code-review-tool-card" data-openbitfun-part="issues">
              {issues.map((issue, index) => (
                (() => {
                  const coverageSource = getCoverageSourceLabel(issue.source_reviewer, t);
                  return (
                    <div data-openbitfun-component="code-review-tool-card" data-openbitfun-part="issue"
                      key={index}
                      id={`review-issue-${index}`}
                      className={`review-issue-item severity-${getSeverityClass(issue.severity ?? 'info')}`}
                    >
                      <div className="issue-header">
                        <div className="issue-left">
                          {getSeverityIcon(issue.severity ?? 'info')}
                          {issue.category && (
                            <span className="issue-category">[{issue.category}]</span>
                          )}
                          {coverageSource && (
                            <span className="issue-source">{coverageSource}</span>
                          )}
                          {issue.file && (
                            <OverflowText className="issue-location">
                              {issue.file}{issue.line ? `:${issue.line}` : ''}
                            </OverflowText>
                          )}
                        </div>
                        <span className="issue-certainty">
                          {t(`toolCards.codeReview.certainties.${issue.certainty ?? 'possible'}`)}
                        </span>
                      </div>
                      <div className="issue-title">{issue.title}</div>
                      <div className="issue-description">{issue.description}</div>
                      {issue.validation_note && (
                        <div className="issue-validation-note">
                          {issue.validation_note}
                        </div>
                      )}
                      {issue.suggestion && (
                        <div className="issue-suggestion">
                          <span className="suggestion-label">{t('toolCards.codeReview.suggestion')}:</span>
                          <span className="suggestion-text">{issue.suggestion}</span>
                        </div>
                      )}
                    </div>
                  );
                })()
              ))}
            </div>
          </ReviewReportSection>
        )}

        {remediationItemCount > 0 && (
          <ReviewReportSection
            title={t('toolCards.codeReview.sections.remediation')}
            summary={t('toolCards.codeReview.sectionItemCount', {
              count: remediationItemCount,
            })}
            expanded={remediationExpanded}
            onToggle={handleToggleReportSection('remediation')}
          >
            <div className="review-remediation" data-openbitfun-component="code-review-tool-card" data-openbitfun-part="remediation">
            <div className="remediation-header-row">
              <div>
                <div className="remediation-header">
                  {t('toolCards.codeReview.remediationPlan')}
                </div>
              </div>
            </div>
            {review_mode === 'deep' ? (
              <div className="review-remediation__groups" data-openbitfun-component="code-review-tool-card" data-openbitfun-part="groups">
                {reportSections.remediationGroups.map((group) => {
                  const groupTitle = getRemediationGroupTitle(group.id, t);

                  // Render needs_decision group with structured decision context
                  if (group.id === 'needs_decision') {
                    const rawEntries = reviewData?.report_sections?.remediation_groups?.needs_decision;
                    return (
                      <div data-openbitfun-component="code-review-tool-card" data-openbitfun-part="group" key={group.id} id={`review-remediation-group-${group.id}`} className="review-report-group">
                        <div className="review-report-group__title">{groupTitle}</div>
                        <ul className="review-report-group__list">
                          {group.items.map((_, index) => {
                            const raw = rawEntries?.[index];
                            const ctx = raw ? normalizeDecisionEntry(raw as string | DecisionContext) : null;
                            return (
                              <li data-openbitfun-component="code-review-tool-card" data-openbitfun-part="decision" key={`${group.id}-${index}`} id={`review-remediation-${group.id}-${index}`}>
                                {ctx && ctx.question !== ctx.plan ? (
                                  <div className="review-decision-item">
                                    <div className="review-decision-item__question">{ctx.question}</div>
                                    {ctx.options && ctx.options.length > 0 && (
                                      <ul className="review-decision-item__options">
                                        {ctx.options.map((opt, oi) => (
                                          <li key={oi} className={oi === ctx.recommendation ? 'is-recommended' : ''}>
                                            {opt}{oi === ctx.recommendation ? ` (${t('toolCards.codeReview.remediationActions.recommended')})` : ''}
                                          </li>
                                        ))}
                                      </ul>
                                    )}
                                    {ctx.tradeoffs && (
                                      <div className="review-decision-item__tradeoffs">{ctx.tradeoffs}</div>
                                    )}
                                  </div>
                                ) : (
                                  group.items[index]
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    );
                  }

                  // Default rendering for other groups
                  return (
                    <div data-openbitfun-component="code-review-tool-card" data-openbitfun-part="group" key={group.id} id={`review-remediation-group-${group.id}`} className="review-report-group">
                      <div className="review-report-group__title">{groupTitle}</div>
                      <ul className="review-report-group__list">
                        {group.items.map((item, index) => (
                          <li key={`${group.id}-${index}`} id={`review-remediation-${group.id}-${index}`}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="remediation-list" data-openbitfun-component="code-review-tool-card" data-openbitfun-part="remediationList">
                {remediationItems.map((item) => {
                const issue = item.issue;
                const expanded = expandedRemediationIds.has(item.id);
                const location = issue?.file
                  ? `${issue.file}${issue.line ? `:${issue.line}` : ''}`
                  : null;

                return (
                  <div data-openbitfun-component="code-review-tool-card" data-openbitfun-part="remediationItem"
                    key={item.id}
                    className="remediation-item"
                  >
                    <div className="remediation-item__topline">
                      <span className="remediation-item__label">
                        <span className="remediation-index">{item.index + 1}</span>
                        <span>{item.plan}</span>
                      </span>
                      <button
                        type="button"
                        className="remediation-item__expand"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleToggleRemediationDetails(item.id);
                        }}
                        aria-expanded={expanded}
                      >
                        {expanded ? <Icon name="chevron-up" size="sm" /> : <Icon name="chevron-down" size="sm" />}
                        <span>
                          {expanded
                            ? t('toolCards.codeReview.remediationActions.collapsePlan')
                            : t('toolCards.codeReview.remediationActions.expandPlan')}
                        </span>
                      </button>
                    </div>
                    {expanded && (
                      <div className="remediation-item__details">
                        {issue ? (
                          <>
                            <div className="remediation-detail-row">
                              <span>{t('toolCards.codeReview.remediationActions.relatedIssue')}</span>
                              <strong>{issue.title}</strong>
                            </div>
                            <div className="remediation-detail-grid">
                              {issue.severity && (
                                <div>
                                  <span>{t('toolCards.codeReview.remediationActions.severity')}</span>
                                  <strong><OverflowText>{t(`toolCards.codeReview.severities.${issue.severity}`, { defaultValue: issue.severity })}</OverflowText></strong>
                                </div>
                              )}
                              {issue.certainty && (
                                <div>
                                  <span>{t('toolCards.codeReview.remediationActions.certainty')}</span>
                                  <strong><OverflowText>{t(`toolCards.codeReview.certainties.${issue.certainty}`, { defaultValue: issue.certainty })}</OverflowText></strong>
                                </div>
                              )}
                              {location && (
                                <div>
                                  <span>{t('toolCards.codeReview.remediationActions.location')}</span>
                                  <strong><OverflowText>{location}</OverflowText></strong>
                                </div>
                              )}
                            </div>
                            {issue.description && (
                              <p>{issue.description}</p>
                            )}
                            {issue.suggestion && (
                              <p className="remediation-item__suggestion">
                                <span>{t('toolCards.codeReview.suggestion')}:</span>
                                {issue.suggestion}
                              </p>
                            )}
                            {issue.validation_note && (
                              <p className="remediation-item__validation">{issue.validation_note}</p>
                            )}
                          </>
                        ) : (
                          <p>
                            {t('toolCards.codeReview.remediationActions.noRelatedIssue')}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              </div>
            )}
            {/* Review remediation actions are rendered as the shared floating bar at
                the bottom of the BtwSessionPanel. */}
            </div>
          </ReviewReportSection>
        )}

        {strengthItemCount > 0 && (
          <ReviewReportSection
            title={t('toolCards.codeReview.sections.strengths')}
            summary={t('toolCards.codeReview.sectionItemCount', {
              count: strengthItemCount,
            })}
            expanded={strengthsExpanded}
            onToggle={handleToggleReportSection('strengths')}
          >
            <div className="review-positive" data-openbitfun-component="code-review-tool-card" data-openbitfun-part="positive">
              {renderReportGroupList(
                reportSections.strengthGroups,
                (id) => getStrengthGroupTitle(id, t),
              )}
            </div>
          </ReviewReportSection>
        )}

        {reportSections.coverageNotes.length > 0 && (
          <ReviewReportSection
            title={t('toolCards.codeReview.sections.coverage')}
            summary={t('toolCards.codeReview.sectionItemCount', {
              count: reportSections.coverageNotes.length,
            })}
            expanded={coverageExpanded}
            onToggle={handleToggleReportSection('coverage')}
          >
            <ul className="review-report-group__list">
              {reportSections.coverageNotes.map((note, index) => (
                <li key={index}>{note}</li>
              ))}
            </ul>
          </ReviewReportSection>
        )}
      </div>
    );
  }, [
    expandedRemediationIds,
    expandedReportSectionIds,
    handleToggleRemediationDetails,
    handleToggleReportSection,
    remediationItems,
    reviewData,
    sessionRunManifest,
    t,
  ]);

  const normalizedStatus = status === 'analyzing' ? 'running' : status;

  return (
    <div data-openbitfun-component="code-review-tool-card" data-openbitfun-part="root" ref={cardRootRef} data-tool-card-id={toolId ?? ''}>
      <ProminentToolCard
        status={normalizedStatus as 'pending' | 'preparing' | 'streaming' | 'running' | 'completed' | 'error' | 'cancelled'}
        isExpanded={isExpanded}
        onToggle={handleCardClick}
        className="code-review-card"
        summary={renderSummary()}
        allowExpandedWhenFailed
        expandedContent={expandedContent ?? undefined}
      />
    </div>
  );
});
