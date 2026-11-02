const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
// Exercise the actual lifecycle methods; only ArkUI's declarative build and
// decorators are removed for the host runner. Native replay covers the view.
const source = fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets/pages/components/StreamingMarkdownContent.ets'), 'utf8')
  .replace(/@ComponentV2\s*/g, '').replace(/@(Param|Local|Event)\s*/g, '')
  .replace(/@Monitor\([^\n]*\)\s*/g, '').replace('export struct ', 'export class ')
  .replace(/  build\(\) \{[\s\S]*?\n  private handleTextChanged/, '  private handleTextChanged');
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
} }).outputText;
const exported = {};
new Function('require', 'exports', 'setInterval', 'clearInterval', compiled)(
  () => ({ RemoteLogger: { info() {} } }), exported, () => 1, () => {});
const { StreamingMarkdownContent } = exported;
function active(text, key) {
  const view = new StreamingMarkdownContent();
  view.text = text; view.active = true; view.streamKey = key;
  view.aboutToAppear(); view.renderedText = text;
  return view;
}
test('authoritative rewrite, truncation and deletion replace revealed content while active', () => {
  for (const next of ['corrected', 'old', '']) {
    const view = active('old content', `rewrite-${next}`);
    view.text = next; view.handleTextChanged();
    assert.equal(view.renderedText, next); assert.equal(view.targetText, next);
    assert.equal(view.timerId, 0);
  }
});
test('append-only growth keeps the current reveal and animates toward the new target', () => {
  const view = active('prefix', 'append');
  view.text = 'prefix suffix'; view.handleTextChanged();
  assert.equal(view.renderedText, 'prefix'); assert.equal(view.targetText, 'prefix suffix');
  assert.notEqual(view.timerId, 0);
});
test('remount accepts cached prefixes but never resurrects incompatible cached content', () => {
  const old = active('obsolete answer', 'remount'); old.aboutToDisappear();
  const corrected = new StreamingMarkdownContent();
  corrected.active = true; corrected.streamKey = 'remount'; corrected.text = 'new answer';
  corrected.aboutToAppear();
  assert.equal(corrected.renderedText, ''); assert.equal(corrected.targetText, 'new answer');
  const prefix = active('new', 'prefix-cache'); prefix.aboutToDisappear();
  const growing = new StreamingMarkdownContent();
  growing.active = true; growing.streamKey = 'prefix-cache'; growing.text = 'new answer'; growing.aboutToAppear();
  assert.equal(growing.renderedText, 'new');
});
