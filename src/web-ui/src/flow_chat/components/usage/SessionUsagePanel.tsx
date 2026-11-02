import React, { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { MarkdownRenderer } from '@/infrastructure/markdown';
import { Empty, Icon, IconButton, LoadingState, PageHeader, ScrollArea, Tooltip } from '@openbitfun/ui';
import type { SessionUsageReport } from '@/infrastructure/api/service-api/SessionAPI';
import {
  buildSessionUsageExportMarkdown,
  isUnusedSession,
  getUsageFileNameFromPath,
  getUsageExportRedactPathsPreference,
  subscribeUsageExportRedactPathsPreference,
} from './usageReportUtils';
import { SessionUsageSummary } from './SessionUsageSummary';
import { SessionUsageEmptyState } from './SessionUsageEmptyState';
import { useContextPreview } from './useContextPreview';
import type { SessionUsagePanelTab } from './sessionUsagePanelTypes';
import './SessionUsagePanel.scss';

interface SessionUsagePanelProps {
  report?: SessionUsageReport;
  markdown?: string;
  sessionId?: string;
  sessionTitle?: string;
  isLoading?: boolean;
  error?: string;
  workspacePath?: string;
  workspaceId?: string;
  onTitleChange?: (title: string) => void;
  /** Accepted for saved panels from versions with detail tabs. */
  initialTab?: SessionUsagePanelTab;
}

export const SessionUsagePanel: React.FC<SessionUsagePanelProps> = ({
  report,
  markdown = '',
  sessionId,
  sessionTitle,
  isLoading = false,
  error,
  workspacePath,
  workspaceId,
  onTitleChange,
}) => {
  const { t } = useI18n('flow-chat');
  const reportTitle = t('usage.panel.report');
  const [copied, setCopied] = useState(false);
  const { previewLoading, previewContext: handlePreviewContext } = useContextPreview({
    sessionId: sessionId ?? report?.sessionId, reportSessionId: report?.sessionId,
    workspaceId: workspaceId ?? report?.workspace.workspaceId,
  });
  const [redactExportPaths, setRedactExportPaths] = useState(getUsageExportRedactPathsPreference);

  useEffect(() => (
    subscribeUsageExportRedactPathsPreference(setRedactExportPaths)
  ), []);

  useEffect(() => {
    onTitleChange?.(reportTitle);
  }, [onTitleChange, reportTitle]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(buildSessionUsageExportMarkdown(markdown, report, {
        redactPaths: redactExportPaths,
        t,
      }));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }, [markdown, redactExportPaths, report, t]);

  if (isLoading || error) {
    return (
      <div className="session-usage-panel session-usage-panel--status" data-openbitfun-product-component="session-usage-panel" data-openbitfun-product-part="root">
        {isLoading ? (
          <LoadingState role="status" aria-live="polite">{t('usage.loading.title')}</LoadingState>
        ) : (
          <Empty title={t('usage.panel.failed')} description={error} />
        )}
      </div>
    );
  }

  if (!report) {
    return (
      <ScrollArea data-openbitfun-product-component="session-usage-panel" data-openbitfun-product-part="root" data-openbitfun-state="fallback" className="session-usage-panel session-usage-panel--fallback">
        <div className="session-usage-panel__fallback-toolbar" data-openbitfun-product-component="session-usage-panel" data-openbitfun-product-part="header">
          <Tooltip content={copied ? t('usage.actions.copied') : t('usage.actions.copyMarkdown')}>
            <IconButton
              size="sm"
              onClick={handleCopy}
              aria-label={copied ? t('usage.actions.copied') : t('usage.actions.copyMarkdown')}
              icon={copied ? <Icon name="check-line" size="sm" /> : <Icon name="duplicate" size="sm" />}
            />
          </Tooltip>
        </div>
        <MarkdownRenderer content={markdown} />
      </ScrollArea>
    );
  }

  if (isUnusedSession(report)) {
    return (
      <div className="session-usage-panel session-usage-panel--status" data-openbitfun-product-component="session-usage-panel" data-openbitfun-product-part="root">
        <SessionUsageEmptyState />
      </div>
    );
  }

  const effectiveWorkspacePath = workspacePath ?? report.workspace.pathLabel;
  const workspaceName = effectiveWorkspacePath?.trim()
    ? getUsageFileNameFromPath(effectiveWorkspacePath.trim())
    : t('usage.unavailable');
  return (
    <ScrollArea data-openbitfun-product-component="session-usage-panel" data-openbitfun-product-part="root" className="session-usage-panel">
      <div className="session-usage-panel__intro">
        <p className="session-usage-panel__eyebrow">{reportTitle}</p>
        <PageHeader
          className="session-usage-panel__header"
          data-openbitfun-product-component="session-usage-panel"
          data-openbitfun-product-part="header"
          level={2}
          size="lg"
          title={<span className="session-usage-panel__title">{sessionTitle || reportTitle}</span>}
          action={
            <Tooltip content={copied ? t('usage.actions.copied') : t('usage.actions.copyMarkdown')}>
              <IconButton
                size="sm"
                onClick={handleCopy}
                aria-label={copied ? t('usage.actions.copied') : t('usage.actions.copyMarkdown')}
                icon={copied ? <Icon name="check-line" size="sm" /> : <Icon name="duplicate" size="sm" />}
              />
            </Tooltip>
          }
        />
      </div>

      <SessionUsageSummary report={report} workspaceName={workspaceName}
        onPreviewContext={handlePreviewContext} previewLoading={previewLoading} />
    </ScrollArea>
  );
};

SessionUsagePanel.displayName = 'SessionUsagePanel';
