const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function load(name, deps = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets', name + '.ets'), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exported = {};
  new Function('require', 'exports', js)(name => deps[name] || {}, exported);
  return exported;
}
const factory = load('services/RemoteCommandFactory');
const { RemoteSessionManager } = load('services/RemoteSessionManager', { './RemoteCommandFactory': factory });
test('permission save displays host-confirmed mode', async () => {
  const manager = Object.create(RemoteSessionManager.prototype);
  manager.send = async () => ({ resp: 'ok', mode: 'auto' });
  assert.equal(await manager.setPermissionMode('full_access'), 'auto');
});

test('legacy permission acknowledgement is followed by an authoritative read', async () => {
  const manager = Object.create(RemoteSessionManager.prototype);
  const calls = [];
  manager.send = async command => {
    calls.push(command.cmd);
    return command.cmd === 'set_permission_mode' ? { resp: 'ok' } : { resp: 'ok', mode: 'ask' };
  };
  assert.equal(await manager.setPermissionMode('full_access'), 'ask');
  assert.deepEqual(calls, ['set_permission_mode', 'get_permission_mode']);
});

test('missing or future permission modes never masquerade as approval policy', async () => {
  const manager = Object.create(RemoteSessionManager.prototype);
  for (const mode of [undefined, 'future_mode']) {
    manager.send = async () => ({ resp: 'ok', mode });
    await assert.rejects(manager.getPermissionMode(), /Permission mode unavailable/);
    await assert.rejects(manager.setPermissionMode('full_access'), /Permission mode unavailable/);
  }
});
