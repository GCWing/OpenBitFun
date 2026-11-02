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
const { RemoteSessionManager } = load('services/RemoteSessionManager', { './RemoteCommandFactory': factory, '../i18n/RemoteI18n': { RemoteI18n: { t: () => 'New Session' } } });
function fixture(response) {
  const manager = Object.create(RemoteSessionManager.prototype);
  manager.workspace = { path: '/previous-ssh', remoteConnectionId: 'previous-profile' };
  const calls = [];
  manager.send = async command => { calls.push(command); return response; };
  return { manager, calls };
}
test('default Claw leaves workspace selection to host and adopts its primary local workspace', async () => {
  const f = fixture({ session_id: 'new', workspace_path: '/runtime/primary' });
  let allocated;
  const session = await f.manager.createSession({ agentType: 'claw', title: '', instruction: '' }, async value => { allocated = value; });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].agent_type, 'claw');
  assert.equal(f.calls[0].session_name, '');
  assert.equal(f.calls[0].workspace_path, undefined);
  assert.equal(f.calls[0].remote_connection_id, undefined);
  assert.equal(session.workspacePath, '/runtime/primary');
  assert.equal(allocated.workspacePath, '/runtime/primary');
  assert.equal(session.remoteConnectionId, undefined);
});
test('explicit workspace Claw preserves selected saved SSH identity without global workspace mutation', async () => {
  const f = fixture({ session_id: 'new', workspace_path: '/canonical/project', remote_connection_id: 'saved-clicked' });
  const session = await f.manager.createSession({ agentType: 'claw', title: '', instruction: '', workspacePath: '/clicked', remoteConnectionId: 'saved-clicked' });
  assert.deepEqual(f.calls.map(c => c.cmd), ['create_session']);
  assert.equal(f.calls[0].agent_type, 'claw');
  assert.equal(f.calls[0].workspace_path, '/clicked');
  assert.equal(f.calls[0].remote_connection_id, 'saved-clicked');
  assert.equal(session.workspacePath, '/canonical/project');
  assert.equal(session.remoteConnectionId, 'saved-clicked');
  assert.equal(f.manager.workspace.path, '/previous-ssh');
});
test('explicit local workspace carries empty local marker despite selected SSH workspace', async () => {
  const f = fixture({ session_id: 'new', workspace_path: '/local' });
  await f.manager.createSession({ agentType: 'code', title: '', instruction: '', workspacePath: '/local' });
  assert.equal(f.calls[0].remote_connection_id, '');
});
test('host allocation identity is required before routing a created session', async () => {
  const f = fixture({ workspace_path: '/runtime/primary' });
  let allocated = false;
  await assert.rejects(f.manager.createSession({ agentType: 'claw', title: '', instruction: '' }, async () => { allocated = true; }), /no session identity/);
  assert.equal(allocated, false);
});
test('workspace creation flow forwards Claw and clicked saved profile without selecting a global assistant', async () => {
  const calls = [];
  const runtime = {
    filePreview: { close() {} },
    sessions: { async createSessionInWorkspace(...args) { calls.push(args); } },
    selectAssistantWorkspace() { throw Error('Global assistant must not change'); }
  };
  const { RemoteCreateFlowController } = load('pages/viewmodel/RemoteCreateFlowController', {
    './ConversationRuntime': { requireRemoteRuntime: () => runtime }
  });
  const flow = new RemoteCreateFlowController({ controlTargetDeviceId: 'runtime', connectionState: 'connected' }, runtime);
  await flow.createRemoteSessionInWorkspace('/clicked', 'claw', false, 'runtime', 'saved-clicked');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/clicked');
  assert.equal(calls[0][2], 'claw');
  assert.equal(calls[0][6], 'saved-clicked');
});

test('custom titles including legacy-looking text survive creation', async () => {
  const f = fixture({ session_id: 'custom' });
  const session = await f.manager.createSession({ agentType: 'claw', title: 'Remote Claw Session', instruction: '' });
  assert.equal(f.calls[0].session_name, 'Remote Claw Session');
  assert.equal(session.title, 'Remote Claw Session');
});
