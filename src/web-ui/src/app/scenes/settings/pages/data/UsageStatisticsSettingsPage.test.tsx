// @vitest-environment jsdom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import UsageStatisticsSettingsPage from '@/app/scenes/settings/pages/data/UsageStatisticsSettingsPage';
import type { UsageStatistics } from '@/infrastructure/api';

const getStatisticsMock = vi.hoisted(() => vi.fn());
const translateMock = vi.hoisted(() => vi.fn((key: string) => key));
const TokenUsageStatisticsUnavailableErrorMock = vi.hoisted(() => class extends Error {
  constructor() {
    super('Usage statistics are not supported by the active host');
    this.name = 'TokenUsageStatisticsUnavailableError';
  }
});

vi.mock('@/infrastructure/api', () => ({
  TokenUsageStatisticsUnavailableError: TokenUsageStatisticsUnavailableErrorMock,
  tokenUsageStatisticsApi: { getStatistics: getStatisticsMock },
}));

vi.mock('@/infrastructure/i18n', () => ({
  useI18n: () => ({
    t: translateMock,
    formatDate: (date: Date | number) => new Date(date).toISOString(),
    formatNumber: (value: number, options?: Intl.NumberFormatOptions) => (
      new Intl.NumberFormat('en-US', options).format(value)
    ),
    resolvedTimeZone: 'UTC',
  }),
}));

vi.mock('@openbitfun/ui', async importOriginal => ({
  ...await importOriginal<typeof import('@openbitfun/ui')>(),
  ScrollArea: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  FormSection: ({
    children, title, actions, description, headingAs: _headingAs, ...props
  }: Omit<React.HTMLAttributes<HTMLElement>, 'title'> & {
    title?: React.ReactNode;
    actions?: React.ReactNode;
    description?: React.ReactNode;
    headingAs?: string;
  }) => <section {...props}>{title}{description}{actions}{children}</section>,
  FieldGroup: ({
    children, appearance: _appearance, dividers: _dividers, fieldSurface: _fieldSurface, ...props
  }: React.HTMLAttributes<HTMLDivElement> & {
    appearance?: string;
    dividers?: boolean;
    fieldSurface?: string;
  }) => <div {...props}>{children}</div>,
  Icon: ({ name, ...props }: { name: string } & React.HTMLAttributes<HTMLSpanElement>) => <span data-icon={name} {...props} />,
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  IconButton: ({
    children, icon, tooltip: _tooltip, size: _size, variant: _variant, ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    icon?: React.ReactNode;
    tooltip?: React.ReactNode;
    size?: string;
    variant?: string;
  }) => <button {...props}>{icon ?? children}</button>,
  Input: ({
    leading, trailing, size: _size, ...props
  }: React.InputHTMLAttributes<HTMLInputElement> & {
    leading?: React.ReactNode;
    trailing?: React.ReactNode;
  }) => <div>{leading}<input {...props} />{trailing}</div>,
  Select: ({ value, options, onValueChange, 'aria-label': ariaLabel }: {
    value: string | number;
    options: { value: string | number; label: string }[];
    onValueChange?: (value: string) => void;
    'aria-label'?: string;
  }) => (
    <select aria-label={ariaLabel} value={String(value)} onChange={event => onValueChange?.(event.target.value)}>
      {options.map(option => <option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}
    </select>
  ),
}));

vi.mock('../../../../../infrastructure/config/components/common', async importOriginal => ({
  ...await importOriginal<typeof import('@/infrastructure/config/components/common')>(),
  ConfigLoadingState: ({ label }: { label?: string }) => <div data-testid="usage-loading">{label}</div>,
  ConfigMessage: ({ message }: { message: { type: string; text: string } | null }) => message ? (
    <div data-testid="usage-message" data-message-type={message.type}>{message.text}</div>
  ) : null,
  ConfigRefreshButton: ({ onClick }: { onClick?: () => void }) => (
    <button type="button" data-testid="usage-refresh" onClick={onClick} />
  ),
}));

const SAMPLE_STATS: UsageStatistics = {
  totalRequests: 47,
  totalTokens: 4_800_000,
  totalInputTokens: 4_400_000,
  totalOutputTokens: 400_000,
  totalCachedTokens: 4_200_000,
  totalCacheWriteTokens: 0,
  totalCacheReportedInputTokens: 4_400_000,
  byModel: [{
    key: 'model-config:deepseek', name: 'deepseek-v4-flash', providerName: 'DeepSeek',
    attributionStatus: 'resolved', requests: 47, tokens: 4_800_000, cacheHitRate: 0.95679,
  }],
  byGroup: [{
    key: 'provider:deepseek', name: 'DeepSeek', providerName: null,
    attributionStatus: 'resolved', requests: 47, tokens: 4_800_000, cacheHitRate: 0.95,
  }],
  byEndpoint: [{
    key: 'endpoint:api.openbitfun.com/v1/chat/completions',
    name: 'api.openbitfun.com/v1/chat/completions', providerName: null,
    attributionStatus: 'resolved', requests: 47, tokens: 4_800_000, cacheHitRate: 0.95,
  }],
  trend: [{
    bucket: '2026-08-16T11:00:00.000Z', inputTokens: 1_000_000, outputTokens: 100_000,
    cacheReadTokens: 900_000, cacheWriteTokens: 50_000, cacheHitRate: 0.9,
  }, {
    bucket: '2026-08-16T12:00:00.000Z', inputTokens: 2_000_000, outputTokens: 200_000,
    cacheReadTokens: 1_900_000, cacheWriteTokens: 0, cacheHitRate: 0.95,
  }],
  granularity: 'day',
};

describe('UsageStatisticsSettingsPage', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    getStatisticsMock.mockReset();
    getStatisticsMock.mockResolvedValue(SAMPLE_STATS);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render() {
    await act(async () => { root.render(<UsageStatisticsSettingsPage />); });
    await act(async () => { await Promise.resolve(); });
  }

  it('places the fixed six-month heatmap first and includes subagent calls in both queries', async () => {
    await render();

    expect(getStatisticsMock).toHaveBeenCalledWith({
      timeRange: 'thisMonth', granularity: 'day', timeZone: 'UTC', includeSubagent: true,
    });
    expect(getStatisticsMock).toHaveBeenCalledWith(expect.objectContaining({
      timeRange: 'custom', granularity: 'day', timeZone: 'UTC', includeSubagent: true,
    }));
    const sections = container.querySelectorAll('.openbitfun-config-page-section');
    expect(sections[0]?.getAttribute('data-openbitfun-part')).toBe('activityPanel');
    expect(sections[1]?.getAttribute('data-openbitfun-part')).toBe('overview');
    expect(container.querySelector('[data-openbitfun-part="summary"]')?.textContent).toContain('4.8M');
    expect(sections[1]?.querySelectorAll('.openbitfun-config-page-row')).toHaveLength(5);
    expect(sections[1]?.querySelector('[data-openbitfun-part="summary"]')?.closest('.openbitfun-config-page-row__control')).not.toBeNull();
    expect(container.querySelectorAll('button.openbitfun-usage-stats__activity-day').length).toBeGreaterThanOrEqual(181);
  });

  it('changes only the selected-period query when the time range changes', async () => {
    await render();
    const select = container.querySelector('select[aria-label="timeRange.label"]') as HTMLSelectElement;
    await act(async () => {
      const nativeSet = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      nativeSet?.call(select, 'last24Hours');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); });
    expect(getStatisticsMock).toHaveBeenCalledTimes(3);
    expect(getStatisticsMock).toHaveBeenLastCalledWith({
      timeRange: 'last24Hours', granularity: 'hour', timeZone: 'UTC', includeSubagent: true,
    });
  });

  it('searches only the visible breakdown and preserves same-named model identities', async () => {
    getStatisticsMock.mockResolvedValue({
      ...SAMPLE_STATS,
      byModel: [
        { ...SAMPLE_STATS.byModel[0], key: 'model-config:a', name: 'Same', providerName: 'Provider A' },
        { ...SAMPLE_STATS.byModel[0], key: 'model-config:b', name: 'Same', providerName: 'Provider B' },
        { ...SAMPLE_STATS.byModel[0], key: 'missing-config:c', name: 'Legacy', providerName: null, attributionStatus: 'config_missing' },
      ],
    });
    await render();
    const rows = container.querySelectorAll('[data-openbitfun-part="distributions"] [role="tabpanel"] .openbitfun-config-page-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain('Provider A');
    expect(rows[1]?.textContent).toContain('Provider B');
    expect(rows[2]?.textContent).toContain('attribution.deletedConfig');

    const input = container.querySelector('[data-testid="usage-filter-input"]') as HTMLInputElement;
    await act(async () => {
      const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      nativeSet?.call(input, 'Provider B');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelectorAll('[data-openbitfun-part="distributions"] [role="tabpanel"] .openbitfun-config-page-row')).toHaveLength(1);
    expect(container.querySelector('[data-openbitfun-part="summary"]')?.textContent).toContain('4.8M');
    expect(getStatisticsMock).toHaveBeenCalledTimes(2);
  });

  it('shows trend, cache, and endpoint data without a disclosure control', async () => {
    await render();
    const details = container.querySelector('[data-openbitfun-part="details"]')!;
    expect(details.querySelector('button[aria-expanded]')).toBeNull();
    expect(details.querySelector('.openbitfun-usage-stats__trend-svg')).not.toBeNull();
    expect(details.querySelectorAll('.openbitfun-config-page-row').length).toBeGreaterThanOrEqual(4);
    expect(details.textContent).toContain('trend.partial');
  });

  it('distinguishes an empty selected period from all-time empty data', async () => {
    getStatisticsMock.mockResolvedValue({ ...SAMPLE_STATS, totalRequests: 0, byModel: [], byGroup: [], byEndpoint: [], trend: [] });
    await render();
    expect(container.querySelector('[data-openbitfun-part="empty"]')?.textContent).toContain('empty.periodTitle');
    expect(container.querySelector('[data-openbitfun-part="details"]')).toBeNull();
  });

  it('surfaces unsupported hosts without leaving duplicate sections', async () => {
    getStatisticsMock.mockRejectedValue(new TokenUsageStatisticsUnavailableErrorMock());
    await render();
    const messages = container.querySelectorAll('[data-testid="usage-message"]');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.getAttribute('data-message-type')).toBe('info');
    expect(container.querySelector('[data-openbitfun-part="activityPanel"]')).toBeNull();
  });
});
