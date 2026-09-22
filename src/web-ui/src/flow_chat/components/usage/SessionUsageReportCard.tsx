import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Checkbox, OverflowText, Button, Card, Icon, IconButton, Tooltip } from '@openbitfun/ui';
import { useTranslation } from 'react-i18next';
import { Activity, AlertTriangle, Database, FileText, Wrench, type LucideProps } from 'lucide-react';
import { MarkdownRenderer } from '@/infrastructure/markdown';
import { ToolProcessingDots } from '@openbitfun/ui/flow-chat';
import type { SessionUsageReport } from '@/infrastructure/api/service-api/SessionAPI';
import { copyTextToClipboard } from '@/shared/utils/textSelection';
import {
  buildSessionUsageExportMarkdown,
  formatHitRateSuffix,
  formatUsageDuration,
  formatUsageNumber,
  formatTokenCount,
  formatUsageTimestamp,
  getCoverageLabel,
  getCoverageTone,
  getFileScopeHelp,
  getFileSummaryLabel,
  getUsageDisplayPathLabel,
  getModelHelp,
  getModelLabel,
  getRedactedLabel,
  getTopFiles,
  getTopModels,
  getTopTools,
  getToolCategoryLabel,
  getUsageExportRedactPathsPreference,
  getUsageFileNameFromPath,
  setUsageExportRedactPathsPreference,
  subscribeUsageExportRedactPathsPreference,
} from './usageReportUtils';
import type { SessionUsagePanelTab } from './sessionUsagePanelTypes';
import './SessionUsageReportCard.scss';

const SUMMARY_LIST_LIMIT = 3;

const UsageClockIcon: React.FC<LucideProps> = ({ className, size = 18, style }) => (
  <Icon
    name="clock"
    size="lg"
    className={className}
    style={{ width: size, height: size, ...style }}
  />
);

interface SessionUsageReportCardProps {
  report?: SessionUsageReport;
  markdown?: string;
  generatedAt?: number;
  isLoading?: boolean;
  compact?: boolean;
  onOpenDetails?: (report: SessionUsageReport, initialTab?: SessionUsagePanelTab) => void;
}

const UsageMiniListFilePathLabel = React.forwardRef<HTMLSpanElement, { pathLabel: string }>(
  function UsageMiniListFilePathLabel({ pathLabel }, ref) {
    return (
      <OverflowText data-openbitfun-component="session-usage-report-card" data-openbitfun-part="listRow" ref={ref} className="session-usage-report-card__mini-list-file-name">
        {getUsageFileNameFromPath(pathLabel)}
      </OverflowText>
    );
  }
);

export const SessionUsageReportCard: React.FC<SessionUsageReportCardProps> = ({
  report,
  markdown = '',
  generatedAt,
  isLoading = false,
  compact = false,
  onOpenDetails,
}) => {
  const { t } = useTranslation('flow-chat');
  const [copied, setCopied] = useState(false);
  const [loadingStep, setLoadingStep] = useState(0);
  const [redactExportPaths, setRedactExportPaths] = useState(getUsageExportRedactPathsPreference);

  const handleCopy = useCallback(async (event: React.MouseEvent) => {
    event.stopPropagation();
    const didCopy = await copyTextToClipboard(buildSessionUsageExportMarkdown(markdown, report, {
      redactPaths: redactExportPaths,
      t,
    }));
    if (didCopy) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } else {
      setCopied(false);
    }
  }, [markdown, redactExportPaths, report, t]);

  const handleRedactExportPathsChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setUsageExportRedactPathsPreference(event.target.checked);
  }, []);

  const handleOpenDetails = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    if (report) {
      onOpenDetails?.(report);
    }
  }, [onOpenDetails, report]);

  const handleOpenSectionDetails = useCallback((initialTab: SessionUsagePanelTab) => (event: React.MouseEvent) => {
    event.stopPropagation();
    if (report) {
      onOpenDetails?.(report, initialTab);
    }
  }, [onOpenDetails, report]);

  const topModels = useMemo(() => report ? getTopModels(report, SUMMARY_LIST_LIMIT) : [], [report]);
  const topTools = useMemo(() => report ? getTopTools(report, SUMMARY_LIST_LIMIT) : [], [report]);
  const topFiles = useMemo(() => report ? getTopFiles(report, SUMMARY_LIST_LIMIT) : [], [report]);
  const loadingHints = useMemo(() => [
    t('usage.loading.steps.collecting'),
    t('usage.loading.steps.tokens'),
    t('usage.loading.steps.safety'),
  ], [t]);
  const compactClassName = compact ? ' session-usage-report-card--compact' : '';

  useEffect(() => {
    if (!isLoading || loadingHints.length <= 1) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      setLoadingStep(step => (step + 1) % loadingHints.length);
    }, 1600);

    return () => window.clearInterval(timer);
  }, [isLoading, loadingHints.length]);

  useEffect(() => (
    subscribeUsageExportRedactPathsPreference(setRedactExportPaths)
  ), []);

  if (isLoading) {
    return (
      <div data-openbitfun-component="session-usage-report-card" data-openbitfun-part="loading" data-openbitfun-state="loading" className={`session-usage-report-card session-usage-report-card--loading${compactClassName}`} aria-live="polite">
        <div className="session-usage-report-card__loading-main">
          <ToolProcessingDots className="session-usage-report-card__loading-dots" size={12} />
          <div>
            <h3 className="session-usage-report-card__loading-title">{t('usage.loading.title')}</h3>
            <p className="session-usage-report-card__loading-description">{t('usage.loading.description')}</p>
          </div>
        </div>
        <div className="session-usage-report-card__loading-step">
          {loadingHints[loadingStep] ?? loadingHints[0]}
        </div>
      </div>
    );
  }

  if (!report) {
    return (
      <div data-openbitfun-component="session-usage-report-card" data-openbitfun-part="fallback" data-openbitfun-state="fallback" className={`session-usage-report-card session-usage-report-card--fallback${compactClassName}`}>
        <div className="session-usage-report-card__fallback-actions" data-openbitfun-component="session-usage-report-card" data-openbitfun-part="actions">
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
      </div>
    );
  }

  const coverageTone = getCoverageTone(report.coverage.level);
  const tokenTotal = report.tokens.totalTokens;
  const cachedTokenText = report.tokens.cacheCoverage === 'unavailable'
    ? t('usage.status.cacheNotReported')
    : `${formatTokenCount(report.tokens.cachedTokens, t)}${formatHitRateSuffix(report.tokens.cacheHitRate, t)}`;
  const cachedTokenHelp = report.tokens.cacheCoverage === 'unavailable'
    ? t('usage.help.cachedTokens')
    : report.tokens.cacheCoverage === 'partial'
      ? t('usage.help.cachedTokensPartial')
    : undefined;
  const fileMetricHelp = getFileScopeHelp(report, t);
  const workspacePathLabel = getUsageDisplayPathLabel(report.workspace.pathLabel, t, {
    redactPaths: redactExportPaths,
  });
  const coverageBadgeClassName =
    `session-usage-report-card__coverage session-usage-report-card__coverage--${coverageTone}` +
    (report.coverage.level !== 'complete' ? ' session-usage-report-card__coverage--hint' : '');

  if (compact) {
    const primaryModel = topModels[0];
    const primaryModelSource = primaryModel?.modelIdSource
      ?? (primaryModel?.modelId === 'unknown_model' ? 'legacy_missing' : undefined);
    const primaryModelLabel = primaryModel
      ? getModelLabel(primaryModel.modelId, t, primaryModelSource)
      : t('usage.status.modelNotRecorded');
    const primaryModelHelp = primaryModel
      ? getModelHelp(primaryModelSource, t, primaryModel.modelId)
      : undefined;
    const compactMetrics = [
      {
        key: 'wall',
        label: t('usage.metrics.wall'),
        value: formatUsageDuration(report.time.wallTimeMs, t),
        icon: <Icon name="clock" size="sm" />,
        help: t('usage.help.wall'),
      },
      {
        key: 'active',
        label: t('usage.metrics.active'),
        value: formatUsageDuration(report.time.activeTurnMs, t),
        icon: <Icon glyph={Activity} size="sm" />,
        help: t('usage.help.active'),
      },
      {
        key: 'files',
        label: t('usage.metrics.files'),
        value: getFileSummaryLabel(report, t),
        icon: <Icon name="files" size="sm" />,
        help: fileMetricHelp,
      },
      {
        key: 'errors',
        label: t('usage.metrics.errors'),
        value: formatUsageNumber(report.errors.totalErrors, t),
        icon: <Icon glyph={AlertTriangle} size="sm" />,
        tone: report.errors.totalErrors > 0 ? 'warning' : undefined,
        help: t('usage.help.errors'),
      },
    ];
    const showAllTools = buildShowAllAction({
      totalCount: report.tools.length,
      visibleCount: topTools.length,
      sectionLabel: t('usage.sections.tools'),
      t,
      onClick: onOpenDetails ? handleOpenSectionDetails('tools') : undefined,
    });

    return (
      <div
        data-openbitfun-component="session-usage-report-card"
        data-openbitfun-part="root"
        className="session-usage-report-card session-usage-report-card--compact"
        data-report-id={report.reportId}
      >
        <div className="session-usage-report-card__header" data-openbitfun-component="session-usage-report-card" data-openbitfun-part="header">
          <div className="session-usage-report-card__title-block" data-openbitfun-component="session-usage-report-card" data-openbitfun-part="title">
            <div className="session-usage-report-card__meta">
              <OverflowText className="session-usage-report-card__compact-meta-item">{formatUsageTimestamp(generatedAt ?? report.generatedAt, t)}</OverflowText>
              <OverflowText className="session-usage-report-card__compact-meta-item">{t('usage.card.turns', { count: report.scope.turnCount })}</OverflowText>
            </div>
            <div className="session-usage-report-card__compact-workspace">
              <Icon name="folder" size="sm" />
              <OverflowText title={workspacePathLabel}>{workspacePathLabel}</OverflowText>
            </div>
          </div>
          <div className="session-usage-report-card__actions" data-openbitfun-component="session-usage-report-card" data-openbitfun-part="actions">
            <Tooltip content={copied ? t('usage.actions.copied') : t('usage.actions.copyMarkdown')}>
              <IconButton
                size="sm"
                onClick={handleCopy}
                data-testid="session-usage-copy"
                aria-label={copied ? t('usage.actions.copied') : t('usage.actions.copyMarkdown')}
                icon={<Icon name={copied ? 'check-line' : 'duplicate'} size="sm" />}
              />
            </Tooltip>
            <Tooltip content={t('usage.actions.openDetails')}>
              <Button
                type="button"
                variant="text"
                size="sm"
                trailingIcon={<Icon name="chevron-right" size="sm" />}
                onClick={handleOpenDetails}
                disabled={!onOpenDetails}
                data-testid="session-usage-details"
                aria-label={t('usage.actions.openDetails')}
              >
                {t('usage.actions.viewDetails')}
              </Button>
            </Tooltip>
          </div>
        </div>

        <div className="session-usage-report-card__compact-overview">
          <Card appearance="subtle" padding="md">
            <section className="session-usage-report-card__compact-token" data-openbitfun-component="session-usage-report-card" data-openbitfun-part="metric">
              <div className="session-usage-report-card__compact-token-label">
                <Icon glyph={Database} size="sm" />
                <span>{t('usage.card.tokenUsage')}</span>
              </div>
              <div className="session-usage-report-card__compact-token-value">
                {formatTokenCount(tokenTotal, t)}
              </div>
              <div className="session-usage-report-card__compact-model">
                {primaryModelHelp ? (
                  <Tooltip content={primaryModelHelp}>
                    <span className="session-usage-report-card__compact-model-name session-usage-report-card__compact-model-name--help">
                      {primaryModelLabel}
                    </span>
                  </Tooltip>
                ) : (
                  <span className="session-usage-report-card__compact-model-name">{primaryModelLabel}</span>
                )}
                <span className="session-usage-report-card__compact-model-calls">{t('usage.card.calls', { count: primaryModel?.callCount ?? 0 })}</span>
              </div>
              <div className="session-usage-report-card__compact-cache">
                <span className="session-usage-report-card__compact-cache-label">{t('usage.metrics.cached')}</span>
                <UsageMetricValue value={cachedTokenText} help={cachedTokenHelp} />
              </div>
            </section>
          </Card>

          <div className="session-usage-report-card__compact-metrics" data-openbitfun-component="session-usage-report-card" data-openbitfun-part="metrics">
            {compactMetrics.map(metric => (
              <Card appearance="subtle" padding="sm" radius="sm" key={metric.key}>
                <div
                  data-openbitfun-component="session-usage-report-card"
                  data-openbitfun-part="metric"
                  className={`session-usage-report-card__compact-metric${metric.tone ? ` session-usage-report-card__compact-metric--${metric.tone}` : ''}`}
                >
                  <div className="session-usage-report-card__compact-metric-label">
                    {metric.icon}
                    <span>{metric.label}</span>
                  </div>
                  <UsageMetricValue value={metric.value} help={metric.help} />
                </div>
              </Card>
            ))}
          </div>
        </div>

        <section className="session-usage-report-card__compact-tools" data-openbitfun-component="session-usage-report-card" data-openbitfun-part="lists">
          <div className="session-usage-report-card__compact-tools-header">
            <h3>{t('usage.sections.tools')}</h3>
            {showAllTools && (
              <Tooltip content={showAllTools.ariaLabel}>
                <Button
                  type="button"
                  variant="text"
                  size="sm"
                  trailingIcon={<Icon name="chevron-right" size="sm" aria-hidden />}
                  onClick={showAllTools.onClick}
                  data-testid="session-usage-tools-details"
                  aria-label={showAllTools.ariaLabel}
                >
                  {showAllTools.label}
                </Button>
              </Tooltip>
            )}
          </div>
          <div className="session-usage-report-card__compact-tool-list" data-openbitfun-component="session-usage-report-card" data-openbitfun-part="list">
            {topTools.length === 0 ? (
              <div className="session-usage-report-card__compact-tool-empty">
                {t('usage.empty.tools')}
              </div>
            ) : topTools.map(tool => (
              <div
                className="session-usage-report-card__compact-tool-row"
                data-openbitfun-component="session-usage-report-card"
                data-openbitfun-part="listRow"
                key={tool.toolName}
              >
                <span className="session-usage-report-card__compact-tool-icon" aria-hidden>
                  {renderCompactToolIcon(tool.toolName, tool.category)}
                </span>
                <OverflowText className="session-usage-report-card__compact-tool-name" title={tool.redacted ? getRedactedLabel(t) : tool.toolName}>
                  {tool.redacted ? getRedactedLabel(t) : tool.toolName}
                </OverflowText>
                <span className="session-usage-report-card__compact-tool-calls">
                  {t('usage.card.calls', { count: tool.callCount })}
                </span>
              </div>
            ))}
          </div>
        </section>

        <p className="session-usage-report-card__compact-disclaimer">
          {t('usage.card.dataDelayDisclaimer')}
        </p>
      </div>
    );
  }

  const metrics = [
    {
      key: 'wall',
      label: t('usage.metrics.wall'),
      value: formatUsageDuration(report.time.wallTimeMs, t),
      icon: UsageClockIcon,
      help: t('usage.help.wall'),
    },
    {
      key: 'active',
      label: t('usage.metrics.active'),
      value: formatUsageDuration(report.time.activeTurnMs, t),
      icon: Activity,
      help: t('usage.help.active'),
    },
    {
      key: 'tokens',
      label: t('usage.metrics.tokens'),
      value: formatTokenCount(tokenTotal, t),
      icon: Database,
    },
    {
      key: 'cached',
      label: t('usage.metrics.cached'),
      value: cachedTokenText,
      icon: Database,
      help: cachedTokenHelp,
    },
    {
      key: 'files',
      label: t('usage.metrics.files'),
      value: getFileSummaryLabel(report, t),
      icon: FileText,
      help: fileMetricHelp,
    },
    {
      key: 'errors',
      label: t('usage.metrics.errors'),
      value: formatUsageNumber(report.errors.totalErrors, t),
      icon: AlertTriangle,
      tone: report.errors.totalErrors > 0 ? 'warning' : undefined,
      help: t('usage.help.errors'),
    },
  ];

  return (
    <div data-openbitfun-component="session-usage-report-card" data-openbitfun-part="root" className={`session-usage-report-card${compactClassName}`} data-report-id={report.reportId}>
      <div className="session-usage-report-card__header" data-openbitfun-component="session-usage-report-card" data-openbitfun-part="header">
        <div className="session-usage-report-card__title-block" data-openbitfun-component="session-usage-report-card" data-openbitfun-part="title">
          <h3 className="session-usage-report-card__title">{t('usage.card.heading')}</h3>
          <div className="session-usage-report-card__meta">
            <OverflowText>{formatUsageTimestamp(generatedAt ?? report.generatedAt, t)}</OverflowText>
            <OverflowText>{t('usage.card.turns', { count: report.scope.turnCount })}</OverflowText>
            <OverflowText>{workspacePathLabel}</OverflowText>
          </div>
        </div>
        <div className="session-usage-report-card__actions" data-openbitfun-component="session-usage-report-card" data-openbitfun-part="actions">
          {report.coverage.level !== 'complete' ? (
            <Tooltip content={t('usage.coverage.partialNotice')} placement="top">
              <span className={coverageBadgeClassName}>
                {getCoverageLabel(report.coverage.level, t)}
              </span>
            </Tooltip>
          ) : (
            <span className={coverageBadgeClassName}>
              {getCoverageLabel(report.coverage.level, t)}
            </span>
          )}
          <div className="session-usage-report-card__header-actions">
            <Tooltip content={t('usage.export.redactPathsHelp')}>
              <Checkbox
                appearance="native"
                size="sm"
                className="session-usage-report-card__export-option"
                checked={redactExportPaths}
                onChange={handleRedactExportPathsChange}
                aria-label={t('usage.export.redactPaths')}
                label={<OverflowText>{t('usage.export.redactPaths')}</OverflowText>}
              />
            </Tooltip>
            <Tooltip content={copied ? t('usage.actions.copied') : t('usage.actions.copyMarkdown')}>
              <IconButton
                className="session-usage-report-card__copy-action"
                size="sm"
                onClick={handleCopy}
                aria-label={copied ? t('usage.actions.copied') : t('usage.actions.copyMarkdown')}
                icon={copied ? <Icon name="check-line" size="sm" /> : <Icon name="duplicate" size="sm" />}
              />
            </Tooltip>
            <Tooltip content={t('usage.actions.openDetails')}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                trailingIcon={<Icon name="chevron-right" aria-hidden />}
                onClick={handleOpenDetails}
                disabled={!onOpenDetails}
                aria-label={t('usage.actions.openDetails')}
              >
                {t('usage.actions.viewDetails')}
              </Button>
            </Tooltip>
          </div>
        </div>
      </div>

      <div className="session-usage-report-card__metrics" data-openbitfun-component="session-usage-report-card" data-openbitfun-part="metrics">
        {metrics.map(metric => {
          const Icon = metric.icon;
          return (
            <div data-openbitfun-component="session-usage-report-card" data-openbitfun-part="metric"
              className={`session-usage-report-card__metric${metric.tone ? ` session-usage-report-card__metric--${metric.tone}` : ''}`}
              key={metric.key}
            >
              <Icon size={14} aria-hidden />
              <OverflowText className="session-usage-report-card__metric-label">{metric.label}</OverflowText>
              <UsageMetricValue value={metric.value} help={metric.help} />
            </div>
          );
        })}
      </div>

      <div className="session-usage-report-card__lists" data-openbitfun-component="session-usage-report-card" data-openbitfun-part="lists">
        <UsageMiniList
          title={t('usage.sections.models')}
          showAll={buildShowAllAction({
            totalCount: report.models.length,
            visibleCount: topModels.length,
            sectionLabel: t('usage.sections.models'),
            t,
            onClick: onOpenDetails ? handleOpenSectionDetails('models') : undefined,
          })}
          items={topModels.map(model => {
            const source = model.modelIdSource ?? (model.modelId === 'unknown_model' ? 'legacy_missing' : undefined);
            const help = getModelHelp(source, t, model.modelId);
            const label = getModelLabel(model.modelId, t, source);
            const tokenValue = typeof model.totalTokens === 'number' && Number.isFinite(model.totalTokens)
              ? t('usage.card.tokens', { value: formatTokenCount(model.totalTokens, t) })
              : formatTokenCount(model.totalTokens, t);
            return {
              label: help ? { value: label, help } : label,
              value: tokenValue,
              detail: t('usage.card.calls', { count: model.callCount }),
            };
          })}
          emptyLabel={t('usage.empty.models')}
          emptyDescription={t('usage.empty.modelsDescription')}
        />
        <UsageMiniList
          title={t('usage.sections.tools')}
          showAll={buildShowAllAction({
            totalCount: report.tools.length,
            visibleCount: topTools.length,
            sectionLabel: t('usage.sections.tools'),
            t,
            onClick: onOpenDetails ? handleOpenSectionDetails('tools') : undefined,
          })}
          items={topTools.map(tool => ({
            label: tool.redacted ? getRedactedLabel(t) : tool.toolName,
            value: t('usage.card.calls', { count: tool.callCount }),
            detail: getToolCategoryLabel(tool.category, t),
          }))}
          emptyLabel={t('usage.empty.tools')}
          emptyDescription={t('usage.empty.toolsDescription')}
        />
        <UsageMiniList
          title={t('usage.sections.files')}
          showAll={buildShowAllAction({
            totalCount: report.files.files.length,
            visibleCount: topFiles.length,
            sectionLabel: t('usage.sections.files'),
            t,
            onClick: onOpenDetails ? handleOpenSectionDetails('files') : undefined,
          })}
          items={topFiles.map(file => {
            const pathLabel = getUsageDisplayPathLabel(file.pathLabel, t, {
              redactPaths: redactExportPaths,
              keepFileName: true,
            });
            return {
              label: file.redacted
                ? getRedactedLabel(t)
                : {
                  node: <UsageMiniListFilePathLabel pathLabel={file.pathLabel} />,
                  text: pathLabel,
                  help: pathLabel,
                },
              value: t('usage.card.operations', { count: file.operationCount }),
              detail: (
                <UsageFileChangeDetail
                  addedLines={file.addedLines}
                  deletedLines={file.deletedLines}
                  t={t}
                />
              ),
            };
          })}
          emptyLabel={getFileSummaryLabel(report, t)}
          emptyDescription={fileMetricHelp ?? t('usage.empty.filesDescription')}
        />
      </div>
    </div>
  );
};

function renderCompactToolIcon(toolName: string, category?: string) {
  const normalizedName = toolName.toLowerCase();
  const catalogIcon = (name: 'browser' | 'edit' | 'git' | 'search' | 'terminal') => (
    <Icon name={name} size="sm" />
  );

  if (
    normalizedName.includes('exec')
    || normalizedName.includes('bash')
    || normalizedName.includes('command')
    || normalizedName.includes('terminal')
    || category === 'shell'
  ) {
    return catalogIcon('terminal');
  }
  if (
    normalizedName.includes('grep')
    || normalizedName.includes('glob')
    || normalizedName.includes('search')
  ) {
    return catalogIcon('search');
  }
  if (
    normalizedName.includes('edit')
    || normalizedName.includes('write')
    || normalizedName.includes('patch')
  ) {
    return catalogIcon('edit');
  }
  if (normalizedName.includes('web')) {
    return catalogIcon('browser');
  }
  if (normalizedName.includes('git') || category === 'git') {
    return catalogIcon('git');
  }
  if (
    normalizedName.includes('read')
    || normalizedName.includes('file')
    || category === 'file'
  ) {
    return <Icon name="files" size="sm" />;
  }
  return <Icon glyph={Wrench} size="sm" />;
}

function UsageMetricValue({ value, help }: { value: string; help?: string }) {
  const node = (
    <span className={`session-usage-report-card__metric-value${help ? ' session-usage-report-card__metric-value--help' : ''}`}>
      {value}
    </span>
  );

  return help ? <Tooltip content={help}>{node}</Tooltip> : node;
}

type UsageMiniListLabel = string | {
  value: string;
  help?: string;
} | {
  node: React.ReactElement;
  text: string;
  help?: string;
};

type UsageMiniListShowAll = {
  label: string;
  ariaLabel: string;
  onClick: (event: React.MouseEvent) => void;
};

interface UsageMiniListProps {
  title: string;
  showAll?: UsageMiniListShowAll;
  items: Array<{
    label: UsageMiniListLabel;
    value: string;
    detail: React.ReactNode;
  }>;
  emptyLabel: string;
  emptyDescription?: string;
}

function buildShowAllAction({
  totalCount,
  visibleCount,
  sectionLabel,
  t,
  onClick,
}: {
  totalCount: number;
  visibleCount: number;
  sectionLabel: string;
  t: (key: string, options?: Record<string, unknown>) => string;
  onClick?: (event: React.MouseEvent) => void;
}): UsageMiniListShowAll | undefined {
  if (!onClick || totalCount <= visibleCount) {
    return undefined;
  }
  return {
    label: t('usage.actions.viewAllSection', { count: totalCount }),
    ariaLabel: t('usage.actions.openSectionDetails', { section: sectionLabel }),
    onClick,
  };
}

function getMiniListLabelText(label: UsageMiniListLabel): string {
  if (typeof label !== 'string' && 'node' in label) {
    return label.text;
  }
  return typeof label === 'string' ? label : label.value;
}

function UsageMiniListLabelView({ label }: { label: UsageMiniListLabel }) {
  if (typeof label !== 'string' && 'node' in label) {
    return label.help
      ? <Tooltip content={label.help}>{label.node}</Tooltip>
      : label.node;
  }

  const labelText = getMiniListLabelText(label);
  const node = (
    <OverflowText className={`session-usage-report-card__mini-list-label${typeof label !== 'string' && label.help ? ' session-usage-report-card__mini-list-label--help' : ''}`}>
      {labelText}
    </OverflowText>
  );

  return typeof label !== 'string' && label.help
    ? <Tooltip content={label.help}>{node}</Tooltip>
    : node;
}

function UsageFileChangeDetail({
  addedLines,
  deletedLines,
  t,
}: {
  addedLines?: number;
  deletedLines?: number;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  return (
    <span data-openbitfun-component="session-usage-report-card" data-openbitfun-part="fileStat"
      className="session-usage-report-card__file-stat"
      aria-label={`${t('usage.table.added')}: ${formatUsageNumber(addedLines, t)}, ${t('usage.table.deleted')}: ${formatUsageNumber(deletedLines, t)}`}
    >
      <span className="session-usage-report-card__file-stat--added">
        {formatSignedFileLineCount(addedLines, '+', t)}
      </span>
      <span className="session-usage-report-card__file-stat-separator">/</span>
      <span className="session-usage-report-card__file-stat--deleted">
        {formatSignedFileLineCount(deletedLines, '-', t)}
      </span>
    </span>
  );
}

function formatSignedFileLineCount(
  value: number | undefined,
  sign: '+' | '-',
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  const formatted = formatUsageNumber(value, t);
  return typeof value === 'number' && Number.isFinite(value) ? `${sign}${formatted}` : formatted;
}

function UsageMiniList({ title, showAll, items, emptyLabel, emptyDescription }: UsageMiniListProps) {
  return (
    <div data-openbitfun-component="session-usage-report-card" data-openbitfun-part="list" className="session-usage-report-card__mini-list">
      <div className="session-usage-report-card__mini-list-header">
        <div className="session-usage-report-card__mini-list-title">{title}</div>
        {showAll && (
          <Tooltip content={showAll.ariaLabel}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              trailingIcon={<Icon name="chevron-right" size="xs" aria-hidden />}
              onClick={showAll.onClick}
              aria-label={showAll.ariaLabel}
            >
              {showAll.label}
            </Button>
          </Tooltip>
        )}
      </div>
      {items.length === 0 ? (
        <div className="session-usage-report-card__mini-list-empty">
          <strong>{emptyLabel}</strong>
          {emptyDescription && <span>{emptyDescription}</span>}
        </div>
      ) : (
        items.map(item => (
          <div className="session-usage-report-card__mini-list-row" key={`${getMiniListLabelText(item.label)}-${item.value}`} data-openbitfun-component="session-usage-report-card" data-openbitfun-part="listRow">
            <UsageMiniListLabelView label={item.label} />
            <span className="session-usage-report-card__mini-list-value">{item.value}</span>
            <OverflowText className="session-usage-report-card__mini-list-detail">{item.detail}</OverflowText>
          </div>
        ))
      )}
    </div>
  );
}

SessionUsageReportCard.displayName = 'SessionUsageReportCard';
