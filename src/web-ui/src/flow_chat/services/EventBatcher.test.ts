import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setIncludeSensitiveDiagnostics } from '@/shared/utils/logger';
import {
  DEFAULT_EVENT_MAX_LATENCY_MS,
  EventBatcher,
  TEXT_CHUNK_MAX_LATENCY_MS,
  generateTextChunkKey,
  generateToolEventKey,
  getBatchedEventsLogPayload,
  parseEventKey,
  summarizeBatchedEventsForLog,
  type BatchedEvent,
  type ToolEventData,
} from './EventBatcher';

describe('summarizeBatchedEventsForLog', () => {
  afterEach(() => {
    setIncludeSensitiveDiagnostics(true);
  });

  it('keeps full payloads when sensitive diagnostics are enabled', () => {
    setIncludeSensitiveDiagnostics(true);
    const events: BatchedEvent[] = [
      {
        key: 'tool:params:session:call:none',
        payload: {
          toolEvent: {
            event_type: 'ParamsPartial',
            params: '{"file_path":"src/secret.ts","content":"very sensitive content"}',
          },
        },
        strategy: 'accumulate',
        sourceCount: 12,
        timestamp: 1000,
        maxLatencyMs: 100,
      },
    ];

    const payloadText = JSON.stringify(getBatchedEventsLogPayload(events));

    expect(payloadText).toContain('very sensitive content');
    expect(payloadText).toContain('src/secret.ts');
  });

  it('keeps batch diagnostics without logging full event payloads', () => {
    setIncludeSensitiveDiagnostics(false);
    const events: BatchedEvent[] = [
      {
        key: 'tool:params:session:call:none',
        payload: {
          toolEvent: {
            event_type: 'ParamsPartial',
            params: '{"file_path":"src/secret.ts","content":"very sensitive content"}',
          },
        },
        strategy: 'accumulate',
        sourceCount: 12,
        timestamp: 1000,
        maxLatencyMs: 100,
      },
    ];

    const summary = summarizeBatchedEventsForLog(events);
    const summaryText = JSON.stringify(summary);

    expect(summary.rawEventCount).toBe(12);
    expect(summary.mergedEventCount).toBe(1);
    expect(summary.events[0]).toEqual({
      key: 'tool:params:session:call:none',
      strategy: 'accumulate',
      sourceCount: 12,
      timestamp: 1000,
      eventType: 'ParamsPartial',
      toolName: undefined,
      paramsLength: 64,
    });
    expect(summaryText).not.toContain('very sensitive content');
    expect(summaryText).not.toContain('src/secret.ts');
  });
});

describe('generateToolEventKey', () => {
  it('accumulates Write params so argument deltas survive batching', () => {
    const keyInfo = generateToolEventKey({
      sessionId: 'session-1',
      turnId: 'turn-1',
      roundId: 'round-1',
      toolEvent: {
        event_type: 'ParamsPartial',
        tool_id: 'tool-1',
        tool_name: 'Write',
        params: '{"file_path":"src/app.ts"',
      },
    } satisfies ToolEventData);

    expect(keyInfo).toEqual({
      key: 'tool:params:session-1:tool-1:none',
      strategy: 'accumulate',
    });
  });

  it('separates text chunks across retry attempts in the same round', () => {
    expect(generateTextChunkKey({
      sessionId: 'session-1',
      turnId: 'turn-1',
      roundId: 'round-1',
      attemptId: 'round-1:attempt:1',
      attemptIndex: 1,
      text: 'alpha',
      contentType: 'text',
    })).not.toEqual(generateTextChunkKey({
      sessionId: 'session-1',
      turnId: 'turn-1',
      roundId: 'round-1',
      attemptId: 'round-1:attempt:2',
      attemptIndex: 2,
      text: 'beta',
      contentType: 'text',
    }));
  });

  it('separates raw reasoning from reasoning summary chunks', () => {
    const common = {
      sessionId: 'session-1',
      turnId: 'turn-1',
      roundId: 'round-1',
      text: 'chunk',
      contentType: 'thinking' as const,
    };

    const reasoningKey = generateTextChunkKey({
      ...common,
      reasoningKind: 'reasoning',
    });
    const summaryKey = generateTextChunkKey({
      ...common,
      reasoningKind: 'summary',
    });

    expect(reasoningKey).not.toEqual(summaryKey);
    expect(parseEventKey(summaryKey)?.ids.reasoningKind).toBe('summary');
  });
});

describe('EventBatcher dual latency', () => {
  const rafCallbacks = new Map<number, FrameRequestCallback>();
  let nextRafId = 1;

  async function drainAnimationFrames(): Promise<void> {
    const pending = [...rafCallbacks.entries()];
    rafCallbacks.clear();
    for (const [, cb] of pending) {
      cb(performance.now());
    }
  }

  beforeEach(() => {
    nextRafId = 1;
    rafCallbacks.clear();
    vi.useFakeTimers({ now: 0 });
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = nextRafId++;
      rafCallbacks.set(id, cb);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      rafCallbacks.delete(id);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('flushes text events near the text latency budget', async () => {
    const onFlush = vi.fn();
    const batcher = new EventBatcher({ onFlush });

    batcher.add('text:s:r:text:none', { text: 'a' }, 'accumulate', (a, b) => ({
      text: `${a.text}${b.text}`,
    }), { maxLatencyMs: TEXT_CHUNK_MAX_LATENCY_MS });

    await vi.advanceTimersByTimeAsync(TEXT_CHUNK_MAX_LATENCY_MS - 1);
    await drainAnimationFrames();
    expect(onFlush).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await drainAnimationFrames();
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0][0][0].payload.text).toBe('a');
    batcher.destroy();
  });

  it('keeps default tool latency at 100ms', async () => {
    const onFlush = vi.fn();
    const batcher = new EventBatcher({ onFlush });

    batcher.add('tool:progress:s:t:none', { progress: 1 }, 'replace');

    await vi.advanceTimersByTimeAsync(DEFAULT_EVENT_MAX_LATENCY_MS - 1);
    await drainAnimationFrames();
    expect(onFlush).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await drainAnimationFrames();
    expect(onFlush).toHaveBeenCalledTimes(1);
    batcher.destroy();
  });

  it('commits accumulated facts when a minimized window stops delivering frames', async () => {
    const onFlush = vi.fn();
    const batcher = new EventBatcher({ onFlush });
    batcher.add('text', 'a', 'accumulate', (a, b) => a + b, { maxLatencyMs: TEXT_CHUNK_MAX_LATENCY_MS });
    await vi.advanceTimersByTimeAsync(TEXT_CHUNK_MAX_LATENCY_MS);
    batcher.add('text', 'b', 'accumulate', (a, b) => a + b, { maxLatencyMs: TEXT_CHUNK_MAX_LATENCY_MS });
    await vi.advanceTimersByTimeAsync(TEXT_CHUNK_MAX_LATENCY_MS);
    expect(onFlush).toHaveBeenCalledExactlyOnceWith([{ key: 'text', payload: 'ab' }]);
    await drainAnimationFrames();
    expect(onFlush).toHaveBeenCalledTimes(1);
    batcher.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reschedules earlier when a text event arrives after a tool event', async () => {
    const onFlush = vi.fn();
    const batcher = new EventBatcher({ onFlush });

    batcher.add('tool:progress:s:t:none', { progress: 1 }, 'replace');
    await vi.advanceTimersByTimeAsync(10);

    batcher.add('text:s:r:text:none', { text: 'hi' }, 'replace', undefined, {
      maxLatencyMs: TEXT_CHUNK_MAX_LATENCY_MS,
    });

    // Original tool schedule would still be ~90ms away; text should pull flush forward.
    await vi.advanceTimersByTimeAsync(TEXT_CHUNK_MAX_LATENCY_MS);
    await drainAnimationFrames();
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0][0]).toHaveLength(2);
    batcher.destroy();
  });
});
