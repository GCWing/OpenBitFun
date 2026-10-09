import { Button, IconButton } from '@openbitfun/ui';
import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tooltip, Icon } from '@openbitfun/ui';
import { notificationService } from '@/shared/notification-system';
import { createMarkdownEditorTab } from '@/shared/utils/tabUtils';
import { downloadMarkdownInBrowser } from '@/shared/utils/browserDownload';
import {
  formatCodeReviewReportMarkdown,
  type CodeReviewReportData,
  type CodeReviewReportMarkdownLabels,
} from '../utils/codeReviewReport';
import type { ReviewTeamRunManifest } from '@/shared/services/reviewTeamService';

interface CodeReviewReportExportActionsProps {
  reviewData: CodeReviewReportData | null | undefined;
  runManifest?: ReviewTeamRunManifest;
  actions?: CodeReviewReportExportAction[];
  variant?: 'icon' | 'footer';
}

type CodeReviewReportExportAction = 'copy' | 'open' | 'save';

const DEFAULT_EXPORT_ACTIONS: CodeReviewReportExportAction[] = ['copy', 'open', 'save'];

function timestampForFileName(): string {
  return new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);
}

function isTauriDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
}

export const CodeReviewReportExportActions: React.FC<CodeReviewReportExportActionsProps> = ({
  reviewData,
  runManifest,
  actions = DEFAULT_EXPORT_ACTIONS,
  variant = 'icon',
}) => {
  const { t } = useTranslation('flow-chat');
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const visibleActions = useMemo(() => new Set(actions), [actions]);

  const markdownLabels = useMemo<Partial<CodeReviewReportMarkdownLabels>>(() => ({
    titleStandard: t('toolCards.codeReview.report.titleStandard'),
    titleDeep: t('toolCards.codeReview.report.titleDeep'),
    executiveSummary: t('toolCards.codeReview.sections.summary'),
    reviewDecision: t('toolCards.codeReview.report.reviewDecision'),
    riskLevel: t('toolCards.codeReview.riskLevel'),
    recommendedAction: t('toolCards.codeReview.recommendedAction'),
    evidenceStatus: t('toolCards.codeReview.evidenceStatus'),
    scope: t('toolCards.codeReview.reviewScope'),
    issues: t('toolCards.codeReview.sections.issues'),
    noIssues: t('toolCards.codeReview.report.noIssues'),
    remediationPlan: t('toolCards.codeReview.sections.remediation'),
    strengths: t('toolCards.codeReview.sections.strengths'),
    reliabilitySignals: t('toolCards.codeReview.report.reliabilitySignals'),
    coverageNotes: t('toolCards.codeReview.sections.coverage'),
    validation: t('toolCards.codeReview.report.validation'),
    suggestion: t('toolCards.codeReview.suggestion'),
    source: t('toolCards.codeReview.report.source'),
    noItems: t('toolCards.codeReview.report.noItems'),
    coverageSourceLabels: {
      businessLogic: t('toolCards.codeReview.coverageSources.businessLogic'),
      performance: t('toolCards.codeReview.coverageSources.performance'),
      security: t('toolCards.codeReview.coverageSources.security'),
      architecture: t('toolCards.codeReview.coverageSources.architecture'),
      frontend: t('toolCards.codeReview.coverageSources.frontend'),
      qualityGate: t('toolCards.codeReview.coverageSources.qualityGate'),
      focusedCheck: t('toolCards.codeReview.coverageSources.focusedCheck'),
    },
    groupTitles: {
      must_fix: t('toolCards.codeReview.groups.must_fix'),
      should_improve: t('toolCards.codeReview.groups.should_improve'),
      needs_decision: t('toolCards.codeReview.groups.needs_decision'),
      verification: t('toolCards.codeReview.groups.verification'),
      architecture: t('toolCards.codeReview.groups.architecture'),
      maintainability: t('toolCards.codeReview.groups.maintainability'),
      tests: t('toolCards.codeReview.groups.tests'),
      security: t('toolCards.codeReview.groups.security'),
      performance: t('toolCards.codeReview.groups.performance'),
      user_experience: t('toolCards.codeReview.groups.user_experience'),
      other: t('toolCards.codeReview.groups.other'),
    },
    reliabilityNoticeLabels: {
      context_pressure: t('toolCards.codeReview.reliabilityStatus.context_pressure.label'),
      compression_preserved: t('toolCards.codeReview.reliabilityStatus.compression_preserved.label'),
      cache_hit: t('toolCards.codeReview.reliabilityStatus.cache_hit.label'),
      cache_miss: t('toolCards.codeReview.reliabilityStatus.cache_miss.label'),
      concurrency_limited: t('toolCards.codeReview.reliabilityStatus.concurrency_limited.label'),
      partial_reviewer: t('toolCards.codeReview.reliabilityStatus.partial_reviewer.label'),
      target_evidence_limited: t('toolCards.codeReview.reliabilityStatus.target_evidence_limited.label'),
      reduced_scope: t('toolCards.codeReview.reliabilityStatus.reduced_scope.label'),
      retry_guidance: t('toolCards.codeReview.reliabilityStatus.retry_guidance.label'),
      skipped_reviewers: t('toolCards.codeReview.reliabilityStatus.skipped_reviewers.label'),
      token_budget_limited: t('toolCards.codeReview.reliabilityStatus.token_budget_limited.label'),
      user_decision: t('toolCards.codeReview.reliabilityStatus.user_decision.label'),
    },
  }), [t]);

  const markdown = useMemo(
    () => reviewData ? formatCodeReviewReportMarkdown(
      reviewData,
      markdownLabels,
      { runManifest: reviewData.review_mode === 'deep' ? runManifest : undefined },
    ) : '',
    [markdownLabels, reviewData, runManifest],
  );

  const fileName = useMemo(() => {
    const prefix = t('toolCards.codeReview.export.fileNamePrefix');
    return `${prefix}_${timestampForFileName()}.md`;
  }, [t]);

  const handleCopy = useCallback(async (event: React.MouseEvent) => {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
      notificationService.success(t('toolCards.codeReview.export.copySuccess'));
    } catch {
      notificationService.error(t('toolCards.codeReview.export.copyFailed'));
    }
  }, [markdown, t]);

  const handleOpenInEditor = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    try {
      createMarkdownEditorTab(
        t('toolCards.codeReview.export.editorTitle'),
        markdown,
        undefined,
        undefined,
        'agent',
      );
    } catch {
      notificationService.error(t('toolCards.codeReview.export.openFailed'));
    }
  }, [markdown, t]);

  const handleSave = useCallback(async (event: React.MouseEvent) => {
    event.stopPropagation();
    setSaving(true);
    try {
      if (isTauriDesktop()) {
        const [{ save }, { writeFile }] = await Promise.all([
          import('@tauri-apps/plugin-dialog'),
          import('@tauri-apps/plugin-fs'),
        ]);
        const filePath = await save({
          title: t('toolCards.codeReview.export.saveDialogTitle'),
          defaultPath: fileName,
          filters: [{
            name: 'Markdown',
            extensions: ['md'],
          }],
        });
        if (!filePath) {
          return;
        }
        await writeFile(filePath, new TextEncoder().encode(markdown));
      } else {
        downloadMarkdownInBrowser(fileName, markdown);
      }
      notificationService.success(t('toolCards.codeReview.export.saveSuccess'));
    } catch {
      notificationService.error(t('toolCards.codeReview.export.saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [fileName, markdown, t]);

  if (variant === 'footer') {
    return (
      <div
        className="code-review-report-actions code-review-report-actions--footer"
        onClick={(event) => event.stopPropagation()}
      >
        {visibleActions.has('open') && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            leadingIcon={<Icon name="arrow-up-right" size="md" />}
            onClick={handleOpenInEditor}
            disabled={!reviewData}
          >
            {t('toolCards.codeReview.export.openMarkdown')}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="code-review-report-actions" onClick={(event) => event.stopPropagation()}>
      {visibleActions.has('copy') && (
        <Tooltip content={t('toolCards.codeReview.export.copyMarkdown')} placement="top">
          <IconButton
            type="button"
            className="code-review-report-actions__button"
            size="sm"
            variant="quiet"
            onClick={handleCopy}
            disabled={!reviewData}
            aria-label={t('toolCards.codeReview.export.copyMarkdown')}
            icon={copied ? <Icon name="check-line" size="sm" /> : <Icon name="duplicate" size="sm" />}
          />
        </Tooltip>
      )}
      {visibleActions.has('open') && (
        <Tooltip content={t('toolCards.codeReview.export.openMarkdown')} placement="top">
          <IconButton
            type="button"
            className="code-review-report-actions__button"
            size="sm"
            variant="quiet"
            onClick={handleOpenInEditor}
            disabled={!reviewData}
            aria-label={t('toolCards.codeReview.export.openMarkdown')}
            icon={<Icon name="arrow-up-right" size="sm" />}
          />
        </Tooltip>
      )}
      {visibleActions.has('save') && (
        <Tooltip content={t('toolCards.codeReview.export.saveMarkdown')} placement="top">
          <IconButton
            type="button"
            className="code-review-report-actions__button"
            size="sm"
            variant="quiet"
            onClick={handleSave}
            disabled={saving || !reviewData}
            aria-label={t('toolCards.codeReview.export.saveMarkdown')}
            icon={saving ? <Icon name="progress-25" className="animate-spin" size="sm" /> : <Icon name="arrow-down" size="sm" />}
          />
        </Tooltip>
      )}
    </div>
  );
};

CodeReviewReportExportActions.displayName = 'CodeReviewReportExportActions';
