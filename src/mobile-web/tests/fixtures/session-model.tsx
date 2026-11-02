import React, { useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import '../../src/styles/reset.scss';
import '@openbitfun/theme-openbitfun/default.css';
import '@openbitfun/ui/mobile.css';
import '../../src/styles/index.scss';
import ChatPage from '../../src/pages/ChatPage';
import { I18nProvider } from '../../src/i18n';
import { ThemeProvider } from '../../src/theme';
import { useMobileStore } from '../../src/services/store';
import { useWideLayout } from '../../src/hooks/useWideLayout';
import { RemoteSessionManager, type RemoteModelConfig } from '../../src/services/RemoteSessionManager';
import { RelayHttpClient, type ControlTargetSnapshot } from '../../src/services/RelayHttpClient';
import { encrypt, decrypt } from '../../src/services/E2EEncryption';
import { REMOTE_CAPABILITY_HOST_STREAM_V1 } from '../../../shared/relay-transport/HostStream';
import type { QueueRequest } from '../../../shared/dialog-queue/HostDialogQueue';

interface Selection { modelId: string | null; reasoningPreset: string | null }
interface Command {
  cmd: string; session_id?: string; model_id?: string; reasoning_preset?: string | null;
  model_write_token?: string; prepare_model_write?: boolean; model_write_fence?: string;
  command?: string; content?: string; request?: QueueRequest;
}
class HostCommandRejected extends Error {}
type HoldPhase = 'dispatch' | 'execution' | 'response';

/** Real ChatPage, stream projection and RPC serialization; only host/relay IO is simulated. */
export function mountSessionModelFixture(options: { legacy?: boolean; fencing?: boolean; reusePage?: boolean; queue?: boolean } = {}) {
  const element = document.createElement('main');
  document.body.replaceChildren(element);
  useMobileStore.setState({
    connectionHealth: 'connected', currentWorkspace: null, authenticatedUserId: 'account-a',
    controlTarget: null, activeTurn: null, messagesBySession: {}, error: null,
  });
  const models: RemoteModelConfig[] = ['a', 'b', 'c'].map(id => ({
    id: `model-${id}`, name: 'Fixture provider', provider: 'fixture', base_url: '',
    model_name: `Model ${id.toUpperCase()}`, enabled: true, capabilities: ['text_chat'],
    reasoning: { status: 'known', presets: [
      { id: 'low', label: 'Low', order: 0, actions: [], source: 'model_config' },
      { id: 'high', label: 'High', order: 1, actions: [], source: 'model_config' },
    ] },
  }));
  const defaults = { primary: 'model-a', fast: 'model-b' };
  const hosts: Record<string, Record<string, Selection>> = {
    'host-a': {
      A: { modelId: 'model-a', reasoningPreset: 'high' },
      B: { modelId: 'model-b', reasoningPreset: 'low' },
      fresh: { modelId: null, reasoningPreset: null },
      auto: { modelId: 'auto', reasoningPreset: null },
      default: { modelId: 'default', reasoningPreset: null },
      primary: { modelId: 'primary', reasoningPreset: 'high' },
      fast: { modelId: 'fast', reasoningPreset: 'low' },
    },
    'host-b': { A: { modelId: 'model-b', reasoningPreset: 'low' } },
  };
  const accountHosts: Record<string, typeof hosts> = { 'account-a': hosts, 'account-b': structuredClone(hosts) };
  accountHosts['account-b']['host-a'].A = { modelId: 'model-b', reasoningPreset: 'low' };
  let accountId = 'account-a';
  const capabilities = [REMOTE_CAPABILITY_HOST_STREAM_V1, ...(options.queue ? ['dialog_queue_v1'] : [])];
  let deviceId = 'host-a';
  let epoch = 0;
  let heldCommand: { cmd: string; phase: HoldPhase } | null = null;
  const listeners = new Set<() => void>();
  const commands: (Command & { deviceId: string; accountId: string })[] = [];
  const sent: (Selection & { sessionId: string; content?: string })[] = [];
  const pending: { cmd: string; sessionId?: string; release: (error?: string) => void; expire: () => void }[] = [];
  const subscriptions: { sessionId: string; epoch: number; closed: boolean }[] = [];
  const modelTokens = new Map<string, Set<string>>();
  const modelLanes = new Map<string, Promise<void>>();
  async function inModelLane<T>(scope: string, execute: () => Promise<T>): Promise<T> {
    const previous = modelLanes.get(scope) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>(resolve => { release = resolve; });
    modelLanes.set(scope, tail);
    await previous;
    try { return await execute(); }
    finally { release(); if (modelLanes.get(scope) === tail) modelLanes.delete(scope); }
  }
  const client = {
    get accountUserId() { return accountId; },
    get controlTargetEpoch() { return epoch; },
    get targetDeviceId() { return deviceId; },
    getControlTargetSnapshot: () => ({ deviceId, epoch }),
    isControlTargetCurrent: (target: ControlTargetSnapshot) => target.epoch === epoch,
    onControlTargetChange: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    sendDeviceRpc: (target: string, command: Command) => {
      let expire!: () => void;
      const deadline = new Promise<never>((_, reject) => {
        expire = () => reject(new Error('RPC acknowledgement lost; delivery outcome is unknown'));
      });
      const execution = (async () => {
        commands.push({ ...command, deviceId: target, accountId });
        const requestHosts = accountHosts[accountId];
        const scope = JSON.stringify([accountId, target, command.session_id]);
        const fenced = !options.legacy && options.fencing !== false;
        const held = heldCommand?.cmd === command.cmd ? heldCommand : null;
        if (held) heldCommand = null;
        const waitForRelease = () => new Promise<void>((resolve, reject) => pending.push({
          cmd: command.cmd, sessionId: command.session_id,
          release: error => error ? reject(new Error(error)) : resolve(), expire,
        }));
        if (held?.phase === 'dispatch') await waitForRelease();
        const executeOnHost = async () => {
          if (command.cmd === 'set_session_model' && fenced) {
            if (command.model_write_token !== undefined) {
              if (!modelTokens.get(scope)?.delete(command.model_write_token)) {
                return { resp: 'error', message: 'Session model selection expired; reload the session model before retrying' };
              }
            } else modelTokens.delete(scope);
          }
          if (command.cmd === 'get_model_catalog' && fenced && command.model_write_fence) {
            modelTokens.get(scope)?.delete(command.model_write_fence);
          }
          // A host refusal has a definitive error response; a transport deadline
          // below is independent and cannot release the host's model gate.
          if (held?.phase === 'execution') await waitForRelease().catch(error => { throw new HostCommandRejected(error.message); });
          const selection = command.session_id ? requestHosts[target][command.session_id] : null;
          let response: object;
          switch (command.cmd) {
            case 'get_model_catalog': {
              const token = fenced && command.prepare_model_write ? crypto.randomUUID() : undefined;
              if (token) {
                const tokens = modelTokens.get(scope) ?? new Set<string>();
                if (tokens.size >= 64) tokens.delete(tokens.values().next().value!);
                tokens.add(token);
                modelTokens.set(scope, tokens);
              }
              response = { resp: 'model_catalog', catalog: {
                version: 1, models, default_models: { ...defaults },
                ...(options.legacy ? {} : { reasoning_preset_selection_supported: true }),
                ...(fenced ? { session_model_write_fence_supported: true } : {}),
                ...(token ? { session_model_write_token: token } : {}),
                session_model_id: selection!.modelId, session_reasoning_preset: selection!.reasoningPreset,
              } };
              break;
            }
            case 'set_session_model':
              if (options.legacy && 'reasoning_preset' in command) throw new Error('Legacy host received reasoning_preset');
              selection!.modelId = command.model_id!;
              if ('reasoning_preset' in command) selection!.reasoningPreset = command.reasoning_preset ?? null;
              response = { resp: 'session_model_updated', model_id: selection!.modelId, reasoning_preset: selection!.reasoningPreset };
              break;
            case 'get_workspace_info':
              response = { resp: 'workspace_info', capabilities };
              break;
            case 'host_invoke':
              if (command.command !== 'get_session_interaction_mailbox') throw new Error(`Unexpected host operation: ${command.command}`);
              response = { ok: true, value: { sessionId: '', permissions: { revision: 0, requests: [] }, userQuestions: { revision: 0, questions: [] } } };
              break;
            case 'dialog_queue': {
              const request = command.request!;
              const message = request.action === 'submit' ? request.message : null;
              if (message) sent.push({ ...requestHosts[target][request.sessionId], sessionId: request.sessionId, content: message.content });
              response = { snapshot: {
                sessionId: request.sessionId, queueEpoch: target, revision: sent.length,
                activeTurnId: null, items: [], capacity: 20, used: 0,
                receipt: message ? {
                  turnId: message.turnId, displayContent: message.content, previewTruncated: false,
                  attachmentCount: message.attachments.length, agentType: message.agentType,
                  createdAtMs: Date.now(), status: 'completed', reason: null, targetTurnId: null, steeringId: null,
                } : null,
              } };
              break;
            }
            case 'send_message':
              sent.push({ ...selection!, sessionId: command.session_id!, content: command.content });
              response = { resp: 'message_sent', turn_id: `sent-${sent.length}` };
              break;
            default: throw new Error(`Unexpected command: ${command.cmd}`);
          }
          return response;
        };
        const modelCommand = command.cmd === 'get_model_catalog' || command.cmd === 'set_session_model';
        const response = await (fenced && modelCommand ? inModelLane(scope, executeOnHost) : executeOnHost())
          .catch(error => {
            if (error instanceof HostCommandRejected) return { resp: 'error', message: error.message };
            throw error;
          });
        if (held?.phase === 'response') await waitForRelease();
        return response;
      })();
      // An acknowledgement timeout ends the caller's wait, not host execution.
      return Promise.race([execution, deadline]);
    },
    subscribeHostStream: async (sessionId: string, callbacks: Parameters<RemoteSessionManager['subscribeSessionStream']>[1]) => {
      const subscription = { sessionId, epoch, closed: false };
      subscriptions.push(subscription);
      callbacks.onHistoryState?.({ hasMore: false, oldestSeq: 0, cursor: 0, truncated: false });
      callbacks.onCaughtUp?.();
      return { close() { subscription.closed = true; }, wake() {}, loadOlder: async () => {} };
    },
  } as unknown as RelayHttpClient;
  const hostRpc = client.sendDeviceRpc.bind(client);
  const messageKey = new Uint8Array(32).fill(7);
  // Exercise the real decryption/error boundary, not a mock that hands host
  // error envelopes directly to the manager. Only account and socket IO differ.
  const transport = Object.assign(Object.create(RelayHttpClient.prototype), {
    identityGeneration: 0,
    deviceMessageKeys: new Map(),
    withAccount: (operation: (identity: { generation: number }) => Promise<unknown>) => operation({ generation: 0 }),
    deviceMessageKey: async () => messageKey,
    realtime: { call: async (target: string, envelope: { encrypted_data: string; nonce: string }) => {
      const command = JSON.parse(await decrypt(messageKey, envelope.encrypted_data, envelope.nonce));
      const response = await hostRpc(target, command);
      const encrypted = await encrypt(messageKey, JSON.stringify(response));
      return { encrypted_data: encrypted.data, nonce: encrypted.nonce };
    } },
  });
  Object.defineProperty(transport, 'controlTargetEpochValue', { get: () => epoch });
  client.sendDeviceRpc = (target, command, requestOptions) => transport.sendDeviceRpc(target, command, requestOptions);
  const manager = new RemoteSessionManager(client, capabilities);
  let open: (id: string) => void;
  let remount: () => void;
  function Fixture() {
    const [sessionId, setSessionId] = useState('A');
    const [generation, setGeneration] = useState(0);
    open = id => flushSync(() => setSessionId(id));
    remount = () => flushSync(() => setGeneration(value => value + 1));
    const wide = useWideLayout();
    return <ThemeProvider><I18nProvider><div className="mobile-app" data-layout={wide ? 'wide' : 'compact'}>
      <ChatPage key={options.reusePage ? generation : `${generation}:${sessionId}`} sessionMgr={manager} sessionId={sessionId} sessionName={sessionId} onBack={() => {}} autoFocus wideLayout={wide} />
    </div></I18nProvider></ThemeProvider>;
  }
  const root = createRoot(element);
  flushSync(() => root.render(<Fixture />));
  return {
    commands, sent, pending, subscriptions, hosts, accountHosts, models, defaults, manager,
    open: (id: string) => open(id), remount: () => remount(),
    readFromOtherController: (id: string) => client.sendDeviceRpc(deviceId, { cmd: 'get_model_catalog', session_id: id }),
    holdNext: (cmd: string, phase: HoldPhase = 'response') => { heldCommand = { cmd, phase }; },
    release: (error?: string) => { const request = pending.shift(); if (!request) throw new Error('No pending request'); request.release(error); },
    expirePending: () => { const request = pending[0]; if (!request) throw new Error('No pending request'); request.expire(); },
    switchTarget: (next: string) => { deviceId = next; epoch += 1; for (const listener of listeners) listener(); },
    switchAccount: (next: string) => {
      if (!accountHosts[next]) throw new Error(`Unknown fixture account: ${next}`);
      accountId = next;
      epoch += 1;
      useMobileStore.setState({ authenticatedUserId: next });
      for (const listener of listeners) listener();
    },
    error: () => useMobileStore.getState().error,
    offline: (value: boolean) => useMobileStore.setState({ connectionHealth: value ? 'unreachable' : 'connected' }),
    dispose: () => root.unmount(),
  };
}
