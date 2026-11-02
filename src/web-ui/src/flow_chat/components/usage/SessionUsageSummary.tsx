import type { ReactNode } from 'react';
import { useUsageSeriesHighlight } from './useUsageSeriesHighlight';
import { Empty, Icon, IconButton, OverflowText, PageHeader, Tooltip } from '@openbitfun/ui';
import { ChartPie, ExternalLink } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n';
import type { SessionUsageReport, UsageContextBreakdown, UsageContextCategory } from '@/infrastructure/api/service-api/SessionAPI';
import { formatTokenCount, formatUsagePercent } from './usageReportUtils';

const CONTEXT_CATEGORIES = [
  'systemPrompt', 'toolDefinitions', 'rules', 'skills', 'mcpTools',
  'subagentDefinitions', 'summarizedConversation', 'conversation',
] as const satisfies readonly (keyof UsageContextBreakdown)[];

const isCount = (value: number | undefined): value is number => (
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
);

interface UsageSeries {
  key: string;
  parentKey?: string;
  label: string;
  value?: number;
  formattedValue?: ReactNode;
  share?: number;
  action?: ReactNode;
  shareSuffix?: ReactNode;
}

function UsageLegend({ rows, highlight, className = '', showShares = true }: {
  rows: UsageSeries[];
  highlight: ReturnType<typeof useUsageSeriesHighlight<UsageSeries>>['highlight'];
  className?: string;
  showShares?: boolean;
}) {
  const { t } = useI18n('flow-chat');
  return (
    <dl className={`session-usage-panel__legend ${className}`}>
      {rows.map(row => (
        <div className="session-usage-panel__legend-row" key={row.key} data-usage-category={row.key} data-usage-parent={row.parentKey}
          tabIndex={(row.share ?? 0) > 0 ? 0 : undefined} {...highlight(row)}>
          <dt>
            <span aria-hidden="true" className={`session-usage-panel__swatch session-usage-panel__series--${row.key}`} />
            <OverflowText>{row.label}</OverflowText>
            {row.action && <span className="session-usage-panel__legend-action">{row.action}</span>}
          </dt>
          <dd>
            <strong>{row.formattedValue ?? formatTokenCount(row.value, t)}</strong>
            {showShares && row.share !== undefined ? (
              <span className="session-usage-panel__legend-share" data-openbitfun-product-component="session-usage-panel" data-openbitfun-product-part="legendShare">
                {formatUsagePercent(row.share * 100, t)}{row.shareSuffix}
              </span>
            ) : row.shareSuffix}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Context composition and cumulative provider usage intentionally have independent denominators. */
export function SessionUsageSummary({ report, workspaceName, onPreviewContext, previewLoading }: {
  report: SessionUsageReport;
  workspaceName: string;
  onPreviewContext: (category: UsageContextCategory) => void;
  previewLoading: UsageContextCategory | null;
}) {
  const { t } = useI18n('flow-chat');
  const context = report.context;
  const hasContext = !!context && CONTEXT_CATEGORIES.every(key => isCount(context[key]));
  const contextTotal = hasContext ? CONTEXT_CATEGORIES.reduce((sum, key) => sum + context[key], 0) : 0;
  const hasContextTotal = hasContext && Number.isSafeInteger(contextTotal);
  const contextWindow = isCount(context?.contextWindow) && context.contextWindow > 0
    ? context.contextWindow : undefined;
  const hasContextDistribution = hasContextTotal && contextWindow !== undefined && contextTotal <= contextWindow;
  let offset = 0;
  const contextRows: Array<UsageSeries & { offset: number }> = CONTEXT_CATEGORIES.map(key => {
    const share = hasContextDistribution ? context![key] / contextWindow : undefined;
    const row = { key, label: t(`usage.context.categories.${key}`), value: hasContext ? context![key] : undefined, share, offset,
      action: key !== 'summarizedConversation' && key !== 'conversation' ? (
        <Tooltip content={t('usage.context.previewCategory', { category: t(`usage.context.categories.${key}`) })}>
          <IconButton size="xs" icon={<Icon glyph={ExternalLink} size="xs" />}
            aria-label={t('usage.context.previewCategory', { category: t(`usage.context.categories.${key}`) })}
            loading={previewLoading === key} disabled={previewLoading !== null && previewLoading !== key}
            onClick={() => onPreviewContext(key)} />
        </Tooltip>
      ) : undefined };
    offset += (share ?? 0) * 100;
    return row;
  });
  if (hasContextDistribution) {
    const unused = contextWindow - contextTotal;
    contextRows.push({
      key: 'unused', label: t('usage.context.unused'), value: unused,
      share: unused / contextWindow, offset,
    });
  }
  const { inputTokens, outputTokens, totalTokens, cachedTokens, cacheCoverage } = report.tokens;
  const hasTokenDistribution = isCount(inputTokens) && isCount(outputTokens) && isCount(totalTokens)
    && inputTokens + outputTokens === totalTokens && totalTokens > 0;
  const cacheValue = cacheCoverage !== 'unavailable' && isCount(cachedTokens) && isCount(inputTokens)
    && cachedTokens <= inputTokens ? cachedTokens : undefined;
  const tokenRows: UsageSeries[] = [
    { key: 'input', label: t('usage.table.input'), value: isCount(inputTokens) ? inputTokens : undefined,
      share: hasTokenDistribution ? inputTokens / totalTokens : undefined },
    { key: 'output', label: t('usage.table.output'), value: isCount(outputTokens) ? outputTokens : undefined,
      share: hasTokenDistribution ? outputTokens / totalTokens : undefined },
  ];
  const cacheRate = cacheValue !== undefined && isCount(inputTokens) && inputTokens > 0
    ? cacheValue / inputTokens : undefined;
  const cacheRateLabel = cacheRate === undefined ? undefined : cacheCoverage === 'partial' && cacheRate < 1
    ? t('usage.tokens.minimumRate', { rate: formatUsagePercent(Math.floor(cacheValue! * 100 / inputTokens!), t) })
    : formatUsagePercent(cacheRate * 100, t);
  const cacheHelp = t(cacheCoverage === 'partial' ? 'usage.tokens.partialCacheHelp' : cacheValue === undefined
    ? 'usage.help.cachedTokens' : 'usage.panel.cachedSubset');
  tokenRows[0].shareSuffix = (
    <Tooltip content={cacheRate !== undefined ? `${cacheHelp}\n${t('usage.tokens.hitRateDetail', {
      rate: cacheRateLabel, cached: formatTokenCount(cacheValue, t), input: formatTokenCount(inputTokens, t),
    })}` : cacheHelp}>
      <span className="session-usage-panel__legend-detail" data-usage-cache-summary
        data-openbitfun-product-component="session-usage-panel" data-openbitfun-product-part="legendDetail">
        {cacheRate !== undefined ? t('usage.tokens.cacheHitDetail', { rate: cacheRateLabel })
          : t('usage.tokens.cacheUnavailable')}
      </span>
    </Tooltip>
  );
  const hasCacheSplit = hasTokenDistribution && cacheRate !== undefined;
  const cacheRows: UsageSeries[] = hasCacheSplit ? [
    { key: 'cachedInput', parentKey: 'input', label: t(cacheCoverage === 'partial' ? 'usage.tokens.recordedCacheHits' : 'usage.tokens.cacheHit'), value: cacheValue,
      share: cacheValue! / totalTokens },
    { key: 'uncachedInput', parentKey: 'input', label: t(cacheCoverage === 'partial' ? 'usage.tokens.remainingInput' : 'usage.tokens.uncachedInput'), value: inputTokens - cacheValue!,
      share: (inputTokens - cacheValue!) / totalTokens },
  ] : [];
  for (const row of cacheRows) {
    const share = formatUsagePercent(row.value! / inputTokens! * 100, t);
    row.formattedValue = (
      <Tooltip content={`${t('usage.tokens.inputShareDetail', {
        tokens: formatTokenCount(row.value, t), input: formatTokenCount(inputTokens, t), share,
      })}\n${cacheHelp}`}>
        <span>{share}</span>
      </Tooltip>
    );
  }
  const { activeRow: activeContext, highlight: highlightContext } = useUsageSeriesHighlight(contextRows);
  const { highlight: highlightTokens } = useUsageSeriesHighlight([...tokenRows, ...cacheRows]);

  const tokenUsage = (
    <section className="session-usage-panel__summary session-usage-panel__tokens" data-openbitfun-product-component="session-usage-panel" data-openbitfun-product-part="section" aria-label={t('usage.tokens.title')}>
      <PageHeader level={3} size="sm" title={t('usage.tokens.title')} />
      <div className="session-usage-panel__token-chart" data-openbitfun-product-component="session-usage-panel" data-openbitfun-product-part="tokenChart">
        <UsageLegend rows={tokenRows} highlight={highlightTokens} className="session-usage-panel__token-legend" />
        <div className="session-usage-panel__segmented-bar" aria-hidden="true">
          {tokenRows.map(row => row.share !== undefined && row.share > 0 && (
            <div key={row.key} className="session-usage-panel__bar-group" data-usage-category={row.key}
              data-openbitfun-product-component="session-usage-panel" data-openbitfun-product-part="tokenGroup"
              {...highlightTokens(row)} style={{ flexGrow: row.share }}>
              {(row.key === 'input' && hasCacheSplit ? cacheRows : [row]).map(segment => segment.share! > 0 && (
                <span key={segment.key} className={`session-usage-panel__bar-segment session-usage-panel__series--${segment.key}`}
                  {...highlightTokens(segment)} data-usage-category={segment.key} data-usage-parent={segment.parentKey}
                  style={{ flexGrow: segment.share! / row.share! }} />
              ))}
            </div>
          ))}
        </div>
        {hasCacheSplit && <UsageLegend rows={cacheRows} highlight={highlightTokens} showShares={false}
          className="session-usage-panel__cache-legend" />}
      </div>
      {!hasTokenDistribution && <p className="session-usage-panel__section-help">{t('usage.panel.distributionUnavailable')}</p>}
    </section>
  );

  return (
    <>
      <dl className="session-usage-panel__summary-facts" data-openbitfun-product-component="session-usage-panel" data-openbitfun-product-part="summaryFacts">
        <div className="session-usage-panel__summary-fact" data-openbitfun-product-component="session-usage-panel" data-openbitfun-product-part="summaryFact">
          <dt>{t('usage.panel.workspace')}</dt><dd><OverflowText>{workspaceName}</OverflowText></dd>
        </div>
        <div className="session-usage-panel__summary-fact" data-openbitfun-product-component="session-usage-panel" data-openbitfun-product-part="summaryFact">
          <dt>{t('usage.panel.totalUsage')}</dt>
          <dd><OverflowText>{formatTokenCount(isCount(totalTokens) ? totalTokens : undefined, t)}</OverflowText></dd>
        </div>
        <div className="session-usage-panel__summary-fact" data-openbitfun-product-component="session-usage-panel" data-openbitfun-product-part="summaryFact">
          <dt>{t('usage.context.label')}</dt>
          <dd>
            <Tooltip content={t('usage.context.estimateHelp')}>
              <OverflowText>{hasContextTotal || contextWindow !== undefined
                ? t('usage.context.usageOfCapacity', {
                  used: hasContextTotal
                    ? t('usage.context.approximateTokens', { value: formatTokenCount(contextTotal, t) })
                    : t('usage.unavailable'),
                  size: formatTokenCount(contextWindow, t),
                })
                : t('usage.unavailable')}</OverflowText>
            </Tooltip>
          </dd>
        </div>
      </dl>
      {tokenUsage}
      <section className="session-usage-panel__summary session-usage-panel__context" data-openbitfun-product-component="session-usage-panel" data-openbitfun-product-part="section" aria-label={t('usage.context.title')}>
        <PageHeader level={3} size="sm" title={t('usage.context.title')} action={
          <Tooltip content={t('usage.context.estimateHelp')}><span className="session-usage-panel__chart-meta">{t('usage.context.estimated')}</span></Tooltip>
        } />
        {hasContextTotal ? (
          <>
            {!hasContextDistribution && <p className="session-usage-panel__section-help">{t(contextWindow === undefined
              ? 'usage.context.capacityUnavailable' : 'usage.context.exceedsCapacity')}</p>}
            <div className="session-usage-panel__distribution">
              {hasContextDistribution && <div className="session-usage-panel__donut">
                <svg viewBox="0 0 200 200" aria-hidden="true" focusable="false">
                  <circle className="session-usage-panel__donut-track" cx="100" cy="100" r="82" />
                  {contextRows.map(row => row.share! > 0 && (
                    <circle key={row.key} className={`session-usage-panel__donut-segment session-usage-panel__series--${row.key}`}
                      {...highlightContext(row)}
                      data-usage-category={row.key} cx="100" cy="100" r="82" pathLength="100"
                      strokeDasharray={`${row.share! * 100} ${100 - row.share! * 100}`} strokeDashoffset={-row.offset} />
                  ))}
                </svg>
                <div className="session-usage-panel__donut-label">
                  <strong>{formatUsagePercent((activeContext?.share ?? contextTotal / contextWindow) * 100, t)}</strong>
                  <span>{activeContext ? activeContext.label : t('usage.context.utilization')}</span>
                </div>
              </div>}
              <UsageLegend rows={contextRows} highlight={highlightContext} />
            </div>
          </>
        ) : <Empty icon={<Icon glyph={ChartPie} />} title={t('usage.context.unavailable')} />}
      </section>
    </>
  );
}
