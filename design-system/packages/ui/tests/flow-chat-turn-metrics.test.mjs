import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FlowChatMetric, FlowChatMetricDetails, FlowChatTurnMetrics } from '../dist/flow-chat.js';

const props = {
  label: 'Turn metrics', tokenValue: '12.8K', tokenDescription: 'Total 12.8K, input cache hit 72%',
  cacheHitRate: 0.72, rateValue: '68 t/s', rateDescription: 'Average output 68 tokens/s, fast',
  speedLevel: 3,
};

test('the animated outer card owns the backdrop and provides an opaque fallback', async () => {
  const css = await readFile(new URL('../src/flow-chat/conversation/FlowChatTurnMetrics.module.css', import.meta.url), 'utf8');
  assert.match(css, /\.detailsCard\s*\{[^}]*background:\s*var\(--openbitfun-color-surface-raised\)/);
  assert.match(css, /@supports[^{}]*backdrop-filter[^{}]*\{\s*\.detailsCard\s*\{[^}]*backdrop-filter:\s*var\(--openbitfun-effect-blur-base\)/);
  const content = css.match(/\.detailsCard \[data-openbitfun-part='content'\]\s*\{([^}]*)\}/)?.[1];
  assert.match(content, /background:\s*transparent/);
  assert.match(content, /backdrop-filter:\s*none/);
  assert.match(css, /@media \(prefers-reduced-transparency: reduce\)[^{]*\{\s*\.detailsCard\s*\{[^}]*background:\s*var\(--openbitfun-color-surface-raised\)/);
});

test('metrics retain exact accessible descriptions and reuse the shared Icon glyphs', () => {
  const html = renderToStaticMarkup(React.createElement(FlowChatTurnMetrics, props));
  assert.match(html, /aria-label="Turn metrics"/);
  assert.match(html, /aria-label="Total 12.8K, input cache hit 72%"/);
  assert.match(html, /aria-label="Average output 68 tokens\/s, fast"/);
  assert.match(html, /data-openbitfun-component="icon"/);
  assert.match(html, /lucide-circle/);
  assert.match(html, /lucide-signal-high/);
  assert.match(html, /data-speed-level="3"/);
  assert.match(html, /12.8K/);
  assert.match(html, /68 t\/s/);
});

test('usage retains its cache icon without a ratio and pending metrics cannot take focus', () => {
  const unknown = renderToStaticMarkup(React.createElement(FlowChatTurnMetrics, {
    ...props, tokenDescription: 'Total 12.8K', cacheHitRate: null, speedLevel: null, focusable: false,
  }));
  assert.match(unknown, /data-openbitfun-part="tokens"/);
  assert.match(unknown, /data-cache-state="unknown"/);
  assert.match(unknown, /lucide-circle/);
  assert.match(unknown, />12\.8K<\/span>/);
  assert.doesNotMatch(unknown, /--_cache-dash|data-speed-level|lucide-signal|tabindex="0"|input cache hit/);
});

test('reported zero usage and cache remain distinct from missing data', () => {
  const zero = renderToStaticMarkup(React.createElement(FlowChatTurnMetrics, {
    ...props, tokenValue: '0', tokenDescription: 'Total 0, input cache hit 0%', cacheHitRate: 0, rateValue: null,
  }));
  assert.match(zero, /data-openbitfun-part="tokens"/);
  assert.match(zero, /data-cache-state="reported"/);
  assert.match(zero, /lucide-circle/);
  assert.match(zero, />0<\/span>/);
  assert.doesNotMatch(zero, /--_cache-dash|data-cache-state="unknown"/);
});

test('cache data keeps the usage unit visible without inventing a total', () => {
  for (const cacheHitRate of [0, 0.72, 1]) {
    const html = renderToStaticMarkup(React.createElement(FlowChatTurnMetrics, {
      ...props, tokenValue: null, tokenDescription: `Input cache hit ${cacheHitRate * 100}%`, cacheHitRate, rateValue: null,
    }));
    assert.match(html, /data-openbitfun-part="tokens"/);
    assert.match(html, /data-cache-state="reported"/);
    assert.match(html, /lucide-circle/);
    assert.doesNotMatch(html, /12\.8K|Total|data-openbitfun-part="speed"|<span><\/span>/);
  }
});

test('invalid cache ratios retain a neutral icon only when usage is available', () => {
  for (const cacheHitRate of [-0.1, 1.1, NaN, Infinity]) {
    const render = tokenValue => renderToStaticMarkup(React.createElement(FlowChatTurnMetrics, {
      ...props, tokenValue, tokenDescription: 'Total 12.8K', cacheHitRate, rateValue: null,
    }));
    const html = render('12.8K');
    assert.match(html, /data-cache-state="unknown"/);
    assert.match(html, /lucide-circle/);
    assert.doesNotMatch(html, /--_cache-dash/);
    assert.equal(render(null), '');
  }
});

test('the usage unit is omitted only when both values are missing, independently of speed', () => {
  const render = overrides => renderToStaticMarkup(React.createElement(FlowChatTurnMetrics, { ...props, ...overrides }));
  assert.equal(render({ tokenValue: null, cacheHitRate: null, rateValue: null }), '');
  const tokensOnly = render({ rateValue: null });
  assert.match(tokensOnly, /data-openbitfun-part="tokens"/);
  assert.doesNotMatch(tokensOnly, /data-openbitfun-part="speed"|68 t\/s/);
  const speedOnly = render({ tokenValue: null, cacheHitRate: null, rateValue: '0 t/s', speedLevel: 1 });
  assert.match(speedOnly, /0 t\/s/);
  assert.doesNotMatch(speedOnly, /data-openbitfun-part="tokens"|12\.8K/);
});

test('elapsed time uses its own metric trigger and separates visible text from details', () => {
  const html = renderToStaticMarkup(React.createElement(FlowChatMetric, {
    description: 'Completed 15:40:47, duration 1m16s',
    content: React.createElement(FlowChatMetricDetails, { rows: [
      { label: 'Completed', value: '15:40:47' }, { label: 'Duration', value: '1m16s' },
    ] }),
  }, '1m16s'));
  assert.match(html, /aria-label="Completed 15:40:47, duration 1m16s"/);
  assert.match(html, /<button type="button"[^>]*>1m16s<\/button>/);
  assert.doesNotMatch(html, />15:40:47</);
  const details = renderToStaticMarkup(React.createElement(FlowChatMetricDetails, {
    rows: [{ label: 'Input cache hit', value: '72%' }], note: 'Input tokens only',
  }));
  assert.match(details, /<dt[^>]*>Input cache hit<\/dt>/);
  assert.match(details, /<dd[^>]*>72%<\/dd>/);
  assert.match(details, /Input tokens only/);
});
