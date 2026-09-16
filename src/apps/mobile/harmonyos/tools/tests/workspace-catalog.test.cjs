const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function load(name) {
  const source = fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets/services', `${name}.ets`), 'utf8');
  const exports = {};
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function('require', 'exports', js)(dependency => load(dependency.replace('./', '')), exports);
  return exports;
}
const { projectWorkspaceCatalog } = load('WorkspaceCatalog');
const assistants = [{ path: '/assistant', name: 'Assistant' }];

test('empty opened catalog stays empty without losing picker history', () => {
  const catalog = projectWorkspaceCatalog({ workspaces: [{ path: '/closed' }], opened_workspaces: [] }, assistants);
  assert.equal(catalog.source, 'opened');
  assert.deepEqual(catalog.workspaces, []);
  assert.equal(catalog.recentWorkspaces[0].path, '/closed');
});

test('old hosts use explicitly identified recent fallback', () => {
  for (const opened_workspaces of [undefined, null]) {
    const catalog = projectWorkspaceCatalog({ workspaces: [{ path: '/history' }], opened_workspaces }, assistants);
    assert.equal(catalog.source, 'recent');
    assert.deepEqual(catalog.workspaces.map(row => row.path), ['/assistant', '/history']);
  }
});

test('assistant enrichment never changes remote identity and same-path SSH roots stay distinct', () => {
  const catalog = projectWorkspaceCatalog({ opened_workspaces: [
    { path: '/assistant', name: 'folder' },
    { path: '/assistant', name: 'SSH A', remote_connection_id: 'a' },
    { path: '/assistant', name: 'SSH B', remote_connection_id: 'b' },
    { path: '/assistant', name: 'duplicate' },
  ] }, assistants);
  assert.equal(catalog.source, 'opened');
  assert.deepEqual(catalog.workspaces.map(row => row.name), ['Assistant', 'SSH A', 'SSH B']);
  assert.deepEqual(catalog.workspaces.map(row => row.remoteConnectionId), [undefined, 'a', 'b']);
});

const { remoteWorkspaceKey, remoteSessionBelongsToWorkspace, stampRemoteSessionWorkspace,
  stampRemoteSessionDevice } = load('RemoteSessionIdentity');

test('session ownership distinguishes same paths on local and SSH hosts', () => {
  const local = { path: '/project' };
  const a = { path: '/project', remoteConnectionId: 'a', remoteSshHost: 'host-a' };
  const b = { path: '/project', remoteConnectionId: 'b', remoteSshHost: 'host-b' };
  const session = stampRemoteSessionDevice(stampRemoteSessionWorkspace({ id: '1' }, a.path,
    a.remoteConnectionId, a.remoteSshHost), 'desktop');
  for (const scope of [local, a, b]) {
    assert.equal(remoteSessionBelongsToWorkspace(session, scope, [local, a, b]), scope === a);
  }
  assert.equal(session.deviceId, 'desktop');
  assert.equal(session.workspacePath, a.path);
});

test('legacy session paths never guess an SSH owner or an ambiguous catalog row', () => {
  const session = { id: 'legacy', workspacePath: '/project' };
  const local = { path: '/project' };
  const ssh = { path: '/project', remoteConnectionId: 'ssh' };
  assert.equal(remoteSessionBelongsToWorkspace(session, local, [local]), true);
  assert.equal(remoteSessionBelongsToWorkspace(session, local, [local, ssh]), false);
  assert.equal(remoteSessionBelongsToWorkspace(session, ssh, [ssh]), false);
  assert.equal(remoteSessionBelongsToWorkspace({ id: 'missing' }, local, [local]), false);
});

test('workspace identity normalizes trailing separators without aliasing missing paths to root', () => {
  assert.equal(remoteWorkspaceKey({ path: '/project/' }), remoteWorkspaceKey({ path: '/project' }));
  assert.notEqual(remoteWorkspaceKey({ path: '' }), remoteWorkspaceKey({ path: '/' }));
  assert.notEqual(remoteWorkspaceKey({ path: '/project', remoteSshHost: 'a' }),
    remoteWorkspaceKey({ path: '/project', remoteSshHost: 'b' }));
});

test('publishing an already scoped session preserves its owning SSH workspace', () => {
  const original = stampRemoteSessionWorkspace({ id: 'a' }, '/project', 'ssh-a', 'host-a');
  assert.equal(stampRemoteSessionWorkspace(original, '/project', 'ssh-b', 'host-b'), original);
  assert.equal(stampRemoteSessionWorkspace(original, '/local'), original);
});

const { RemoteCommandFactory } = load('RemoteCommandFactory');
test('workspace list and creation commands preserve SSH scope without changing legacy omission', () => {
  const listing = RemoteCommandFactory.listSessions('/repo', 50, 0, '', 'saved', 'host');
  assert.equal(listing.remote_connection_id, 'saved');
  assert.equal(listing.remote_ssh_host, 'host');
  const created = RemoteCommandFactory.createSession({ agentType: 'code', title: '', remoteConnectionId: 'saved', remoteSshHost: 'host' }, '/repo');
  assert.equal(created.remote_connection_id, 'saved');
  assert.equal(created.remote_ssh_host, 'host');
  const legacy = RemoteCommandFactory.listSessions('/repo', 50, 0, '');
  assert.equal(JSON.stringify(legacy).includes('remote_connection_id'), false);
  assert.equal(JSON.stringify(legacy).includes('remote_ssh_host'), false);
});
