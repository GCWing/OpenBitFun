const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname,
  '../../entry/src/main/ets/pages/policy/ConversationMessageRenderPolicy.ets'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
} }).outputText;
const exported = {};
new Function('require', 'exports', compiled)(() => ({}), exported);
const { ConversationMessageRenderPolicy } = exported;

function message(status, role = 'assistant') {
  return { id: 'message', role, text: 'answer', status };
}

test('copy stays hidden while an answer is streaming or finalizing', () => {
  assert.equal(ConversationMessageRenderPolicy.canCopyAssistant(message('active'), true, false, 6), false);
  assert.equal(ConversationMessageRenderPolicy.canCopyAssistant(message('completed'), false, true, 6), false);
  assert.equal(ConversationMessageRenderPolicy.canCopyAssistant(message('processing'), false, false, 6), false);
});

test('copy appears for settled assistant answers with content', () => {
  for (const status of ['', 'done', 'completed', 'success', 'sent']) {
    assert.equal(ConversationMessageRenderPolicy.canCopyAssistant(message(status), false, false, 6), true, status);
  }
  assert.equal(ConversationMessageRenderPolicy.canCopyAssistant(message('completed'), false, false, 0), false);
  assert.equal(ConversationMessageRenderPolicy.canCopyAssistant(message('completed', 'user'), false, false, 6), false);
});
