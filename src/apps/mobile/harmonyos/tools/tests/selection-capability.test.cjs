const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// The gate is pure policy, so the host runner exercises the real .ets source
// without any ArkUI stubbing.
const POLICY = path.join(__dirname, '../../entry/src/main/ets/pages/policy/SelectionCapabilityPolicy.ets');
const MARKDOWN_CONTENT = path.join(__dirname, '../../entry/src/main/ets/pages/components/MarkdownContent.ets');

function loadPolicy() {
  const source = fs.readFileSync(POLICY, 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
  } }).outputText;
  const exported = {};
  new Function('exports', compiled)(exported);
  return exported.SelectionCapabilityPolicy;
}

const SelectionCapabilityPolicy = loadPolicy();
const supports = (version) => SelectionCapabilityPolicy.supportsCrossBlockSelection(version);

test('API 26 is the first level that selects across blocks', () => {
  assert.equal(SelectionCapabilityPolicy.CROSS_BLOCK_SELECTION_API_LEVEL, 26);
  assert.equal(supports(26), true);
});

test('levels around the boundary fall on the side of their own API', () => {
  assert.equal(supports(25), false);
  assert.equal(supports(24), false);
  assert.equal(supports(21), false);
  assert.equal(supports(26.9), true);
  assert.equal(supports(27), true);
  assert.equal(supports(100), true);
});

test('an unmeasurable level never opts into the API 26 path', () => {
  const junk = [undefined, null, NaN, Infinity, -Infinity, 0, -1, -26, '', '26', {}, [], true, () => 26];
  for (const value of junk) {
    assert.equal(supports(value), false, `${String(value)} must not enable cross-block selection`);
  }
});

test('a failed platform read reports no API level at all', () => {
  // The service is the only place that reads the device, and its failure value
  // has to be one the gate rejects, or an unmeasurable device would be trusted.
  const source = fs.readFileSync(
    path.join(__dirname, '../../entry/src/main/ets/services/DeviceApiLevelService.ets'),
    'utf8'
  );
  const failureValue = /catch\s*\(_err\)\s*\{\s*return\s+(-?\d+n?|NaN)/.exec(source);
  assert.ok(failureValue, 'DeviceApiLevelService must report a value on a failed read');
  assert.equal(supports(Number(failureValue[1].replace('n', ''))), false);
});

test('the capability gate stays free of platform imports', () => {
  // Keeping device reads out of the policy is what makes the boundary testable
  // here and what keeps components off platform kits through a policy file.
  const source = fs.readFileSync(POLICY, 'utf8');
  assert.doesNotMatch(source, /^\s*import\b/m);
});

test('markdown renders one shared block column behind both selection paths', () => {
  // The API<26 fallback has to be the same subtree, not a second copy of it, so
  // the two paths must call one builder and that builder must own the blocks.
  const source = fs.readFileSync(MARKDOWN_CONTENT, 'utf8');
  const callSites = (source.match(/this\.MarkdownBlockColumn\(\)/g) || []).length;
  assert.equal(callSites, 2);
  assert.equal((source.match(/@Builder\s+MarkdownBlockColumn\(\)/g) || []).length, 1);
  assert.match(
    source,
    /SelectionContainer\(\)\s*\{\s*this\.MarkdownBlockColumn\(\)\s*\}[\s\S]*?\.copyOption\(CopyOptions\.LocalDevice\)[\s\S]*?\.textJoinStyle\(SelectionContainerTextJoinStyle\.NEWLINE\)/
  );
});
