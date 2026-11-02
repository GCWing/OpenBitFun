import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ControlHubToolCard, ListModelsToolCard } from "../dist/flow-chat.js";

test("model discovery keeps an unknown historical result expandable", () => {
  const html = renderToStaticMarkup(createElement(ListModelsToolCard, {
    action: 'List models', status: 'completed', models: [], modelsLabel: 'Models', modelIdLabel: 'Model ID',
    hasResult: true, onToggle() {},
  }));
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /data-openbitfun-tool-card="list-models"/);
  assert.match(html, /data-openbitfun-attention="ambient"/);
});

test("control failures retain partial output, error hints and the detail toggle", () => {
  const html = renderToStaticMarkup(createElement(ControlHubToolCard, {
    action: 'Click', status: 'error', domain: 'browser', attention: 'prominent', isExpanded: true,
    error: 'STALE_REF', resultLabel: 'Result', resultText: 'Partial output',
    notices: ['Read the page again.'], paramsText: '{"selector":"@e1"}', paramsLabel: 'Parameters', onToggle() {},
  }));
  assert.match(html, /data-openbitfun-attention="prominent"/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /STALE_REF/);
  assert.match(html, /Partial output/);
  assert.match(html, /Read the page again/);
});
