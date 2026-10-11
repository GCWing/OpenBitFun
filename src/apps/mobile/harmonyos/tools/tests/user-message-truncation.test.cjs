const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// The truncation rule is display policy: exercise the real module the bubble
// calls, so the eight-line / 360-character boundary is host-verifiable. The
// bubble's own layout stays a device-level check.
function loadEts(file) {
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  const exported = {};
  new Function('require', 'exports', compiled)(() => ({}), exported);
  return exported;
}

const policyDir = path.join(__dirname, '../../entry/src/main/ets/pages/policy');
const { UserMessageTruncationPolicy } = loadEts(
  path.join(policyDir, 'UserMessageTruncationPolicy.ets')
);

function lines(count, separator = '\n') {
  return Array.from({ length: count }, (_value, index) => `line${index}`).join(separator);
}

test('frozen thresholds are eight lines, 360 characters and the three-dot ellipsis', () => {
  assert.equal(UserMessageTruncationPolicy.MAX_PREVIEW_LINES, 8);
  assert.equal(UserMessageTruncationPolicy.MAX_PREVIEW_CHARS, 360);
  assert.equal(UserMessageTruncationPolicy.ELLIPSIS, '...');
});

test('short text is left completely untouched', () => {
  const text = 'Ship the mobile truncation rule';
  assert.equal(UserMessageTruncationPolicy.shouldTruncate(text), false);
  assert.equal(UserMessageTruncationPolicy.truncatedPreview(text), text);
});

test('empty and whitespace-only messages are never truncated', () => {
  for (const text of ['', ' ', '\n', '  \n\t ']) {
    assert.equal(UserMessageTruncationPolicy.shouldTruncate(text), false);
    assert.equal(UserMessageTruncationPolicy.truncatedPreview(text), text);
  }
});

test('a message of exactly eight lines keeps every line', () => {
  const text = lines(8);
  assert.equal(UserMessageTruncationPolicy.shouldTruncate(text), false);
  assert.equal(UserMessageTruncationPolicy.truncatedPreview(text), text);
});

test('a nine-line message cuts at the eighth line break and drops the ninth line', () => {
  const preview = UserMessageTruncationPolicy.truncatedPreview(lines(9));
  assert.equal(preview, `${lines(8)}...`);
  assert.equal(preview.includes('line8'), false);
  assert.equal(preview.split('\n').length, 8);
});

test('a message of exactly 360 characters keeps all of them', () => {
  const text = 'a'.repeat(360);
  assert.equal(UserMessageTruncationPolicy.shouldTruncate(text), false);
  assert.equal(UserMessageTruncationPolicy.truncatedPreview(text), text);
});

test('a message of 361 characters cuts at 360 and appends the ellipsis', () => {
  const text = `${'a'.repeat(360)}b`;
  assert.equal(UserMessageTruncationPolicy.shouldTruncate(text), true);
  assert.equal(UserMessageTruncationPolicy.truncatedPreview(text), `${'a'.repeat(360)}...`);
});

test('the character limit binds before the line limit on a single long line', () => {
  const text = 'x'.repeat(900);
  const preview = UserMessageTruncationPolicy.truncatedPreview(text);
  assert.equal(preview.length, 363);
  assert.equal(preview, `${'x'.repeat(360)}...`);
});

test('the line limit binds before the character limit on many short lines', () => {
  const text = lines(40);
  const preview = UserMessageTruncationPolicy.truncatedPreview(text);
  assert.equal(preview, `${lines(8)}...`);
  assert.ok(text.length < UserMessageTruncationPolicy.MAX_PREVIEW_CHARS);
});

test('a line break before eight lines still cuts when 360 characters come first', () => {
  // Two lines whose second one starts inside the character limit: the cut lands
  // just past the line break, and the ellipsis still joins the first line.
  const text = `${'a'.repeat(359)}\n${'b'.repeat(20)}`;
  const preview = UserMessageTruncationPolicy.truncatedPreview(text);
  assert.equal(preview, `${'a'.repeat(359)}...`);
});

test('trailing whitespace is dropped so the ellipsis never follows a gap', () => {
  const text = `${'a'.repeat(359)} ${'b'.repeat(4)}`;
  assert.equal(UserMessageTruncationPolicy.shouldTruncate(text), true);
  assert.equal(UserMessageTruncationPolicy.truncatedPreview(text), `${'a'.repeat(359)}...`);
});

test('CRLF collapses to LF before the line count is taken', () => {
  const text = lines(9, '\r\n');
  assert.equal(UserMessageTruncationPolicy.normalize(text), lines(9, '\n'));
  const preview = UserMessageTruncationPolicy.truncatedPreview(text);
  assert.equal(preview, `${lines(8)}...`);
  assert.equal(preview.includes('\r'), false);
});

test('a CRLF message of exactly eight lines is not truncated', () => {
  const text = lines(8, '\r\n');
  assert.equal(UserMessageTruncationPolicy.shouldTruncate(text), false);
  assert.equal(UserMessageTruncationPolicy.truncatedPreview(text), lines(8));
});

test('a cut that hides only empty trailing lines does not truncate', () => {
  const text = `${lines(8)}\n\n\n`;
  assert.equal(UserMessageTruncationPolicy.shouldTruncate(text), false);
  assert.equal(UserMessageTruncationPolicy.truncatedPreview(text), text);
});

test('CRLF is not double-counted towards the character limit', () => {
  const text = `${'a'.repeat(179)}\r\n${'b'.repeat(180)}`;
  assert.equal(text.length, 361);
  assert.ok(text.length > UserMessageTruncationPolicy.MAX_PREVIEW_CHARS);
  // 360 normalized characters across two lines, so the message is not long by
  // either limit even though the raw string crosses the character threshold.
  assert.equal(UserMessageTruncationPolicy.shouldTruncate(text), false);
  assert.equal(
    UserMessageTruncationPolicy.truncatedPreview(text),
    `${'a'.repeat(179)}\n${'b'.repeat(180)}`
  );
});
