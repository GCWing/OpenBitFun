import { Fragment, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import { Circle, Signal, SignalHigh, SignalLow, SignalMedium } from 'lucide-react';
import { Icon } from '../../components/Icon/Icon';
import { Tooltip } from '../../components/Tooltip/Tooltip';
import styles from './FlowChatTurnMetrics.module.css';

export interface FlowChatTurnMetricsProps {
  label: string;
  tokenValue: string | null;
  tokenDescription: string;
  tokenDetails?: ReactNode;
  cacheHitRate: number | null;
  rateValue: string | null;
  rateDescription: string;
  rateDetails?: ReactNode;
  speedLevel: 1 | 2 | 3 | 4 | null;
  focusable?: boolean;
}

const speedGlyphs = { 1: SignalLow, 2: SignalMedium, 3: SignalHigh, 4: Signal };
// Lucide Circle has radius 10 in its shared 24-unit icon viewBox.
const ringLength = 2 * Math.PI * 10;

export interface FlowChatMetricProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'content' | 'children' | 'type'> {
  children: ReactNode;
  content: ReactNode;
  description: string;
  focusable?: boolean;
}

/** Shared capsule trigger and frosted details surface for both sides of the footer. */
export function FlowChatMetric({ children, content, description, focusable = true, disabled = false, className = '', ...props }: FlowChatMetricProps) {
  const isDisabled = disabled || !focusable;
  return <Tooltip content={content} placement="top" trigger="hover-focus" openOnClick interactive disabled={isDisabled} className={styles.detailsCard}>
    <button {...props} type="button" className={`${styles.metric} ${className}`.trim()}
      disabled={isDisabled} tabIndex={isDisabled ? -1 : 0} aria-label={description}>
      {children}
    </button>
  </Tooltip>;
}

export interface FlowChatMetricDetailsProps {
  rows: ReadonlyArray<{ label: string; value: string }>;
  note?: string;
}

export function FlowChatMetricDetails({ rows, note }: FlowChatMetricDetailsProps) {
  return <div>
    <dl className={styles.detailsGrid}>
      {rows.map(row => <Fragment key={row.label}>
        <dt className={styles.detailLabel}>{row.label}</dt>
        <dd className={styles.detailValue}>{row.value}</dd>
      </Fragment>)}
    </dl>
    {note && <p className={styles.detailsNote}>{note}</p>}
  </div>;
}

/** Compact data glyphs; measurement, thresholds and localized copy belong to the host. */
export function FlowChatTurnMetrics({
  label, tokenValue, tokenDescription, tokenDetails, cacheHitRate,
  rateValue, rateDescription, rateDetails, speedLevel, focusable = true,
}: FlowChatTurnMetricsProps) {
  const ratio = cacheHitRate !== null && Number.isFinite(cacheHitRate)
    && cacheHitRate >= 0 && cacheHitRate <= 1 ? cacheHitRate : null;
  const hasTokenUsage = tokenValue !== null || ratio !== null;
  const speedGlyph = speedLevel === null ? undefined : speedGlyphs[speedLevel];

  if (!hasTokenUsage && rateValue === null) return null;

  return <div className={styles.root} role="group" aria-label={label}
    data-openbitfun-component="flow-chat-turn-metrics" data-openbitfun-part="root">
      {hasTokenUsage && <FlowChatMetric content={tokenDetails ?? tokenDescription} description={tokenDescription} focusable={focusable}
        data-openbitfun-component="flow-chat-turn-metrics" data-openbitfun-part="tokens">
        <span className={styles.gauge} aria-hidden="true" data-cache-state={ratio === null ? 'unknown' : 'reported'}>
          <Icon glyph={Circle} size="sm" className={styles.track} />
          {ratio !== null && ratio > 0 && <Icon glyph={Circle} size="sm" className={styles.cacheFill}
            style={{ '--_cache-dash': `${ratio * ringLength} ${ringLength}` } as CSSProperties} />}
        </span>
        {tokenValue !== null && <span>{tokenValue}</span>}
      </FlowChatMetric>}
      {rateValue !== null && <FlowChatMetric content={rateDetails ?? rateDescription} description={rateDescription} focusable={focusable}
        data-openbitfun-component="flow-chat-turn-metrics" data-openbitfun-part="speed">
        {speedGlyph && <span className={styles.gauge} aria-hidden="true" data-speed-level={speedLevel}>
          <Icon glyph={Signal} size="sm" className={styles.track} />
          <Icon glyph={speedGlyph} size="sm" className={styles.speedFill} />
        </span>}
        <span>{rateValue}</span>
      </FlowChatMetric>}
  </div>;
}
