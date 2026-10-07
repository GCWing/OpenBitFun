import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, createRetryMiddleware } from './ApiClient';
import {
  LOCAL_SURFACE_ID,
  SurfaceChangedError,
  activateSurface,
  isSurfaceChangedError,
} from '@/infrastructure/peer-device/deviceSurface';

const adapterMocks = vi.hoisted(() => ({
  request: vi.fn(),
  listen: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  isConnected: vi.fn(() => true),
}));

const traceMocks = vi.hoisted(() => ({
  estimateJsonBytes: vi.fn(() => 1),
  recordApiCall: vi.fn(),
}));

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../adapters', () => ({
  getTransportAdapter: () => adapterMocks,
  isPeerLocalOnlyCommand: (command: string) => command === 'account_status',
}));

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => loggerMocks,
}));

vi.mock('@/shared/utils/startupTrace', () => ({
  estimateJsonBytes: traceMocks.estimateJsonBytes,
  isRemoteTraceRequest: vi.fn(() => false),
  startupTrace: traceMocks,
}));

describe('ApiClient startup trace classification', () => {
  beforeEach(() => {
    activateSurface(LOCAL_SURFACE_ID);
    vi.clearAllMocks();
    delete globalThis.__OPENBITFUN_PERF_TRACE_ENABLED__;
  });

  it('does not record optional get_config not found as a startup failure', async () => {
    adapterMocks.request.mockRejectedValueOnce(new Error("Config path not found: 'font'"));
    const client = new ApiClient({ enableLogging: true, retries: 0 });

    await expect(
      client.invoke('get_config', {
        request: {
          path: 'font',
          skipRetryOnNotFound: true,
        },
      })
    ).rejects.toThrow();

    expect(traceMocks.recordApiCall).toHaveBeenCalledWith(expect.objectContaining({
      command: 'get_config',
      target: 'font',
      outcome: 'success',
    }));
    expect(client.getStats()).toMatchObject({
      successfulRequests: 1,
      failedRequests: 0,
    });
    expect(loggerMocks.error).not.toHaveBeenCalled();
  });

  it('does not estimate payload bytes by default', async () => {
    adapterMocks.request.mockResolvedValueOnce({ turns: [] });
    const client = new ApiClient({ enableLogging: false, retries: 0 });

    await client.invoke('restore_session_view', {
      request: {
        sessionId: 'history-1',
        workspacePath: 'D:/workspace/OpenBitFun',
      },
    });

    expect(traceMocks.estimateJsonBytes).not.toHaveBeenCalled();
    expect(traceMocks.recordApiCall).toHaveBeenCalledWith(expect.objectContaining({
      command: 'restore_session_view',
      requestBytes: undefined,
      responseBytes: undefined,
      payloadEstimateDurationMs: undefined,
    }));
  });

  it('preserves structured transport error facts across command wrapping', async () => {
    const transportError = Object.assign(new Error('Unknown Server Host operation'), {
      code: -32004,
      data: {
        code: 'host_capability_unavailable',
        detail: 'Unknown Server Host operation',
        retryable: false,
        stage: 'execute_remote',
        correlationId: 'server-legacy-1',
        recoveryActions: [{ type: 'reconnect_host' }],
      },
    });
    adapterMocks.request.mockRejectedValueOnce(transportError);
    const client = new ApiClient({ enableLogging: false, retries: 0 });

    const error = await client.invoke('get_external_source_control_snapshot', {
      request: { workspacePath: 'D:/workspace/OpenBitFun' },
    }).catch((caught: unknown) => caught as {
      code: string;
      details?: { originalError?: unknown };
    });

    expect(error).toMatchObject({
      code: 'COMMAND_FAILED',
      details: {
        originalError: {
          code: -32004,
          data: {
            code: 'host_capability_unavailable',
            correlationId: 'server-legacy-1',
            recoveryActions: [{ type: 'reconnect_host' }],
          },
        },
      },
    });
  });

  it('preserves a surface change as control flow and never retries it', async () => {
    adapterMocks.request.mockRejectedValue(
      new SurfaceChangedError('peer-b', 7, 'load sessions'),
    );
    const client = new ApiClient({ enableLogging: true, retries: 3 });

    const error = await client.invoke('list_persisted_sessions_page', {
      request: { workspacePath: '/repo' },
    }).catch((caught: unknown) => caught);

    expect(isSurfaceChangedError(error)).toBe(true);
    expect(adapterMocks.request).toHaveBeenCalledTimes(1);
    expect(loggerMocks.warn).not.toHaveBeenCalledWith(
      'Retrying request',
      expect.anything(),
    );
  });

  it('does not let retry middleware replay a stale request on another surface', async () => {
    adapterMocks.request.mockRejectedValue(
      new SurfaceChangedError('peer-b', 7, 'load sessions'),
    );
    const client = new ApiClient({
      enableLogging: false,
      retries: 0,
      middleware: [createRetryMiddleware(3, 0)],
    });

    const error = await client.invoke('list_persisted_sessions_page', {
      request: { workspacePath: '/repo' },
    }).catch((caught: unknown) => caught);

    expect(isSurfaceChangedError(error)).toBe(true);
    expect(adapterMocks.request).toHaveBeenCalledTimes(1);
  });

  it('checks the surface again when delayed middleware reaches the transport', async () => {
    let continueRequest!: () => void;
    const middlewareGate = new Promise<void>(resolve => {
      continueRequest = resolve;
    });
    const client = new ApiClient({
      enableLogging: false,
      retries: 0,
      middleware: [async (request, next) => {
        await middlewareGate;
        return next(request);
      }],
    });

    const pending = client.invoke('list_persisted_sessions_page', {
      request: { workspacePath: '/repo' },
    });
    activateSurface('peer-b');
    continueRequest();

    await expect(pending).rejects.toSatisfy(isSurfaceChangedError);
    expect(adapterMocks.request).not.toHaveBeenCalled();
  });

  it('rejects a product response that lands after the device activation changed', async () => {
    let resolveRequest!: (value: unknown) => void;
    adapterMocks.request.mockReturnValueOnce(new Promise(resolve => {
      resolveRequest = resolve;
    }));
    const client = new ApiClient({ enableLogging: false, retries: 0 });

    const pending = client.invoke('list_persisted_sessions_page', {
      request: { workspacePath: '/repo' },
    });
    activateSurface('peer-b');
    resolveRequest({ sessions: [] });

    await expect(pending).rejects.toSatisfy(isSurfaceChangedError);
  });

  it('allows controller-plane responses to survive a rendered surface change', async () => {
    let resolveRequest!: (value: unknown) => void;
    adapterMocks.request.mockReturnValueOnce(new Promise(resolve => {
      resolveRequest = resolve;
    }));
    const client = new ApiClient({ enableLogging: false, retries: 0 });

    const pending = client.invoke('account_status', {});
    activateSurface('peer-b');
    resolveRequest({ loggedIn: true });

    await expect(pending).resolves.toEqual({ loggedIn: true });
  });

  it('enforces the configured timeout for stalled Tauri commands', async () => {
    vi.useFakeTimers();
    try {
      adapterMocks.request.mockReturnValueOnce(new Promise(() => {}));
      const client = new ApiClient({ enableLogging: false, retries: 0 });

      const outcome = client
        .invoke('get_mode_skill_configs', {}, { timeout: 60_000 })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(60_000);

      await expect(outcome).resolves.toMatchObject({
        code: 'REQUEST_TIMEOUT',
        message: 'Request timeout',
      });
      expect(client.getStats()).toMatchObject({
        successfulRequests: 0,
        failedRequests: 1,
        activeRequests: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a streamed transfer opt out of the request deadline', async () => {
    vi.useFakeTimers();
    try {
      let settle: (value: unknown) => void = () => {};
      adapterMocks.request.mockReturnValueOnce(
        new Promise((resolve) => {
          settle = resolve;
        }),
      );
      const client = new ApiClient({ enableLogging: false, retries: 0 });

      const pending = client.invoke(
        'remote_download_to_local_path',
        {},
        { timeout: 0 },
      );
      // Any wall-clock budget is longer than the default 30s deadline, so a
      // transfer that is still running must not be aborted.
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      settle('transferred');

      await expect(pending).resolves.toBe('transferred');
      expect(client.getStats()).toMatchObject({
        successfulRequests: 1,
        failedRequests: 0,
        activeRequests: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the message from plain structured Tauri errors', async () => {
    const transportError = {
      code: 'worktree_not_found',
      message: 'Session not found: history-1',
    };
    adapterMocks.request.mockRejectedValueOnce(transportError);
    const client = new ApiClient({ enableLogging: false, retries: 0 });

    const error = await client.invoke('worktree_bind_session', {
      request: { sessionId: 'history-1', enabled: true },
    }).catch((caught: unknown) => caught as {
      code: string;
      message: string;
      details?: { originalError?: unknown };
    });

    expect(error).toMatchObject({
      code: 'COMMAND_FAILED',
      message: 'Session not found: history-1',
      details: {
        originalError: transportError,
      },
    });
    expect(error.message).not.toBe('[object Object]');
  });

  it('keeps message-only transport errors parseable by domain adapters', async () => {
    const encoded = JSON.stringify({
      code: 'stale_revision',
      detail: 'Refresh and try again',
      retryable: true,
      recoveryActions: [{ type: 'refresh' }],
    });
    adapterMocks.request.mockRejectedValueOnce(new Error(encoded));
    const client = new ApiClient({ enableLogging: false, retries: 0 });

    const error = await client.invoke('apply_external_source_control_action_command', {
      request: {},
    }).catch((caught: unknown) => caught as {
      details?: { originalError?: unknown };
    });

    expect(error.details?.originalError).toBe(encoded);
  });

  it('uses a bounded response estimate cap for session view restore when perf trace is enabled', async () => {
    globalThis.__OPENBITFUN_PERF_TRACE_ENABLED__ = true;
    adapterMocks.request.mockResolvedValueOnce({ turns: [] });
    const client = new ApiClient({ enableLogging: false, retries: 0 });

    await client.invoke('restore_session_view', {
      request: {
        sessionId: 'history-1',
        workspacePath: 'D:/workspace/OpenBitFun',
      },
    });

    expect(traceMocks.estimateJsonBytes).toHaveBeenCalledWith(
      { turns: [] },
      2 * 1024 * 1024
    );
  });

  it('uses the Session response estimate cap for Turn windows', async () => {
    globalThis.__OPENBITFUN_PERF_TRACE_ENABLED__ = true;
    adapterMocks.request.mockResolvedValueOnce({ status: 'ready', turns: [] });
    const client = new ApiClient({ enableLogging: false, retries: 0 });

    await client.invoke('load_session_turn_window', {
      request: {
        sessionId: 'history-1',
        workspacePath: 'D:/workspace/OpenBitFun',
        targetStorageTurnIndex: 4,
      },
    });

    expect(traceMocks.estimateJsonBytes).toHaveBeenCalledWith(
      { status: 'ready', turns: [] },
      2 * 1024 * 1024
    );
  });

  it('records request boundary timings and active request pressure', async () => {
    let releaseFirstRequest!: () => void;
    adapterMocks.request
      .mockImplementationOnce((_command, _args, timing) => new Promise<void>(resolve => {
        Object.assign(timing, {
          adapterInitDurationMs: 1,
          invokeDurationMs: 10,
          transportDurationMs: 11,
        });
        releaseFirstRequest = resolve;
      }))
      .mockImplementationOnce((_command, _args, timing) => {
        Object.assign(timing, {
          adapterInitDurationMs: 2,
          invokeDurationMs: 20,
          transportDurationMs: 22,
        });
        return Promise.resolve({ ok: true });
      });
    const client = new ApiClient({ enableLogging: false, retries: 0 });

    const firstRequest = client.invoke('get_config', {
      request: { path: 'app.keybindings' },
    });
    const secondRequest = client.invoke('list_persisted_sessions_page', {
      request: {
        workspacePath: 'D:/workspace/OpenBitFun',
        limit: 5,
      },
    });

    await secondRequest;
    releaseFirstRequest();
    await firstRequest;

    expect(traceMocks.recordApiCall).toHaveBeenCalledWith(expect.objectContaining({
      command: 'list_persisted_sessions_page',
      requestPayloadEstimateDurationMs: undefined,
      responsePayloadEstimateDurationMs: undefined,
      payloadEstimateDurationMs: undefined,
      adapterInitDurationMs: expect.any(Number),
      transportDurationMs: expect.any(Number),
      activeRequestsAtStart: 1,
      activeRequestsAtEnd: 1,
      maxConcurrentRequests: 2,
    }));
  });

  it('binds file explorer and watcher startup trace targets without exposing paths', async () => {
    adapterMocks.request.mockResolvedValue({ ok: true });
    const client = new ApiClient({ enableLogging: false, retries: 0 });

    await client.invoke('explorer_get_children', {
      request: { path: 'D:/workspace/OpenBitFun' },
    });
    await client.invoke('start_file_watch', {
      path: 'D:/workspace/OpenBitFun',
      recursive: false,
    });
    await client.invoke('start_file_watch', {
      path: 'D:/workspace/OpenBitFun',
      recursive: true,
    });

    expect(traceMocks.recordApiCall).toHaveBeenCalledWith(expect.objectContaining({
      command: 'explorer_get_children',
      target: 'file_explorer:children',
    }));
    expect(traceMocks.recordApiCall).toHaveBeenCalledWith(expect.objectContaining({
      command: 'start_file_watch',
      target: 'file_watch:non_recursive',
    }));
    expect(traceMocks.recordApiCall).toHaveBeenCalledWith(expect.objectContaining({
      command: 'start_file_watch',
      target: 'file_watch:recursive',
    }));

    const calls = traceMocks.recordApiCall.mock.calls.map(([call]) => call);
    expect(JSON.stringify(calls)).not.toContain('D:/workspace/OpenBitFun');
  });
});
