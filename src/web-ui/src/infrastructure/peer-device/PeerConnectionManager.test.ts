import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PeerConnectionManager,
  type PeerConnectionState,
} from './PeerConnectionManager';

const KEEPALIVE_MS = 20_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 4_000;

describe('PeerConnectionManager attach', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('negotiates capabilities and attaches control in one handshake', async () => {
    const rpc = createRpc();
    const manager = createManager(rpc.deviceRpc);

    const connection = await manager.connect('peer-1', 'Studio');

    expect(rpc.commands()).toEqual(['peer_mode_ping', 'peer_control_attach']);
    expect(rpc.args('peer_control_attach')).toEqual({ controller_device_id: 'controller-1' });
    expect(connection.surfaceId).toBe('peer-1');
    expect(connection.getState()).toMatchObject({
      deviceName: 'Studio',
      health: 'ready',
      capabilities: {
        idempotentDialogSubmit: true,
        inlineImageAttachmentsV1: true,
        targetedSessionRollback: false,
        tokenUsageStatistics: true,
        miniAppAgentContextFilesV1: true,
        productControlV1: true,
        productControlNativeV1: false,
        productControlPresentationV1: false,
        userQuestionResponse: true,
      },
    });
    expect(manager.get('peer-1')).toBe(connection);
  });

  it('classifies a truly old Desktop from its supported tool catalog probe', async () => {
    const rpc = createLegacyRpc('desktop');
    const manager = createManager(rpc.deviceRpc);

    const connection = await manager.connect('peer-1', 'Studio');
    expect(connection.getState().capabilities).toMatchObject({
      cancelTool: true,
      toolCatalog: true,
      hostKind: 'desktop',
    });
    expect(rpc.commands()).toEqual([
      'peer_mode_ping',
      'get_all_tools_info',
      'peer_control_attach',
    ]);

    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
    expect(rpc.commands().filter(command => command === 'get_all_tools_info')).toHaveLength(1);
  });

  it('classifies a truly old CLI from an unsupported tool catalog probe', async () => {
    const rpc = createLegacyRpc('cli');
    const manager = createManager(rpc.deviceRpc);

    const connection = await manager.connect('peer-1', 'CLI');
    expect(connection.getState().capabilities).toMatchObject({
      cancelTool: false,
      toolCatalog: false,
      hostKind: 'cli',
    });
    expect(rpc.commands()).toEqual([
      'peer_mode_ping',
      'get_all_tools_info',
      'peer_control_attach',
    ]);
  });

  it('parses advertised new capability fields as true', async () => {
    const manager = new PeerConnectionManager({
      deviceRpc: async () => JSON.stringify({
        resp: 'host_invoke_result',
        ok: true,
        value: {
          capabilities: {
            cancel_tool: true,
            tool_catalog: true,
            chat_mcp_catalog_v1: true,
            user_question_response: true,
            miniapp_agent_context_files_v1: true,
            wsl_workspaces_v1: true,
          },
        },
      }),
      getControllerDeviceId: async () => 'controller-1',
    });

    const connection = await manager.connect('peer-1', 'Studio');
    const caps = connection.getState().capabilities;
    expect(caps.cancelTool).toBe(true);
    expect(caps.toolCatalog).toBe(true);
    expect(caps.chatMcpCatalogV1).toBe(true);
    expect(caps.miniAppAgentContextFilesV1).toBe(true);
    expect(caps.wslWorkspacesV1).toBe(true);
  });

  it('parses host_type into hostKind for desktop and cli', async () => {
    // host_type lets a controller resolve capabilities an older host did not
    // advertise: an old Desktop always implemented cancel_tool/tool_catalog,
    // an old CLI never did. See PR #2428 round 5 #1.
    const makeManager = (hostType: string | undefined) => {
      const value: Record<string, unknown> = {
        ok: true,
        peer: true,
        device_id: 'd',
        capabilities: {},
      };
      if (hostType !== undefined) value.host_type = hostType;
      return new PeerConnectionManager({
        deviceRpc: async () => JSON.stringify({
          resp: 'host_invoke_result',
          ok: true,
          value,
        }),
        getControllerDeviceId: async () => 'controller-1',
      });
    };

    const desktop = await makeManager('desktop').connect('peer-1', 'Studio');
    expect(desktop.getState().capabilities.hostKind).toBe('desktop');
    expect(desktop.getState().capabilities.inlineImageAttachmentsV1).toBe(false);
    expect(desktop.getState().capabilities.chatMcpCatalogV1).toBe(false);

    const cli = await makeManager('cli').connect('peer-2', 'Studio');
    expect(cli.getState().capabilities.hostKind).toBe('cli');

    const unknown = await makeManager(undefined).connect('peer-3', 'Studio');
    expect(unknown.getState().capabilities.hostKind).toBeNull();

    const garbage = await makeManager('relay').connect('peer-4', 'Studio');
    expect(garbage.getState().capabilities.hostKind).toBeNull();
  });

  it('leaves nothing attached when the handshake fails', async () => {
    const rpc = createRpc({ failCommands: new Set(['peer_control_attach']) });
    const manager = createManager(rpc.deviceRpc);

    await expect(manager.connect('peer-1', 'Studio')).rejects.toThrow('peer refused');

    expect(manager.get('peer-1')).toBeUndefined();
    expect(manager.list()).toEqual([]);
  });

  it('reuses one attachment for concurrent callers', async () => {
    const rpc = createRpc();
    const manager = createManager(rpc.deviceRpc);

    const [first, second] = await Promise.all([
      manager.connect('peer-1', 'Studio'),
      manager.connect('peer-1', 'Studio'),
    ]);

    expect(first).toBe(second);
    expect(rpc.commands().filter(c => c === 'peer_control_attach')).toHaveLength(1);
  });

  it('orders detach after a handshake that was disposed in flight', async () => {
    const ping = deferred<string>();
    const commands: string[] = [];
    const deviceRpc = vi.fn(async (_target: string, commandJson: string): Promise<string> => {
      const command = (JSON.parse(commandJson) as { command?: string }).command ?? 'unknown';
      commands.push(command);
      if (command === 'peer_mode_ping') {
        return ping.promise;
      }
      return JSON.stringify({ resp: 'host_invoke_result', ok: true, value: null });
    });
    const manager = createManager(deviceRpc);

    const connecting = manager.connect('peer-1', 'Studio');
    await vi.waitFor(() => expect(commands).toEqual(['peer_mode_ping']));
    const disposing = manager.dispose('peer-1');
    ping.resolve(JSON.stringify({
      resp: 'host_invoke_result',
      ok: true,
      value: { capabilities: {} },
    }));

    await expect(connecting).rejects.toThrow('disposed during attachment');
    await disposing;
    expect(commands).toEqual(['peer_mode_ping', 'peer_control_detach']);
    expect(manager.get('peer-1')).toBeUndefined();
  });
});

describe('PeerConnectionManager health', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('degrades on a single missed ping instead of tearing the peer down', async () => {
    const rpc = createRpc();
    const manager = createManager(rpc.deviceRpc);
    const seen = observe(manager);
    await manager.connect('peer-1', 'Studio');

    rpc.failNext(1);
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);

    expect(manager.get('peer-1')?.getState()).toMatchObject({
      health: 'degraded',
      consecutiveFailures: 1,
    });
    expect(seen.healthTimeline()).toEqual(['connecting', 'ready', 'degraded']);
  });

  it('reconnects with exponential backoff while degraded', async () => {
    const rpc = createRpc();
    const manager = createManager(rpc.deviceRpc);
    await manager.connect('peer-1', 'Studio');

    rpc.failNext(2);
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
    const afterFirstFailure = rpc.commands().length;

    // 1s, then 2s: nothing is retried before that attempt's delay elapses.
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS - 1);
    expect(rpc.commands().length).toBe(afterFirstFailure);
    await vi.advanceTimersByTimeAsync(1);
    expect(rpc.commands().length).toBe(afterFirstFailure + 1);

    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS * 2 - 1);
    expect(rpc.commands().length).toBe(afterFirstFailure + 1);
    await vi.advanceTimersByTimeAsync(1);

    // The third attempt answers, so the peer recovers and the delay resets.
    expect(manager.get('peer-1')?.getState()).toMatchObject({
      health: 'ready',
      consecutiveFailures: 0,
    });
    // A recovered peer re-attaches: the host may have pruned us during the gap.
    expect(rpc.commands().filter(c => c === 'peer_control_attach')).toHaveLength(2);
  });

  it('caps the reconnect delay', async () => {
    const rpc = createRpc();
    const manager = createManager(rpc.deviceRpc);
    await manager.connect('peer-1', 'Studio');

    rpc.failNext(5);
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
    // Failures 1..4 back off 1s, 2s, 4s, 4s — the fourth is already capped.
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS + RECONNECT_BASE_MS * 2 + RECONNECT_MAX_MS);
    const beforeCappedAttempt = rpc.commands().length;

    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS);

    expect(rpc.commands().length).toBe(beforeCappedAttempt + 1);
    expect(manager.get('peer-1')?.getState().consecutiveFailures).toBe(5);
  });

  it('retains the attachment through a long outage and resumes capped retries', async () => {
    const rpc = createRpc();
    const manager = createManager(rpc.deviceRpc);
    const connection = await manager.connect('peer-1', 'Studio');

    rpc.failAll();
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS + 120_000);

    expect(manager.get('peer-1')).toBe(connection);
    expect(connection.getState().health).toBe('degraded');
    expect(connection.getState().consecutiveFailures).toBeGreaterThan(3);
    expect(connection.adapter.isDisposed()).toBe(false);
    expect(rpc.commands()).not.toContain('peer_control_detach');

    rpc.failNext(0);
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS);
    expect(manager.get('peer-1')).toBe(connection);
    expect(connection.getState()).toMatchObject({ health: 'ready', consecutiveFailures: 0 });
    expect(rpc.commands().filter(command => command === 'peer_control_attach')).toHaveLength(2);
    await manager.disposeAll();
  });

  it('recovers a 2.3 second presence gap on the same attachment', async () => {
    const rpc = createRpc();
    const manager = createManager(rpc.deviceRpc);
    const connection = await manager.connect('peer-1', 'Studio');

    rpc.failAll();
    manager.reportPresence(['peer-2']);
    expect(connection.getState()).toMatchObject({ health: 'degraded', consecutiveFailures: 0 });
    await vi.advanceTimersByTimeAsync(2_300);

    rpc.failNext(0);
    manager.reportPresence(['peer-1', 'peer-2']);
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.get('peer-1')).toBe(connection);
    expect(connection.adapter.isDisposed()).toBe(false);
    expect(connection.getState()).toMatchObject({ health: 'ready', consecutiveFailures: 0 });
    expect(rpc.commands()).not.toContain('peer_control_detach');
    expect(rpc.commands().filter(command => command === 'peer_control_attach')).toHaveLength(2);
  });

  it('waits for a recovery handshake even when a product request succeeds', async () => {
    const rpc = createRpc();
    const manager = createManager(rpc.deviceRpc);
    const connection = await manager.connect('peer-1', 'Studio');

    rpc.failNext(1);
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
    expect(connection.getState().health).toBe('degraded');

    await connection.adapter.request('get_opened_workspaces', { request: {} });

    expect(connection.getState().health).toBe('degraded');
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
    expect(connection.getState()).toMatchObject({ health: 'ready', consecutiveFailures: 0 });
    await vi.waitFor(() => {
      expect(rpc.commands().filter(c => c === 'peer_control_attach')).toHaveLength(2);
    });
  });

  it('coalesces product failures into a probe without consuming health retries', async () => {
    const rpc = createRpc();
    const manager = createManager(rpc.deviceRpc);
    const connection = await manager.connect('peer-1', 'Studio');

    rpc.failNext(8);
    await Promise.all(Array.from({ length: 8 }, async () => {
      await expect(connection.adapter.request('subscribe_permission_requests', {}))
        .rejects.toThrow('relay unavailable');
    }));

    expect(connection.getState()).toMatchObject({ health: 'degraded', consecutiveFailures: 0 });
    expect(rpc.commands().filter(command => command === 'peer_mode_ping')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
    expect(connection.getState()).toMatchObject({ health: 'ready', consecutiveFailures: 0 });
    expect(rpc.commands().filter(command => command === 'peer_mode_ping')).toHaveLength(2);
    expect(rpc.commands().filter(command => command === 'peer_control_attach')).toHaveLength(2);
  });

  it('does not postpone a health retry when more product requests or presence updates fail', async () => {
    const rpc = createRpc();
    const manager = createManager(rpc.deviceRpc);
    const connection = await manager.connect('peer-1', 'Studio');
    rpc.failAll();
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
    expect(connection.getState().consecutiveFailures).toBe(1);

    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS / 2);
    manager.reportPresence([]);
    manager.reportPresence([]);
    await expect(connection.adapter.request('subscribe_permission_requests', {})).rejects.toThrow();
    expect(connection.getState().consecutiveFailures).toBe(1);

    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS / 2);
    expect(connection.getState().consecutiveFailures).toBe(2);
  });

});

describe('PeerConnectionManager disposal', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('detaches without issuing a Turn cancellation command', async () => {
    const rpc = createRpc();
    const manager = createManager(rpc.deviceRpc);
    const connection = await manager.connect('peer-1', 'Studio');

    await manager.dispose('peer-1');

    expect(rpc.commands()).toContain('peer_control_detach');
    expect(rpc.commands()).not.toContain('cancel_dialog_turn');
    expect(rpc.commands()).not.toContain('cancel_acp_dialog_turn');
    expect(connection.adapter.isDisposed()).toBe(true);
    expect(manager.get('peer-1')).toBeUndefined();
    expect(manager.list()).toEqual([]);

    const afterDispose = rpc.commands().length;
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS * 3);
    expect(rpc.commands().length).toBe(afterDispose);
  });

  it('skips the detach RPC for a peer that is already gone', async () => {
    const rpc = createRpc();
    const manager = createManager(rpc.deviceRpc);
    await manager.connect('peer-1', 'Studio');

    await manager.dispose('peer-1', { notifyPeer: false });

    expect(rpc.commands()).not.toContain('peer_control_detach');
  });

  it('settles transport work still waiting on a disposed peer', async () => {
    const rpc = createRpc();
    const manager = createManager(rpc.deviceRpc);
    const connection = await manager.connect('peer-1', 'Studio');

    rpc.hangNext();
    const pending = connection.adapter.request('list_persisted_sessions_page', {
      request: { workspacePath: '/repo' },
    });
    const settled = pending.then(() => 'resolved', () => 'rejected');

    await manager.dispose('peer-1');

    await expect(settled).resolves.toBe('rejected');
  });

  it('orders detach after a recovery re-attach already in flight', async () => {
    const reattach = deferred<string>();
    const commands: string[] = [];
    let failNextPing = false;
    let attachCount = 0;
    const deviceRpc = vi.fn(async (_target: string, commandJson: string): Promise<string> => {
      const command = (JSON.parse(commandJson) as { command?: string }).command ?? 'unknown';
      commands.push(command);
      if (command === 'peer_mode_ping' && failNextPing) {
        failNextPing = false;
        throw new Error('relay unavailable');
      }
      if (command === 'peer_control_attach' && ++attachCount === 2) {
        return reattach.promise;
      }
      if (command === 'peer_mode_ping') {
        return JSON.stringify({
          resp: 'host_invoke_result',
          ok: true,
          value: { capabilities: {} },
        });
      }
      return JSON.stringify({ resp: 'host_invoke_result', ok: true, value: null });
    });
    const manager = createManager(deviceRpc);
    const connection = await manager.connect('peer-1', 'Studio');

    failNextPing = true;
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
    await connection.adapter.request('get_opened_workspaces', { request: {} });
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
    await vi.waitFor(() => {
      expect(commands.filter(command => command === 'peer_control_attach')).toHaveLength(2);
    });

    const disposing = manager.dispose('peer-1');
    await Promise.resolve();
    expect(commands).not.toContain('peer_control_detach');

    reattach.resolve(JSON.stringify({ resp: 'host_invoke_result', ok: true, value: null }));
    await disposing;
    expect(commands.at(-1)).toBe('peer_control_detach');
  });

  it('publishes a snapshot when a ready peer reports changed capabilities', async () => {
    // A peer that stays `ready` but whose host changes capabilities mid-session
    // (e.g. a restart on a different build) must push a fresh snapshot, or the
    // UI keeps gating on stale capabilities. See PR #2428 #6.
    let capabilities: Record<string, unknown> = { cancel_tool: false, tool_catalog: false };
    const manager = new PeerConnectionManager({
      deviceRpc: async (_target, commandJson) => {
        const parsed = JSON.parse(commandJson) as { command?: string };
        if (parsed.command === 'peer_mode_ping') {
          return JSON.stringify({
            resp: 'host_invoke_result',
            ok: true,
            value: { capabilities },
          });
        }
        return JSON.stringify({ resp: 'host_invoke_result', ok: true, value: null });
      },
      getControllerDeviceId: async () => 'controller-1',
      keepaliveIntervalMs: KEEPALIVE_MS,
    });

    const connection = await manager.connect('peer-1', 'Studio');
    expect(connection.getState().capabilities.cancelTool).toBe(false);

    const snapshots: number[] = [];
    manager.subscribe(states => snapshots.push(states.length));

    // Host restarts advertising cancel_tool now available, without going degraded.
    capabilities = { cancel_tool: true, tool_catalog: false };
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);

    await vi.waitFor(() => {
      expect(connection.getState().capabilities.cancelTool).toBe(true);
    });
    // A snapshot was published for the capability change while staying ready.
    expect(snapshots.length).toBeGreaterThan(0);
  });

  it('does not let a stale health probe classify a replacement connection', async () => {
    const healthCatalog = deferred<string>();
    const commands: string[] = [];
    let catalogCallCount = 0;
    const deviceRpc = vi.fn(async (_target: string, commandJson: string): Promise<string> => {
      const command = (JSON.parse(commandJson) as { command?: string }).command ?? 'unknown';
      commands.push(command);

      if (command === 'peer_mode_ping') {
        return JSON.stringify({
          resp: 'host_invoke_result',
          ok: true,
          value: { capabilities: {} },
        });
      }
      if (command === 'get_all_tools_info') {
        catalogCallCount += 1;
        if (catalogCallCount === 1) {
          throw new Error('relay unavailable');
        }
        if (catalogCallCount === 2) {
          return healthCatalog.promise;
        }
        throw new Error('relay unavailable');
      }
      return JSON.stringify({ resp: 'host_invoke_result', ok: true, value: null });
    });
    const manager = createManager(deviceRpc);

    const first = await manager.connect('peer-1', 'Studio');
    expect(first.getState().capabilities).toMatchObject({
      cancelTool: null,
      toolCatalog: null,
      hostKind: null,
    });

    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
    await vi.waitFor(() => expect(commands.filter(command => command === 'get_all_tools_info')).toHaveLength(2));

    await manager.dispose('peer-1', { notifyPeer: false });
    const replacement = await manager.connect('peer-1', 'Studio');
    expect(replacement.getState().capabilities).toMatchObject({
      cancelTool: null,
      toolCatalog: null,
      hostKind: null,
    });

    expect(catalogCallCount).toBe(3);
    healthCatalog.resolve(JSON.stringify({
      resp: 'host_invoke_result',
      ok: true,
      value: [],
    }));
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
    expect(catalogCallCount).toBe(4);
    expect(replacement.getState().capabilities).toMatchObject({
      cancelTool: null,
      toolCatalog: null,
      hostKind: null,
    });
  });
});

function createManager(
  deviceRpc: ReturnType<typeof createRpc>['deviceRpc'],
): PeerConnectionManager {
  return new PeerConnectionManager({
    deviceRpc,
    getControllerDeviceId: async () => 'controller-1',
    keepaliveIntervalMs: KEEPALIVE_MS,
    reconnectBaseDelayMs: RECONNECT_BASE_MS,
    reconnectMaxDelayMs: RECONNECT_MAX_MS,
  });
}

interface RpcCall {
  command: string;
  args: Record<string, unknown>;
}

function createRpc(options: { failCommands?: Set<string> } = {}) {
  const calls: RpcCall[] = [];
  let remainingFailures = 0;
  let hangNext = false;

  const deviceRpc = vi.fn(async (_target: string, commandJson: string): Promise<string> => {
    const parsed = JSON.parse(commandJson) as {
      command?: string;
      args?: Record<string, unknown>;
    };
    const command = parsed.command ?? 'unknown';
    calls.push({ command, args: parsed.args ?? {} });

    if (hangNext) {
      hangNext = false;
      return new Promise<string>(() => {
        // Models a relay request that never settles.
      });
    }
    if (options.failCommands?.has(command)) {
      throw new Error('peer refused');
    }
    if (remainingFailures > 0) {
      remainingFailures -= 1;
      throw new Error('relay unavailable');
    }
    if (command === 'peer_mode_ping') {
      return JSON.stringify({
        resp: 'host_invoke_result',
        ok: true,
        value: {
          host_type: 'desktop',
          capabilities: {
            idempotent_dialog_submit: true,
            inline_image_attachments_v1: true,
            token_usage_statistics: true,
            miniapp_agent_context_files_v1: true,
            wsl_workspaces_v1: true,
            product_control_v1: true,
            cancel_tool: true,
            tool_catalog: true,
            user_question_response: true,
          },
        },
      });
    }
    return JSON.stringify({ resp: 'host_invoke_result', ok: true, value: null });
  });

  return {
    deviceRpc,
    commands: () => calls.map(call => call.command),
    args: (command: string) => calls.find(call => call.command === command)?.args,
    failNext: (count: number) => {
      remainingFailures = count;
    },
    failAll: () => {
      remainingFailures = Number.MAX_SAFE_INTEGER;
    },
    hangNext: () => {
      hangNext = true;
    },
  };
}

function createLegacyRpc(kind: 'desktop' | 'cli') {
  const calls: RpcCall[] = [];
  const deviceRpc = vi.fn(async (_target: string, commandJson: string): Promise<string> => {
    const parsed = JSON.parse(commandJson) as { command?: string; args?: Record<string, unknown> };
    const command = parsed.command ?? 'unknown';
    calls.push({ command, args: parsed.args ?? {} });

    if (command === 'peer_mode_ping') {
      return JSON.stringify({
        resp: 'host_invoke_result',
        ok: true,
        value: {
          ok: true,
          peer: true,
          device_id: 'legacy-peer',
          capabilities: {
            idempotent_dialog_submit: true,
            targeted_session_rollback: true,
            token_usage_statistics: true,
          },
        },
      });
    }
    if (command === 'get_all_tools_info') {
      if (kind === 'cli') {
        return JSON.stringify({
          resp: 'host_invoke_result',
          ok: false,
          error: "command 'get_all_tools_info' is not supported on CLI peer host",
        });
      }
      return JSON.stringify({
        resp: 'host_invoke_result',
        ok: true,
        value: [],
      });
    }
    return JSON.stringify({ resp: 'host_invoke_result', ok: true, value: null });
  });

  return {
    deviceRpc,
    commands: () => calls.map(call => call.command),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

function observe(manager: PeerConnectionManager) {
  const updates: PeerConnectionState[][] = [];
  manager.subscribe(states => updates.push(states.map(state => ({ ...state }))));
  return {
    healthTimeline: () => updates
      .map(states => states[0]?.health)
      .filter((health, index, all): health is PeerConnectionState['health'] =>
        health !== undefined && health !== all[index - 1]),
  };
}

describe('PeerConnectionManager recovery races', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('serializes presence recovery and only marks ready after re-attach succeeds', async () => {
    const rpc = createRpc();
    const reattach = deferred<string>();
    let attachCount = 0;
    const deviceRpc = vi.fn(async (target: string, commandJson: string) => {
      const command = JSON.parse(commandJson).command;
      if (command === 'peer_control_attach' && ++attachCount === 2) return reattach.promise;
      return rpc.deviceRpc(target, commandJson);
    });
    const manager = createManager(deviceRpc);
    const connection = await manager.connect('peer-1', 'Studio');
    manager.reportPresence([]);
    manager.reportPresence(['peer-1']);
    await vi.advanceTimersByTimeAsync(0);
    expect(attachCount).toBe(2);

    // These hints used to start competing recovery work or clear the failure
    // state before event delivery was actually attached again.
    manager.reportPresence([]);
    manager.reportPresence(['peer-1']);
    await connection.adapter.request('get_opened_workspaces', { request: {} });
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS * 2);
    expect(attachCount).toBe(2);
    expect(connection.getState().health).toBe('degraded');

    reattach.resolve(JSON.stringify({ resp: 'host_invoke_result', ok: true, value: null }));
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.getState().health).toBe('ready');
  });

  it('keeps a retry scheduled when online presence arrives as a failed probe settles', async () => {
    const rpc = createRpc();
    const manager = createManager(rpc.deviceRpc);
    const connection = await manager.connect('peer-1', 'Studio');
    manager.subscribe(states => {
      if (states[0]?.consecutiveFailures === 1) manager.reportPresence(['peer-1']);
    });
    manager.reportPresence([]);
    rpc.failNext(1);
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
    expect(connection.getState().health).toBe('degraded');
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
    expect(connection.getState().health).toBe('ready');
  });

  it('re-attaches when presence drops during an already running keepalive', async () => {
    const rpc = createRpc();
    const ping = deferred<string>();
    let pingCount = 0;
    const manager = createManager(vi.fn(async (target: string, commandJson: string) => {
      if (JSON.parse(commandJson).command === 'peer_mode_ping' && ++pingCount === 2) return ping.promise;
      return rpc.deviceRpc(target, commandJson);
    }));
    const connection = await manager.connect('peer-1', 'Studio');
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
    manager.reportPresence([]);
    ping.resolve(JSON.stringify({ resp: 'host_invoke_result', ok: true, value: { host_type: 'desktop', capabilities: {} } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.getState().health).toBe('ready');
    expect(rpc.commands().filter(command => command === 'peer_control_attach')).toHaveLength(2);
  });
});
