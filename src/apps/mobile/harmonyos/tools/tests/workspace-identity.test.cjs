const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.join(__dirname, '../../entry/src/main/ets');
const STUBS = {
  'i18n/RemoteI18n': { RemoteI18n: { t: key => key, f: (key, ...args) => `${key}:${args.join(',')}` } },
  'services/RemoteLogger': { RemoteLogger: { info() {}, warn() {}, error() {} } },
};
const cache = new Map();

/** Loads one .ets module and resolves its relative imports from the source tree. */
function load(relative) {
  if (STUBS[relative]) return STUBS[relative];
  if (cache.has(relative)) return cache.get(relative);
  const source = fs.readFileSync(path.join(ROOT, relative + '.ets'), 'utf8')
    .replace(/@ObservedV2\s*/g, '').replace(/@Trace\s*/g, '');
  const js = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
  } }).outputText;
  const exported = {};
  cache.set(relative, exported);
  new Function('require', 'exports', js)(name => {
    // System modules (@ohos.*, @kit.*) are only reached by code paths these tests do not run.
    if (!name.startsWith('.')) return {};
    const target = path.relative(ROOT, path.resolve(path.join(ROOT, relative), '..', name)).split(path.sep).join('/');
    return load(target);
  }, exported);
  return exported;
}

const {
  remoteWorkspaceKey, legacyRemoteWorkspaceKey, remoteWorkspaceIdentityMatches,
  remoteSessionBelongsToWorkspace, stampRemoteSessionWorkspace
} = load('services/RemoteSessionIdentity');
const { LegacyWorkspaceCompatibility } = load('services/LegacyWorkspaceCompatibility');
const { RemoteCommandFactory } = load('services/RemoteCommandFactory');
const { RemoteResponseMapper } = load('services/RemoteResponseMapper');
const { RemoteSessionManager } = load('services/RemoteSessionManager');
const { mergeLegacyWorkspaces, projectWorkspaceCatalog } = load('services/WorkspaceCatalog');
const { REMOTE_CAPABILITY_WORKSPACE_ID_REFERENCES_V1 } = load('model/RemoteModels');
const { SessionListProjector } = load('pages/policy/SessionListProjection');
const { DeviceDirectoryState } = load('pages/state/DeviceDirectoryState');

const WS = 'ws-0001';

test('an identified reference keys by its ID alone; only ID-less references use the legacy triple', () => {
  const byId = { workspaceId: WS, path: '/repo', remoteConnectionId: 'saved', remoteSshHost: 'host' };
  assert.equal(remoteWorkspaceKey(byId), `workspace:${WS.length}:${WS}`);
  assert.equal(remoteWorkspaceKey(byId), remoteWorkspaceKey({ workspaceId: WS, path: '/moved/elsewhere' }));
  assert.notEqual(remoteWorkspaceKey(byId), remoteWorkspaceKey({ workspaceId: 'ws-0002', path: '/repo' }));
  const legacy = { path: '/repo/', remoteConnectionId: 'saved', remoteSshHost: 'host' };
  assert.equal(remoteWorkspaceKey(legacy), legacyRemoteWorkspaceKey(legacy));
  assert.equal(remoteWorkspaceKey(legacy), remoteWorkspaceKey({ path: '/repo', remoteConnectionId: 'saved', remoteSshHost: 'host' }));
  assert.notEqual(remoteWorkspaceKey({ path: '/repo' }), remoteWorkspaceKey({ path: '/repo', remoteConnectionId: 'saved' }));
  assert.equal(remoteWorkspaceKey({ workspaceId: '', path: '/repo' }), remoteWorkspaceKey({ path: '/repo' }));
});

test('two identified references compare by ID only, whatever their paths say', () => {
  const catalog = [{ workspaceId: WS, path: '/repo' }];
  assert.equal(remoteWorkspaceIdentityMatches({ workspaceId: WS, path: '/repo' }, { workspaceId: WS, path: '/other' }, catalog), true);
  assert.equal(remoteWorkspaceIdentityMatches({ workspaceId: WS, path: '/repo' }, { workspaceId: 'ws-x', path: '/repo' }, catalog), false);
});

test('legacy attribution adopts the unique catalog row and reports its ID', () => {
  const local = { workspaceId: WS, path: '/repo' };
  const ssh = { workspaceId: 'ws-ssh', path: '/srv/repo', remoteConnectionId: 'saved', remoteSshHost: 'host' };
  const catalog = [local, ssh];
  assert.equal(LegacyWorkspaceCompatibility.resolve({ path: '/repo/' }, catalog), local);
  assert.equal(LegacyWorkspaceCompatibility.resolve({ path: '/srv/repo', remoteConnectionId: 'saved' }, catalog), ssh);
  assert.equal(LegacyWorkspaceCompatibility.resolve({ path: '/srv/repo', remoteConnectionId: 'other' }, catalog), undefined);
  assert.equal(LegacyWorkspaceCompatibility.resolve({ path: '/missing' }, catalog), undefined);
  assert.equal(remoteWorkspaceIdentityMatches({ path: '/repo' }, local, catalog), true);
  assert.equal(remoteWorkspaceIdentityMatches({ path: '/repo' }, ssh, catalog), false);
});

test('an unknown ID is an error state and never falls back to the path', () => {
  const local = { workspaceId: WS, path: '/repo' };
  assert.equal(LegacyWorkspaceCompatibility.resolve({ workspaceId: 'ws-unknown', path: '/repo' }, [local]), undefined);
  assert.equal(remoteWorkspaceIdentityMatches({ workspaceId: 'ws-unknown', path: '/repo' }, { path: '/repo' }, [local]), false);
  assert.equal(remoteWorkspaceIdentityMatches({ workspaceId: 'ws-unknown', path: '/repo' }, local, [local]), false);
});

test('an ambiguous legacy path stays unresolved instead of guessing a row', () => {
  const local = { workspaceId: WS, path: '/repo' };
  const ssh = { workspaceId: 'ws-ssh', path: '/repo', remoteConnectionId: 'saved', remoteSshHost: 'host' };
  assert.equal(LegacyWorkspaceCompatibility.resolve({ path: '/repo' }, [local, ssh]), undefined);
  assert.equal(remoteWorkspaceIdentityMatches({ path: '/repo' }, local, [local, ssh]), false);
  assert.equal(remoteWorkspaceIdentityMatches({ path: '/repo' }, ssh, [local, ssh]), false);
  assert.equal(remoteSessionBelongsToWorkspace({ id: 's', workspacePath: '/repo' }, local, [local, ssh]), false);
});

test('a 1.0.0 localhost marker without a saved connection is not an SSH host', () => {
  const local = { workspaceId: WS, path: '/repo' };
  const ssh = { workspaceId: 'ws-ssh', path: '/repo', remoteConnectionId: 'saved', remoteSshHost: 'localhost' };
  assert.equal(LegacyWorkspaceCompatibility.resolve({ path: '/repo', remoteSshHost: 'localhost' }, [local]), local);
  assert.equal(LegacyWorkspaceCompatibility.resolve({ path: '/repo', remoteSshHost: 'localhost' }, [local, ssh]), undefined);
  assert.equal(LegacyWorkspaceCompatibility.resolve({ path: '/repo', remoteConnectionId: 'saved', remoteSshHost: 'localhost' }, [local, ssh]), ssh);
});

test('sessions stamped from an identified listing carry the workspace ID and keep a host-pinned ID', () => {
  const scope = { workspaceId: WS, path: '/repo', remoteConnectionId: 'saved', remoteSshHost: 'host' };
  const stamped = stampRemoteSessionWorkspace({ id: 's1' }, scope);
  assert.deepEqual(stamped.workspaceIdentity, scope);
  assert.equal(stamped.workspacePath, '/repo');
  const pinned = stampRemoteSessionWorkspace({ id: 's2', workspaceIdentity: { workspaceId: 'ws-other', path: '/x' } }, scope);
  assert.equal(pinned.workspaceIdentity.workspaceId, 'ws-other');
  const completed = stampRemoteSessionWorkspace({ id: 's3', workspaceIdentity: { workspaceId: WS, path: '/repo' } }, scope);
  assert.equal(completed.workspaceIdentity.remoteConnectionId, 'saved');
  assert.equal(completed.workspaceIdentity.workspaceId, WS);
  assert.equal(remoteSessionBelongsToWorkspace(stamped, { workspaceId: WS, path: '/renamed' }, []), true);
  assert.equal(remoteSessionBelongsToWorkspace(stamped, { workspaceId: 'ws-other', path: '/repo' }, []), false);
});

test('session_list rows map workspace_id into the session identity', () => {
  const [withId, legacy] = RemoteResponseMapper.allSessions([
    { id: 'a', workspace_id: WS, workspace_path: '/repo', agent_type: 'code' },
    { id: 'b', workspace_path: '/repo', agent_type: 'code' },
  ]);
  assert.deepEqual(withId.workspaceIdentity, { workspaceId: WS, path: '/repo' });
  assert.equal(legacy.workspaceIdentity, undefined);
  assert.equal(legacy.workspacePath, '/repo');
});

test('list_sessions carries only workspace_id when the reference has one', () => {
  const command = RemoteCommandFactory.listSessions({ workspaceId: WS, path: '/repo', remoteConnectionId: 'saved', remoteSshHost: 'host' }, 20, 40, ' q ');
  assert.deepEqual(command, { cmd: 'list_sessions', workspace_id: WS, limit: 20, offset: 40, query: 'q' });
  const legacy = RemoteCommandFactory.listSessions({ path: '/repo', remoteConnectionId: 'saved', remoteSshHost: 'host' }, 50, 0, '');
  assert.deepEqual(legacy, { cmd: 'list_sessions', workspace_path: '/repo', limit: 50, offset: 0, remote_connection_id: 'saved', remote_ssh_host: 'host' });
});

test('set_assistant and set_workspace carry only workspace_id when the reference has one', () => {
  assert.deepEqual(RemoteCommandFactory.setAssistant('/assistant', WS), { cmd: 'set_assistant', workspace_id: WS });
  assert.deepEqual(RemoteCommandFactory.setAssistant('/assistant'), { cmd: 'set_assistant', path: '/assistant' });
  assert.deepEqual(RemoteCommandFactory.setWorkspace('/repo', WS, 'saved', 'host'), { cmd: 'set_workspace', workspace_id: WS });
  assert.deepEqual(RemoteCommandFactory.setWorkspace('/repo'), { cmd: 'set_workspace', path: '/repo' });
  assert.deepEqual(RemoteCommandFactory.setWorkspace('/repo', undefined, 'saved', 'host'),
    { cmd: 'set_workspace', path: '/repo', remote_connection_id: 'saved', remote_ssh_host: 'host' });
});

test('create_session carries only workspace_id when the reference has one', () => {
  const command = RemoteCommandFactory.createSession(
    { agentType: 'code', title: '', instruction: '', workspaceId: WS, remoteConnectionId: 'saved', remoteSshHost: 'host' }, '/repo');
  assert.deepEqual(command, { cmd: 'create_session', agent_type: 'code', session_name: 'Remote Code Session', workspace_id: WS });
  const legacy = RemoteCommandFactory.createSession({ agentType: 'code', title: '', instruction: '', remoteConnectionId: 'saved', remoteSshHost: 'host' }, '/repo');
  assert.equal(legacy.workspace_id, undefined);
  assert.equal(legacy.workspace_path, '/repo');
  assert.equal(legacy.remote_connection_id, 'saved');
});

function manager(capabilities, workspace) {
  const instance = Object.create(RemoteSessionManager.prototype);
  instance.hostCapabilities = capabilities;
  instance.workspace = workspace;
  instance.sent = [];
  return instance;
}

test('session_created.workspace_id is consumed and wins over the requested ID', async () => {
  const m = manager([REMOTE_CAPABILITY_WORKSPACE_ID_REFERENCES_V1]);
  m.send = async command => {
    m.sent.push(command);
    return { resp: 'session_created', session_id: 's1', workspace_id: 'ws-host', workspace_path: '/repo', remote_connection_id: 'saved', remote_ssh_host: 'host' };
  };
  const allocated = [];
  const summary = await m.createSession({ agentType: 'code', title: '', instruction: '', workspaceId: WS, workspacePath: '/repo' },
    async session => { allocated.push(session); });
  assert.deepEqual(m.sent, [{ cmd: 'create_session', agent_type: 'code', session_name: 'Remote Code Session', workspace_id: WS }]);
  assert.equal(summary.workspaceId, 'ws-host');
  assert.equal(summary.workspacePath, '/repo');
  assert.equal(summary.remoteConnectionId, 'saved');
  assert.equal(summary.remoteSshHost, 'host');
  assert.equal(allocated[0].workspaceId, 'ws-host');
});

test('a pre-ID host answering session_created without workspace_id keeps the legacy projection', async () => {
  const m = manager([]);
  m.send = async () => ({ resp: 'session_created', session_id: 's1' });
  const summary = await m.createSession({ agentType: 'code', title: '', instruction: '', workspacePath: '/repo', remoteConnectionId: 'saved', remoteSshHost: 'host' });
  assert.equal(summary.workspaceId, undefined);
  assert.equal(summary.workspacePath, '/repo');
  assert.equal(summary.remoteConnectionId, 'saved');
});

test('an identified reference against a host without workspace_id_references_v1 is an explicit unsupported state', async () => {
  const m = manager(['harness_profiles_v1'], { workspaceId: WS, path: '/repo' });
  m.send = async command => { m.sent.push(command); return { resp: 'ok', success: true, sessions: [] }; };
  await assert.rejects(m.setWorkspace('/repo', undefined, undefined, WS), /errors\.workspaceIdUnsupported/);
  await assert.rejects(m.setAssistant('/assistant', WS), /errors\.workspaceIdUnsupported/);
  await assert.rejects(m.createSession({ agentType: 'code', title: '', instruction: '', workspaceId: WS }), /errors\.workspaceIdUnsupported/);
  await assert.rejects(m.listSessionPageForWorkspace({ workspaceId: WS, path: '/repo' }), /errors\.workspaceIdUnsupported/);
  await assert.rejects(m.listSessions(10, 0, '', ''), /errors\.workspaceIdUnsupported/);
  assert.equal(m.supportsWorkspaceIdReferences(), false);
  assert.deepEqual(m.sent, [], 'no command may be downgraded to a path');
  const legacy = manager(['harness_profiles_v1'], { path: '/repo' });
  legacy.send = async command => { legacy.sent.push(command); return { resp: 'session_list', sessions: [], has_more: false }; };
  await legacy.listSessionPageForWorkspace({ path: '/repo', remoteConnectionId: 'saved' });
  assert.deepEqual(legacy.sent, [{ cmd: 'list_sessions', workspace_path: '/repo', limit: 50, offset: 0, remote_connection_id: 'saved' }]);
});

test('manager listings use the active workspace ID and stamp it on every row', async () => {
  const m = manager([REMOTE_CAPABILITY_WORKSPACE_ID_REFERENCES_V1], { workspaceId: WS, path: '/repo', remoteConnectionId: 'saved' });
  m.send = async command => {
    m.sent.push(command);
    return { resp: 'session_list', sessions: [{ id: 'a', workspace_id: WS, workspace_path: '/repo', agent_type: 'code' }, { id: 'b', agent_type: 'code' }], has_more: false };
  };
  assert.equal(m.supportsWorkspaceIdReferences(), true);
  const page = await m.listSessions(10, 0, '', '');
  assert.deepEqual(m.sent, [{ cmd: 'list_sessions', workspace_id: WS, limit: 10, offset: 0 }]);
  assert.deepEqual(page.sessions.map(s => s.workspaceIdentity.workspaceId), [WS, WS]);
  assert.equal(page.sessions[0].workspaceIdentity.remoteConnectionId, 'saved');
  m.sent.length = 0;
  await m.listSessionPageForWorkspace({ workspaceId: 'ws-2', path: '/other' }, 7);
  assert.deepEqual(m.sent, [{ cmd: 'list_sessions', workspace_id: 'ws-2', limit: 7, offset: 0 }]);
});

test('legacy catalog merge dedups by workspaceId when present and by legacy triple otherwise', () => {
  const rows = mergeLegacyWorkspaces([
    { workspaceId: WS, path: '/moved', name: 'Moved', lastOpened: '', workspaceKind: 'normal' },
    { path: '/assistant', name: 'Folder', lastOpened: '', workspaceKind: 'normal' },
    { path: '/assistant', name: 'SSH', lastOpened: '', workspaceKind: 'normal', remoteConnectionId: 'saved' },
    { workspaceId: 'ws-9', path: '/assistant', name: 'Other ID', lastOpened: '', workspaceKind: 'normal' },
  ], [{ workspace_id: WS, path: '/assistant', name: 'Assistant' }]);
  assert.deepEqual(rows.map(row => row.name), ['Assistant', 'Folder', 'SSH', 'Other ID']);
  assert.equal(rows[0].workspaceId, WS);
});

test('old-shape cached catalog rows without workspace_id remain readable and keep their identity', () => {
  const catalog = projectWorkspaceCatalog({ workspaces: [
    { path: '/repo', name: 'Old row' },
    { path: '/repo', name: 'Old SSH row', remote_connection_id: 'saved', remote_ssh_host: 'host', workspace_kind: 'remote' },
    { workspace_id: WS, path: '/repo', name: 'New row' },
  ] }, []);
  assert.deepEqual(catalog.workspaces.map(row => row.workspaceId), [undefined, undefined, WS]);
  assert.deepEqual(catalog.workspaces.map(row => row.name), ['Old row', 'Old SSH row', 'New row']);
});

test('sidebar sections key by workspaceId and attribute pre-ID sessions through the resolver', () => {
  const current = { workspaceId: WS, path: '/repo', name: 'Repo', lastOpened: '', workspaceKind: 'normal' };
  const ssh = { workspaceId: 'ws-ssh', path: '/repo', name: 'Repo on host', lastOpened: '', workspaceKind: 'remote', remoteConnectionId: 'saved', remoteSshHost: 'host' };
  const assistant = { workspaceId: 'ws-assistant', path: '/assistant', name: 'Assistant', lastOpened: '', workspaceKind: 'assistant' };
  const other = { path: '/legacy', name: 'Legacy', lastOpened: '', workspaceKind: 'normal' };
  const sessions = [
    { id: 'byId', title: 'a', agentType: 'code', status: 'idle', updatedAt: '', createdAt: '', messageCount: 0, workspacePath: '/renamed', workspaceIdentity: { workspaceId: WS, path: '/renamed' } },
    { id: 'sshById', title: 'b', agentType: 'code', status: 'idle', updatedAt: '', createdAt: '', messageCount: 0, workspacePath: '/repo', workspaceIdentity: { workspaceId: 'ws-ssh', path: '/repo' } },
    { id: 'ambiguous', title: 'c', agentType: 'code', status: 'idle', updatedAt: '', createdAt: '', messageCount: 0, workspacePath: '/repo' },
    { id: 'legacy', title: 'd', agentType: 'code', status: 'idle', updatedAt: '', createdAt: '', messageCount: 0, workspacePath: '/legacy/' },
    { id: 'assistantById', title: 'e', agentType: 'code', status: 'idle', updatedAt: '', createdAt: '', messageCount: 0, workspacePath: '/assistant', workspaceIdentity: { workspaceId: 'ws-assistant', path: '/assistant' } },
  ];
  const projection = SessionListProjector.project({
    sessions, query: '', sortMode: 'project', workspaceName: 'Repo', workspacePath: '/repo', workspaceId: WS,
    workspaceKind: 'normal', recentWorkspaces: [current, ssh, assistant, other], workspaceFilter: '', agentFilter: '',
    statusFilter: '', showWorkspaceMetadata: false, showUpdatedMetadata: false, showStatusMetadata: false
  });
  assert.deepEqual(projection.projects.map(p => p.workspaceId), [WS, 'ws-ssh', undefined]);
  assert.deepEqual(SessionListProjector.sessionsForProject(projection, { workspaceId: WS, path: '/whatever' }).map(s => s.id), ['byId']);
  assert.deepEqual(SessionListProjector.sessionsForProject(projection, ssh).map(s => s.id), ['sshById']);
  assert.deepEqual(SessionListProjector.sessionsForProject(projection, other).map(s => s.id), ['legacy']);
  assert.deepEqual(SessionListProjector.sessionsForProject(projection, { path: '/legacy' }).map(s => s.id), ['legacy']);
  assert.deepEqual(projection.chats.map(s => s.id), ['assistantById']);
  assert.equal(projection.filtered.some(s => s.id === 'ambiguous'), true, 'unattributed sessions are kept, not dropped');
  assert.equal(SessionListProjector.sectionKeyFor(current), `workspace:${WS.length}:${WS}`);
});

test('disclosure rows match by workspaceId first and keep same-path SSH rows apart without IDs', () => {
  const state = new DeviceDirectoryState();
  state.setWorkspaceExpanded('desktop', '/repo', true, 'saved', 'host', WS);
  assert.equal(state.workspaceExpanded('desktop', '/renamed', undefined, undefined, WS), true);
  assert.equal(state.workspaceExpanded('desktop', '/repo', 'saved', 'host', 'ws-other'), false);
  const load = state.workspaceLoadState('desktop', '/renamed', undefined, undefined, WS);
  assert.equal(load.expanded, true);
  assert.equal(load.workspaceId, WS);
  assert.equal(state.isCurrentWorkspaceLoad(load), true);
  const legacyA = state.workspaceLoadState('desktop', '/same', 'a', 'host-a');
  const legacyB = state.workspaceLoadState('desktop', '/same', 'b', 'host-b');
  assert.notEqual(legacyA, legacyB);
  assert.equal(state.workspaceDirectory.length, 3);
});
