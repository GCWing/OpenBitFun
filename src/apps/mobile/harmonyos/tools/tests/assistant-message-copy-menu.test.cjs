const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// The assistant message's copy menu is composed from a policy list so each
// export scope is data. Exercise the list, the scope contract and the copy
// itself; the anchored popup's geometry, dismissal and the actual pasteboard
// write stay a device-level check.
function loadEts(file, resolveModule) {
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  const exported = {};
  new Function('require', 'exports', compiled)(resolveModule || (() => ({})), exported);
  return exported;
}

const etsRoot = path.join(__dirname, '../../entry/src/main/ets');
const resourcesRoot = path.join(__dirname, '../../entry/src/main/resources');

// The scope enum is owned by the copy intent, which is the one value the policy
// imports. Load it through the same transpile pass instead of restating it.
const intent = loadEts(path.join(etsRoot, 'pages/actions/ConversationIntent.ets'));
const { MessageCopyScope } = intent;
const { AssistantMessageCopyAction, AssistantMessageCopyMenuPolicy } = loadEts(
  path.join(etsRoot, 'pages/policy/AssistantMessageCopyMenuPolicy.ets'),
  (specifier) => {
    if (specifier === '../actions/ConversationIntent') {
      return intent;
    }
    return {};
  }
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

test('the copy menu offers the three export scopes in frozen order', () => {
  const items = AssistantMessageCopyMenuPolicy.items();
  assert.equal(items.length, 3);
  assert.deepEqual(
    items.map((item) => item.scope),
    [MessageCopyScope.Rich, MessageCopyScope.Markdown, MessageCopyScope.Plain]
  );
  assert.deepEqual(
    items.map((item) => item.labelKey),
    ['chat.copyRich', 'chat.copyMarkdown', 'chat.copyPlain']
  );
});

test('every menu item names a distinct action, so a second entry cannot collide', () => {
  const items = AssistantMessageCopyMenuPolicy.items();
  const actions = items.map((item) => item.action);
  assert.equal(new Set(actions).size, actions.length);
  assert.deepEqual(actions, [
    AssistantMessageCopyAction.RichText,
    AssistantMessageCopyAction.Markdown,
    AssistantMessageCopyAction.PlainText
  ]);
});

test('the scope contract the clipboard branches on is exactly rich, markdown and plain', () => {
  assert.equal(MessageCopyScope.Rich, 'rich');
  assert.equal(MessageCopyScope.Markdown, 'markdown');
  assert.equal(MessageCopyScope.Plain, 'plain');
});

test('each call hands back its own list', () => {
  const first = AssistantMessageCopyMenuPolicy.items();
  first.push({ action: 'scratch', scope: MessageCopyScope.Rich, labelKey: 'scratch' });
  assert.equal(AssistantMessageCopyMenuPolicy.items().length, 3);
});

test('this package adds its copy to every locale catalog', () => {
  const expected = {
    chat_copyRich: { 'en_US': 'Copy (rich text)', 'zh_CN': '复制（富文本）' },
    chat_copyMarkdown: { 'en_US': 'Copy Markdown', 'zh_CN': '复制 Markdown' },
    chat_copyPlain: { 'en_US': 'Copy plain text', 'zh_CN': '复制纯文本' },
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
    for (const item of AssistantMessageCopyMenuPolicy.items()) {
      const resourceName = item.labelKey.replace(/\./g, '_');
      assert.equal(values.has(resourceName), true, `${resourceName} in ${locale}`);
      assert.ok(values.get(resourceName).length > 0, `${resourceName} in ${locale} is empty`);
    }
  }
});

test('the two locale catalogs stay in key lockstep', () => {
  assert.equal(catalog('en_US').size, catalog('zh_CN').size);
});
