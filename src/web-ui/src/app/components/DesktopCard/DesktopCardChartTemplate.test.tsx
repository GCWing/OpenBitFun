import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopCardChartTemplate } from '@/infrastructure/api/service-api/DesktopCardAPI';
import { ChartTemplate } from './DesktopCardTemplates';
import type { DesktopCardFormatters } from './desktopCardModel';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@openbitfun/ui', () => ({
  Button: () => null,
  Checkbox: () => null,
  StatusPill: () => null,
}));

vi.mock('@/infrastructure/i18n/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
  }),
}));

vi.mock('@/infrastructure/api/service-api/CronAPI', () => ({ cronAPI: {} }));
vi.mock('./DesktopCardCustomFrame', () => ({ default: () => null }));
vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const formatters: DesktopCardFormatters = {
  formatNumber: (value, options) => (options?.style === 'percent' ? `${Math.round(value * 100)}%` : String(value)),
  formatDate: value => `d${typeof value === 'number' ? value : value.getTime()}`,
  formatRelativeTime: () => 'now',
};

describe('ChartTemplate', () => {
  let dom: JSDOM;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('navigator', dom.window.navigator);
    container = dom.window.document.getElementById('root') as HTMLDivElement;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  function render(template: DesktopCardChartTemplate, data: unknown = null) {
    act(() => {
      root.render(<ChartTemplate template={template} data={data} formatters={formatters} />);
    });
    return container.querySelector<HTMLElement>('[data-openbitfun-part="chart"]');
  }

  function marks() {
    return Array.from(container.querySelectorAll<HTMLElement>('.openbitfun-desktop-card__chart-mark'));
  }

  it('draws a ranked bar breakdown with hints and caption', () => {
    const figure = render({
      kind: 'chart',
      chart: 'bar',
      suffix: ' GB',
      items: [
        { label: 'Temp files', value: 4, hint: 'Disk Cleanup' },
        { label: 'npm cache', value: 2, tone: 'warning' },
      ],
      caption: 'Review first.',
    });
    expect(figure?.dataset.chart).toBe('bar');
    expect(figure?.getAttribute('aria-label')).toBe('Temp files 4 GB, npm cache 2 GB');
    const bars = Array.from(container.querySelectorAll<HTMLElement>('.openbitfun-desktop-card__chart-bar'));
    expect(bars.map(bar => bar.querySelector('.openbitfun-desktop-card__chart-value')?.textContent)).toEqual(['4 GB', '2 GB']);
    expect(bars[0].querySelector('.openbitfun-desktop-card__chart-hint')?.textContent).toBe('Disk Cleanup');
    expect(marks().map(mark => mark.style.inlineSize)).toEqual(['100%', '50%']);
    expect(marks()[1].dataset.tone).toBe('warning');
    expect(container.querySelector('figcaption')?.textContent).toBe('Review first.');
  });

  it('shows used against total with a remainder row on stacked charts', () => {
    render({
      kind: 'chart',
      chart: 'stacked',
      total: 100,
      remainderLabel: 'Free',
      items: [{ label: 'Apps', value: 30 }, { label: 'Media', value: 10 }],
    });
    expect(container.querySelector('.openbitfun-desktop-card__chart-total')?.textContent).toBe('40');
    expect(container.querySelector('.openbitfun-desktop-card__chart-summary')?.textContent)
      .toContain('desktopCard.chart.ofTotal:{"total":"100"} · 40%');
    const stack = container.querySelector('.openbitfun-desktop-card__chart-stack')!;
    expect(Array.from(stack.children).map(child => (child as HTMLElement).style.inlineSize)).toEqual(['30%', '10%']);
    const legend = Array.from(container.querySelectorAll('.openbitfun-desktop-card__chart-legend > li'));
    expect(legend.map(row => row.querySelector('.openbitfun-desktop-card__chart-label')?.textContent))
      .toEqual(['Apps', 'Media', 'Free']);
    expect(legend[2].querySelector('.openbitfun-desktop-card__chart-share')?.textContent).toBe('60%');
    expect(legend.map(row => row.querySelector<HTMLElement>('.openbitfun-desktop-card__chart-swatch')?.dataset.shade))
      .toEqual(['0', '1', undefined]);
  });

  it('draws donut segments clockwise from the top and the share in the center', () => {
    render({
      kind: 'chart',
      chart: 'donut',
      items: [{ label: 'Passed', value: 3, tone: 'success' }, { label: 'Failed', value: 1, tone: 'danger' }],
    });
    const circles = Array.from(container.querySelectorAll('circle'));
    expect(circles).toHaveLength(3);
    expect(circles[1].getAttribute('stroke-dasharray')).toBe('75.000 25.000');
    expect(circles[1].getAttribute('stroke-dashoffset')).toBe('25.000');
    expect(circles[2].getAttribute('stroke-dashoffset')).toBe('-50.000');
    expect(container.querySelector('.openbitfun-desktop-card__chart-donut-center')?.textContent).toBe('4');
    expect(container.textContent).not.toContain('desktopCard.chart.remaining');
  });

  it('labels columns with formatted dates and draws a line with its change and range', () => {
    render({
      kind: 'chart',
      chart: 'column',
      itemsPath: '/max',
      labelsPath: '/day',
      labelFormat: 'weekday',
    }, { max: [10, 20], day: ['2026-03-16', '2026-03-17'] });
    const columns = Array.from(container.querySelectorAll('.openbitfun-desktop-card__chart-column'));
    expect(columns.map(column => column.querySelector('.openbitfun-desktop-card__chart-column-label')?.textContent))
      .toEqual([`d${new Date(2026, 2, 16).getTime()}`, `d${new Date(2026, 2, 17).getTime()}`]);
    expect(columns.map(column => column.querySelector<HTMLElement>('.openbitfun-desktop-card__chart-mark')?.style.blockSize))
      .toEqual(['50%', '100%']);

    render({ kind: 'chart', chart: 'line', itemsPath: '', prefix: '$' }, [10, 14, 12]);
    expect(container.querySelector('.openbitfun-desktop-card__chart-total')?.textContent).toBe('$12');
    expect(container.querySelector('.openbitfun-desktop-card__chart-summary')?.textContent)
      .toContain('desktopCard.chart.changeSince:{"change":"+$2","label":"1"}');
    expect(container.querySelector('polyline')?.getAttribute('points')).toBe('0,38 50,2 100,20');
    expect(container.querySelector('.openbitfun-desktop-card__chart-axis')?.textContent)
      .toContain('desktopCard.chart.range:{"min":"$10","max":"$14"}');
  });

  it('reports empty data and styles from a newer build explicitly', () => {
    render({ kind: 'chart', chart: 'bar', itemsPath: '/rows' }, { rows: 'not an array' });
    expect(container.textContent).toBe('desktopCard.chart.empty');
    render({ kind: 'chart', chart: 'radar', items: [{ label: 'a', value: 1 }] });
    expect(container.textContent).toBe('desktopCard.unsupportedTemplate');
  });
});
