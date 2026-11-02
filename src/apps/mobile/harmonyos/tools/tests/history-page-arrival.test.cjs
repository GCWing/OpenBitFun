const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function load(name) {
  const source = fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets/pages/policy', `${name}.ets`), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exported = {};
  new Function('require', 'exports', compiled)(() => ({}), exported);
  return exported;
}
const { HistoryPageArrivalTracker } = load('HistoryPageArrivalTracker');

test('layout cannot request a page and bounce cannot rearm the same gesture', () => {
  const tracker = new HistoryPageArrivalTracker();
  assert.equal(tracker.arrived(true), false);
  tracker.beginGesture();
  assert.equal(tracker.arrived(false), false);
  assert.equal(tracker.arrived(true), true);
  for (let i = 0; i < 10; i++) {
    assert.equal(tracker.arrived(false), false);
    assert.equal(tracker.arrived(true), false);
  }
  tracker.beginGesture();
  assert.equal(tracker.arrived(true), true);
  tracker.cancelArrival();
  assert.equal(tracker.arrived(true), false);
});
