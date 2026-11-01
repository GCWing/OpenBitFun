import { describe, expect, it } from 'vitest';
import type { DesktopCardChartTemplate, DesktopCardRecord } from '@/infrastructure/api/service-api/DesktopCardAPI';
import {
  chartSeries,
  chartShare,
  countdownParts,
  effectiveCardData,
  formatChartLabel,
  formatChartValue,
  formatCountdownClock,
  formatMetricValue,
  hasUnresolvedTemplatePaths,
  isKnownChartStyle,
  isSafeWebLink,
  knownTemplate,
  lineGeometry,
  metricHint,
  metricTone,
  progressState,
  resolvePointer,
  templateDataPaths,
  type DesktopCardFormatters,
} from './desktopCardModel';

const formatters: DesktopCardFormatters = {
  formatNumber: (value, options) => `${options?.style ?? 'n'}:${value}${options?.currency ? `:${options.currency}` : ''}`,
  formatDate: value => `date:${typeof value === 'number' ? value : value.getTime()}`,
  formatRelativeTime: value => `rel:${typeof value === 'number' ? value : value.getTime()}`,
};

function card(overrides: Partial<DesktopCardRecord>): DesktopCardRecord {
  return {
    id: 'card-1',
    title: 'Card',
    template: { kind: 'note', text: 'hello' },
    visible: true,
    alwaysOnTop: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  } as DesktopCardRecord;
}

describe('desktop card model', () => {
  it('detects template paths the rendered data leaves missing or null', () => {
    const metrics = { kind: 'metrics', items: [{ label: 'Stars', path: '/stars', hintPath: '/hint' }] } as const;
    const source = { kind: 'command', command: 'gh api', intervalSeconds: 300 } as const;
    expect(hasUnresolvedTemplatePaths(card({
      template: metrics,
      dataSource: source,
      lastData: { fetchedAtMs: 1, value: { stars: 3, hint: 'ok' } },
    }))).toBe(false);
    expect(hasUnresolvedTemplatePaths(card({
      template: metrics,
      dataSource: source,
      lastData: { fetchedAtMs: 1, value: { stars: 3, hint: null } },
    }))).toBe(true);
    expect(hasUnresolvedTemplatePaths(card({
      template: { kind: 'progress', valuePath: '/done', maxPath: '/total' },
      data: { done: 1 },
    }))).toBe(true);
    expect(hasUnresolvedTemplatePaths(card({ lastData: { fetchedAtMs: 1, value: null } }))).toBe(false);
  });

  it('resolves RFC 6901 pointers including escapes and array indexes', () => {
    const root = { a: { 'b/c': [10, { 'd~e': 'x' }] } };
    expect(resolvePointer(root, '')).toBe(root);
    expect(resolvePointer(root, '/a/b~1c/0')).toBe(10);
    expect(resolvePointer(root, '/a/b~1c/1/d~0e')).toBe('x');
    expect(resolvePointer(root, '/a/missing')).toBeUndefined();
    expect(resolvePointer(root, '/a/b~1c/01')).toBeUndefined();
    expect(resolvePointer(root, 'a')).toBeUndefined();
    expect(resolvePointer(root, undefined)).toBeUndefined();
  });

  it('reads fetched data only when the card has a data source', () => {
    expect(effectiveCardData(card({ data: { local: 1 } }))).toEqual({ local: 1 });
    expect(effectiveCardData(card({
      data: { local: 1 },
      dataSource: { kind: 'http', url: 'https://example.com', intervalSeconds: 60 },
      lastData: { fetchedAtMs: 2, value: { remote: 2 } },
    }))).toEqual({ remote: 2 });
    expect(effectiveCardData(card({ dataSource: { kind: 'http', url: 'https://example.com', intervalSeconds: 60 } }))).toBeNull();
  });

  it('treats templates written by a newer build as unsupported', () => {
    expect(knownTemplate(card({}))?.kind).toBe('note');
    expect(knownTemplate(card({ template: { kind: 'hologram' } as never }))).toBeNull();
  });

  it('formats metric values with prefixes, units and empty placeholders', () => {
    expect(formatMetricValue({ label: 'x', format: 'number' }, '12.5', formatters)).toBe('n:12.5');
    expect(formatMetricValue({ label: 'x', format: 'percent' }, 5, formatters)).toBe('percent:0.05');
    expect(formatMetricValue({ label: 'x', format: 'currency', currency: 'EUR' }, 3, formatters)).toBe('currency:3:EUR');
    expect(formatMetricValue({ label: 'x', format: 'datetime' }, 1_700_000_000, formatters)).toBe('date:1700000000000');
    expect(formatMetricValue({ label: 'x', format: 'relativeTime' }, '2026-01-01T00:00:00Z', formatters))
      .toBe(`rel:${Date.parse('2026-01-01T00:00:00Z')}`);
    expect(formatMetricValue({ label: 'x', prefix: '#', suffix: ' open' }, 4, formatters)).toBe('#4 open');
    expect(formatMetricValue({ label: 'x' }, { nested: true }, formatters)).toBe('{"nested":true}');
    expect(formatMetricValue({ label: 'x', format: 'number' }, null, formatters)).toBe('—');
    expect(formatMetricValue({ label: 'x', format: 'number' }, 'n/a', formatters)).toBe('n/a');
  });

  it('chooses metric tone from tone maps, then sign, then the static tone', () => {
    expect(metricTone({ label: 'x', toneMap: { MERGED: 'success' }, tone: 'info' }, 'MERGED')).toBe('success');
    expect(metricTone({ label: 'x', toneMap: { MERGED: 'success' }, tone: 'info' }, 'OPEN')).toBe('info');
    expect(metricTone({ label: 'x', signTone: true }, -1.2)).toBe('danger');
    expect(metricTone({ label: 'x', signTone: true }, '3')).toBe('success');
    expect(metricTone({ label: 'x', signTone: true }, 0)).toBe('neutral');
    expect(metricTone({ label: 'x', tone: 'not-a-tone' }, 1)).toBeUndefined();
  });

  it('prefers a resolved hint over the static hint', () => {
    expect(metricHint({ label: 'x', hint: 'static', hintPath: '/h' }, { h: 'live' })).toBe('live');
    expect(metricHint({ label: 'x', hint: 'static', hintPath: '/missing' }, {})).toBe('static');
  });

  it('clamps progress and defaults an invalid max to 100', () => {
    expect(progressState({ kind: 'progress', valuePath: '/done', maxPath: '/total', statusPath: '/s' }, { done: 3, total: 4, s: 'Building' }))
      .toEqual({ value: 3, max: 4, ratio: 0.75, status: 'Building' });
    expect(progressState({ kind: 'progress', value: 150, max: 0 }, null)).toEqual({ value: 150, max: 100, ratio: 1, status: undefined });
    expect(progressState({ kind: 'progress' }, null).ratio).toBeNull();
  });

  it('splits countdowns into days and a clock and reports elapsed ratio', () => {
    const parts = countdownParts(1_000 + 90_061_000, 1_000, 1_000);
    expect(parts).toMatchObject({ days: 1, hours: 1, minutes: 1, seconds: 1, due: false, elapsedRatio: 0 });
    expect(formatCountdownClock(parts)).toBe('01:01:01');
    const short = countdownParts(10_000, 0, 5_500);
    expect(formatCountdownClock(short)).toBe('00:05');
    expect(short.elapsedRatio).toBeCloseTo(0.55);
    const due = countdownParts(10_000, undefined, 20_000);
    expect(due).toMatchObject({ due: true, remainingMs: 0, elapsedRatio: null });
  });

  describe('charts', () => {
    const chart = (overrides: Partial<DesktopCardChartTemplate>): DesktopCardChartTemplate => ({
      kind: 'chart',
      chart: 'bar',
      ...overrides,
    });

    it('recognizes chart templates and their data paths', () => {
      expect(knownTemplate(card({ template: chart({ items: [{ label: 'a', value: 1 }] }) }))?.kind).toBe('chart');
      expect(isKnownChartStyle('donut')).toBe(true);
      expect(isKnownChartStyle('radar')).toBe(false);
      expect(isKnownChartStyle('toString')).toBe(false);
      expect(templateDataPaths(chart({ itemsPath: '/rows', labelsPath: '/labels', totalPath: '/total' })))
        .toEqual(['/rows', '/labels', '/total']);
      expect(hasUnresolvedTemplatePaths(card({
        template: chart({ chart: 'column', itemsPath: '/daily/max', labelsPath: '/daily/time' }),
        data: { daily: { max: [1, 2] } },
      }))).toBe(true);
    });

    it('reads static items and computes the remainder of a total', () => {
      const series = chartSeries(chart({
        chart: 'stacked',
        total: 906,
        items: [
          { label: 'WeChat', value: 62.7, tone: 'warning', hint: 'Clean inside WeChat' },
          { label: 'Other used', value: 249.3, tone: 'not-a-tone' },
        ],
      }), null, 'Other');
      expect(series.points).toEqual([
        { label: 'WeChat', value: 62.7, tone: 'warning', hint: 'Clean inside WeChat' },
        { label: 'Other used', value: 249.3, tone: undefined, hint: undefined },
      ]);
      expect(series.sum).toBeCloseTo(312);
      expect(series.total).toBe(906);
      expect(series.remainder).toBeCloseTo(594);
      expect(series.scale).toBe(906);
    });

    it('reads bound arrays of numbers, pairs, and objects', () => {
      const data = {
        temps: [21, '23.5', null, 19],
        days: ['2026-03-16', '2026-03-17', '2026-03-18', '2026-03-19'],
        pairs: [['npm', 4.12], ['pip', 'x'], ['uv', 1.69]],
        rows: [{ name: 'Temp', size: 4.44, todo: 'Disk Cleanup', tone: 'warning' }, { size: 2 }],
      };
      expect(chartSeries(chart({ chart: 'column', itemsPath: '/temps', labelsPath: '/days' }), data, 'Other').points)
        .toEqual([
          { label: '2026-03-16', value: 21 },
          { label: '2026-03-17', value: 23.5 },
          { label: '2026-03-19', value: 19 },
        ]);
      expect(chartSeries(chart({ itemsPath: '/pairs' }), data, 'Other').points)
        .toEqual([{ label: 'npm', value: 4.12 }, { label: 'uv', value: 1.69 }]);
      expect(chartSeries(chart({ itemsPath: '/rows', labelKey: 'name', valueKey: 'size', hintKey: 'todo' }), data, 'Other').points)
        .toEqual([
          { label: 'Temp', value: 4.44, tone: 'warning', hint: 'Disk Cleanup' },
          { label: '2', value: 2, tone: undefined, hint: undefined },
        ]);
      expect(chartSeries(chart({ itemsPath: '/missing' }), data, 'Other').points).toEqual([]);
      expect(chartSeries(chart({ itemsPath: '/days' }), data, 'Other').points).toEqual([]);
    });

    it('trims long arrays per style and merges extra parts into Other', () => {
      const values = Array.from({ length: 130 }, (_, index) => index + 1);
      const line = chartSeries(chart({ chart: 'line', itemsPath: '' }), values, 'Other');
      expect(line.points).toHaveLength(120);
      expect(line.points[0].value).toBe(11);
      expect(line.total).toBeNull();

      const bar = chartSeries(chart({ chart: 'bar', itemsPath: '' }), values, 'Other');
      expect(bar.points.map(point => point.value)).toEqual(values.slice(0, 12));
      expect(bar.scale).toBe(12);

      const donut = chartSeries(chart({ chart: 'donut', itemsPath: '' }), values.slice(0, 8), 'Other');
      expect(donut.points).toHaveLength(6);
      expect(donut.points[5]).toEqual({ label: 'Other', value: 6 + 7 + 8, merged: true });
      expect(donut.sum).toBe(36);
      expect(donut.scale).toBe(36);
    });

    it('clamps negative values except on line charts and ignores invalid totals', () => {
      const data = { values: [-3, 5], total: 'n/a' };
      expect(chartSeries(chart({ chart: 'column', itemsPath: '/values' }), data, 'Other').points.map(point => point.value))
        .toEqual([0, 5]);
      expect(chartSeries(chart({ chart: 'line', itemsPath: '/values' }), data, 'Other').points.map(point => point.value))
        .toEqual([-3, 5]);
      const bar = chartSeries(chart({ itemsPath: '/values', totalPath: '/total' }), data, 'Other');
      expect(bar.total).toBeNull();
      expect(bar.remainder).toBe(0);
      const scaled = chartSeries(chart({ itemsPath: '/values', total: 20 }), data, 'Other');
      expect(scaled.scale).toBe(20);
      expect(chartShare(5, scaled.scale)).toBe(0.25);
      expect(chartShare(5, 0)).toBe(0);
      expect(chartShare(30, 20)).toBe(1);
    });

    it('formats values and timestamp labels through the shared formatters', () => {
      expect(formatChartValue(chart({ suffix: ' GB' }), 4.12, formatters)).toBe('n:4.12 GB');
      expect(formatChartValue(chart({ format: 'currency', currency: 'USD' }), 3, formatters)).toBe('currency:3:USD');
      expect(formatChartLabel(chart({}), '2026-03-17', formatters)).toBe('2026-03-17');
      expect(formatChartLabel(chart({ labelFormat: 'weekday' }), '2026-03-17', formatters))
        .toBe(`date:${new Date(2026, 2, 17).getTime()}`);
      expect(formatChartLabel(chart({ labelFormat: 'date' }), '1700000000', formatters)).toBe('date:1700000000000');
      expect(formatChartLabel(chart({ labelFormat: 'time' }), 'later', formatters)).toBe('later');
    });

    it('maps line points into the view box', () => {
      expect(lineGeometry([{ label: 'a', value: 1 }])).toBeNull();
      const geometry = lineGeometry([
        { label: 'a', value: 10 },
        { label: 'b', value: 20 },
        { label: 'c', value: 15 },
      ]);
      expect(geometry).toEqual({
        line: '0,38 50,2 100,20',
        area: 'M0,40 L0,38 L50,2 L100,20 L100,40 Z',
        min: 10,
        max: 20,
        first: 10,
        last: 15,
      });
      expect(lineGeometry([{ label: 'a', value: 3 }, { label: 'b', value: 3 }])?.line).toBe('0,20 100,20');
    });
  });

  it('accepts only http and https links', () => {
    expect(isSafeWebLink('https://example.com')).toBe(true);
    expect(isSafeWebLink('http://example.com/x')).toBe(true);
    expect(isSafeWebLink('javascript:alert(1)')).toBe(false);
    expect(isSafeWebLink('file:///etc/passwd')).toBe(false);
    expect(isSafeWebLink('not a url')).toBe(false);
    expect(isSafeWebLink(undefined)).toBe(false);
  });
});
