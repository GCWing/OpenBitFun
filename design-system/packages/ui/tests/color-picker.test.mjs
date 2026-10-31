import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';
import { ColorPicker } from '../dist/index.js';

test('ColorPicker publishes its collapsed and expanded accessible anatomy without a native picker', () => {
  const collapsed = renderToStaticMarkup(createElement(ColorPicker, { value: '#3366CC' }));
  assert.match(collapsed, /aria-expanded="false"/);
  assert.match(collapsed, /hidden="" data-openbitfun-part="expansion"/);
  assert.doesNotMatch(collapsed, /type="color"/);
  const expanded = renderToStaticMarkup(createElement(ColorPicker, { value: '#3366CC', defaultOpen: true }));
  assert.match(expanded, /aria-expanded="true"/);
  assert.equal((expanded.match(/data-openbitfun-part="petal"/g) ?? []).length, 19);
  assert.match(expanded, /role="slider"[^>]*aria-label="Lightness"[^>]*aria-valuemin="0"[^>]*aria-valuemax="100"[^>]*aria-valuenow="50"/);
});
