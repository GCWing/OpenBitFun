const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// The truncated bubble's long-press menu is composed from a policy list so the
// rollback entry can join it as data. Exercise the list itself; the anchored
// menu's rendering and dismissal stay a device-level check.
function loadEts(file) {
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  const exported = {};
  new Function('require', 'exports', compiled)(() => ({}), exported);
  return exported;
}

const etsRoot = path.join(__dirname, '../../entry/src/main/ets');
const resourcesRoot = path.join(__dirname, '../../entry/src/main/resources');
const { UserMessageMenuAction, UserMessageMenuPolicy } = loadEts(
  path.join(etsRoot, 'pages/policy/UserMessageMenuPolicy.ets')
);

function catalog(locale) {
  const source = fs.readFileSync(path.join(resourcesRoot, locale, 'element/string.json'), 'utf8');
  const entries = JSON.parse(source).string;
  const values = new Map();
  for (const entry of entries) {
    values.set(entry.name, entry.value);
  }
  return values;
}

test('the truncated bubble menu carries copy-full-text and nothing else yet', () => {
  const items = UserMessageMenuPolicy.items();
  assert.equal(items.length, 1);
  assert.equal(items[0].action, UserMessageMenuAction.CopyFullText);
  assert.equal(items[0].labelKey, 'chat.copyFullText');
});

test('every menu item names a distinct action, so a second entry cannot collide', () => {
  const items = UserMessageMenuPolicy.items();
  const actions = items.map((item) => item.action);
  assert.equal(new Set(actions).size, actions.length);
  assert.equal(UserMessageMenuPolicy.items()[0].action, UserMessageMenuAction.CopyFullText);
});

test('each call hands back its own list', () => {
  const first = UserMessageMenuPolicy.items();
  first.push({ action: 'scratch', labelKey: 'scratch' });
  assert.equal(UserMessageMenuPolicy.items().length, 1);
});

test('this package adds its copy to every locale catalog', () => {
  const expected = {
    chat_fullText: { 'en_US': 'Full text', 'zh_CN': '全文' },
    chat_copyFullText: { 'en_US': 'Copy full text', 'zh_CN': '复制全文' },
  };
  for (const [name, values] of Object.entries(expected)) {
    for (const [locale, value] of Object.entries(values)) {
      assert.equal(catalog(locale).get(name), value, `${name} in ${locale}`);
    }
  }
});

test('the menu labels resolve against the resource names the app asks for', () => {
  for (const locale of ['en_US', 'zh_CN']) {
    const values = catalog(locale);
    for (const item of UserMessageMenuPolicy.items()) {
      const resourceName = item.labelKey.replace(/\./g, '_');
      assert.equal(values.has(resourceName), true, `${resourceName} in ${locale}`);
      assert.ok(values.get(resourceName).length > 0, `${resourceName} in ${locale} is empty`);
    }
  }
});
