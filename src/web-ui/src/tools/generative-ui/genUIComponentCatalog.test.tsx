/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GenUIOpenUIDocument from './genUIOpenUI';
import { genUIProduct } from './genUIProduct';

describe('default OpenUI component catalog', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('mounts the core content and local interaction primitives together', async () => {
    const errors = vi.fn();
    await act(async () => root.render(<GenUIOpenUIDocument
      source={{ kind: 'openui-lang', content: [
        'root = Col([markdown, image, list, table, chart, map, slider, date, svg, html])',
        'markdown = Markdown("# Hello")',
        'image = Image("https://example.com/image.png", "Example")',
        'list = List(["One"], "bullet")',
        'table = Table(["Name"], [["Ada"]])',
        'chart = Chart("bar", [{label: "Q1", value: 4}], "label", ["value"], "number")',
        'map = Map([{label: "Home", lat: 31.2, lng: 121.5}])',
        'slider = Slider($range, 0, 10, 1, "Range")',
        'date = DatePicker($date, "Date")',
        'line = Line(50, 20, 50, 80, "accent", 3)',
        'circle = Circle(50, 50, 10, "warning", "accent", 2)',
        'caption = SvgText("Pendulum", 50, 96, 10, "muted", "middle")',
        'svg = Svg([line, circle, caption], "0 0 100 100")',
        'html = HtmlView("<p>Safe</p>")',
      ].join('\n') }}
      library={genUIProduct.libraries['openbitfun.composable.v1']}
      initialState={{ range: 5, date: '2026-10-31' }}
      onError={next => errors(...next)}
    />));
    expect(errors.mock.calls.filter(([message]) => message).length).toBe(0);
    expect(container.querySelector('.gen-ui-oi-markdown')).not.toBeNull();
    expect(container.querySelector('.gen-ui-oi-image img')?.getAttribute('alt')).toBe('Example');
    expect(container.querySelectorAll('.gen-ui-oi-list li')).toHaveLength(1);
    expect(container.querySelectorAll('.gen-ui-oi-table tbody tr')).toHaveLength(1);
    expect(container.querySelectorAll('.gen-ui-oi-chart rect')).toHaveLength(1);
    expect(container.querySelectorAll('.gen-ui-oi-map circle')).toHaveLength(1);
    expect(container.querySelector('input[type="range"]')).not.toBeNull();
    expect(container.querySelector('input[type="date"]')).not.toBeNull();
    expect(container.querySelector('.gen-ui-oi-svg circle')).not.toBeNull();
    expect(container.querySelector('.gen-ui-oi-svg line')?.getAttribute('stroke')).toBe('var(--openbitfun-color-accent-default)');
    expect(container.querySelector('.gen-ui-oi-svg text')?.getAttribute('fill')).toBe('var(--openbitfun-color-content-secondary)');
    expect(container.querySelector('.gen-ui-oi-svg')?.getAttribute('height')).toBeNull();
    expect(container.querySelector('.gen-ui-oi-html')).not.toBeNull();
  });

  it('honors an explicit SVG height instead of deriving it from the wide card', async () => {
    await act(async () => root.render(<GenUIOpenUIDocument
      source={{ kind: 'openui-lang', content: 'root = Svg([Line(0, 0, 100, 100, "accent", 2)], "0 0 100 100", "100%", 180)' }}
      library={genUIProduct.libraries['openbitfun.composable.v1']}
    />));
    const svg = container.querySelector<SVGSVGElement>('.gen-ui-oi-svg');
    expect(svg?.getAttribute('height')).toBe('180');
    expect(svg?.style.height).toBe('180px');
  });
});
