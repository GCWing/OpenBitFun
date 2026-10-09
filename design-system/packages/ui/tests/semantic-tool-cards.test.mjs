import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentRosterToolCard, GoalToolCard, ImageAnalysisToolCard, MarketplacePublishToolCard, PortForwardToolCard } from '../dist/flow-chat.js';

test('raw-only historical cards retain an accessible expansion affordance before lazy details are formatted', () => {
  for (const attention of ['ambient', 'prominent']) {
    const html = renderToStaticMarkup(createElement(GoalToolCard, {
      status: 'completed', action: 'Read goal', attention, detailsAvailable: true, onToggle() {},
    }));
    assert.match(html, /aria-expanded="false"/);
    assert.match(html, /data-openbitfun-icon="target"|lucide-target/);
  }
});

test('business outcome, deletion count, independent actions and failed details stay available', () => {
  const html = renderToStaticMarkup(createElement(AgentRosterToolCard, {
    deleting: true, status: 'completed', action: 'Delete agents', attention: 'prominent',
    summary: 'One selected root', resultSummary: 'Four deleted agents', outcome: { label: 'Deleted', tone: 'neutral' },
    actions: [{ key: 'open', label: 'Open transcript', onPress() {} }], detailsAvailable: true, onToggle() {},
  }));
  assert.match(html, /Four deleted agents/); assert.match(html, /Deleted/);
  const buttons = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]);
  assert.ok(buttons.find(button => button.includes('Open transcript')));
  assert.ok(!buttons.find(button => button.includes('aria-expanded') && button.includes('Open transcript')));
  const failure = renderToStaticMarkup(createElement(MarketplacePublishToolCard, {
    status: 'error', action: 'Submit', attention: 'prominent', isExpanded: true, onToggle() {},
    error: 'Authentication expired', sections: [{ key: 'partial', label: 'Receipt', content: 'Upload receipt remains available' }],
  }));
  assert.match(failure, /Authentication expired/); assert.match(failure, /Upload receipt remains available/);
});

test('network endpoints remain distinct and ordered record lists preserve semantics', () => {
  const html = renderToStaticMarkup(createElement(PortForwardToolCard, {
    status: 'completed', action: 'Forward port', isExpanded: true, onToggle() {}, ordered: true,
    connection: { from: 'remote:3000', to: '127.0.0.1:5174' }, records: [{ key: '1', title: 'Recorded listener' }],
  }));
  assert.match(html, /data-openbitfun-part="connection"/); assert.match(html, /remote:3000/); assert.match(html, /127\.0\.0\.1:5174/);
  assert.match(html, /<ol\b/); assert.match(html, /<li\b/);
});

test('auxiliary icons follow ambient subjects while prominent cards keep trailing controls', () => {
  for (const attention of ['ambient', 'prominent']) {
    const html = renderToStaticMarkup(createElement(ImageAnalysisToolCard, {
      attention, status: 'error', action: 'Analyze image', summary: 'original.png',
      resultSummary: 'Recorded dimensions', error: 'Analysis failed', isExpanded: true, onToggle() {},
      actions: [{ key: 'source', label: 'Open original image', icon: 'arrow-up-right', onPress() {} }],
    }));
    const control = html.indexOf('aria-label="Open original image"');
    const result = html.indexOf('Recorded dimensions');
    assert.ok(html.indexOf('original.png') < control);
    assert.ok(attention === 'ambient' ? control < result : result < control);
    assert.match(html, /data-reveal="hover"/);
    assert.doesNotMatch(html, />Open original image</);
    assert.match(html, /Analysis failed/);
  }
});

test('authorization remains a visible labelled decision outside auxiliary reveal', () => {
  for (const attention of ['ambient', 'prominent']) {
    const html = renderToStaticMarkup(createElement(MarketplacePublishToolCard, {
      attention, status: 'completed', action: 'Publish', summary: 'Clock',
      actions: [{ key: 'authorize', label: 'Authorize publishing', intent: 'primary', onPress() {} }],
    }));
    assert.match(html, />Authorize publishing</);
    assert.doesNotMatch(html, /data-reveal="hover"/);
  }
});
