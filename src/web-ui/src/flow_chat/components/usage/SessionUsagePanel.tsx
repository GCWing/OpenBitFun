import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, AlertTriangle, Database, FileText, GitCompare, ShieldCheck, Wrench, type LucideProps } from 'lucide-react';
import { MarkdownRenderer } from '@/infrastructure/markdown';
import { Checkbox, Button, OverflowText, TabGroup, Tooltip } from '@openbitfun/ui';
import { snapshotAPI } from '@/infrastructure/api';
import type { SessionUsageReport } from '@/infrastructure/api/service-api/SessionAPI';
import { globalEventBus } from '@/infrastructure/event-bus';
import { createDiffEditorTab } from '@/shared/utils/tabUtils';
import { createLogger } from '@/shared/utils/logger';
import {
  FLOWCHAT_FOCUS_ITEM_EVENT,
  type FlowChatFocusItemRequest,
} from '../../events/flowchatNavigation';
import {
  calculateShare,
  buildSessionUsageExportMarkdown,
  formatHitRatePercent,
  formatUsageDuration,
  formatUsageNumber,
  formatTokenCount,
  formatUsagePercent,
  formatUsageTimestamp,
  getAccountingLabel,
  getCoverageLabel,
  getCoverageTone,
  getFileScopeHelp,
  getFileScopeLabel,
  getFileSummaryLabel,
  getUsageDisplayPathLabel,
  getModelHelp,
  getModelLabel,
  getRedactedLabel,
  getSlowSpanHelp,
  getSlowSpanLabel,
  getToolCategoryLabel,
  getUsageExportRedactPathsPreference,
  setUsageExportRedactPathsPreference,
  subscribeUsageExportRedactPathsPreference,
  getDisplayTurnIndex,
} from './usageReportUtils';
import type { SessionUsagePanelTab } from './sessionUsagePanelTypes';
import { sessionWorkspaceId } from '../../session-drivers/sessionFileNavigation';
import './SessionUsagePanel.scss';
import { IconButton, Icon } from '@openbitfun/ui';

const log = createLogger('SessionUsagePanel');
type UsageTranslator = (key: string, options?: Record<string, unknown>) => string;
interface SessionUsagePanelProps {
  report?: SessionUsageReport;
  markdown?: string;
  sessionId?: string;
  workspacePath?: string;
  initialTab?: SessionUsagePanelTab;
}

const TABS: SessionUsagePanelTab[] = ['overview', 'models', 'tools', 'files', 'errors', 'slowest'];
const MAX_USAGE_TABLE_ROWS = 50;

const UsageClockIcon: React.FC<LucideProps> = ({ className, size = 16, style }) => (
  <Icon
    name="clock"
    size="md"
    className={className}
    style={{ width: size, height: size, ...style }}
  />
);

function tabId(tab: SessionUsagePanelTab): string {
  return `session-usage-tab-${tab}`;
}

function tabPanelId(tab: SessionUsagePanelTab): string {
  return `session-usage-panel-${tab}`;
}

export const SessionUsagePanel: React.FC<SessionUsagePanelProps> = ({
  report,
  markdown = '',
  sessionId,
  workspacePath,
  initialTab,
}) => {
  const { t } = useTranslation('flow-chat');
  const [activeTab, setActiveTab] = useState<SessionUsagePanelTab>(initialTab ?? 'overview');
  const [copied, setCopied] = useState(false);
  const [copiedMeta, setCopiedMeta] = useState<'session' | 'workspace' | null>(null);
  const [redactExportPaths, setRedactExportPaths] = useState(getUsageExportRedactPathsPreference);

  useEffect(() => {
    if (initialTab) {
      setActiveTab(initialTab);
    }
  }, [initialTab]);

  useEffect(() => (
    subscribeUsageExportRedactPathsPreference(setRedactExportPaths)
  ), []);

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

  const handleRedactExportPathsChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setUsageExportRedactPathsPreference(event.target.checked);
  }, []);

  const handleCopyMeta = useCallback(async (
    value: string,
    field: 'session' | 'workspace'
  ) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedMeta(field);
      window.setTimeout(() => setCopiedMeta(null), 1800);
    } catch {
      setCopiedMeta(null);
    }
  }, []);

  if (!report) {
    return (
      <div data-openbitfun-product-component="session-usage-panel" data-openbitfun-product-part="root" data-openbitfun-state="fallback" className="session-usage-panel session-usage-panel--fallback">
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
      </div>
    );
  }

  const coverageTone = getCoverageTone(report.coverage.level);
  const effectiveSessionId = sessionId ?? report.sessionId;
  const effectiveWorkspacePath = workspacePath ?? report.workspace.pathLabel;
  const displayedWorkspacePath = getUsageDisplayPathLabel(effectiveWorkspacePath, t, {
    redactPaths: redactExportPaths,
  });
  const coverageBadgeClassName =
    `session-usage-panel__badge session-usage-panel__badge--${coverageTone}` +
    (report.coverage.level !== 'complete' ? ' session-usage-panel__badge--hint' : '');
  const coverageBadge = (
    <span className={coverageBadgeClassName}>
      {getCoverageLabel(report.coverage.level, t)}
    </span>
  );

  return (
    <div data-openbitfun-product-component="session-usage-panel" data-openbitfun-product-part="root" data-openbitfun-tab={activeTab} className="session-usage-panel">
      <header className="session-usage-panel__header" data-openbitfun-product-component="session-usage-panel" data-openbitfun-product-part="header">
        <div className="session-usage-panel__title-wrap">
          <div className="session-usage-panel__title-main">
            <h2>{t('usage.title')}</h2>
            <div className="session-usage-panel__meta-list" aria-label={t('usage.panel.metadataLabel')}>
              <UsageMetaRow
                label={t('usage.meta.generatedAt')}
                value={formatUsageTimestamp(report.generatedAt, t)}
              />
              <UsageMetaRow
                label={t('usage.meta.sessionId')}
                value={effectiveSessionId}
                copyLabel={copiedMeta === 'session' ? t('usage.actions.copied') : t('usage.actions.copySessionId')}
                copied={copiedMeta === 'session'}
                onCopy={() => handleCopyMeta(effectiveSessionId, 'session')}
              />
              <UsageMetaRow
                label={t('usage.meta.workspacePath')}
                value={displayedWorkspacePath}
                copyLabel={copiedMeta === 'workspace' ? t('usage.actions.copied') : t('usage.actions.copyWorkspacePath')}
                copied={copiedMeta === 'workspace'}
                onCopy={() => handleCopyMeta(displayedWorkspacePath, 'workspace')}
              />
            </div>
          </div>
        </div>
        <div className="session-usage-panel__header-actions">
          {report.coverage.level !== 'complete' ? (
            <Tooltip content={t('usage.coverage.partialNotice')} placement="top">
              {coverageBadge}
            </Tooltip>
          ) : coverageBadge}
          <UsageExportRedactionToggle
            checked={redactExportPaths}
            onChange={handleRedactExportPathsChange}
            className="session-usage-panel__export-option"
          />
          <Tooltip content={copied ? t('usage.actions.copied') : t('usage.actions.copyMarkdown')}>
            <IconButton
              className="session-usage-panel__copy"
              size="sm"
              onClick={handleCopy}
              aria-label={copied ? t('usage.actions.copied') : t('usage.actions.copyMarkdown')}
              icon={copied ? <Icon name="check-line" size="sm" /> : <Icon name="duplicate" size="sm" />}
            />
          </Tooltip>
        </div>
      </header>

      <TabGroup
        className="session-usage-panel__tabs"
        data-openbitfun-product-component="session-usage-panel"
        data-openbitfun-product-part="tabs"
        aria-label={t('usage.panel.tabsLabel')}
        value={activeTab}
        onValueChange={value => setActiveTab(value as SessionUsagePanelTab)}
        items={TABS.map(tab => ({
          value: tab,
          id: tabId(tab),
          panelId: tabPanelId(tab),
          label: t(`usage.tabs.${tab}`),
          tabProps: {
            className: `session-usage-panel__tab${activeTab === tab ? ' session-usage-panel__tab--active' : ''}`,
            'data-openbitfun-product-component': 'session-usage-panel',
            'data-openbitfun-product-part': 'tab',
            'data-openbitfun-tab': tab,
            'data-openbitfun-state': activeTab === tab ? 'active' : undefined,
          },
        }))}
      />

      <main
        className="session-usage-panel__body"
        data-openbitfun-product-component="session-usage-panel"
        data-openbitfun-product-part="body"
        data-openbitfun-tab={activeTab}
        role="tabpanel"
        id={tabPanelId(activeTab)}
        aria-labelledby={tabId(activeTab)}
      >
        {activeTab === 'overview' && <UsageOverview report={report} />}
        {activeTab === 'models' && <UsageModels report={report} sessionId={effectiveSessionId} />}
        {activeTab === 'tools' && <UsageTools report={report} sessionId={effectiveSessionId} />}
        {activeTab === 'files' && (
          <UsageFiles
            report={report}
            sessionId={effectiveSessionId}
            workspacePath={workspacePath ?? report.workspace.pathLabel}
            redactPaths={redactExportPaths}
          />
        )}
        {activeTab === 'errors' && <UsageErrors report={report} sessionId={effectiveSessionId} />}
        {activeTab === 'slowest' && <UsageSlowest report={report} sessionId={effectiveSessionId} />}
      </main>
    </div>
  );
};

function UsageExportRedactionToggle({
  checked,
  onChange,
  className,
}: {
  checked: boolean;
  onChange: React.ChangeEventHandler<HTMLInputElement>;
  className: string;
}) {
  const { t } = useTranslation('flow-chat');
  return (
    <Tooltip content={t('usage.export.redactPathsHelp')}>
      <Checkbox
        appearance="native"
        size="sm"
        className={className}
        checked={checked}
        onChange={onChange}
        aria-label={t('usage.export.redactPaths')}
        label={t('usage.export.redactPaths')}
      />
    </Tooltip>
  );
}

function UsageMetaRow({
  label,
  value,
  copyLabel,
  copied = false,
  onCopy,
}: {
  label: string;
  value: string;
  copyLabel?: string;
  copied?: boolean;
  onCopy?: () => void;
}) {
  return (
    <div data-openbitfun-product-component="session-usage-panel" data-openbitfun-product-part="metaRow" className="session-usage-panel__meta-row">
      <span className="session-usage-panel__meta-label">{label}</span>
      <OverflowText className="session-usage-panel__meta-value" title={value}>{value}</OverflowText>
      {onCopy && copyLabel && (
        <Tooltip content={copyLabel}>
          <IconButton
            className="session-usage-panel__meta-copy"
            size="sm"
            onClick={onCopy}
            aria-label={copyLabel}
            icon={copied ? <Icon name="check-line" size="lg" style={{ width: 13, height: 13 }} /> : <Icon name="duplicate" size="lg" style={{ width: 13, height: 13 }} />}
          />
        </Tooltip>
      )}
    </div>
  );
}

type UsageTableValueCell = {
  value: string;
  help?: string;
  className?: string;
};

type UsageTableNodeCell = {
  node: React.ReactNode;
  className?: string;
};

type UsageTableCell = string | UsageTableValueCell | UsageTableNodeCell;

interface UsageTableHeader {
  id: string;
  label: string;
  help?: string;
}

interface UsageTableRow {
  id: string;
  cells: UsageTableCell[];
}

function UsageValue({
  value,
  help,
  strong = false,
}: {
  value: string;
  help?: string;
  strong?: boolean;
}) {
  const className = help ? 'session-usage-panel__help-value' : undefined;
  const node = strong
    ? <strong className={className}>{value}</strong>
    : <span className={className}>{value}</span>;

  return help ? <Tooltip content={help}>{node}</Tooltip> : node;
}

function UsageMissingValue({ value, help }: { value: string; help?: string }) {
  const node = (
    <span className={`session-usage-panel__missing-value${help ? ' session-usage-panel__missing-value--help' : ''}`}>
      {value}
    </span>
  );

  return help ? <Tooltip content={help}>{node}</Tooltip> : node;
}

function missingUsageValue(value: string, help?: string): UsageTableCell {
  return {
    className: 'session-usage-panel__missing-cell',
    node: <UsageMissingValue value={value} help={help} />,
  };
}

function UsageRowAnchorLink({
  label,
  help,
  sessionId,
  turnId,
  turnIndex,
  itemId,
}: {
  label: string;
  help?: string;
  sessionId?: string;
  turnId?: string;
  turnIndex?: number;
  itemId?: string;
}) {
  const { t } = useTranslation('flow-chat');
  const displayTurnIndex = typeof turnIndex === 'number' && Number.isFinite(turnIndex)
    ? getDisplayTurnIndex(turnIndex)
    : undefined;
  const canJump = Boolean(sessionId && (turnId || displayTurnIndex));

  if (!canJump) {
    return <UsageValue value={label} help={help} />;
  }

  const jumpHelp = t('usage.actions.jumpToTurn');
  const node = (
    <Button labelBehavior="static" variant="text" data-overflow-trigger
      type="button"
      className="session-usage-panel__row-anchor-link"
      onClick={() => {
        const request: FlowChatFocusItemRequest = {
          sessionId: sessionId as string,
          source: 'usage-report',
        };
        if (turnId) {
          request.turnId = turnId;
        }
        if (displayTurnIndex) {
          request.turnIndex = displayTurnIndex;
        }
        if (itemId) {
          request.itemId = itemId;
        }
        globalEventBus.emit(FLOWCHAT_FOCUS_ITEM_EVENT, request, 'SessionUsagePanel');
      }}
      aria-label={`${jumpHelp}: ${label}`}
    ><OverflowText>
      {label}
    </OverflowText></Button>
  );

  return (
    <Tooltip content={help ? `${help} ${jumpHelp}` : jumpHelp}>
      {node}
    </Tooltip>
  );
}

function UsageFilePathValue({ pathLabel }: { pathLabel: string }) {
  const node = (
    <OverflowText className="session-usage-panel__file-path-display">
      {getCompactFilePathLabel(pathLabel)}
    </OverflowText>
  );

  return <Tooltip content={pathLabel}>{node}</Tooltip>;
}

function UsageFileTurnIndexesValue({
  file,
  sessionId,
  onJumpToTurn,
}: {
  file: SessionUsageReport['files']['files'][number];
  sessionId?: string;
  onJumpToTurn: (file: SessionUsageReport['files']['files'][number], rawTurnIndex: number) => void;
}) {
  const { t } = useTranslation('flow-chat');
  const turnIndexes = (file.turnIndexes ?? []).filter(index => Number.isFinite(index));

  if (turnIndexes.length === 0) {
    return <UsageMissingValue value={t('usage.status.notRecorded')} help={t('usage.help.fileTurnIndexes')} />;
  }

  const displayIndexes = turnIndexes.map(getDisplayTurnIndex);
  if (!sessionId) {
    return (
      <UsageValue
        value={displayIndexes.map(index => formatUsageNumber(index, t)).join(', ')}
        help={t('usage.help.fileTurnIndexes')}
      />
    );
  }

  const visibleTurnIndexes = turnIndexes.slice(0, 3);
  const hiddenCount = Math.max(0, turnIndexes.length - visibleTurnIndexes.length);
  return (
    <span className="session-usage-panel__turn-indexes">
      {visibleTurnIndexes.map(rawTurnIndex => {
        const displayTurnIndex = getDisplayTurnIndex(rawTurnIndex);
        const displayTurnText = formatUsageNumber(displayTurnIndex, t);
        return (
          <Tooltip key={rawTurnIndex} content={t('usage.actions.jumpToTurn')}>
            <Button labelBehavior="static" variant="text"
              type="button"
              className="session-usage-panel__turn-index-link"
              onClick={() => onJumpToTurn(file, rawTurnIndex)}
              aria-label={`${t('usage.actions.jumpToTurn')}: ${displayTurnText}`}
            >
              {displayTurnText}
            </Button>
          </Tooltip>
        );
      })}
      {hiddenCount > 0 && (
        <Tooltip content={displayIndexes.map(index => formatUsageNumber(index, t)).join(', ')}>
          <span className="session-usage-panel__turn-index-overflow">
            +{formatUsageNumber(hiddenCount, t)}
          </span>
        </Tooltip>
      )}
    </span>
  );
}

function getStableFileToolAnchorId(
  scope: SessionUsageReport['files']['scope'],
  file: SessionUsageReport['files']['files'][number]
): string | undefined {
  if (
    scope !== 'tool_inputs_only' ||
    (file.turnIndexes?.length ?? 0) !== 1 ||
    (file.operationIds?.length ?? 0) !== 1
  ) {
    return undefined;
  }
  return file.operationIds?.[0];
}

function getCompactFilePathLabel(pathLabel: string): string {
  const normalizedPath = pathLabel.replace(/\\/g, '/');
  const segments = normalizedPath.split('/').filter(Boolean);

  if (segments.length <= 2) {
    return normalizedPath;
  }

  return `.../${segments.slice(-2).join('/')}`;
}

function UsageOverview({ report }: { report: SessionUsageReport }) {
  const { t } = useTranslation('flow-chat');
  const denominator = report.time.activeTurnMs ?? report.time.wallTimeMs;
  const fileScopeHelp = getFileScopeHelp(report, t);
  const cacheCoverageHelp = report.tokens.cacheCoverage === 'unavailable'
    ? t('usage.help.cachedTokens')
    : report.tokens.cacheCoverage === 'partial'
      ? t('usage.help.cachedTokensPartial')
      : undefined;
  const metrics = [
    {
      key: 'wall',
      icon: UsageClockIcon,
      label: t('usage.metrics.wall'),
      value: formatUsageDuration(report.time.wallTimeMs, t),
      help: t('usage.help.wall'),
    },
    {
      key: 'active',
      icon: Activity,
      label: t('usage.metrics.active'),
      value: formatUsageDuration(report.time.activeTurnMs, t),
      help: t('usage.help.active'),
    },
    {
      key: 'model',
      icon: Database,
      label: t('usage.metrics.modelTime'),
      value: formatUsageDuration(report.time.modelMs, t),
      detail: formatUsagePercent(calculateShare(report.time.modelMs, denominator), t),
      help: t('usage.help.modelRoundTime'),
    },
    {
      key: 'tool',
      icon: Wrench,
      label: t('usage.metrics.toolTime'),
      value: formatUsageDuration(report.time.toolMs, t),
      detail: formatUsagePercent(calculateShare(report.time.toolMs, denominator), t),
      help: t('usage.help.toolTime'),
    },
    {
      key: 'tokens',
      icon: Database,
      label: t('usage.metrics.tokens'),
      value: formatTokenCount(report.tokens.totalTokens, t),
    },
    {
      key: 'files',
      icon: FileText,
      label: t('usage.metrics.files'),
      value: getFileSummaryLabel(report, t),
      detail: getFileScopeLabel(report.files.scope, t),
      help: fileScopeHelp,
    },
  ];

  return (
    <section data-openbitfun-product-component="session-usage-panel" data-openbitfun-product-part="section" className="session-usage-panel__section">
      {report.coverage.level !== 'complete' && (
        <div className="session-usage-panel__notice">
          <AlertTriangle size={14} aria-hidden />
          <span>{t('usage.coverage.partialNotice')}</span>
        </div>
      )}

      <div className="session-usage-panel__overview-grid">
        {metrics.map(metric => {
          const Icon = metric.icon;
          return (
            <div data-openbitfun-product-component="session-usage-panel" data-openbitfun-product-part="metric" className="session-usage-panel__overview-metric" key={metric.key}>
              <Icon size={16} aria-hidden />
              <div>
                <span>{metric.label}</span>
                <UsageValue value={metric.value} help={metric.help} strong />
                {metric.detail && <em>{metric.detail}</em>}
              </div>
            </div>
          );
        })}
      </div>

      <dl className="session-usage-panel__definition-list">
        <div>
          <dt>{t('usage.panel.accounting')}</dt>
          <dd><OverflowText>{getAccountingLabel(report.time.accounting, t)}</OverflowText></dd>
        </div>
        <div>
          <dt>{t('usage.panel.turnScope')}</dt>
          <dd><OverflowText>{t('usage.card.turns', { count: report.scope.turnCount })}</OverflowText></dd>
        </div>
        <div>
          <dt>{t('usage.panel.cacheCoverage')}</dt>
          <dd>
            <UsageValue
              value={t(`usage.cacheCoverage.${report.tokens.cacheCoverage}`)}
              help={cacheCoverageHelp}
            />
          </dd>
        </div>
        <div>
          <dt>{t('usage.panel.compressions')}</dt>
          <dd><OverflowText>{formatUsageNumber(report.compression.compactionCount, t)}</OverflowText></dd>
        </div>
      </dl>

      <div className="session-usage-panel__privacy">
        <ShieldCheck size={16} aria-hidden />
        <div>
          <strong>{t('usage.privacy.title')}</strong>
          <span>{t('usage.privacy.summary')}</span>
        </div>
      </div>
    </section>
  );
}

function UsageModels({ report, sessionId }: { report: SessionUsageReport; sessionId?: string }) {
  const { t } = useTranslation('flow-chat');
  const hasModelDuration = report.models.some(model => model.durationMs !== undefined);
  const headers: UsageTableHeader[] = [
    { id: 'model', label: t('usage.table.model') },
    { id: 'calls', label: t('usage.table.calls') },
    ...(hasModelDuration ? [{ id: 'duration', label: t('usage.table.duration') }] : []),
    { id: 'input', label: t('usage.table.input') },
    { id: 'output', label: t('usage.table.output') },
    { id: 'cached', label: t('usage.table.cached') },
    { id: 'hitRate', label: t('usage.table.hitRate') },
  ];
  return (
    <UsageTable
      empty={report.models.length === 0}
      emptyLabel={t('usage.empty.models')}
      emptyDescription={t('usage.empty.modelsDescription')}
      headers={headers}
      rows={report.models.map((model, index) => {
        const cached = formatTokenCount(model.cachedTokens, t);
        const source = model.modelIdSource ?? (model.modelId === 'unknown_model' ? 'legacy_missing' : undefined);
        const modelHelp = getModelHelp(source, t, model.modelId);
        const modelLabel = getModelLabel(model.modelId, t, source);
        const cells: UsageTableCell[] = [
          {
            node: (
              <UsageRowAnchorLink
                label={modelLabel}
                help={modelHelp}
                sessionId={sessionId}
                turnId={model.sampleTurnId}
                turnIndex={model.sampleTurnIndex}
              />
            ),
          },
          formatUsageNumber(model.callCount, t),
        ];
        if (hasModelDuration) {
          cells.push(
            model.durationMs === undefined
              ? missingUsageValue(t('usage.status.timingNotRecorded'), t('usage.help.modelRoundTime'))
              : formatUsageDuration(model.durationMs, t)
          );
        }
        cells.push(
          formatTokenCount(model.inputTokens, t),
          formatTokenCount(model.outputTokens, t),
          report.tokens.cacheCoverage === 'unavailable'
            ? { value: t('usage.status.cacheNotReported'), help: t('usage.help.cachedTokens') }
            : cached,
          formatHitRatePercent(model.cacheHitRate, t),
        );
        return {
          id: `model-${index}-${model.modelId}`,
          cells,
        };
      })}
    />
  );
}

function UsageTools({ report, sessionId }: { report: SessionUsageReport; sessionId?: string }) {
  const { t } = useTranslation('flow-chat');
  const hasExecutionDuration = report.tools.some(tool => tool.executionMs !== undefined);
  const headers: UsageTableHeader[] = [
    { id: 'tool', label: t('usage.table.tool') },
    { id: 'category', label: t('usage.table.category') },
    { id: 'calls', label: t('usage.table.calls') },
    { id: 'success', label: t('usage.table.success') },
    { id: 'errors', label: t('usage.table.errors') },
    { id: 'duration', label: t('usage.table.toolDuration'), help: t('usage.help.toolDuration') },
    { id: 'p95', label: t('usage.table.toolP95Duration'), help: t('usage.help.toolP95') },
    ...(hasExecutionDuration
      ? [{ id: 'execution', label: t('usage.table.toolExecutionDuration'), help: t('usage.help.toolExecution') }]
      : []),
  ];
  return (
    <UsageTable
      empty={report.tools.length === 0}
      emptyLabel={t('usage.empty.tools')}
      emptyDescription={t('usage.empty.toolsDescription')}
      headers={headers}
      rows={report.tools.map((tool, index) => {
        const duration = formatUsageDuration(tool.durationMs, t);
        const p95 = formatUsageDuration(tool.p95DurationMs, t);
        const execution = formatUsageDuration(tool.executionMs, t);
        const cells: UsageTableCell[] = [
          {
            node: (
              <UsageRowAnchorLink
                label={tool.redacted ? getRedactedLabel(t) : tool.toolName}
                sessionId={sessionId}
                turnId={tool.sampleTurnId}
                turnIndex={tool.sampleTurnIndex}
                itemId={tool.sampleItemId}
              />
            ),
          },
          getToolCategoryLabel(tool.category, t),
          formatUsageNumber(tool.callCount, t),
          formatUsageNumber(tool.successCount, t),
          formatUsageNumber(tool.errorCount, t),
          tool.durationMs === undefined
            ? missingUsageValue(t('usage.status.timingNotRecorded'), t('usage.help.toolDuration'))
            : duration,
          tool.p95DurationMs === undefined
            ? missingUsageValue(
              tool.durationMs === undefined
                ? t('usage.status.timingNotRecorded')
                : t('usage.status.p95SampleInsufficient'),
              t('usage.help.toolP95')
            )
            : p95,
        ];
        if (hasExecutionDuration) {
          cells.push(
            tool.executionMs === undefined
              ? missingUsageValue(t('usage.status.timingNotRecorded'), t('usage.help.toolExecution'))
              : execution
          );
        }
        return {
          id: tool.redacted
            ? `tool-${index}-redacted-${tool.category}`
            : `tool-${index}-${tool.category}-${tool.toolName}`,
          cells,
        };
      })}
    />
  );
}

function UsageFiles({
  report,
  sessionId,
  workspacePath,
  redactPaths,
}: {
  report: SessionUsageReport;
  sessionId?: string;
  workspacePath?: string;
  redactPaths: boolean;
}) {
  const { t } = useTranslation('flow-chat');
  const fileScopeHelp = getFileScopeHelp(report, t);
  const [openingDiffKey, setOpeningDiffKey] = useState<string | null>(null);

  const handleJumpToFileTurn = useCallback((
    file: SessionUsageReport['files']['files'][number],
    rawTurnIndex: number
  ) => {
    const targetSessionId = file.sessionId ?? sessionId;
    if (!targetSessionId) {
      return;
    }

    const turnIndex = getDisplayTurnIndex(rawTurnIndex);
    const request: FlowChatFocusItemRequest = {
      sessionId: targetSessionId,
      turnIndex,
      source: 'usage-report',
    };
    const itemId = getStableFileToolAnchorId(report.files.scope, file);
    if (itemId) {
      request.itemId = itemId;
    }
    globalEventBus.emit(FLOWCHAT_FOCUS_ITEM_EVENT, request, 'SessionUsagePanel');
  }, [report.files.scope, sessionId]);

  const handleOpenFileDiff = useCallback(async (file: SessionUsageReport['files']['files'][number]) => {
    if (!sessionId || file.redacted || report.files.scope !== 'snapshot_summary') {
      return;
    }

    const resolvedPath = resolveUsageFilePath(file.pathLabel, workspacePath);
    const operationId = file.operationIds?.[0];
    const diffKey = `${resolvedPath}:${operationId ?? ''}`;
    setOpeningDiffKey(diffKey);

    try {
      const diff = await snapshotAPI.getOperationDiff(
        sessionId,
        resolvedPath,
        operationId,
      );
      const diffPath = diff.filePath || resolvedPath;
      createDiffEditorTab(
        diffPath,
        getUsageFileName(diffPath),
        diff.originalContent || '',
        diff.modifiedContent || '',
        true,
        'agent',
        workspacePath,
        diff.anchorLine ? Number(diff.anchorLine) : undefined,
        undefined,
        {
          titleKind: 'diff',
          duplicateKeyPrefix: 'diff',
          workspaceId: sessionWorkspaceId(sessionId),
        },
      );
    } catch (error) {
      log.warn('Failed to open usage report file diff', {
        sessionId,
        filePath: resolvedPath,
        operationId,
        error,
      });
    } finally {
      setOpeningDiffKey(null);
    }
  }, [report.files.scope, sessionId, workspacePath]);

  const rows = useMemo(() => report.files.files.map((file, index) => {
    const operationId = file.operationIds?.[0];
    const resolvedPath = resolveUsageFilePath(file.pathLabel, workspacePath);
    const displayPathLabel = getUsageDisplayPathLabel(file.pathLabel, t, {
      redactPaths,
      keepFileName: true,
    });
    const diffKey = `${resolvedPath}:${operationId ?? ''}`;
    const canOpenDiff = canOpenUsageFileDiff(report.files.scope, file, sessionId);
    const actionCell: UsageTableNodeCell = {
      className: 'session-usage-panel__sticky-action-cell',
      node: canOpenDiff ? (
        <Tooltip content={t('usage.actions.openFileDiff')}>
          <IconButton
            className="session-usage-panel__table-action"
            size="sm"
            onClick={() => void handleOpenFileDiff(file)}
            disabled={openingDiffKey === diffKey}
            aria-label={t('usage.actions.openFileDiff')}
            icon={<GitCompare size={13} />}
          />
        </Tooltip>
      ) : (
        <Tooltip content={t('usage.help.fileDiffUnavailable')}>
          <span className="session-usage-panel__table-action-placeholder">-</span>
        </Tooltip>
      ),
    };

    return {
      id: file.redacted
        ? `file-${index}-redacted-${file.operationCount}`
        : `file-${index}-${file.pathLabel}-${(file.operationIds ?? []).join('|')}`,
      cells: [
      file.redacted
        ? getRedactedLabel(t)
        : {
          node: <UsageFilePathValue pathLabel={displayPathLabel} />,
          className: 'session-usage-panel__file-path-cell',
        },
        formatUsageNumber(file.operationCount, t),
        formatUsageNumber(file.addedLines, t),
        formatUsageNumber(file.deletedLines, t),
        {
          node: (
            <UsageFileTurnIndexesValue
              file={file}
              sessionId={file.sessionId ?? sessionId}
              onJumpToTurn={handleJumpToFileTurn}
            />
          ),
        },
        actionCell,
      ],
    };
  }), [handleJumpToFileTurn, handleOpenFileDiff, openingDiffKey, redactPaths, report.files.files, report.files.scope, sessionId, t, workspacePath]);

  return (
    <section data-openbitfun-product-component="session-usage-panel" data-openbitfun-product-part="section" className="session-usage-panel__section">
      <div className="session-usage-panel__scope-line">
        <span>{t('usage.panel.fileScope')}</span>
        <UsageValue
          value={report.files.scope === 'unavailable' ? getFileSummaryLabel(report, t) : getFileScopeLabel(report.files.scope, t)}
          help={fileScopeHelp}
          strong
        />
      </div>
      <UsageTable
        empty={report.files.files.length === 0}
        emptyLabel={getFileSummaryLabel(report, t)}
        emptyDescription={fileScopeHelp ?? t('usage.empty.filesDescription')}
        headers={[
          { id: 'file', label: t('usage.table.file') },
          { id: 'operations', label: t('usage.table.operations') },
          { id: 'added', label: t('usage.table.added') },
          { id: 'deleted', label: t('usage.table.deleted') },
          { id: 'turns', label: t('usage.table.turns') },
          { id: 'actions', label: t('usage.table.actions') },
        ]}
        rows={rows}
        tableClassName="session-usage-panel__table--files"
      />
    </section>
  );
}

function UsageErrors({ report, sessionId }: { report: SessionUsageReport; sessionId?: string }) {
  const { t } = useTranslation('flow-chat');
  return (
    <section data-openbitfun-product-component="session-usage-panel" data-openbitfun-product-part="section" className="session-usage-panel__section">
      <div className="session-usage-panel__scope-line">
        <span>{t('usage.panel.errorScope')}</span>
        <UsageValue
          value={formatUsageNumber(report.errors.totalErrors, t)}
          help={t('usage.help.errors')}
          strong
        />
      </div>
      <p className="session-usage-panel__section-help">{t('usage.help.errors')}</p>
      <dl className="session-usage-panel__definition-list">
        <div>
          <dt>{t('usage.metrics.errors')}</dt>
          <dd>
            <UsageValue
              value={formatUsageNumber(report.errors.totalErrors, t)}
              help={t('usage.help.errors')}
            />
          </dd>
        </div>
        <div>
          <dt>{t('usage.panel.toolErrors')}</dt>
          <dd>
            <UsageValue
              value={formatUsageNumber(report.errors.toolErrors, t)}
              help={t('usage.help.toolErrors')}
            />
          </dd>
        </div>
        <div>
          <dt>{t('usage.panel.modelErrors')}</dt>
          <dd>
            <UsageValue
              value={formatUsageNumber(report.errors.modelErrors, t)}
              help={t('usage.help.modelErrors')}
            />
          </dd>
        </div>
      </dl>
      <UsageTable
        empty={report.errors.examples.length === 0}
        emptyLabel={t('usage.empty.errors')}
        emptyDescription={t('usage.empty.errorsDescription')}
        emptyHelp={t('usage.help.errorExamples')}
        headers={[
          { id: 'label', label: t('usage.table.label') },
          { id: 'count', label: t('usage.table.count') },
        ]}
        rows={report.errors.examples.map((example, index) => ({
          id: example.redacted
            ? `error-${index}-redacted-${example.count}`
            : `error-${index}-${example.label}-${example.count}`,
          cells: [
            {
              node: (
                <UsageRowAnchorLink
                  label={example.redacted ? getRedactedLabel(t) : example.label}
                  help={t('usage.help.errorExampleRow')}
                  sessionId={sessionId}
                  turnId={example.sampleTurnId}
                  turnIndex={example.sampleTurnIndex}
                  itemId={example.sampleItemId}
                />
              ),
            },
            {
              value: formatUsageNumber(example.count, t),
              help: t('usage.help.errorExampleCount'),
            },
          ],
        }))}
      />
    </section>
  );
}

function canOpenUsageFileDiff(
  scope: SessionUsageReport['files']['scope'],
  file: SessionUsageReport['files']['files'][number],
  sessionId?: string,
): boolean {
  return Boolean(sessionId && scope === 'snapshot_summary' && !file.redacted && file.pathLabel);
}

function resolveUsageFilePath(pathLabel: string, workspacePath?: string): string {
  if (!workspacePath || isAbsolutePathLike(pathLabel)) {
    return pathLabel;
  }
  return `${workspacePath.replace(/[\\/]+$/, '')}/${pathLabel.replace(/^[\\/]+/, '')}`;
}

function isAbsolutePathLike(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\');
}

function getUsageFileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

function UsageSlowest({ report, sessionId }: { report: SessionUsageReport; sessionId?: string }) {
  const { t } = useTranslation('flow-chat');
  const handleJumpToSpan = useCallback((span: SessionUsageReport['slowest'][number]) => {
    if (!sessionId) return;

    if (!span.turnId && typeof span.turnIndex !== 'number') return;

    const request: FlowChatFocusItemRequest = {
      sessionId,
      source: 'usage-report',
    };
    if (span.turnId) {
      request.turnId = span.turnId;
    }
    if (typeof span.turnIndex === 'number' && Number.isFinite(span.turnIndex)) {
      request.turnIndex = getDisplayTurnIndex(span.turnIndex);
    }
    if (span.itemId) {
      request.itemId = span.itemId;
    }
    globalEventBus.emit(FLOWCHAT_FOCUS_ITEM_EVENT, request, 'SessionUsagePanel');
  }, [sessionId]);

  return (
    <section data-openbitfun-product-component="session-usage-panel" data-openbitfun-product-part="section" className="session-usage-panel__section">
      <div className="session-usage-panel__scope-line">
        <span>{t('usage.sections.slowest')}</span>
        <UsageValue
          value={formatUsageNumber(report.slowest.length, t)}
          help={t('usage.help.slowestSpans')}
          strong
        />
      </div>
      <p className="session-usage-panel__section-help">{t('usage.help.slowestSpans')}</p>
      <UsageTable
        empty={report.slowest.length === 0}
        emptyLabel={t('usage.empty.slowest')}
        emptyDescription={t('usage.empty.slowestDescription')}
        emptyHelp={t('usage.help.slowestSpans')}
        headers={[
          { id: 'label', label: t('usage.table.label') },
          { id: 'kind', label: t('usage.table.kind') },
          { id: 'duration', label: t('usage.table.duration') },
        ]}
        rows={report.slowest.map((span, index) => {
          const spanHelp = getSlowSpanHelp(span, t);
          const spanLabel = getSlowSpanLabel(span, t);
          const detailRows = getSlowSpanDetailRows(span, t);
          const canJumpToSpan = Boolean(
            sessionId &&
            (span.turnId || (typeof span.turnIndex === 'number' && Number.isFinite(span.turnIndex)))
          );
          const jumpHelp = t('usage.actions.jumpToTurn');
          const labelCell: UsageTableCell = canJumpToSpan
            ? {
              node: (
                <div className="session-usage-panel__slow-span">
                  <Tooltip content={spanHelp ? `${spanHelp} ${jumpHelp}` : jumpHelp}>
                    <Button labelBehavior="static" variant="text" data-overflow-trigger
                      type="button"
                      className="session-usage-panel__turn-link"
                      onClick={() => handleJumpToSpan(span)}
                      aria-label={`${jumpHelp}: ${spanLabel}`}
                    ><OverflowText>
                      {spanLabel}
                    </OverflowText></Button>
                  </Tooltip>
                  {detailRows.length > 0 && (
                    <dl className="session-usage-panel__slow-span-details">
                      {detailRows.map(row => (
                        <div key={row.label}>
                          <dt>{row.label}</dt>
                          <dd>{row.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
              ),
            }
            : spanHelp
              ? { value: spanLabel, help: spanHelp }
              : spanLabel;
          return {
            id: `slowest-${index}-${span.kind}-${span.turnId ?? spanLabel}`,
            cells: [
              labelCell,
              t(`usage.slowestKinds.${span.kind === 'model' ? 'modelCall' : span.kind}`),
              formatUsageDuration(span.durationMs, t),
            ],
          };
        })}
      />
    </section>
  );
}

function getSlowSpanDetailRows(
  span: SessionUsageReport['slowest'][number],
  t: UsageTranslator
): Array<{ label: string; value: string }> {
  if (span.kind !== 'tool' || span.redacted) {
    return [];
  }

  const rows: Array<{ label: string; value: string }> = [];
  if (span.inputSummary) {
    rows.push({
      label: t('usage.slowest.details.input'),
      value: span.inputSummary,
    });
  }
  if (span.status) {
    rows.push({
      label: t('usage.slowest.details.status'),
      value: getSlowToolStatusLabel(span.status, t),
    });
  }
  if (typeof span.exitCode === 'number') {
    rows.push({
      label: t('usage.slowest.details.exitCode'),
      value: String(span.exitCode),
    });
  }
  if (span.timedOut === true) {
    rows.push({
      label: t('usage.slowest.details.timedOut'),
      value: t('usage.status.timedOut'),
    });
  }
  if (typeof span.executionMs === 'number') {
    rows.push({
      label: t('usage.slowest.details.execution'),
      value: formatUsageDuration(span.executionMs, t),
    });
  }
  if (span.errorSummary) {
    rows.push({
      label: t('usage.slowest.details.error'),
      value: span.errorSummary,
    });
  }
  return rows;
}

function getSlowToolStatusLabel(
  status: string,
  t: UsageTranslator
): string {
  if (status === 'failed') {
    return t('shared:statuses.failed');
  }
  if (status === 'succeeded') {
    return t('shared:statuses.done');
  }
  if (status === 'timed_out') {
    return t('usage.status.timedOut');
  }
  return status;
}

interface UsageTableProps {
  empty: boolean;
  emptyLabel: string;
  emptyDescription?: string;
  emptyHelp?: string;
  headers: UsageTableHeader[];
  rows: UsageTableRow[];
  tableClassName?: string;
}

function UsageTable({ empty, emptyLabel, emptyDescription, emptyHelp, headers, rows, tableClassName }: UsageTableProps) {
  const { t } = useTranslation('flow-chat');
  const [expanded, setExpanded] = useState(false);

  if (empty) {
    return (
      <div data-openbitfun-product-component="session-usage-panel" data-openbitfun-product-part="empty" className="session-usage-panel__empty">
        <UsageValue value={emptyLabel} help={emptyHelp} strong />
        {emptyDescription && <span>{emptyDescription}</span>}
      </div>
    );
  }

  const shouldLimitRows = rows.length > MAX_USAGE_TABLE_ROWS;
  const visibleRows = shouldLimitRows && !expanded
    ? rows.slice(0, MAX_USAGE_TABLE_ROWS)
    : rows;

  return (
    <>
      <div data-openbitfun-product-component="session-usage-panel" data-openbitfun-product-part="table" className="session-usage-panel__table-wrap">
        <table className={['session-usage-panel__table', tableClassName].filter(Boolean).join(' ')}>
          <thead>
            <tr>
              {headers.map(header => (
                <th key={header.id}>
                  <UsageTableHeaderLabel header={header} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map(row => (
              <tr key={row.id}>
                {row.cells.map((cell, cellIndex) => (
                  <td
                    key={`${row.id}-${headers[cellIndex]?.id ?? cellIndex}`}
                    className={typeof cell === 'string' ? undefined : cell.className}
                  >
                    {typeof cell === 'string'
                      ? <OverflowText>{cell}</OverflowText>
                      : 'node' in cell
                        ? cell.node
                        : <UsageValue value={cell.value} help={cell.help} />}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shouldLimitRows && (
        <div className="session-usage-panel__table-footer">
          <span>
            {t('usage.table.rowLimitSummary', {
              visible: visibleRows.length,
              total: rows.length,
            })}
          </span>
          <Button labelBehavior="static" variant="text"
            type="button"
            className="session-usage-panel__table-expand"
            onClick={() => setExpanded(value => !value)}
          >
            {expanded
              ? t('usage.table.showFewerRows', { count: MAX_USAGE_TABLE_ROWS })
              : t('usage.table.showAllRows', { count: rows.length })}
          </Button>
        </div>
      )}
    </>
  );
}

function UsageTableHeaderLabel({ header }: { header: UsageTableHeader }) {
  if (!header.help) {
    return <span>{header.label}</span>;
  }

  return <UsageValue value={header.label} help={header.help} />;
}

SessionUsagePanel.displayName = 'SessionUsagePanel';
