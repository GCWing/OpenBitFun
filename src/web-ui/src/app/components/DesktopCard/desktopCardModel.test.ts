import { describe, expect, it } from 'vitest';
import type { DesktopCardRecord } from '@/infrastructure/api/service-api/DesktopCardAPI';
import {
  countdownParts,
  effectiveCardData,
  formatCountdownClock,
  formatMetricValue,
  hasUnresolvedTemplatePaths,
  isSafeWebLink,
  knownTemplate,
  metricHint,
  metricTone,
  progressState,
  resolvePointer,
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

  it('accepts only http and https links', () => {
    expect(isSafeWebLink('https://example.com')).toBe(true);
    expect(isSafeWebLink('http://example.com/x')).toBe(true);
    expect(isSafeWebLink('javascript:alert(1)')).toBe(false);
    expect(isSafeWebLink('file:///etc/passwd')).toBe(false);
    expect(isSafeWebLink('not a url')).toBe(false);
    expect(isSafeWebLink(undefined)).toBe(false);
  });
});
