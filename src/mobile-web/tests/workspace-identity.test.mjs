import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/services/workspaceIdentity.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const {
  mergeWorkspaceSessions, sessionMatchesWorkspace, workspaceIdentityKey,
  resolveLegacyWorkspaceReference, sameWorkspace,
  isClawAgent, isRemoteSessionWorkspace, resolveChatHeaderContext, selectedSessionWorkspaceContext,
  sessionWorkspaceContext, workspaceContext,
} = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
);

const a = { path: '/projects/herdr', remote_connection_id: 'ssh-a', remote_ssh_host: 'host-a' };
const b = { path: a.path, remote_connection_id: 'ssh-b', remote_ssh_host: 'host-b' };
const local = { path: a.path };
const row = (id, identity) => ({
  session_id: id, name: id, agent_type: 'agentic', created_at: '1', updated_at: '1',
  message_count: 0, workspace_path: a.path, workspace_identity: identity,
});

test('same-path SSH and local session caches retain distinct ownership after reload', () => {
  let sessions = mergeWorkspaceSessions([], [row('a')], a, true);
  sessions = mergeWorkspaceSessions(sessions, [row('b')], b, true);
  sessions = mergeWorkspaceSessions(sessions, [row('local')], local, true);
  sessions = JSON.parse(JSON.stringify(sessions));
  for (const [workspace, id] of [[a, 'a'], [b, 'b'], [local, 'local']]) {
    assert.deepEqual(sessions.filter(s => sessionMatchesWorkspace(s, workspace, [a, b, local]))
      .map(s => s.session_id), [id]);
  }
  const refreshed = mergeWorkspaceSessions(sessions, [], a, true);
  assert.deepEqual(refreshed.map(s => s.session_id), ['b', 'local']);
});

test('legacy rows remain readable and are retained without guessing a remote host', () => {
  const legacy = JSON.parse(JSON.stringify(row('legacy')));
  assert.equal(sessionMatchesWorkspace(legacy, local), true);
  assert.equal(sessionMatchesWorkspace(legacy, a), false);
  assert.equal(sessionMatchesWorkspace(legacy, local, [a, local]), false);
  assert.deepEqual(mergeWorkspaceSessions([legacy], [], a, true), [legacy]);
  const repaired = mergeWorkspaceSessions([legacy], [legacy], b, true);
  assert.equal(repaired.length, 1);
  assert.equal(sessionMatchesWorkspace(repaired[0], b), true);
  const unscopedRefresh = mergeWorkspaceSessions(repaired, [legacy], undefined, false);
  assert.equal(sessionMatchesWorkspace(unscopedRefresh[0], b), true);
});

test('workspace identity keys cannot collide through delimiter-shaped paths and ids', () => {
  assert.notEqual(workspaceIdentityKey(a), workspaceIdentityKey(b));
  assert.notEqual(workspaceIdentityKey(a), workspaceIdentityKey(local));
  assert.notEqual(workspaceIdentityKey({ path: 'c:d', remote_connection_id: 'a', remote_ssh_host: 'b' }),
    workspaceIdentityKey({ path: 'd', remote_connection_id: 'a:b', remote_ssh_host: 'c' }));
});

const { projectWorkspaceCatalog } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
);
const named = (identity, name) => ({ ...identity, name, last_opened: '' });
const assistant = { path: '/assistant/workspace', name: 'Mina', workspace_kind: 'assistant', last_opened: '' };

test('opened catalog excludes closed history and preserves the assistant identity name', () => {
  const response = {
    workspaces: [named(a, 'Closed SSH'), named(local, 'Project'), named({ path: '/old-worktree' }, 'Closed worktree')],
    opened_workspaces: [assistant, named(local, 'Project')],
  };
  const catalog = projectWorkspaceCatalog(JSON.parse(JSON.stringify(response)));
  assert.equal(catalog.source, 'opened');
  assert.deepEqual(catalog.workspaces.map(w => w.name), ['Mina', 'Project']);
  assert.equal(catalog.workspaces[0].workspace_kind, 'assistant');
  // A successful empty refresh must stay empty, even with retained history.
  assert.deepEqual(projectWorkspaceCatalog({ ...response, opened_workspaces: [] }).workspaces, []);
  assert.deepEqual(response.workspaces.map(w => w.name), ['Closed SSH', 'Project', 'Closed worktree']);
});

test('catalog preserves same-path SSH identities and never substitutes a local assistant name', () => {
  const response = { workspaces: [], opened_workspaces: [named(a, 'A'), named(b, 'B'), named(local, 'Local'), named(a, 'duplicate')] };
  assert.deepEqual(projectWorkspaceCatalog(response).workspaces.map(w => w.name), ['A', 'B', 'Local']);
});

test('legacy hosts advertise recent-history fallback and resolve assistants without guessing paths', () => {
  const legacy = JSON.parse(JSON.stringify({ workspaces: [
    named({ path: assistant.path }, 'workspace'),
    named({ path: '/ordinary/workspace' }, 'workspace'),
    named({ path: assistant.path, remote_connection_id: 'ssh-a', remote_ssh_host: 'host-a' }, 'Remote workspace'),
  ] }));
  const catalog = projectWorkspaceCatalog(legacy, [assistant]);
  assert.equal(catalog.source, 'recent');
  assert.deepEqual(catalog.workspaces.map(w => w.name), ['Mina', 'workspace', 'Remote workspace']);
  assert.equal(catalog.workspaces[0].workspace_kind, 'assistant');
});

async function moduleUrl(relative, imports = {}) {
  let transformed = ts.transpileModule(await readFile(new URL(relative, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  transformed = transformed.replace(/from (['"])([^'"]+)\1/g, (_, quote, specifier) => {
    assert.ok(imports[specifier], `unexpected dependency ${specifier}`);
    return `from ${JSON.stringify(imports[specifier])}`;
  });
  return `data:text/javascript;base64,${Buffer.from(transformed).toString('base64')}`;
}
const agentContract = await moduleUrl('../../shared/agent-harness/contract.generated.ts');
const agentWire = await moduleUrl('../../shared/agent-harness/wire.ts', { './contract.generated': agentContract });
const controlIdentity = await moduleUrl('../src/services/controlClientIdentity.ts');
const hostStream = await moduleUrl('../../shared/relay-transport/HostStream.ts');
const managerUrl = await moduleUrl('../src/services/RemoteSessionManager.ts', {
  '../../../shared/agent-harness/wire': agentWire,
  '../../../shared/dialog-queue/HostDialogQueue': 'data:text/javascript,export class HostDialogQueue {}',
  '../../../shared/relay-transport/HostStream': hostStream,
  './controlClientIdentity': controlIdentity,
  './SessionSynchronizer': 'data:text/javascript,export class SessionSynchronizer {}',
  './workspaceIdentity': `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`,
});
const {
  RemoteSessionManager, RemoteControlTargetChangedError,
  WorkspaceIdReferencesUnsupportedError, isWorkspaceIdReferencesUnsupportedError, projectWorkspaceWireReference,
} = await import(managerUrl);
function catalogClient(handler) {
  const client = {
    controlTargetEpoch: 1,
    targetDeviceId: 'desktop-a',
    getControlTargetSnapshot: () => ({ epoch: client.controlTargetEpoch, deviceId: client.targetDeviceId }),
    isControlTargetCurrent: snapshot => snapshot.epoch === client.controlTargetEpoch && snapshot.deviceId === client.targetDeviceId,
    sendDeviceRpc: handler,
  };
  return client;
}

test('manager preserves opened membership while enriching assistant labels', async () => {
  const calls = [];
  const manager = new RemoteSessionManager(catalogClient(async (device, cmd) => {
    calls.push(cmd.cmd);
    return { resp: 'recent_workspaces', workspaces: [named(a, 'Closed')], opened_workspaces: [assistant] };
  }));
  const catalog = await manager.listWorkspaceCatalog();
  assert.deepEqual(catalog.workspaces, [assistant]);
  assert.deepEqual(calls, ['list_recent_workspaces', 'list_assistants']);
});

test('legacy catalog reads stay on one device generation across both requests', async () => {
  const calls = [];
  let completeAssistants;
  const client = catalogClient(async (device, cmd) => {
    calls.push([device, cmd.cmd]);
    if (cmd.cmd === 'list_recent_workspaces') return { resp: 'recent_workspaces', workspaces: [] };
    return new Promise(resolve => { completeAssistants = resolve; });
  });
  const pending = new RemoteSessionManager(client).listWorkspaceCatalog();
  while (!completeAssistants) await new Promise(resolve => setImmediate(resolve));
  client.controlTargetEpoch = 2;
  client.targetDeviceId = 'desktop-b';
  completeAssistants({ resp: 'assistant_list', assistants: [assistant] });
  await assert.rejects(pending, RemoteControlTargetChangedError);
  assert.deepEqual(calls, [['desktop-a', 'list_recent_workspaces'], ['desktop-a', 'list_assistants']]);
});

test('question activity is capability-gated and scoped to its owning session', async () => {
  const calls = [];
  const client = catalogClient(async (device, cmd) => {
    calls.push([device, cmd]);
    return { resp: 'interaction_accepted', action: 'start_question_interaction', target_id: 'tool-a' };
  });
  const legacy = new RemoteSessionManager(client);
  await assert.rejects(legacy.startQuestionInteraction('session-a', 'tool-a'), /does not support/);
  assert.equal(calls.length, 0);
  const manager = new RemoteSessionManager(client, ['user_question_interaction_v1']);
  await manager.startQuestionInteraction('session-a', 'tool-a');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'desktop-a');
  assert.equal(calls[0][1].cmd, 'start_question_interaction');
  assert.equal(calls[0][1].session_id, 'session-a');
  assert.equal(calls[0][1].tool_id, 'tool-a');
  assert.equal(calls[0][1].answers, undefined);
});


test('workspace IDs remain authoritative when paths move or collide', () => {
  const first = { workspace_id: 'first', path: '/shared' };
  const second = { workspace_id: 'second', path: '/shared' };
  assert.notEqual(workspaceIdentityKey(first), workspaceIdentityKey(second));
  assert.equal(workspaceIdentityKey(first), workspaceIdentityKey({ ...first, path: '/moved' }));
  assert.equal(sessionMatchesWorkspace(row('session', first), second), false);
  assert.equal(sessionMatchesWorkspace(row('legacy'), first), false);
});

test('an ID-less session is attributed to a local workspace only when its path is unique in the catalog', () => {
  const legacy = JSON.parse(JSON.stringify(row('legacy')));
  const twin = { path: a.path };
  assert.equal(sessionMatchesWorkspace(legacy, local, [local]), true);
  // Two local rows with the same path: unresolved for both.
  assert.equal(sessionMatchesWorkspace(legacy, local, [local, twin]), false);
  assert.equal(sessionMatchesWorkspace(legacy, twin, [local, twin]), false);
  // A remote row with the same path makes the root ambiguous.
  assert.equal(sessionMatchesWorkspace(legacy, local, [a, local]), false);
  // Never attributed to a remote workspace.
  assert.equal(sessionMatchesWorkspace(legacy, a, [a]), false);
  // Trailing slashes are not identity.
  assert.equal(sessionMatchesWorkspace(legacy, { path: `${a.path}/` }, [{ path: `${a.path}/` }]), true);
  // A path-less session cannot be attributed at all.
  assert.equal(sessionMatchesWorkspace({ ...legacy, workspace_path: undefined }, local, [local]), false);
});

test('legacy reference resolution mirrors the host resolver', () => {
  const catalog = [{ workspace_id: 'ws-a', ...a }, { workspace_id: 'ws-b', ...b }, { workspace_id: 'ws-local', ...local }];
  assert.equal(resolveLegacyWorkspaceReference({ workspace_id: 'ws-b', path: '/elsewhere' }, catalog), catalog[1]);
  // Unknown IDs never fall back to the path they happen to carry.
  assert.equal(resolveLegacyWorkspaceReference({ workspace_id: 'missing', path: a.path }, catalog), undefined);
  assert.equal(resolveLegacyWorkspaceReference({ path: a.path }, catalog), undefined);
  assert.equal(resolveLegacyWorkspaceReference({ path: a.path, remote_connection_id: 'ssh-a' }, catalog), catalog[0]);
  assert.equal(resolveLegacyWorkspaceReference({ path: a.path, remote_ssh_host: 'host-b' }, catalog), catalog[1]);
  // 1.0.0 stamped sshHost=localhost on local rows; without a connection it is ignored.
  assert.equal(resolveLegacyWorkspaceReference({ path: `${a.path}/`, remote_ssh_host: 'localhost' }, [catalog[2]]), catalog[2]);
  assert.equal(resolveLegacyWorkspaceReference({ path: a.path, remote_connection_id: 'ssh-a', remote_ssh_host: 'localhost' }, catalog), undefined);
  assert.equal(resolveLegacyWorkspaceReference({ path: '' }, catalog), undefined);
  assert.equal(sameWorkspace({ workspace_id: 'ws-a', path: '/x' }, { workspace_id: 'ws-a', path: '/y' }), true);
  assert.equal(sameWorkspace({ workspace_id: 'ws-a', ...a }, { workspace_id: 'ws-b', ...a }), false);
  assert.equal(sameWorkspace({ workspace_id: 'ws-local', path: a.path }, { path: a.path }), true);
  assert.equal(sameWorkspace({ workspace_id: 'ws-local', path: a.path }, a), false);
  assert.equal(sameWorkspace(undefined, a), false);
});

test('old-shape cache records without workspace IDs stay readable and resolve through the compatibility helper', () => {
  // Exact persisted shape written by pre-ID builds: no workspace_id anywhere,
  // provenance rows with the legacy triple, and one row without provenance.
  const oldRecord = JSON.parse(JSON.stringify({
    key: 'acct::device', accountId: 'acct', deviceId: 'device', updatedAt: 1,
    workspaces: [named(a, 'A'), named(local, 'Local')],
    sessions: [
      row('ssh', { path: a.path, remote_connection_id: 'ssh-a', remote_ssh_host: 'host-a' }),
      row('local', { path: a.path }),
      row('bare'),
    ],
  }));
  // The upgraded host now serves the same rows with IDs.
  const upgraded = [{ ...named(a, 'A'), workspace_id: 'ws-a' }, { ...named(local, 'Local'), workspace_id: 'ws-local' }];
  const attributed = (sessions, workspace, catalog) => sessions
    .filter(session => sessionMatchesWorkspace(session, workspace, catalog)).map(session => session.session_id);
  assert.deepEqual(attributed(oldRecord.sessions, upgraded[0], upgraded), ['ssh']);
  assert.deepEqual(attributed(oldRecord.sessions, upgraded[1], upgraded), ['local']);
  // The old catalog projection keeps working for the same record.
  assert.deepEqual(attributed(oldRecord.sessions, oldRecord.workspaces[0], oldRecord.workspaces), ['ssh']);
  assert.deepEqual(attributed(oldRecord.sessions, oldRecord.workspaces[1], oldRecord.workspaces), ['local']);
  // An ID-scoped refresh replaces only that workspace's stale rows and stamps the ID.
  const merged = JSON.parse(JSON.stringify(mergeWorkspaceSessions(
    oldRecord.sessions, [row('fresh', undefined)], { workspace_id: 'ws-local', path: a.path }, true,
  )));
  assert.deepEqual(merged.map(session => session.session_id).sort(), ['bare', 'fresh', 'ssh']);
  const fresh = merged.find(session => session.session_id === 'fresh');
  assert.equal(fresh.workspace_id, 'ws-local');
  assert.equal(fresh.workspace_identity.workspace_id, 'ws-local');
  assert.deepEqual(attributed(merged, upgraded[1], upgraded), ['fresh']);
  assert.deepEqual(attributed(merged, upgraded[0], upgraded), ['ssh']);
  // A session that carries an ID is never attributed to a pre-ID row by path.
  assert.deepEqual(attributed(merged, oldRecord.workspaces[1], oldRecord.workspaces), []);
  // Nothing was dropped for being unresolvable.
  assert.ok(merged.some(session => session.session_id === 'bare'));
});

test('wire projection sends only the ID when one exists and only the legacy triple otherwise', () => {
  assert.deepEqual(projectWorkspaceWireReference({ workspaceId: ' ws-a ', path: a.path, remoteConnectionId: 'ssh-a', remoteSshHost: 'host-a' }, 'workspace_path'), { workspace_id: 'ws-a' });
  assert.deepEqual(projectWorkspaceWireReference({ path: a.path, remoteConnectionId: 'ssh-a', remoteSshHost: 'host-a' }, 'path'),
    { path: a.path, remote_connection_id: 'ssh-a', remote_ssh_host: 'host-a' });
  assert.deepEqual(projectWorkspaceWireReference({ path: a.path }, 'workspace_path'), { workspace_path: a.path });
  assert.deepEqual(projectWorkspaceWireReference(undefined, 'workspace_path', { nullablePath: true }), { workspace_path: null });
  assert.deepEqual(projectWorkspaceWireReference({ workspaceId: '' }, 'workspace_path'), { workspace_path: undefined });
});

const hostFixture = (capabilities, calls) => catalogClient(async (device, cmd) => {
  calls.push(cmd);
  switch (cmd.cmd) {
    case 'get_workspace_info':
      return { resp: 'workspace_info', has_workspace: true, path: a.path, ...(capabilities ? { workspace_id: 'ws-a', capabilities } : {}) };
    case 'list_sessions':
      return { resp: 'session_list', has_more: false, sessions: [{
        session_id: 's1', name: 's1', agent_type: 'agentic', created_at: '1', updated_at: '1', message_count: 0,
        workspace_path: a.path, ...(capabilities ? { workspace_id: 'ws-a' } : {}),
      }] };
    case 'create_session':
      return capabilities
        ? { resp: 'session_created', session_id: 's2', workspace_id: 'ws-a', workspace_path: a.path, remote_connection_id: 'ssh-a', remote_ssh_host: 'host-a' }
        : { resp: 'session_created', session_id: 's2' };
    case 'set_workspace': return { resp: 'workspace_set', success: true, workspace_id: 'ws-a', path: a.path };
    case 'set_assistant': return { resp: 'assistant_set', success: true, workspace_id: 'ws-m', path: assistant.path };
    default: throw new Error(`unexpected ${cmd.cmd}`);
  }
});

test('workspace-scoped commands send only the workspace ID to an ID-aware host', async () => {
  const calls = [];
  const manager = new RemoteSessionManager(hostFixture(['workspace_id_references_v1'], calls));
  const identity = { workspaceId: 'ws-a', remoteConnectionId: 'ssh-a', remoteSshHost: 'host-a' };
  const listed = await manager.listSessions(a.path, 30, 0, '', identity);
  const created = await manager.createSession('agentic', undefined, a.path, identity);
  await manager.setWorkspace({ ...named(a, 'A'), workspace_id: 'ws-a' });
  await manager.setAssistant({ ...assistant, workspace_id: 'ws-m' });
  assert.deepEqual(calls.map(cmd => cmd.cmd), ['get_workspace_info', 'list_sessions', 'create_session', 'set_workspace', 'set_assistant']);
  for (const cmd of calls.slice(1)) {
    assert.equal(cmd.workspace_id, cmd.cmd === 'set_assistant' ? 'ws-m' : 'ws-a');
    for (const field of ['workspace_path', 'path', 'remote_connection_id', 'remote_ssh_host']) {
      assert.equal(field in cmd, false, `${cmd.cmd} leaked ${field}`);
    }
  }
  assert.equal(manager.supportsWorkspaceIdReferences(), true);
  assert.equal(listed.sessions[0].workspace_id, 'ws-a');
  assert.deepEqual(listed.sessions[0].workspace_identity, { workspace_id: 'ws-a', path: a.path, remote_connection_id: 'ssh-a', remote_ssh_host: 'host-a' });
  assert.deepEqual(created, { session_id: 's2', workspace_id: 'ws-a', workspace_path: a.path, remote_connection_id: 'ssh-a', remote_ssh_host: 'host-a' });
});

test('ID-less references keep the legacy triple and IDs are refused by hosts without workspace_id_references_v1', async () => {
  const calls = [];
  const client = hostFixture(undefined, calls);
  const manager = new RemoteSessionManager(client);
  const legacyIdentity = { remoteConnectionId: 'ssh-a', remoteSshHost: 'host-a' };
  const listed = await manager.listSessions(a.path, 30, 0, '', legacyIdentity);
  const created = await manager.createSession('agentic', undefined, a.path, legacyIdentity);
  await manager.listSessions(undefined, 30, 0, '', undefined);
  assert.deepEqual(calls.map(cmd => cmd.cmd), ['list_sessions', 'create_session', 'list_sessions']);
  for (const cmd of calls.slice(0, 2)) {
    assert.equal('workspace_id' in cmd, false);
    assert.equal(cmd.workspace_path, a.path);
    assert.equal(cmd.remote_connection_id, 'ssh-a');
    assert.equal(cmd.remote_ssh_host, 'host-a');
  }
  assert.equal(calls[2].workspace_path, null);
  assert.equal(listed.sessions[0].workspace_id, undefined);
  assert.deepEqual(created, { session_id: 's2', workspace_id: undefined, workspace_path: a.path, remote_connection_id: 'ssh-a', remote_ssh_host: 'host-a' });

  const before = calls.length;
  await assert.rejects(manager.listSessions(a.path, 30, 0, '', { workspaceId: 'ws-a' }), WorkspaceIdReferencesUnsupportedError);
  await assert.rejects(manager.setWorkspace({ ...named(a, 'A'), workspace_id: 'ws-a' }),
    error => isWorkspaceIdReferencesUnsupportedError(error) && error.workspaceId === 'ws-a'
      && error.messageKey === 'workspace.idReferencesUnsupported');
  await assert.rejects(manager.createSession('agentic', undefined, a.path, { workspaceId: 'ws-a' }), WorkspaceIdReferencesUnsupportedError);
  await assert.rejects(manager.setAssistant({ ...assistant, workspace_id: 'ws-m' }), WorkspaceIdReferencesUnsupportedError);
  await assert.rejects(manager.getFileInfo('/file', undefined, { workspaceId: 'ws-a', path: a.path }), WorkspaceIdReferencesUnsupportedError);
  // One capability probe; no scoped command reached the host with a path downgrade.
  assert.deepEqual(calls.slice(before).map(cmd => cmd.cmd), ['get_workspace_info']);
  assert.equal(manager.supportsWorkspaceIdReferences(), false);

  // A switched control target is unknown again and is probed on its own.
  client.controlTargetEpoch = 2;
  client.targetDeviceId = 'desktop-b';
  client.sendDeviceRpc = hostFixture(['workspace_id_references_v1'], calls).sendDeviceRpc;
  const switched = calls.length;
  await manager.listSessions(a.path, 30, 0, '', { workspaceId: 'ws-a' });
  assert.deepEqual(calls.slice(switched).map(cmd => cmd.cmd), ['get_workspace_info', 'list_sessions']);
  assert.deepEqual(Object.keys(calls.at(-1)).filter(key => key !== '_request_id' && key !== 'cmd').sort(), ['limit', 'offset', 'query', 'workspace_id']);
});

test('rollback refuses legacy hosts without sending an unknown mutation', async () => {
  const calls = [];
  const manager = new RemoteSessionManager(catalogClient(async (_device, command) => {
    calls.push(command);
  }), ['host_stream_v1']);
  await assert.rejects(manager.rollbackSessionToTurn('session-a', 'turn-a', 7), /does not support/);
  assert.deepEqual(calls, []);
});

test('rollback forwards the streamed storage index and validates the acknowledgement', async () => {
  const { presentSessionTurn } = await import(await moduleUrl('../src/services/SessionRecordPresentation.ts'));
  const [message] = presentSessionTurn({ turnId: 'turn-a', turnIndex: 7, status: 'completed', timestamp: 1,
    userMessage: { id: 'user-a', content: 'hello', timestamp: 1 }, modelRounds: [] });
  let response = { resp: 'session_rolled_back', session_id: 'session-a', retired_turn_ids: ['turn-a'],
    restored_files: [], composer_text: 'hello', changed: true };
  const calls = [];
  const manager = new RemoteSessionManager(catalogClient(async (_device, command) => {
    calls.push(command);
    return response;
  }), ['session_rollback_v1']);
  assert.equal((await manager.rollbackSessionToTurn('session-a', message.turn_id, message.turn_index)).changed, true);
  assert.equal(calls[0].expected_storage_turn_index, 7);
  response = { ...response, session_id: 'session-b' };
  await assert.rejects(manager.rollbackSessionToTurn('session-a', 'turn-a', 7), /Invalid session rollback response/);
  response = { ...response, session_id: 'session-a', composer_text: { unexpected: 'object' } };
  await assert.rejects(manager.rollbackSessionToTurn('session-a', 'turn-a', 7), /Invalid session rollback response/);
  response = { resp: 'ok' };
  await assert.rejects(manager.rollbackSessionToTurn('session-a', 'turn-a', 7), /Invalid session rollback response/);
});

test('rollback completion cannot cross a control target switch', async () => {
  let finish;
  const client = catalogClient(() => new Promise(resolve => { finish = resolve; }));
  const manager = new RemoteSessionManager(client, ['session_rollback_v1']);
  const pending = manager.rollbackSessionToTurn('session-a', 'turn-a', 7);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  client.controlTargetEpoch = 2;
  client.targetDeviceId = 'desktop-b';
  finish({ resp: 'session_rolled_back', session_id: 'session-a', retired_turn_ids: ['turn-a'], restored_files: [], changed: true });
  await assert.rejects(pending, RemoteControlTargetChangedError);
  await assert.rejects(manager.rollbackSessionToTurn('session-a', 'turn-a', 7), /does not support/);
});

test('workspace icons negotiate support and send only the authoritative host workspace ID', async () => {
  const calls = [];
  const snapshot = { workspaceId: 'project', icon: { version: 1, revision: 2, mode: 'default', color: 'blue', glyph: 'learning' }, imageUnavailable: false, supportedGlyphs: ['default', 'learning'], darkImageData: 'data:image/png;base64,dark', supportsThemedImages: true };
  const client = catalogClient(async (device, command) => {
    calls.push([device, command]);
    return { resp: 'workspace_icon', snapshot };
  });
  assert.equal(await new RemoteSessionManager(client, []).getWorkspaceIcon('project'), null);
  assert.deepEqual(calls, []);
  const manager = new RemoteSessionManager(client, ['workspace_icon_read_v1']);
  assert.deepEqual(await manager.getWorkspaceIcon('project'), snapshot);
  assert.equal(calls.length, 1);
  const { _request_id, ...command } = calls[0][1];
  assert.ok(_request_id);
  assert.deepEqual([calls[0][0], command], ['desktop-a', { cmd: 'get_workspace_icon', workspace_id: 'project' }]);
});

test('workspace icon responses cannot cross a device A -> B -> A switch', async () => {
  let complete;
  const client = catalogClient(() => new Promise(resolve => { complete = resolve; }));
  const manager = new RemoteSessionManager(client, ['workspace_icon_read_v1']);
  const pending = manager.getWorkspaceIcon('same-id');
  while (!complete) await new Promise(resolve => setImmediate(resolve));
  client.controlTargetEpoch += 2;
  complete({ resp: 'workspace_icon', snapshot: { workspaceId: 'same-id', icon: { version: 1, revision: 0, mode: 'default', color: 'red' } } });
  await assert.rejects(pending, RemoteControlTargetChangedError);
});

test('workspace icons reject future formats and external image URLs without local fallback', async () => {
  for (const patch of [{ icon: { version: 2 } }, { imageData: 'file:///controller/private.png' }, { darkImageData: 'file:///controller/private-dark.png' }, { darkImageData: 123 }]) {
    let calls = 0;
    const manager = new RemoteSessionManager(catalogClient(async () => {
      calls++;
      return { resp: 'workspace_icon', snapshot: { workspaceId: 'project', icon: { version: 1, revision: 0, mode: 'image', color: 'default' }, ...patch } };
    }), ['workspace_icon_read_v1']);
    await assert.rejects(manager.getWorkspaceIcon('project'), /Unsupported workspace icon/);
    assert.equal(calls, 1);
  }
});

const home = {
  workspace_id: 'ws-home', has_workspace: true, path: '/Users/me/home',
  project_name: 'home', git_branch: 'master', workspace_kind: 'normal',
};
const claw = { workspace_id: 'ws-claw', path: '/Users/me/.bitfun/personal_assistant/workspace', name: 'Nova' };
const header = (overrides) => resolveChatHeaderContext({
  agentType: 'Standard',
  currentWorkspace: home,
  currentAssistant: null,
  assistantLabel: 'Claw',
  ...overrides,
});

test('assistant sessions never inherit the selected normal workspace or its branch', () => {
  // Issue 2360: Pro mode selected `home / master`, then a Claw session is opened.
  const owner = workspaceContext({ ...claw, workspace_kind: 'assistant' });
  const session = sessionWorkspaceContext({
    workspace_id: 'ws-claw', workspace_path: claw.path, workspace_name: 'workspace',
  }, owner);
  assert.deepEqual(header({ agentType: 'Claw', session }), { workspaceName: 'Nova' });
  // A catalog row may carry the kind without the agent type saying Claw.
  assert.deepEqual(header({ agentType: 'Cowork', session }), { workspaceName: 'Nova' });
  // The selected assistant is matched by identity and supplies the current name.
  assert.deepEqual(
    header({ agentType: 'claw', session: { path: claw.path }, currentAssistant: claw }),
    { workspaceName: 'Nova' },
  );
});

test('a different selected assistant does not rename an attributed assistant session', () => {
  const session = { workspace_id: 'ws-claw', path: claw.path, name: 'Nova', workspace_kind: 'assistant' };
  const other = { workspace_id: 'ws-other', path: '/Users/me/other', name: 'Other' };
  assert.deepEqual(header({ agentType: 'Claw', session, currentAssistant: other }), { workspaceName: 'Nova' });
});

test('assistant sessions without workspace facts use the selection, then the localized label', () => {
  // Navigation restored from an older build only knows the agent type.
  assert.deepEqual(header({ agentType: 'Claw', currentAssistant: claw }), { workspaceName: 'Nova' });
  assert.deepEqual(header({ agentType: 'Claw' }), { workspaceName: 'Claw' });
});

test('normal sessions show their own workspace and a branch only for the current workspace', () => {
  assert.deepEqual(
    header({ session: { workspace_id: 'ws-home', path: home.path, name: 'stale label' } }),
    { workspaceName: 'home', gitBranch: 'master' },
  );
  assert.deepEqual(
    header({ session: { workspace_id: 'ws-api', path: '/Users/me/api', name: 'api' } }),
    { workspaceName: 'api', gitBranch: undefined },
  );
  assert.deepEqual(
    header({ session: { path: '/Users/me/api/' } }),
    { workspaceName: 'api', gitBranch: undefined },
  );
  // No session facts: show nothing rather than guess from the selection.
  assert.deepEqual(header({}), { workspaceName: '' });
});

test('same-path SSH sessions keep their branch scoped to the selected host', () => {
  const sshA = {
    has_workspace: true, path: a.path, project_name: 'herdr', git_branch: 'main',
    workspace_kind: 'remote', remote_connection_id: 'ssh-a', remote_ssh_host: 'host-a',
  };
  assert.deepEqual(
    header({ currentWorkspace: sshA, session: { ...b, name: 'herdr' } }),
    { workspaceName: 'herdr', gitBranch: undefined },
  );
  assert.deepEqual(
    header({ currentWorkspace: sshA, session: { ...a, name: 'herdr' } }),
    { workspaceName: 'herdr', gitBranch: 'main' },
  );
});

test('legacy localhost markers on the current workspace still match the local session', () => {
  const legacy = { ...home, workspace_id: undefined, remote_ssh_host: 'localhost' };
  assert.deepEqual(
    header({ currentWorkspace: legacy, session: { path: home.path } }),
    { workspaceName: 'home', gitBranch: 'master' },
  );
});

test('session workspace context keeps host identity and takes only display facts from the owner', () => {
  const owner = workspaceContext({ ...a, workspace_id: 'ws-owner', name: 'Row name', workspace_kind: 'remote' });
  assert.deepEqual(sessionWorkspaceContext({
    workspace_id: 'ws-session', workspace_path: '/pinned', workspace_name: 'host label',
  }, owner), {
    workspace_id: 'ws-session', path: '/pinned',
    remote_connection_id: 'ssh-a', remote_ssh_host: 'host-a',
    name: 'Row name', workspace_kind: 'remote',
  });
  // Pre-ID rows carry only the path and root label.
  assert.deepEqual(sessionWorkspaceContext({ workspace_path: '/p', workspace_name: 'p' }), {
    workspace_id: undefined, path: '/p', remote_connection_id: undefined, remote_ssh_host: undefined,
    name: 'p', workspace_kind: undefined,
  });
  assert.equal(sessionWorkspaceContext({}), undefined);
  assert.equal(isClawAgent('claw'), true);
  assert.equal(isClawAgent('Claw'), true);
  assert.equal(isClawAgent('Cowork'), false);
});

test('localhost markers from older hosts on either side keep the branch for the selected workspace', () => {
  const legacyCurrent = { ...home, workspace_id: undefined };
  const legacyMarker = { workspace_kind: 'normal', remote_ssh_host: 'localhost' };
  // A new session in the selected workspace: the created reply carries the marker.
  assert.deepEqual(
    header({ currentWorkspace: legacyCurrent, session: { path: home.path, ...legacyMarker } }),
    { workspaceName: 'home', gitBranch: 'master' },
  );
  assert.deepEqual(
    header({
      currentWorkspace: { ...legacyCurrent, remote_ssh_host: 'localhost' },
      session: { path: home.path, ...legacyMarker },
    }),
    { workspaceName: 'home', gitBranch: 'master' },
  );
});

test('the rollback gate follows the open session, not the selected workspace', () => {
  const ssh = { ...a, name: 'herdr', workspace_kind: 'remote' };
  const selectedSsh = {
    has_workspace: true, path: a.path, workspace_kind: 'remote',
    remote_connection_id: 'ssh-a', remote_ssh_host: 'host-a',
  };
  // Local project selected while the open session is SSH.
  assert.equal(isRemoteSessionWorkspace('Standard', ssh, home), true);
  assert.equal(isRemoteSessionWorkspace('Standard', { path: a.path, remote_ssh_host: 'host-a' }, home), true);
  // SSH project selected while a Claw or local session is open.
  assert.equal(isRemoteSessionWorkspace('Claw', undefined, selectedSsh), false);
  assert.equal(isRemoteSessionWorkspace('Claw', { path: claw.path }, selectedSsh), false);
  assert.equal(isRemoteSessionWorkspace('Cowork', { path: claw.path, workspace_kind: 'assistant' }, selectedSsh), false);
  assert.equal(isRemoteSessionWorkspace('Standard', { path: home.path, workspace_kind: 'normal' }, selectedSsh), false);
  // Without session facts the selection still gates, as it did before.
  assert.equal(isRemoteSessionWorkspace('Standard', undefined, selectedSsh), true);
  assert.equal(isRemoteSessionWorkspace('Standard', undefined, home), false);
  assert.equal(isRemoteSessionWorkspace('Standard', undefined, null), false);
  // A normal record's localhost marker is not SSH; an unknown kind keeps its selector.
  assert.equal(isRemoteSessionWorkspace('Standard', { path: home.path, workspace_kind: 'normal', remote_ssh_host: 'localhost' }, null), false);
  assert.equal(isRemoteSessionWorkspace('Standard', { path: home.path, remote_ssh_host: 'localhost' }, null), true);
});

test('a selection that no longer owns the created session lends it no name or kind', () => {
  const selection = workspaceContext({ ...claw, workspace_kind: 'assistant' });
  const facts = (workspace_id, workspace_path, remote = {}) => ({
    workspace_id, workspace_path, workspace_identity: remote,
  });
  assert.equal(selectedSessionWorkspaceContext(facts('ws-claw', claw.path), selection).name, 'Nova');
  const moved = selectedSessionWorkspaceContext(facts('ws-api', '/Users/me/api'), selection);
  assert.equal(moved.name, undefined);
  assert.equal(moved.workspace_kind, undefined);
  assert.equal(moved.workspace_id, 'ws-api');
  // ID-less SSH facts on the same path are a different workspace from a local selection.
  const local = workspaceContext({ path: a.path, name: 'local', workspace_kind: 'normal' });
  const onHost = selectedSessionWorkspaceContext(
    facts(undefined, a.path, { remote_connection_id: 'ssh-a', remote_ssh_host: 'host-a' }),
    local,
  );
  assert.equal(onHost.name, undefined);
  assert.equal(onHost.remote_ssh_host, 'host-a');
});
