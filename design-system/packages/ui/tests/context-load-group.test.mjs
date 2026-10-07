import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContextLoadGroup, GetToolSpecToolCard, SkillToolCard } from '../dist/flow-chat.js';

test('context loading exposes one controlled count and retains native children when expanded', () => {
  for (const expanded of [false, true]) {
    const markup = renderToStaticMarkup(React.createElement(ContextLoadGroup, {
      expanded, summary: '2 context loads', summaryDescription: 'Completed 2 context loads',
      itemCount: 2, onToggle() {}, placement: 'inline',
    }, React.createElement(SkillToolCard, { status: 'completed', summary: 'frontend-design' }),
    React.createElement(GetToolSpecToolCard, { status: 'completed', summary: 'WebSearch' })));
    assert.match(markup, /data-openbitfun-component="context-load-group"/);
    assert.match(markup, /data-testid="chat-context-load-group-toggle"/);
    assert.match(markup, new RegExp(`aria-expanded="${expanded}"`));
    assert.match(markup, /aria-controls="[^"]+"/);
    assert.match(markup, /role="button"/);
    assert.match(markup, /data-item-count="2"/);
    assert.match(markup, /2 context loads/);
    assert.match(markup, /data-openbitfun-name="layers-plus"/);
    assert.match(markup, /lucide-layers-plus/);
    assert.doesNotMatch(markup, /data-(?:skill|tool-spec|discovery|read|search)-count=/);
    if (expanded) {
      assert.match(markup, /data-openbitfun-part="content"/);
      assert.doesNotMatch(markup, /data-openbitfun-overscroll-behavior-y=/);
      assert.match(markup, /frontend-design/);
      assert.match(markup, /WebSearch/);
    }
  }
});
