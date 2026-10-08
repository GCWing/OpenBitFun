const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Transpile the HostTextRetranslator.ets source
const source = fs.readFileSync(
  path.join(__dirname, '../../entry/src/main/ets/i18n/HostTextRetranslator.ets'),
  'utf8'
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText;

// Mock getContext to return a fake resourceManager with test catalog data
function createMockContext(catalog) {
  return {
    resourceManager: {
      getRawFileContentSync(filename) {
        const jsonString = JSON.stringify(catalog);
        const bytes = [];
        for (let i = 0; i < jsonString.length; i++) {
          bytes.push(jsonString.charCodeAt(i));
        }
        return bytes;
      }
    }
  };
}

// Helper to create a retranslator with a given catalog
function createRetranslator(catalog) {
  const exportsObject = {};
  const mockContext = createMockContext(catalog);
  const originalGetContext = global.getContext;
  global.getContext = () => mockContext;
  try {
    new Function('require', 'exports', compiled)(() => ({}), exportsObject);
    // The constructor reads the catalog through getContext, so it must run
    // while the override is active.
    return new exportsObject.HostTextRetranslator('en-US');
  } finally {
    if (originalGetContext === undefined) {
      delete global.getContext;
    } else {
      global.getContext = originalGetContext;
    }
  }
}

// Test catalog with single and dual placeholder templates
const testCatalog = {
  string: [
    { name: 'common.back', value: 'Back' },
    { name: 'common.back.zh', value: '返回' },
    { name: 'sidebar.moreSessions', value: '%1$s more sessions' },
    { name: 'sidebar.moreSessions.zh', value: '还有 %1$s 个会话' },
    { name: 'remote.settings.deviceSwitching', value: 'Switching to %1$s…' },
    { name: 'remote.settings.deviceSwitching.zh', value: '正在切换到 %1$s…' },
    { name: 'dual.placeholder', value: '%1$s and %2$s' },
    { name: 'dual.placeholder.zh', value: '%1$s 和 %2$s' },
    { name: 'status.notConnected', value: 'Not connected' },
    { name: 'status.notConnected.zh', value: '未连接' }
  ]
};

test('exact match returns translated string', () => {
  const retranslator = createRetranslator(testCatalog);
  assert.equal(retranslator.retranslate('Back'), '返回');
  assert.equal(retranslator.retranslate('返回'), 'Back');
  assert.equal(retranslator.retranslate('Not connected'), '未连接');
  assert.equal(retranslator.retranslate('未连接'), 'Not connected');
});

test('single placeholder template matches and fills correctly', () => {
  const retranslator = createRetranslator(testCatalog);
  // English to Chinese
  assert.equal(retranslator.retranslate('3 more sessions'), '还有 3 个会话');
  // Chinese to English
  assert.equal(retranslator.retranslate('还有 5 个会话'), '5 more sessions');
});

test('single placeholder with prefix and suffix', () => {
  const retranslator = createRetranslator(testCatalog);
  // English to Chinese
  assert.equal(retranslator.retranslate('Switching to Desk-1…'), '正在切换到 Desk-1…');
  // Chinese to English
  assert.equal(retranslator.retranslate('正在切换到 Desk-2…'), 'Switching to Desk-2…');
});

test('dual placeholder template matches and fills correctly', () => {
  const retranslator = createRetranslator(testCatalog);
  // English to Chinese: "foo and bar" -> "foo 和 bar"
  assert.equal(retranslator.retranslate('foo and bar'), 'foo 和 bar');
  // Chinese to English: "foo 和 bar" -> "foo and bar"
  assert.equal(retranslator.retranslate('foo 和 bar'), 'foo and bar');
});

test('dual placeholder with different values', () => {
  const retranslator = createRetranslator(testCatalog);
  // English to Chinese
  assert.equal(retranslator.retranslate('hello and world'), 'hello 和 world');
  // Chinese to English
  assert.equal(retranslator.retranslate('你好 和 世界'), '你好 and 世界');
});

test('returns original message when no match found', () => {
  const retranslator = createRetranslator(testCatalog);
  const unknown = 'This message does not exist in any catalog';
  assert.equal(retranslator.retranslate(unknown), unknown);
});

test('returns empty string for empty input', () => {
  const retranslator = createRetranslator(testCatalog);
  assert.equal(retranslator.retranslate(''), '');
});

test('template match returns null for non-matching prefix', () => {
  const retranslator = createRetranslator(testCatalog);
  // "Switched to Desk-1…" does not start with the template prefix "Switching to "
  assert.equal(retranslator.retranslate('Switched to Desk-1…'), 'Switched to Desk-1…');
});

test('template match returns null for non-matching suffix', () => {
  const retranslator = createRetranslator(testCatalog);
  // "3 more sessions xyz" doesn't end with the expected suffix
  assert.equal(retranslator.retranslate('3 more sessions xyz'), '3 more sessions xyz');
});

test('dual placeholder with empty middle', () => {
  const retranslator = createRetranslator(testCatalog);
  // "foo and bar" where middle is " and "
  assert.equal(retranslator.retranslate('A and B'), 'A 和 B');
});

test('dual placeholder with complex values', () => {
  const retranslator = createRetranslator(testCatalog);
  // Values containing spaces
  assert.equal(retranslator.retranslate('hello world and foo bar'), 'hello world 和 foo bar');
  assert.equal(retranslator.retranslate('你好世界 和 foo bar'), '你好世界 and foo bar');
});
