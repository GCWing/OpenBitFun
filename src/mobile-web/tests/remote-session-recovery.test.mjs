import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function moduleUrl(relative, imports = {}) {
  let transformed = ts.transpileModule(await readFile(new URL(relative, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  transformed = transformed.replace(/from (['"])([^'"]+)\1/g, (_, quote, specifier) => {
    assert.ok(imports[specifier], `unexpected dependency ${specifier}`);
    return `from ${JSON.stringify(imports[specifier])}`;
  });
  return `data:text/javascript;base64,${Buffer.from(transformed).toString('base64')}`;
}
const dataModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const agentContract = await moduleUrl('../../shared/agent-harness/contract.generated.ts');
const agentWire = await moduleUrl('../../shared/agent-harness/wire.ts', { './contract.generated': agentContract });
const hostStream = await moduleUrl('../../shared/relay-transport/HostStream.ts');
const workspaceIdentity = await moduleUrl('../src/services/workspaceIdentity.ts');
const relayClientModule = dataModule('export class RemoteHostCommandError extends Error {}');
const managerUrl = await moduleUrl('../src/services/RemoteSessionManager.ts', {
  '../../../shared/agent-harness/wire': agentWire,
  // Minimal idempotent queue: the transport receives the submit request.
  '../../../shared/dialog-queue/HostDialogQueue': dataModule(`export class HostDialogQueue {
    constructor(scope, sessionId, transport) { this.transport = transport; }
    async submit(message) { const snapshot = await this.transport({ action: 'submit', message }); return { receipt: { turnId: snapshot.turnId } }; }
  }`),
  '../../../shared/relay-transport/HostStream': hostStream,
  './controlClientIdentity': await moduleUrl('../src/services/controlClientIdentity.ts'),
  './RelayHttpClient': relayClientModule,
  './SessionSynchronizer': dataModule('export class SessionSynchronizer {}'),
  './workspaceIdentity': workspaceIdentity,
});
const { RemoteSessionManager } = await import(managerUrl);
const synchronizerUrl = await moduleUrl('../src/services/SessionSynchronizer.ts', {
  '../../../shared/relay-transport/HostStream': hostStream,
  '../../../shared/relay-transport/SessionRecordReplica': await moduleUrl('../../shared/relay-transport/SessionRecordReplica.ts'),
  './SessionRecordPresentation': await moduleUrl('../src/services/SessionRecordPresentation.ts'),
});
const { SessionSynchronizer } = await import(synchronizerUrl);
const { UNSUPPORTED_HOST_MESSAGE } = await import(hostStream);
const tick = () => new Promise(resolve => setImmediate(resolve));

function fakeClient(handler) {
  const client = {
    controlTargetEpoch: 1,
    targetDeviceId: 'desktop-a',
    accountUserId: 'user',
    getControlTargetSnapshot: () => ({ epoch: client.controlTargetEpoch, deviceId: client.targetDeviceId }),
    isControlTargetCurrent: snapshot => snapshot.epoch === client.controlTargetEpoch,
    sendDeviceRpc: handler,
  };
  return client;
}

test('an unknown capability snapshot is learned before choosing the send path', async () => {
  const calls = [];
  let answerProbe;
  const manager = new RemoteSessionManager(fakeClient(async (device, cmd) => {
    calls.push(cmd.cmd);
    if (cmd.cmd === 'get_workspace_info') return new Promise(resolve => { answerProbe = resolve; });
    if (cmd.cmd === 'dialog_queue') return { snapshot: { turnId: 'queued-turn' } };
    return { resp: 'message_sent', turn_id: 'legacy-turn' };
  }));
  const changes = [];
  manager.onHostCapabilitiesChange(() => changes.push([manager.hostCapabilitiesKnown, manager.hostCapabilityProbing]));
  assert.equal(manager.hostCapabilitiesKnown, false);
  const sent = manager.sendMessage('session', 'hello', 'Standard');
  while (!answerProbe) await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.hostCapabilityProbing, true, 'the composer can show the host check');
  assert.deepEqual(calls, ['get_workspace_info'], 'nothing is sent while the capabilities are unknown');
  answerProbe({ resp: 'workspace_info', has_workspace: false, capabilities: ['dialog_queue_v1'] });
  assert.equal(await sent, 'queued-turn');
  assert.deepEqual(calls, ['get_workspace_info', 'dialog_queue'], 'the idempotent queue is used, not send_message');
  assert.deepEqual(changes.at(-1), [true, false]);
});

test('a failed capability probe fails the send before anything is submitted', async () => {
  const calls = [];
  const manager = new RemoteSessionManager(fakeClient(async (device, cmd) => {
    calls.push(cmd.cmd);
    if (cmd.cmd === 'get_workspace_info') throw new Error('Relay connection timed out; request was not submitted');
    return { resp: 'message_sent', turn_id: 'legacy-turn' };
  }));
  await assert.rejects(manager.sendMessage('session', 'hello', 'Standard'), /not submitted/);
  assert.deepEqual(calls, ['get_workspace_info']);
  assert.equal(manager.hostCapabilityProbing, false, 'a failed probe re-enables sending');
  assert.equal(await manager.probeHostCapabilities(), false);
});

test('hosts without the queue capability keep the legacy send path', async () => {
  const calls = [];
  const manager = new RemoteSessionManager(fakeClient(async (device, cmd) => {
    calls.push(cmd.cmd);
    if (cmd.cmd === 'get_workspace_info') return { resp: 'workspace_info', has_workspace: false };
    return { resp: 'message_sent', turn_id: 'legacy-turn' };
  }));
  assert.equal(await manager.sendMessage('session', 'hello', 'Standard'), 'legacy-turn');
  assert.deepEqual(calls, ['get_workspace_info', 'send_message']);
});

/** A manager double whose stream subscriptions and recovery signals the test drives. */
function streamManager(outcomes) {
  const manager = {
    subscriptions: [], signals: new Set(), forgotten: 0,
    onStreamRecoverySignal(streamId, listener) { manager.signals.add(listener); return () => manager.signals.delete(listener); },
    signal(reason = 'relay-reconnect') { for (const listener of [...manager.signals]) listener(reason); },
    forgetHostCapabilities() { manager.forgotten += 1; },
    async subscribeSessionStream(streamId, callbacks) {
      const outcome = outcomes.shift() ?? 'open';
      const handle = { closed: false, wakes: 0, callbacks, close() { handle.closed = true; }, wake() { handle.wakes += 1; }, async loadOlder() {} };
      manager.subscriptions.push(handle);
      if (outcome instanceof Error) throw outcome;
      return handle;
    },
  };
  return manager;
}
function synchronizer(manager) {
  const states = [], errors = [];
  const sync = new SessionSynchronizer(manager, 's1', () => {}, 0, undefined, undefined, error => errors.push(error),
    { onSyncState: state => states.push(state) });
  return { sync, states, errors };
}

test('a stalled reader restarts on a recovery signal instead of waiting out its backoff', async () => {
  const manager = streamManager([]);
  const { sync, states, errors } = synchronizer(manager);
  sync.start(); await tick();
  const first = manager.subscriptions[0];
  first.callbacks.onCaughtUp(); assert.equal(sync.state, 'live');
  first.callbacks.onError(new Error('Relay connection changed; delivery outcome is unknown'));
  assert.equal(sync.state, 'catching-up', 'the chat can say it is catching up');
  assert.equal(errors.length, 1);
  manager.signal('relay-reconnect'); await tick();
  assert.equal(first.closed, true, 'the backing-off reader is replaced');
  assert.equal(manager.subscriptions.length, 2);
  manager.subscriptions[1].callbacks.onCaughtUp();
  assert.equal(sync.state, 'live');
  assert.deepEqual(states, ['live', 'catching-up', 'live']);
  manager.signal('hint'); await tick();
  assert.equal(manager.subscriptions.length, 2, 'a healthy reader follows hints itself');
  sync.stop();
  assert.equal(manager.signals.size, 0);
});

test('a pending subscribe retry is cut short by a hint and the delay resets', async () => {
  const manager = streamManager([new Error('timed out'), new Error('timed out')]);
  const { sync } = synchronizer(manager);
  sync.start(); await tick();
  assert.equal(manager.subscriptions.length, 1);
  manager.signal('hint'); await tick();
  assert.equal(manager.subscriptions.length, 2, 'no 1 s wait after a hint');
  manager.signal('visible'); await tick();
  assert.equal(manager.subscriptions.length, 3);
  manager.subscriptions[2].callbacks.onCaughtUp();
  assert.equal(sync.state, 'live');
  sync.stop();
});

test('unsupported hosts are re-probed on recovery signals, never on a timer', async () => {
  const manager = streamManager([new Error(UNSUPPORTED_HOST_MESSAGE)]);
  const { sync } = synchronizer(manager);
  sync.start(); await tick();
  assert.equal(sync.state, 'unsupported');
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(manager.subscriptions.length, 1, 'no timer retry against an unsupported host');
  manager.signal('host-online'); await tick();
  assert.equal(manager.subscriptions.length, 2, 'an updated host gets another chance');
  manager.subscriptions[1].callbacks.onCaughtUp();
  assert.equal(sync.state, 'live');
  sync.stop();
});

test('a host stream restart forgets capabilities, and refreshed() settles on the next catch-up', async () => {
  const manager = streamManager([]);
  const { sync } = synchronizer(manager);
  sync.start(); await tick();
  const handle = manager.subscriptions[0];
  handle.callbacks.onCaughtUp();
  handle.callbacks.onGap('host stream restarted');
  assert.equal(manager.forgotten, 1);
  let settled = false;
  const refreshed = sync.refreshed(5000).then(() => { settled = true; });
  assert.equal(handle.wakes, 1, 'refreshed() asks the host again');
  await tick(); assert.equal(settled, false);
  handle.callbacks.onCaughtUp(); await refreshed;
  assert.equal(settled, true);
  sync.stop();
});

test('a host that comes back online forgets capabilities and signals recovery', async () => {
  let directory;
  const calls = [];
  const client = fakeClient(async (device, cmd) => {
    calls.push(cmd.cmd);
    return { resp: 'workspace_info', has_workspace: false, capabilities: calls.length > 1 ? ['host_stream_v1'] : [] };
  });
  client.onDeviceDirectorySnapshot = listener => { directory = listener; return () => { directory = null; }; };
  client.onRelayReconnect = () => () => {};
  const manager = new RemoteSessionManager(client, []);
  const reasons = [];
  const stop = manager.onRecoverySignal(reason => reasons.push(reason));
  directory([{ device_id: 'desktop-a', online: false }]);
  assert.deepEqual(reasons, []);
  directory([{ device_id: 'desktop-a', online: true }]);
  assert.deepEqual(reasons, ['host-online']);
  assert.equal(manager.hostCapabilitiesKnown, false, 'the returning host may be a different build');
  await tick(); await tick();
  assert.equal(manager.hostCapabilitiesKnown, true, 'capabilities are probed again at once');
  stop();
  assert.equal(directory, null, 'sources are released with the last listener');
});

test('a host learned as unsupported is asked again before the stream is refused', async () => {
  let streams = 0;
  const calls = [];
  const client = fakeClient(async (device, cmd) => {
    calls.push(cmd.cmd);
    return { resp: 'workspace_info', has_workspace: false, capabilities: ['host_stream_v1'] };
  });
  client.subscribeHostStream = async () => { streams += 1; return { close() {}, wake() {}, async loadOlder() {} }; };
  const manager = new RemoteSessionManager(client, []);
  await manager.subscribeSessionStream('s1', { onEvent() {}, onError() {} });
  assert.deepEqual(calls, ['get_workspace_info']);
  assert.equal(streams, 1);
});

test('chat errors are classified into translated copy; host answers keep their text', async () => {
  const { RemoteHostCommandError } = await import(relayClientModule);
  const { describeChatError, isUnknownOutcomeFailure, isNotSubmittedFailure } = await import(await moduleUrl('../src/services/chatErrorPresentation.ts', {
    '../../../shared/relay-transport/RelayFailure': await moduleUrl('../../shared/relay-transport/RelayFailure.ts'),
    '../../../shared/relay-transport/HostStream': hostStream,
    './RelayHttpClient': relayClientModule,
    './RemoteSessionManager': managerUrl,
  }));
  const t = key => key;
  const warn = console.warn; console.warn = () => {};
  try {
    assert.equal(describeChatError(new TypeError('Failed to fetch'), t), 'devices.failureNetwork');
    assert.equal(describeChatError(new Error('Relay returned HTTP 503'), t), 'devices.failureRelayUnavailable');
    assert.equal(describeChatError(new Error('RPC target unavailable'), t), 'chat.desktopUnavailable');
    assert.equal(describeChatError(new Error('Relay connection changed; request was not submitted'), t), 'chat.notSubmitted');
    assert.equal(describeChatError(new Error('Relay connection changed; delivery outcome is unknown'), t), 'chat.outcomeUnknown');
    assert.equal(describeChatError(new Error('operation has timed out'), t), 'chat.outcomeUnknown');
    assert.equal(describeChatError(new Error(UNSUPPORTED_HOST_MESSAGE), t), 'chat.hostStreamUnsupported');
    assert.equal(describeChatError(new RemoteHostCommandError('Session not found'), t), 'Session not found');
    assert.equal(describeChatError('Relay returned HTTP 502', t), 'devices.failureRelayUnavailable', 'queue view errors are strings');
  } finally { console.warn = warn; }
  assert.equal(isUnknownOutcomeFailure(new Error('RPC acknowledgement lost; delivery outcome is unknown')), true);
  assert.equal(isUnknownOutcomeFailure(new RemoteHostCommandError('operation has timed out')), false, 'a host answer is an outcome');
  assert.equal(isNotSubmittedFailure(new Error('RPC deadline elapsed before dispatch')), true);
});

test('connection state names the cause and needs two missed pings before blaming the desktop', async () => {
  const { deriveConnectionState } = await import(await moduleUrl('../src/services/connectionState.ts'));
  const base = { browserOnline: true, relayStatus: 'connected', presence: { online: true, lastSeenAt: 100 }, missedPings: 0, answered: true };
  assert.deepEqual(deriveConnectionState(base), { health: 'connected', issue: null });
  assert.deepEqual(deriveConnectionState({ ...base, missedPings: 1 }), { health: 'connected', issue: null }, 'one lost ping is noise');
  assert.deepEqual(deriveConnectionState({ ...base, missedPings: 2 }).issue, { kind: 'unreachable' });
  assert.deepEqual(deriveConnectionState({ ...base, missedPings: 2, relayStatus: 'disconnected' }).issue, { kind: 'relay' });
  assert.deepEqual(deriveConnectionState({ ...base, browserOnline: false }).issue, { kind: 'offline' }, 'no network is reported at once');
  assert.deepEqual(deriveConnectionState({ ...base, presence: { online: false, lastSeenAt: 90 }, missedPings: 1 }).issue,
    { kind: 'host-offline', lastSeenAt: 90 });
  assert.deepEqual(deriveConnectionState({ ...base, presence: { online: false, lastSeenAt: 90 } }), { health: 'connected', issue: null },
    'a stale offline listing does not hide a desktop that answers');
  assert.deepEqual(deriveConnectionState({ ...base, answered: false }), { health: 'checking', issue: null });
});
