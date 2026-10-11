import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SplitView, SplitViewPrimaryDock } from '../dist/index.js';

test('SplitView publishes a stable primary dock without changing the transcript host', () => {
  const markup = renderToStaticMarkup(createElement(SplitView, {
    layout: 'overlay', rightSize: 500, onRightSizeChange() {}, dividerLabel: 'Resize',
    primary: createElement('div', null,
      createElement('section', { 'data-transcript': true }, 'History'),
      createElement(SplitViewPrimaryDock, null, createElement('textarea', { defaultValue: 'Draft' }))),
    secondary: createElement('iframe', { title: 'Browser' }),
  }));
  assert.match(markup, /data-openbitfun-part="primaryDock"><textarea>Draft<\/textarea>/);
  assert.match(markup, /<section data-transcript="true">History<\/section>/);
});

test('the dock tracks displayed width only in overlay layout and leaves primary geometry full width', async () => {
  const styles = await readFile(new URL('../src/components/SplitView/SplitView.module.css', import.meta.url), 'utf8');
  assert.match(styles, /\.root\[data-layout="overlay"\]:not\(\[data-mode="secondary"\]\)\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(styles, /\.primaryDock\s*\{[^}]*position: absolute;[^}]*inline-size: 100%;[^}]*pointer-events: none;/);
  assert.match(styles, /\.root\[data-layout="overlay"\]\[data-mode="split"\] > \.primary \.primaryDock\s*\{[^}]*inline-size: max\(0px, calc\(100% - var\(--_split-view-right-size\) - var\(--openbitfun-border-width-default\)\)\)/);
  assert.match(styles, /\[data-secondary-side="left"\] > \.primary \.primaryDock\s*\{[^}]*inset-inline-start: calc\(var\(--_split-view-right-size\) \+ var\(--openbitfun-border-width-default\)\)/);
});
