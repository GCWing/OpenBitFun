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

// Mock the '@kit.ArkTS' util.TextDecoder dependency of the compiled module.
// getRawFileContentSync delivers UTF-8 bytes on device, so the harness must
// decode them the same way instead of assuming one byte equals one character.
function mockKitRequire(name) {
  if (name === '@kit.ArkTS') {
    return {
      util: {
        TextDecoder: {
          create() {
            return {
              decodeWithStream(bytes) {
                return Buffer.from(bytes).toString('utf8');
              }
            };
          }
        }
      }
    };
  }
  return {};
}

// Mock getContext to return a fake resourceManager with test catalog data
function createMockContext(catalog) {
  return {
    resourceManager: {
      getRawFileContentSync(filename) {
        // Serve UTF-8-encoded bytes, matching device rawfile reads.
        return Array.from(Buffer.from(JSON.stringify(catalog), 'utf8'));
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
    new Function('require', 'exports', compiled)(mockKitRequire, exportsObject);
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
    { name: 'status.notConnected.zh', value: '未连接' },
    // Two distinct keys share one value per language: the value is ambiguous
    // and must not be re-rendered through either key.
    { name: 'duplicate.first', value: 'Duplicate value' },
    { name: 'duplicate.first.zh', value: '重复值' },
    { name: 'duplicate.second', value: 'Duplicate value' },
    { name: 'duplicate.second.zh', value: '重复值' },
    // The English templates of the two keys collide, so neither key's
    // template can identify a match in any language.
    { name: 'collision.first', value: '%1$s items' },
    { name: 'collision.first.zh', value: '%1$s 项' },
    { name: 'collision.second', value: '%1$s items' },
    { name: 'collision.second.zh', value: '%1$s 条目' }
  ]
};

test('exact match returns translated string', () => {
  const retranslator = createRetranslator(testCatalog);
  assert.equal(retranslator.retranslate('Back'), '返回');
  assert.equal(retranslator.retranslate('返回'), 'Back');
  assert.equal(retranslator.retranslate('Not connected'), '未连接');
  assert.equal(retranslator.retranslate('未连接'), 'Not connected');
});

test('ambiguous value is returned as-is rather than guessed', () => {
  const retranslator = createRetranslator(testCatalog);
  assert.equal(retranslator.retranslate('Duplicate value'), 'Duplicate value');
});

test('ambiguous value refusal applies to every catalog language', () => {
  const retranslator = createRetranslator(testCatalog);
  assert.equal(retranslator.retranslate('重复值'), '重复值');
});

test('duplicate catalog values keep unique neighbors translatable', () => {
  const retranslator = createRetranslator(testCatalog);
  assert.equal(retranslator.retranslate('Back'), '返回');
  assert.equal(retranslator.retranslate('返回'), 'Back');
  assert.equal(retranslator.retranslate('Not connected'), '未连接');
});

test('template with an ambiguous value is refused in every language', () => {
  const retranslator = createRetranslator(testCatalog);
  // collision.first and collision.second share the English value
  // '%1$s items', so neither key's template may match, even in Chinese
  // where the values differ.
  assert.equal(retranslator.retranslate('3 items'), '3 items');
  assert.equal(retranslator.retranslate('3 项'), '3 项');
  assert.equal(retranslator.retranslate('3 条目'), '3 条目');
  // Unambiguous templates keep working.
  assert.equal(retranslator.retranslate('3 more sessions'), '还有 3 个会话');
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
