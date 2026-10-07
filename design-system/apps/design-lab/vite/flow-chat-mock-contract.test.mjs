import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

function block(source, selector) {
  const start = source.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `Missing owner: ${selector}`);
  const open = source.indexOf('{', start);
  let depth = 1;
  let end = open + 1;
  for (; depth > 0 && end < source.length; end++) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
  }
  return source.slice(open + 1, end - 1).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
}

function property(source, name) {
  const value = source.match(new RegExp(`(?:^|[;\\n])\\s*${name}:\\s*([^;]+);`))?.[1].trim();
  assert.ok(value, `Missing property: ${name}`);
  return value;
}

test('conversation bubble geometry and color stay aligned with production', async () => {
  const [lab, product] = await Promise.all([
    read('../src/pages/FlowChatMockPage.css'),
    read('../../../../src/web-ui/src/flow_chat/components/modern/UserMessageItem.scss'),
  ]);
  const preview = block(lab, '.flow-chat-mock__user-bubble');
  const actual = block(product, '.user-message-item');
  for (const name of ['width', 'max-width', 'padding', 'background', 'border', 'border-radius', 'margin-block', 'margin-inline', 'box-shadow']) {
    assert.equal(property(preview, name), property(actual, name), name);
  }
  for (const name of ['--_user-message-radius', '--_user-message-padding-inline', 'margin']) {
    assert.equal(property(block(lab, '.flow-chat-mock__user'), name), property(block(product, '.user-message-item-shell'), name), name);
  }
});

test('conversation reading column, metadata and composer follow their application layout owners', async () => {
  const [lab, layout, input, model] = await Promise.all([
    read('../src/pages/FlowChatMockPage.css'),
    read('../../../../src/web-ui/src/flow_chat/_transcript-layout.scss'),
    read('../../../../src/web-ui/src/flow_chat/components/ChatInput.scss'),
    read('../../../../src/web-ui/src/flow_chat/components/ModelSelector.scss'),
  ]);
  const column = block(layout, '@mixin reading-column');
  for (const name of ['box-sizing', 'min-width', 'width', 'max-width', 'margin-inline']) {
    assert.equal(property(block(lab, '.flow-chat-mock__timeline'), name), property(column, name), name);
  }
  for (const name of ['turn-rail-offset', 'turn-rail-width', 'metadata-action-size']) {
    assert.ok(lab.includes(`var(--openbitfun-control-flow-chat-${name})`));
    assert.ok(layout.includes(`var(--openbitfun-control-flow-chat-${name})`));
  }
  const composer = block(lab, '.flow-chat-mock__composer');
  assert.ok(property(composer, 'inline-size').includes(property(block(input, '.openbitfun-context-drop-zone.openbitfun-chat-input-drop-zone'), 'max-width')));
  for (const name of ['height', 'padding', 'border-radius', 'font-size', 'font-weight', 'letter-spacing', 'opacity']) {
    assert.equal(property(block(lab, '.flow-chat-mock__model'), name), property(block(model, '&__trigger'), name), name);
  }
});

test('the mock surface consumes published design tokens rather than local dimensions or colors', async () => {
  const lab = await read('../src/pages/FlowChatMockPage.css');
  const declarations = lab.split('\n').filter((line) => !line.trim().startsWith('@'));
  assert.doesNotMatch(declarations.join('\n'), /:\s*[^;\n]*\b\d+(?:\.\d+)?(?:px|rem)\b/);
  assert.doesNotMatch(lab, /#[\da-f]{3,8}\b|\brgba?\(/i);
});
