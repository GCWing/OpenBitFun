import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_COMMAND_SCHEMA,
  decodeWsNotification,
  decodeResponseBody,
  encodeRequestBody,
  resolveWsMethod,
  WebSocketTransportAdapter,
} from './websocket-adapter';
import type {
  SubmitDialogTurnBody,
  SubmitDialogTurnResponse,
} from '@/generated/api';

describe('resolveWsMethod', () => {
  it('maps every app-server agent command to its agent/* surface method', () => {
    // The snake_case Tauri command names the service-API call sites use are
    // resolved to the schema `group/verb` method names via the typed
    // `AGENT_COMMAND_SCHEMA` table (web transport only -- desktop/CLI call Tauri
    // commands directly). If one is added/removed on the Rust side, update the
    // table and this case in lockstep.
    expect(resolveWsMethod('create_session')).toBe('agent/createSession');
    expect(resolveWsMethod('list_sessions')).toBe('agent/listSessions');
    expect(resolveWsMethod('delete_session')).toBe('agent/deleteSession');
    expect(resolveWsMethod('fork_session')).toBe('session/forkAtTurn');
    expect(resolveWsMethod('archive_session')).toBe('session/setArchived');
    expect(resolveWsMethod('unarchive_session')).toBe('session/setArchived');
    // `start_dialog_turn` -> `agent/submitDialogTurn` (NOT `agent/submitTurn`):
    // the dialog-turn body carries `agentType`/`workspacePath`/`policy`. Mapping
    // it to `submitTurn` would silently drop `agentType` and omit the required
    // `policy` -- see `agentic_api.rs::start_dialog_turn` for the desktop path.
    expect(resolveWsMethod('start_dialog_turn')).toBe('agent/submitDialogTurn');
    expect(resolveWsMethod('cancel_dialog_turn')).toBe('agent/cancelTurn');
    expect(resolveWsMethod('search_session_content')).toBe('search/sessionContent');
    // Permission surface: reply/list/grants map to the app-server permission
    // methods. `subscribe_permission_requests` is satisfied by the
    // `permission://event` push in web mode; mapping it to list fetches the
    // current pending set once.
    expect(resolveWsMethod('respond_permission')).toBe('agent/respondPermission');
    expect(resolveWsMethod('respond_permission_batch')).toBe(
      'agent/respondPermissionBatch'
    );
    expect(resolveWsMethod('list_pending_permission_requests')).toBe(
      'agent/listPendingPermissionRequests'
    );
    expect(resolveWsMethod('subscribe_permission_requests')).toBe(
      'agent/listPendingPermissionRequests'
    );
    expect(resolveWsMethod('list_project_permission_grants')).toBe(
      'agent/listProjectPermissionGrants'
    );
    expect(resolveWsMethod('remove_project_permission_grant')).toBe(
      'agent/removeProjectPermissionGrant'
    );
    expect(resolveWsMethod('clear_project_permission_grants')).toBe(
      'agent/clearProjectPermissionGrants'
    );
  });

  it('passes non-agent commands through unchanged', () => {
    // ping and external_sources are handled by the Server Host dispatch
    // directly; commands the server does not expose over WS also flow through
    // unchanged so they surface as a clean "unknown command" error rather than
    // a silent rename. `get_project_permission_rules`/`save_project_permission_rules`
    // are desktop-host-managed permission rule files (no AgentRuntime SDK op),
    // so they pass through and fail as "unknown command" in web mode until a
    // later track adds a host-services dispatch.
    expect(resolveWsMethod('ping')).toBe('ping');
    expect(resolveWsMethod('get_external_source_snapshot')).toBe(
      'get_external_source_snapshot'
    );
    expect(resolveWsMethod('get_project_permission_rules')).toBe(
      'get_project_permission_rules'
    );
    expect(resolveWsMethod('some_future_command')).toBe('some_future_command');
    expect(resolveWsMethod('')).toBe('');
  });

  it('maps the git service commands to their git/* surface methods', () => {
    // Read-only git operations exposed by the app-server surface (option C).
    // Write operations and the remote (SSH) path arrive later; the Server Host
    // has no SSH manager, so remote git paths surface as
    // `host_capability_unavailable` (the `external_sources` precedent).
    expect(resolveWsMethod('git_is_repository')).toBe('git/isRepository');
    expect(resolveWsMethod('git_get_status')).toBe('git/getStatus');
    expect(resolveWsMethod('git_get_branches')).toBe('git/getBranches');
  });

  it('maps the config service commands to their config/* surface methods', () => {
    // Read-only config operations: agent-profile canonicalizer + AI model
    // configs + single/batched config-path reads. `get_config`/`get_configs`
    // carry the not-found -> undefined contract the frontend `ConfigAPI`
    // depends on (the app-server surfaces the `OpenBitFunError::NotFound` Display
    // text as the JSON-RPC `message`). `get_skill_configs` still arrives
    // later (workspace dependency).
    expect(resolveWsMethod('get_agent_profile_configs')).toBe(
      'config/getAgentProfileConfigs'
    );
    expect(resolveWsMethod('get_agent_profile_config')).toBe(
      'config/getAgentProfileConfig'
    );
    expect(resolveWsMethod('get_model_configs')).toBe('config/getModelConfigs');
    expect(resolveWsMethod('project_ai_model_reasoning_catalog')).toBe(
      'model/projectReasoningCatalog',
    );
    expect(resolveWsMethod('get_config')).toBe('config/getConfig');
    expect(resolveWsMethod('get_configs')).toBe('config/getConfigs');
    expect(resolveWsMethod('set_agent_profile_config')).toBe(
      'config/setAgentProfileConfig'
    );
    expect(resolveWsMethod('reset_agent_profile_config')).toBe(
      'config/resetAgentProfileConfig'
    );
    expect(resolveWsMethod('set_config')).toBe('config/setConfig');
    expect(resolveWsMethod('save_cloud_speech_config')).toBe(
      'config/saveCloudSpeechConfig'
    );
    expect(resolveWsMethod('get_web_search_credential_status')).toBe(
      'config/getWebSearchCredentialStatus'
    );
    expect(resolveWsMethod('save_web_search_credential')).toBe(
      'config/saveWebSearchCredential'
    );
    expect(resolveWsMethod('clear_web_search_credential')).toBe(
      'config/clearWebSearchCredential'
    );
    expect(resolveWsMethod('validate_config')).toBe('config/validateConfig');
    expect(resolveWsMethod('i18n_get_current_language')).toBe(
      'i18n/getCurrentLanguage'
    );
    expect(resolveWsMethod('i18n_set_language')).toBe('i18n/setLanguage');
    expect(resolveWsMethod('i18n_get_config')).toBe('i18n/getConfig');
    expect(resolveWsMethod('i18n_set_config')).toBe('i18n/setConfig');
    expect(resolveWsMethod('i18n_get_supported_languages')).toBe(
      'i18n/getSupportedLanguages'
    );
  });

  it('pins the typed command schema (Step 1: generated types wired into the method table)', () => {
    // Compile-time: the start_dialog_turn request/response slots are bound to
    // the generated schema types. These locals are intentionally unused at
    // runtime; they exist only so `tsc` fails if the generated barrel or the
    // schema slot type drifts.
    const _body: SubmitDialogTurnBody = {
      sessionId: '',
      message: '',
      agentType: '',
    };
    const _resp: SubmitDialogTurnResponse = { status: 'started', sessionId: '', turnId: '' };

    // Runtime sanity: the schema entry carries the method string and the table
    // covers the schema methods (key count is stable; ordering is not pinned
    // because the table is a plain object). Track B Batch 1 added config write +
    // i18n and the P0 Session/Config control plane. Atomic cloud-speech save
    // config validation, and live reasoning projection raise the count to 34.
    // The read-only Git ownership-trust probe makes 35, and this branch's
    // session-content search makes 36 — the two arrived on separate branches,
    // so the count only reaches 36 once main is merged in. The three
    // device-local WebSearch credential commands make 39.
    expect(AGENT_COMMAND_SCHEMA.start_dialog_turn.method).toBe(
      'agent/submitDialogTurn'
    );
    expect(Object.keys(AGENT_COMMAND_SCHEMA).length).toBe(39);

    // Touch the locals so noUnusedLocals does not flag them under vitest's
    // transformed build (tsc --noEmit is the real gate; this is belt-and-suspenders).
    expect(_body.message).toBe('');
    expect(_resp.status).toBe('started');
  });
});

describe('encodeRequestBody', () => {
  it('renames start_dialog_turn fields to the schema wire shape', () => {
    const frontend = {
      sessionId: 's1',
      userInput: 'hello',
      originalUserInput: 'hello!',
      agentType: 'coder',
      workspacePath: '/repo',
      imageContexts: [{ id: 'img1', imagePath: '/tmp/a.png', mimeType: 'image/png' }],
      userMessageMetadata: { hint: 'fast' },
    };
    const encoded = encodeRequestBody('start_dialog_turn', frontend);
    expect(encoded.sessionId).toBe('s1');
    expect(encoded.message).toBe('hello');
    expect(encoded.originalMessage).toBe('hello!');
    expect(encoded.agentType).toBe('coder');
    expect(encoded.workspacePath).toBe('/repo');
    expect(encoded.attachments).toEqual([
      { kind: 'remote_image', id: 'img1', metadata: { imagePath: '/tmp/a.png', mimeType: 'image/png' } },
    ]);
    expect(encoded.metadata).toEqual({ hint: 'fast' });
    // Original field names must not leak through.
    expect(encoded.userInput).toBeUndefined();
    expect(encoded.imageContexts).toBeUndefined();
    expect(encoded.userMessageMetadata).toBeUndefined();
  });

  it('omits optional start_dialog_turn fields when absent', () => {
    const encoded = encodeRequestBody('start_dialog_turn', {
      sessionId: 's1',
      userInput: 'hi',
      agentType: 'coder',
    });
    expect(encoded.message).toBe('hi');
    expect(encoded.originalMessage).toBeUndefined();
    expect(encoded.attachments).toBeUndefined();
    expect(encoded.metadata).toBeUndefined();
  });

  it('wraps non-object userMessageMetadata in raw_metadata', () => {
    const encoded = encodeRequestBody('start_dialog_turn', {
      sessionId: 's1',
      userInput: 'hi',
      agentType: 'coder',
      userMessageMetadata: 'plain string',
    });
    expect(encoded.metadata).toEqual({ raw_metadata: 'plain string' });
  });

  it('converts respond_permission reply string to tagged-enum shape', () => {
    const encoded = encodeRequestBody('respond_permission', {
      requestId: 'r1',
      reply: 'once',
    });
    expect(encoded.request_id).toBe('r1');
    expect(encoded.reply).toEqual({ reply: 'once' });
    expect(encoded.requestId).toBeUndefined();
  });

  it('embeds feedback into reject reply', () => {
    const encoded = encodeRequestBody('respond_permission_batch', {
      requestId: 'r2',
      reply: 'reject',
      feedback: 'no thanks',
    });
    expect(encoded.request_id).toBe('r2');
    expect(encoded.reply).toEqual({ reply: 'reject', feedback: 'no thanks' });
  });

  it('omits feedback when reply is not reject', () => {
    const encoded = encodeRequestBody('respond_permission', {
      requestId: 'r3',
      reply: 'always',
      feedback: 'should be dropped',
    });
    expect(encoded.reply).toEqual({ reply: 'always' });
  });

  it('encodes fork-at-turn and archive state into Session wire DTOs', () => {
    expect(encodeRequestBody('fork_session', {
      workspace_path: '/repo',
      source_session_id: 's1',
      source_turn_id: 't2',
      remote_connection_id: 'remote-1',
    })).toEqual({
      workspacePath: '/repo',
      sourceSessionId: 's1',
      sourceTurnId: 't2',
      remoteConnectionId: 'remote-1',
    });

    expect(encodeRequestBody('archive_session', {
      workspace_path: '/repo',
      session_id: 's1',
    })).toEqual({
      workspacePath: '/repo',
      sessionId: 's1',
      archived: true,
    });
    expect(encodeRequestBody('unarchive_session', {
      workspace_path: '/repo',
      session_id: 's1',
    })).toEqual({
      workspacePath: '/repo',
      sessionId: 's1',
      archived: false,
    });
  });

  it('forwards the workspace ID for fork and archive without inventing a path', () => {
    expect(encodeRequestBody('fork_session', {
      workspace_id: 'workspace-1',
      source_session_id: 's1',
      source_turn_id: 't2',
    })).toEqual({
      workspaceId: 'workspace-1',
      sourceSessionId: 's1',
      sourceTurnId: 't2',
    });
    expect(encodeRequestBody('archive_session', {
      workspace_id: 'workspace-1',
      session_id: 's1',
    })).toEqual({
      workspaceId: 'workspace-1',
      sessionId: 's1',
      archived: true,
    });
  });

  it('passes unknown actions through unchanged', () => {
    const body = { foo: 'bar' };
    expect(encodeRequestBody('some_unknown_action', body)).toBe(body);
    expect(encodeRequestBody('list_sessions', body)).toBe(body);
  });

  it('preserves the desktop success-string contract for profile mutations', () => {
    expect(decodeResponseBody('set_agent_profile_config', { profile_id: 'Standard' }))
      .toBe('Agent profile configuration updated successfully');
    expect(decodeResponseBody('reset_agent_profile_config', { profile_id: 'Standard' }))
      .toBe('Agent profile configuration reset successfully');
  });
});

describe('decodeWsNotification', () => {
  it('projects typed config notifications to a stable frontend event', () => {
    expect(decodeWsNotification({
      jsonrpc: '2.0',
      method: 'config/event',
      params: { kind: 'modelConfigurationUpdated' },
    })).toEqual({
      event: 'config://updated',
      payload: { kind: 'modelConfigurationUpdated' },
    });
  });

  it('keeps projected agent notifications unchanged', () => {
    expect(decodeWsNotification({
      method: 'agent/frontendEvent',
      params: { event: 'agentic://session-created', payload: { sessionId: 's1' } },
    })).toEqual({
      event: 'agentic://session-created',
      payload: { sessionId: 's1' },
    });
  });
});

describe('decodeResponseBody', () => {
  it('projects start_dialog_turn status to success/message', () => {
    expect(decodeResponseBody('start_dialog_turn', {
      status: 'started',
      sessionId: 's1',
      turnId: 't1',
    })).toEqual({ success: true, message: 'Dialog turn started' });
    expect(decodeResponseBody('start_dialog_turn', {
      status: 'queued',
      sessionId: 's1',
      turnId: 't1',
    })).toEqual({ success: true, message: 'Dialog turn queued' });
  });

  it('unwraps list_sessions into a bare array', () => {
    expect(decodeResponseBody('list_sessions', { sessions: [{ sessionId: 's1' }] }))
      .toEqual([{ sessionId: 's1' }]);
  });

  it('unwraps list_pending_permission_requests into a bare array', () => {
    expect(decodeResponseBody('list_pending_permission_requests', { requests: [{ requestId: 'r1' }] }))
      .toEqual([{ requestId: 'r1' }]);
  });

  it('unwraps respond_permission_batch into a bare string array', () => {
    expect(decodeResponseBody('respond_permission_batch', { request_ids: ['r1', 'r2'] }))
      .toEqual(['r1', 'r2']);
  });

  it('unwraps git_get_branches into a bare array', () => {
    expect(decodeResponseBody('git_get_branches', { branches: [{ name: 'main' }] }))
      .toEqual([{ name: 'main' }]);
  });

  it('passes unknown actions through unchanged', () => {
    const result = { foo: 'bar' };
    expect(decodeResponseBody('some_unknown_action', result)).toBe(result);
    expect(decodeResponseBody('get_config', result)).toBe(result);
  });
});

describe('WebSocketTransportAdapter reconnect lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('cancels a scheduled reconnect when explicitly disconnected', async () => {
    vi.useFakeTimers();

    const sockets: MockWebSocket[] = [];
    class MockWebSocket {
      static readonly OPEN = 1;
      static readonly CLOSING = 2;

      readyState = 0;
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;

      constructor(readonly url: string) {
        sockets.push(this);
      }

      open(): void {
        this.readyState = MockWebSocket.OPEN;
        this.onopen?.({} as Event);
      }

      closeFromServer(): void {
        this.readyState = 3;
        this.onclose?.({} as CloseEvent);
      }

      close(): void {
        this.readyState = 3;
        this.onclose?.({} as CloseEvent);
      }

      send(): void {}
    }

    vi.stubGlobal('WebSocket', MockWebSocket);
    const adapter = new WebSocketTransportAdapter('ws://example.test/ws');
    const connection = adapter.connect();

    sockets[0].open();
    await connection;
    sockets[0].closeFromServer();
    expect(vi.getTimerCount()).toBe(1);

    await adapter.disconnect();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(1);
  });
});

describe('WebSocketTransportAdapter JSON-RPC lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fails the connection closed for an ambiguous response envelope', async () => {
    vi.useFakeTimers();
    const sockets: RpcMockWebSocket[] = [];
    RpcMockWebSocket.instances = sockets;
    vi.stubGlobal('WebSocket', RpcMockWebSocket);
    const adapter = new WebSocketTransportAdapter('ws://example.test/ws');
    const connected = adapter.connect();
    sockets[0].open();
    await connected;

    const response = adapter.request('ping', {});
    const request = JSON.parse(sockets[0].sent[0]) as { id: string };
    sockets[0].receive({
      jsonrpc: '2.0',
      id: request.id,
      result: { ok: true },
      error: { code: -32000, message: 'ambiguous' },
    });

    await expect(response).rejects.toThrow(/exactly one result or error/);
    expect(sockets[0].closeCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a healthy WebSocket reusable after one request deadline', async () => {
    vi.useFakeTimers();
    const sockets: RpcMockWebSocket[] = [];
    RpcMockWebSocket.instances = sockets;
    vi.stubGlobal('WebSocket', RpcMockWebSocket);
    const adapter = new WebSocketTransportAdapter('ws://example.test/ws');
    const connected = adapter.connect();
    sockets[0].open();
    await connected;

    const expired = adapter.request('ping', {});
    const expiredAssertion = expect(expired).rejects.toThrow('Request timeout: ping');
    await vi.advanceTimersByTimeAsync(30_000);
    await expiredAssertion;
    expect(sockets[0].closeCalls).toBe(0);

    const next = adapter.request<{ ok: boolean }>('ping', {});
    await vi.advanceTimersByTimeAsync(0);
    const request = JSON.parse(sockets[0].sent[1]) as { id: string };
    sockets[0].receive({
      jsonrpc: '2.0',
      id: request.id,
      result: { ok: true },
    });
    await expect(next).resolves.toEqual({ ok: true });
    await adapter.disconnect();
  });

  it('fails closed before the browser WebSocket send buffer grows past its cap', async () => {
    const sockets: RpcMockWebSocket[] = [];
    RpcMockWebSocket.instances = sockets;
    vi.stubGlobal('WebSocket', RpcMockWebSocket);
    const adapter = new WebSocketTransportAdapter('ws://example.test/ws');
    const connected = adapter.connect();
    sockets[0].open();
    await connected;
    sockets[0].bufferedAmount = 2 * 1024 * 1024;

    const response = adapter.request('ping', {});
    const bounded = Promise.race([
      response,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('WebSocket send buffer was not bounded')), 50);
      }),
    ]);
    try {
      const error = await bounded.then(
        () => undefined,
        (reason: unknown) => reason,
      );
      const cause = (error as { cause?: unknown } | undefined)?.cause;
      expect(cause).toBeInstanceOf(Error);
      expect((cause as Error).message).toMatch(/send buffer capacity/);
      expect(sockets[0].closeCalls).toBe(1);
    } finally {
      await adapter.disconnect();
    }
  });

  it('closes a connection whose browser send buffer never drains', async () => {
    vi.useFakeTimers();
    const sockets: RpcMockWebSocket[] = [];
    RpcMockWebSocket.instances = sockets;
    vi.stubGlobal('WebSocket', RpcMockWebSocket);
    const adapter = new WebSocketTransportAdapter('ws://example.test/ws');
    const connected = adapter.connect();
    sockets[0].open();
    await connected;
    sockets[0].bufferedAmount = 1;
    let settled = false;
    const response = adapter.request('ping', {});
    void response.catch(() => {
      settled = true;
    });

    try {
      await vi.advanceTimersByTimeAsync(5_100);
      expect(settled).toBe(true);
      expect(sockets[0].closeCalls).toBe(1);
    } finally {
      await adapter.disconnect();
    }
  });

  it('an old socket generation cannot close or settle requests on its replacement', async () => {
    vi.useFakeTimers();
    const sockets: RpcMockWebSocket[] = [];
    RpcMockWebSocket.instances = sockets;
    vi.stubGlobal('WebSocket', RpcMockWebSocket);
    const adapter = new WebSocketTransportAdapter('ws://example.test/ws');
    const connected = adapter.connect();
    sockets[0].open();
    await connected;
    sockets[0].bufferedAmount = 1;
    let oldSettled = false;
    const oldRequest = adapter.request('ping', {});
    void oldRequest.catch(() => {
      oldSettled = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    sockets[0].closeFromServer();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(oldSettled).toBe(true);
    expect(sockets).toHaveLength(2);

    sockets[1].open();
    const current = adapter.request<{ ok: boolean }>('ping', {});
    await vi.advanceTimersByTimeAsync(0);
    const request = JSON.parse(sockets[1].sent[0]) as { id: string };
    sockets[1].receive({ jsonrpc: '2.0', id: request.id, result: { ok: true } });
    await expect(current).resolves.toEqual({ ok: true });
    expect(sockets[1].closeCalls).toBe(0);
    await adapter.disconnect();
  });

  it('a request during reconnect joins the one in-flight replacement socket', async () => {
    vi.useFakeTimers();
    const sockets: RpcMockWebSocket[] = [];
    RpcMockWebSocket.instances = sockets;
    vi.stubGlobal('WebSocket', RpcMockWebSocket);
    const adapter = new WebSocketTransportAdapter('ws://example.test/ws');
    const connected = adapter.connect();
    sockets[0].open();
    await connected;
    sockets[0].closeFromServer();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);

    const response = adapter.request<{ ok: boolean }>('ping', {});
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    await vi.advanceTimersByTimeAsync(0);
    const request = JSON.parse(sockets[1].sent[0]) as { id: string };
    sockets[1].receive({ jsonrpc: '2.0', id: request.id, result: { ok: true } });

    await expect(response).resolves.toEqual({ ok: true });
    await adapter.disconnect();
  });
});

class RpcMockWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static instances: RpcMockWebSocket[] = [];

  readyState = 0;
  readonly sent: string[] = [];
  bufferedAmount = 0;
  closeCalls = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(readonly url: string) {
    RpcMockWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = RpcMockWebSocket.OPEN;
    this.onopen?.({} as Event);
  }

  send(message: string): void {
    this.sent.push(message);
  }

  receive(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent);
  }

  closeFromServer(): void {
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }
}
