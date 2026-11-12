import { describe, expect, it, vi } from 'vitest';
import {
  PEER_IDEMPOTENT_MUTATION_MAX_RETRIES,
  PEER_MUTATION_REQUEST_TIMEOUT_MS,
  PEER_RETRY_BASE_DELAY_MS,
} from '@/infrastructure/api/adapters/peer-device-adapter';
import {
  PEER_HOST_INVOKE_IDEMPOTENCY_TTL_MS,
  PeerHostInvokeIdempotencyCache,
  peerHostInvokeIdempotencyKey,
  type PeerHostInvokeExecutionResult,
} from './peerHostInvokeIdempotency';

function startTurnArgs(sessionId = 'session-1', turnId = 'turn-1') {
  return {
    request: {
      sessionId,
      turnId,
      userInput: 'hello',
    },
  };
}

function successResult(): PeerHostInvokeExecutionResult {
  return {
    ok: true,
    value: { success: true },
    error: null,
  };
}

describe('PeerHostInvokeIdempotencyCache', () => {
  it('keys only dialog submissions with stable session and turn ids', () => {
    expect(peerHostInvokeIdempotencyKey(
      'start_dialog_turn',
      startTurnArgs(),
    )).toBe('start_dialog_turn:session-1:turn-1');
    expect(peerHostInvokeIdempotencyKey(
      'start_acp_dialog_turn',
      startTurnArgs(),
    )).toBe('start_acp_dialog_turn:session-1:turn-1');
    expect(peerHostInvokeIdempotencyKey(
      'start_dialog_turn',
      { request: { sessionId: 'session-1' } },
    )).toBeNull();
    expect(peerHostInvokeIdempotencyKey(
      'delete_session',
      startTurnArgs(),
    )).toBeNull();
  });

  it('coalesces concurrent retries and reuses the completed result', async () => {
    let resolveExecution!: (result: PeerHostInvokeExecutionResult) => void;
    const execution = new Promise<PeerHostInvokeExecutionResult>((resolve) => {
      resolveExecution = resolve;
    });
    const operation = vi.fn(() => execution);
    const duplicateOperation = vi.fn(async () => ({
      ok: false,
      value: null,
      error: 'must not execute',
    }));
    const cache = new PeerHostInvokeIdempotencyCache();

    const first = cache.execute('start_dialog_turn', startTurnArgs(), operation);
    const concurrent = cache.execute(
      'start_dialog_turn',
      startTurnArgs(),
      duplicateOperation,
    );
    expect(first).toBe(concurrent);
    await Promise.resolve();
    expect(operation).toHaveBeenCalledTimes(1);
    expect(duplicateOperation).not.toHaveBeenCalled();

    const result = successResult();
    resolveExecution(result);
    await expect(first).resolves.toEqual(result);
    await expect(cache.execute(
      'start_dialog_turn',
      startTurnArgs(),
      duplicateOperation,
    )).resolves.toEqual(result);
    expect(duplicateOperation).not.toHaveBeenCalled();
  });

  it('executes a new submission after the cache window expires', async () => {
    let now = 100;
    const cache = new PeerHostInvokeIdempotencyCache(1_000, 128, () => now);
    const firstOperation = vi.fn(async () => successResult());
    const secondResult: PeerHostInvokeExecutionResult = {
      ok: false,
      value: null,
      error: 'new execution',
    };
    const secondOperation = vi.fn(async () => secondResult);

    await cache.execute('start_dialog_turn', startTurnArgs(), firstOperation);
    now += 1_001;

    await expect(cache.execute(
      'start_dialog_turn',
      startTurnArgs(),
      secondOperation,
    )).resolves.toEqual(secondResult);
    expect(firstOperation).toHaveBeenCalledTimes(1);
    expect(secondOperation).toHaveBeenCalledTimes(1);
  });

  it('runs an explicit retry again after a failed submission settles', async () => {
    const failure: PeerHostInvokeExecutionResult = {
      ok: false,
      value: null,
      error: 'Failed to start dialog turn: model provider unavailable',
    };
    let resolveFirst!: (result: PeerHostInvokeExecutionResult) => void;
    const first = vi.fn(() => new Promise<PeerHostInvokeExecutionResult>(resolve => {
      resolveFirst = resolve;
    }));
    const concurrent = vi.fn(async () => successResult());
    const retry = vi.fn(async () => successResult());
    const cache = new PeerHostInvokeIdempotencyCache();

    const pending = cache.execute('start_dialog_turn', startTurnArgs(), first);
    // A retry of the in-flight attempt still observes that attempt.
    expect(cache.execute('start_dialog_turn', startTurnArgs(), concurrent)).toBe(pending);
    await Promise.resolve();
    resolveFirst(failure);
    await expect(pending).resolves.toEqual(failure);
    expect(concurrent).not.toHaveBeenCalled();

    await expect(cache.execute('start_dialog_turn', startTurnArgs(), retry))
      .resolves.toEqual(successResult());
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('forgets an operation that rejected instead of answering', async () => {
    const cache = new PeerHostInvokeIdempotencyCache();
    await expect(cache.execute('start_dialog_turn', startTurnArgs(), async () => {
      throw new Error('bridge failed');
    })).rejects.toThrow('bridge failed');
    const retry = vi.fn(async () => successResult());
    await cache.execute('start_dialog_turn', startTurnArgs(), retry);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('keeps a submission replayable for the controller\'s whole retry budget', async () => {
    let backoffMs = 0;
    for (let attempt = 0; attempt < PEER_IDEMPOTENT_MUTATION_MAX_RETRIES; attempt += 1) {
      backoffMs += PEER_RETRY_BASE_DELAY_MS * (2 ** attempt);
    }
    const controllerBudgetMs =
      (PEER_IDEMPOTENT_MUTATION_MAX_RETRIES + 1) * PEER_MUTATION_REQUEST_TIMEOUT_MS + backoffMs;
    expect(PEER_HOST_INVOKE_IDEMPOTENCY_TTL_MS).toBeGreaterThan(controllerBudgetMs);

    let now = 0;
    const cache = new PeerHostInvokeIdempotencyCache(undefined, 128, () => now);
    const first = vi.fn(async () => successResult());
    const late = vi.fn(async () => successResult());
    await cache.execute('start_dialog_turn', startTurnArgs(), first);
    now += controllerBudgetMs;
    await cache.execute('start_dialog_turn', startTurnArgs(), late);
    expect(late).not.toHaveBeenCalled();
  });
});
