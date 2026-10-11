const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Exercise the actual shared login action without creating native UI owners.
const file = path.join(__dirname, '../../entry/src/main/ets/pages/runtime/AppRootRuntimeComposition.ets');
const source = fs.readFileSync(file, 'utf8');
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
let initializer;
function visit(node) {
  if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'cloudLogin') {
    initializer = node.initializer.getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(initializer, 'shared login action exists');
const js = ts.transpileModule(`const action = ${initializer};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function action(context) {
  return new Function(`${js}\nreturn action;`).call(context);
}

test('foreground restoration before login resolves still starts the watch listener after login', async () => {
  let resolveLogin;
  const calls = [];
  const context = {
    settingsController: { loginCloudAccount: () => new Promise(resolve => { resolveLogin = resolve; }) },
    startWatchProvisioning: async () => { calls.push('listen'); },
    pendingAccountDeviceId: '',
  };
  const result = action(context)();
  assert.deepEqual(calls, []);
  resolveLogin('account');
  assert.equal(await result, 'account');
  assert.deepEqual(calls, ['listen']);
});

test('watch listener starts before resuming a pending desktop link', async () => {
  const calls = [];
  const context = {
    settingsController: { loginCloudAccount: async () => 'account' },
    startWatchProvisioning: async () => { calls.push('listen'); },
    pendingAccountDeviceId: 'desktop',
    connectAccountDeviceLink: async id => { calls.push(id); },
  };
  assert.equal(await action(context)(), 'account');
  assert.deepEqual(calls, ['listen', 'desktop']);
  assert.equal(context.pendingAccountDeviceId, '');
});

test('cancelled or failed account login does not start provisioning or consume a pending link', async () => {
  let started = false;
  const context = {
    settingsController: { loginCloudAccount: async () => { throw new Error('cancelled'); } },
    startWatchProvisioning: async () => { started = true; },
    pendingAccountDeviceId: 'desktop',
  };
  await assert.rejects(action(context)(), /cancelled/);
  assert.equal(started, false);
  assert.equal(context.pendingAccountDeviceId, 'desktop');
});
