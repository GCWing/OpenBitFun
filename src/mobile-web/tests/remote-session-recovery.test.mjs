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
const managerUrl = await moduleUrl('../src/services/RemoteSessionManager.ts', {
  '../../../shared/agent-harness/wire': agentWire,
  // Minimal idempotent queue: the transport receives the submit request.
  '../../../shared/dialog-queue/HostDialogQueue': dataModule(`export class HostDialogQueue {
    constructor(scope, sessionId, transport) { this.transport = transport; }
    async submit(message) { const snapshot = await this.transport({ action: 'submit', message }); return { receipt: { turnId: snapshot.turnId } }; }
  }`),
  '../../../shared/relay-transport/HostStream': hostStream,
  './controlClientIdentity': await moduleUrl('../src/services/controlClientIdentity.ts'),
  './RelayHttpClient': dataModule('export class RemoteHostCommandError extends Error {}'),
  './SessionSynchronizer': dataModule('export class SessionSynchronizer {}'),
  './workspaceIdentity': workspaceIdentity,
});
const { RemoteSessionManager } = await import(managerUrl);

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
