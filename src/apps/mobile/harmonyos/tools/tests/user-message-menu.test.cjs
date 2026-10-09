const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// The truncated bubble's long-press menu is composed from a policy list so the
// rollback entry can join it as data. Exercise the list itself; the anchored
// menu's rendering and dismissal stay a device-level check.
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
const { UserMessageMenuAction, UserMessageMenuPolicy } = loadEts(
  path.join(etsRoot, 'pages/policy/UserMessageMenuPolicy.ets')
);
// The shared rollback item key is owned by the presentation policy, which owns no
// ArkUI: the list and the selection menu both read it from there.
const { RollbackPresentationPolicy } = loadEts(
  path.join(etsRoot, 'pages/policy/RollbackPresentationPolicy.ets'),
  (specifier) => specifier === './SessionRollbackPolicy' ?
    loadEts(path.join(etsRoot, 'pages/policy/SessionRollbackPolicy.ets')) : {}
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

test('the truncated bubble menu carries copy-full-text and the rollback entry', () => {
  const items = UserMessageMenuPolicy.items();
  assert.equal(items.length, 2);
  assert.equal(items[0].action, UserMessageMenuAction.CopyFullText);
  assert.equal(items[0].labelKey, 'chat.copyFullText');
  assert.equal(items[1].action, UserMessageMenuAction.RollbackToMessage);
  assert.equal(items[1].labelKey, 'chat.rollbackItem');
});

test('the rollback entry is the one the other user-message surfaces raise', () => {
  // The short bubble and the full-text panel reach the same action through the
  // system selection menu (`RollbackSelectionMenu`), which builds its item from
  // this policy's key. One label, three surfaces: a rename that misses one of
  // them would be two entries for one action.
  const rollback = UserMessageMenuPolicy.items()
    .find((item) => item.action === UserMessageMenuAction.RollbackToMessage);
  assert.equal(rollback.labelKey, RollbackPresentationPolicy.ROLLBACK_ITEM_KEY);
});

test('every menu item names a distinct action, so a second entry cannot collide', () => {
  const items = UserMessageMenuPolicy.items();
  const actions = items.map((item) => item.action);
  assert.equal(new Set(actions).size, actions.length);
  assert.equal(UserMessageMenuPolicy.items()[0].action, UserMessageMenuAction.CopyFullText);
  assert.equal(UserMessageMenuPolicy.items()[1].action, UserMessageMenuAction.RollbackToMessage);
});

test('each call hands back its own list', () => {
  const first = UserMessageMenuPolicy.items();
  first.push({ action: 'scratch', labelKey: 'scratch' });
  assert.equal(UserMessageMenuPolicy.items().length, 2);
});

test('the system selection menu is dismissed before the rollback it asked for', () => {
  // Measured on device: a tap on the extended item left the system selection menu
  // open over the staged preview it had just asked for, and a second tap was
  // needed to dismiss it. The item now closes the menu through the controller of
  // the surface that raised it, before it asks for the rollback.
  const menu = fs.readFileSync(path.join(etsRoot, 'pages/components/RollbackSelectionMenu.ets'), 'utf8');
  assert.ok(/closeSelectionMenu\(\);\s*\n\s*onRollback\(\);/.test(menu),
    'the menu item must dismiss the selection menu before it asks for the rollback');
  assert.ok(/static options\(controller: TextController, onRollback/.test(menu),
    'the item needs the controller of the Text the menu belongs to');
  for (const surface of [
    'pages/components/ChatMessageChrome.ets',
    'pages/components/UserMessageFullTextSheet.ets'
  ]) {
    const source = fs.readFileSync(path.join(etsRoot, surface), 'utf8');
    assert.ok(/new TextController\(\)/.test(source),
      `${surface} must own the controller its selection menu is dismissed through`);
    assert.ok(/Text\([\s\S]{0,60}\{ controller: this\.\w+ \}\)/.test(source),
      `${surface} must build its Text with that controller, or the dismissal goes nowhere`);
    assert.ok(/editMenuOptions\(RollbackSelectionMenu\.options\(this\.\w+, \(\) => \{/.test(source),
      `${surface} must hand its own controller to the shared menu item`);
    assert.equal(source.includes('RollbackSelectionMenu.options(() =>'), false,
      `${surface} must not build the menu item without a controller`);
  }
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
