import { useEffect, useRef, useState, type RefObject } from 'react';
import { Card, Empty, Icon, IconButton, OverflowText, Tooltip, createOverlayPortal, useDismissibleLayer } from '@openbitfun/ui';
import { ChartPie, ExternalLink, Minus } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import type { UsageContextBreakdown } from '@/infrastructure/api/service-api/SessionAPI';
import { useAnchoredPopoverPosition } from '@/shared/utils/useAnchoredPopoverPosition';
import { formatTokenCount, formatUsagePercent } from './usageReportUtils';
import { useUsageSeriesHighlight } from './useUsageSeriesHighlight';
import { useContextPreview } from './useContextPreview';
import './ContextUsagePopover.scss';

const CATEGORIES = [
  'systemPrompt', 'toolDefinitions', 'rules', 'skills', 'mcpTools',
  'subagentDefinitions', 'summarizedConversation', 'conversation',
] as const satisfies readonly (keyof UsageContextBreakdown)[];

const isCount = (value: number | undefined): value is number => (
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
);

/** Opening the overview is read-only; report and category actions are explicit. */
export function ContextUsagePopover({
  id, anchorRef, triggerRef, currentTokens, maxTokens, loadContext, previewSession, onClose, onViewReport,
}: {
  id: string;
  anchorRef: RefObject<HTMLElement>;
  triggerRef: RefObject<HTMLButtonElement>;
  currentTokens: number;
  maxTokens: number;
  loadContext?: () => Promise<UsageContextBreakdown | undefined>;
  previewSession?: { sessionId: string; workspaceId?: string };
  onClose: () => void;
  onViewReport: () => void;
}) {
  const { t } = useI18n('flow-chat');
  const popoverRef = useRef<HTMLDivElement>(null);
  const { previewLoading, previewContext } = useContextPreview({
    ...previewSession, reportSessionId: previewSession?.sessionId,
  });
  const [context, setContext] = useState<UsageContextBreakdown>();
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(loadContext ? 'loading' : 'ready');
  // Snapshot the loader on open: live token updates must not re-fetch the report.
  const loaderRef = useRef(loadContext);
  useEffect(() => {
    let current = true;
    if (loaderRef.current) {
      void loaderRef.current().then(value => {
        if (current) { setContext(value); setStatus('ready'); }
      }, () => { if (current) setStatus('error'); });
    }
    return () => { current = false; };
  }, []);

  const layout = useAnchoredPopoverPosition({
    open: true, anchorRef, popoverRef, preferredPlacement: 'top',
    matchAnchorWidth: true, gap: 8, layoutRevision: status,
  });
  const close = () => { onClose(); triggerRef.current?.focus(); };
  useDismissibleLayer({
    enabled: true, layerRef: popoverRef, branchRefs: [triggerRef],
    onDismiss: reason => {
      if (reason === 'escape-key') close();
      else onClose();
    },
  });
  useEffect(() => { popoverRef.current?.focus(); }, []);

  const hasBreakdown = !!context && CATEGORIES.every(key => isCount(context[key]));
  const total = hasBreakdown ? CATEGORIES.reduce((sum, key) => sum + context[key], 0) : undefined;
  const hasTotal = isCount(total);
  // Older hosts may supply category counts without a capacity. Do not fabricate a denominator.
  const capacity = isCount(context?.contextWindow) && context.contextWindow > 0 ? context.contextWindow
    : context ? undefined : maxTokens > 0 ? maxTokens : undefined;
  const used = hasTotal ? total : context ? undefined : currentTokens;
  const percentage = used !== undefined && capacity !== undefined ? used / capacity * 100 : undefined;
  const hasDistribution = hasTotal && capacity !== undefined && total <= capacity;
  const rows = CATEGORIES.filter(key => key !== 'summarizedConversation' || (context?.[key] ?? 0) > 0);
  const chartRows = hasDistribution ? [
    ...rows.map(key => ({ key, value: context![key] })),
    { key: 'unused', value: capacity - total },
  ] : [];
  const series = chartRows.map(row => ({ ...row, share: row.value / capacity! }));
  const { highlight } = useUsageSeriesHighlight(series);

  return createOverlayPortal(
    <Card ref={popoverRef} id={id} role="dialog" aria-label={t('usage.context.title')}
      tabIndex={-1} appearance="raised" radius="lg" className="context-usage-popover"
      data-openbitfun-product-component="context-usage-popover" data-openbitfun-product-part="root"
      data-testid="context-usage-popover" data-openbitfun-native-webview-occlusion
      style={{ left: layout?.left ?? 0, top: layout?.top ?? 0, width: layout?.width,
        visibility: layout ? 'visible' : 'hidden' }}>
      <div className="context-usage-popover__header"
        data-openbitfun-product-component="context-usage-popover" data-openbitfun-product-part="header">
        <Tooltip content={t('usage.context.estimateHelp')}>
          <span>{t('usage.context.title')}</span>
        </Tooltip>
        <div className="context-usage-popover__header-actions">
          <Tooltip content={t('usage.context.viewReport')}>
            <IconButton size="xs" icon={<Icon glyph={ChartPie} size="sm" />}
              aria-label={t('usage.context.viewReport')} onClick={onViewReport}
              data-testid="context-usage-view-report" />
          </Tooltip>
          <Tooltip content={t('usage.context.collapse')}>
            <IconButton size="xs" icon={<Icon glyph={Minus} size="sm" />}
              aria-label={t('usage.context.collapse')} onClick={close} />
          </Tooltip>
        </div>
      </div>
      <div className="context-usage-popover__totals"
        data-openbitfun-product-component="context-usage-popover" data-openbitfun-product-part="totals">
        <span>{percentage !== undefined
          ? t('usage.context.full', { value: formatUsagePercent(percentage, t) }) : t('usage.unavailable')}</span>
        <span>{t('usage.context.tokenCapacity', {
          used: used !== undefined ? t('usage.context.approximateTokens', { value: formatTokenCount(used, t) }) : t('usage.unavailable'),
          size: formatTokenCount(capacity, t),
        })}</span>
      </div>
      <div className="context-usage-popover__body"
        data-openbitfun-product-component="context-usage-popover" data-openbitfun-product-part="body">
        {hasDistribution && <div className="context-usage-popover__bar" role="img"
          data-openbitfun-product-component="context-usage-popover" data-openbitfun-product-part="bar"
          aria-label={t('usage.context.full', { value: formatUsagePercent(percentage!, t) })}>
          {series.filter(row => row.value > 0).map(row => (
            <span key={row.key} className={`context-usage-popover__segment context-usage-popover__series--${row.key}`}
              data-usage-category={row.key} style={{ flexGrow: row.value }} {...highlight(row)} />
          ))}
        </div>}
        {hasTotal ? <>
          <dl className="context-usage-popover__legend"
            data-openbitfun-product-component="context-usage-popover" data-openbitfun-product-part="legend">
            {rows.map(key => <div key={key} className="context-usage-popover__row" data-usage-category={key}
              data-openbitfun-product-component="context-usage-popover" data-openbitfun-product-part="item"
              tabIndex={0} {...highlight(series.find(row => row.key === key) ?? { key })}>
              <dt><span aria-hidden="true" className={`context-usage-popover__swatch context-usage-popover__series--${key}`} />
                <OverflowText>{t(`usage.context.categories.${key}`)}</OverflowText>
                {previewSession && key !== 'summarizedConversation' && key !== 'conversation' && (
                  <Tooltip content={t('usage.context.previewCategory', { category: t(`usage.context.categories.${key}`) })}>
                    <IconButton size="xs" className="context-usage-popover__preview" icon={<Icon glyph={ExternalLink} size="xs" />}
                      aria-label={t('usage.context.previewCategory', { category: t(`usage.context.categories.${key}`) })}
                      loading={previewLoading === key} disabled={previewLoading !== null && previewLoading !== key}
                      onClick={() => { void previewContext(key); }} />
                  </Tooltip>
                )}
              </dt>
              <dd>{formatTokenCount(context![key], t)}</dd>
            </div>)}
          </dl>
          {!hasDistribution && <p className="context-usage-popover__status" role="status">
            <span data-openbitfun-product-component="context-usage-popover" data-openbitfun-product-part="status">
              {t(capacity === undefined ? 'usage.context.capacityUnavailable' : 'usage.context.exceedsCapacity')}
            </span>
          </p>}
        </> : <div className="context-usage-popover__empty" role="status" aria-live="polite" aria-busy={status === 'loading'}>
          <Empty icon={<Icon glyph={ChartPie} />} imageSize="sm" title={
            <span data-openbitfun-product-component="context-usage-popover" data-openbitfun-product-part="status">
              {t(status === 'loading' ? 'usage.context.loading' : status === 'error' ? 'usage.context.loadFailed' : 'usage.context.unavailable')}
            </span>
          } />
        </div>}
      </div>
    </Card>,
    getAppearanceOverlayHost(), undefined, { ownerRef: triggerRef },
  );
}
