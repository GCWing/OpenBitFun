/**
 * Event batcher
 * 
 * Uses requestAnimationFrame to batch high-frequency events and reduce UI updates
 * 
 * Design principles:
 * - Events with the same key are merged (accumulated or replaced)
 * - Batch processing triggered once per frame
 * - Merge keys are scoped by session, round/tool id, and retry attempt
 */

import { areSensitiveDiagnosticsEnabled, createLogger } from '@/shared/utils/logger';
import { elapsedMs, nowMs } from '@/shared/utils/timing';

const log = createLogger('EventBatcher');

export type MergeStrategy = 'accumulate' | 'replace';

/** Default max latency for tool / non-text batched events. */
export const DEFAULT_EVENT_MAX_LATENCY_MS = 100;

/**
 * Max latency for streaming text chunks. Keeps inflow steady for the
 * adaptive typewriter without forcing a flush on every token.
 */
export const TEXT_CHUNK_MAX_LATENCY_MS = 32;

export interface BatchedEvent<T = any> {
  key: string;
  payload: T;
  strategy: MergeStrategy;
  accumulator?: (existing: T, incoming: T) => T;
  sourceCount: number;
  timestamp: number;
  /** Flush this event (and the batch) within this many ms. */
  maxLatencyMs: number;
}

export interface EventBatcherAddOptions {
  maxLatencyMs?: number;
}

export interface EventBatcherOptions {
  onFlush: (events: Array<{ key: string; payload: any }>) => void;
}

export interface BatchedEventLogSummary {
  rawEventCount: number;
  mergedEventCount: number;
  events: Array<{
    key: string;
    strategy: MergeStrategy;
    sourceCount: number;
    timestamp: number;
    eventType?: string;
    toolName?: string;
    paramsLength?: number;
  }>;
}

export interface SensitiveBatchedEventLogPayload {
  rawEventCount: number;
  mergedEventCount: number;
  mergedEvents: BatchedEvent[];
}

export function summarizeBatchedEventsForLog(bufferedEvents: BatchedEvent[]): BatchedEventLogSummary {
  return {
    rawEventCount: bufferedEvents.reduce((count, event) => count + event.sourceCount, 0),
    mergedEventCount: bufferedEvents.length,
    events: bufferedEvents.map(({ key, payload, strategy, sourceCount, timestamp }) => {
      const toolEvent = payload?.toolEvent;
      const params = toolEvent?.params;

      return {
        key,
        strategy,
        sourceCount,
        timestamp,
        eventType: toolEvent?.event_type,
        toolName: toolEvent?.tool_name,
        paramsLength: typeof params === 'string' ? params.length : undefined,
      };
    }),
  };
}

export function getBatchedEventsLogPayload(
  bufferedEvents: BatchedEvent[]
): BatchedEventLogSummary | SensitiveBatchedEventLogPayload {
  const rawEventCount = bufferedEvents.reduce((count, event) => count + event.sourceCount, 0);
  const mergedEventCount = bufferedEvents.length;

  if (!areSensitiveDiagnosticsEnabled()) {
    return summarizeBatchedEventsForLog(bufferedEvents);
  }

  return {
    rawEventCount,
    mergedEventCount,
    mergedEvents: bufferedEvents.map(({ key, payload, strategy, sourceCount, timestamp, maxLatencyMs }) => ({
      key,
      payload,
      strategy,
      sourceCount,
      timestamp,
      maxLatencyMs,
    })),
  };
}

export class EventBatcher {
  private buffer: Map<string, BatchedEvent> = new Map();
  private scheduled = false;
  private onFlush: (events: Array<{ key: string; payload: any }>) => void;
  private frameId: number | null = null;

  private lastUpdateTime = 0;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  /** Delay currently armed for the pending flush; used to reschedule earlier. */
  private scheduledDelayMs: number | null = null;

  constructor(options: EventBatcherOptions) {
    this.onFlush = options.onFlush;
  }

  add<T>(
    key: string,
    payload: T,
    strategy: MergeStrategy = 'replace',
    accumulator?: (existing: T, incoming: T) => T,
    options?: EventBatcherAddOptions
  ): void {
    const maxLatencyMs = Math.max(
      0,
      options?.maxLatencyMs ?? DEFAULT_EVENT_MAX_LATENCY_MS
    );
    const existing = this.buffer.get(key);

    if (existing) {
      if (strategy === 'accumulate' && accumulator) {
        existing.payload = accumulator(existing.payload, payload);
        existing.timestamp = Date.now();
      } else {
        existing.payload = payload;
        existing.timestamp = Date.now();
      }
      existing.sourceCount += 1;
      existing.maxLatencyMs = Math.min(existing.maxLatencyMs, maxLatencyMs);
    } else {
      this.buffer.set(key, {
        key,
        payload,
        strategy,
        accumulator,
        sourceCount: 1,
        timestamp: Date.now(),
        maxLatencyMs,
      });
    }

    this.scheduleFlush();
  }

  private getBufferMaxLatencyMs(): number {
    let minLatency = DEFAULT_EVENT_MAX_LATENCY_MS;
    for (const event of this.buffer.values()) {
      minLatency = Math.min(minLatency, event.maxLatencyMs);
    }
    return minLatency;
  }

  private cancelScheduledFlush(): void {
    if (this.frameId !== null) {
      cancelAnimationFrame(this.frameId);
      this.frameId = null;
    }
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    this.scheduled = false;
    this.scheduledDelayMs = null;
  }

  private armFlush(delayMs: number): void {
    this.scheduled = true;
    this.scheduledDelayMs = delayMs;

    if (delayMs <= 0) {
      this.frameId = requestAnimationFrame(() => {
        this.flush();
        this.scheduled = false;
        this.frameId = null;
        this.scheduledDelayMs = null;
        this.lastUpdateTime = nowMs();
      });
      return;
    }

    this.timeoutId = setTimeout(() => {
      this.timeoutId = null;
      this.frameId = requestAnimationFrame(() => {
        this.flush();
        this.scheduled = false;
        this.frameId = null;
        this.scheduledDelayMs = null;
        this.lastUpdateTime = nowMs();
      });
    }, delayMs);
  }

  private scheduleFlush(): void {
    const now = nowMs();
    const maxLatencyMs = this.getBufferMaxLatencyMs();
    const timeSinceLastUpdate = now - this.lastUpdateTime;
    const delayMs = Math.max(0, maxLatencyMs - timeSinceLastUpdate);

    if (this.scheduled) {
      // A more urgent event (e.g. text after tools) must pull the flush earlier.
      if (this.scheduledDelayMs !== null && delayMs < this.scheduledDelayMs) {
        this.cancelScheduledFlush();
      } else {
        return;
      }
    }

    this.armFlush(delayMs);
  }

  private flush(): void {
    if (this.buffer.size === 0) return;

    const startTime = nowMs();
    const bufferedEvents = Array.from(this.buffer.values());
    const logPayload = getBatchedEventsLogPayload(bufferedEvents);
    const { rawEventCount, mergedEventCount } = logPayload;

    const events = bufferedEvents.map(({ key, payload }) => ({
      key,
      payload
    }));

    log.trace('Flushing batched events', logPayload);

    this.buffer = new Map();
    this.onFlush(events);

    const durationMs = elapsedMs(startTime);
    if (durationMs > 10) {
      log.warn('Event batch processing took longer than expected', {
        rawEventCount,
        mergedEventCount,
        durationMs,
      });
    }
  }

  flushNow(): void {
    const hadBufferedEvents = this.buffer.size > 0;
    this.cancelScheduledFlush();
    this.flush();
    // Keep the throttle baseline in sync so the next event is not flushed
    // earlier than its latency budget allows.
    if (hadBufferedEvents) {
      this.lastUpdateTime = nowMs();
    }
  }

  getBufferSize(): number {
    return this.buffer.size;
  }

  clear(): void {
    this.cancelScheduledFlush();
    this.buffer.clear();
  }

  destroy(): void {
    this.clear();
  }
}

export interface SubagentParentInfo {
  sessionId: string;
  toolCallId: string;
  dialogTurnId: string;
}

export type ToolEventType =
  | 'EarlyDetected'
  | 'ParamsPartial'
  | 'Queued'
  | 'Waiting'
  | 'Started'
  | 'Progress'
  | 'Streaming'
  | 'StreamChunk'
  | 'ConfirmationNeeded'
  | 'Confirmed'
  | 'Rejected'
  | 'Completed'
  | 'Failed'
  | 'Cancelled';

interface BaseToolEvent<T extends ToolEventType> {
  event_type: T;
  tool_id: string;
  /** Provider-facing name. Deferred calls remain CallDeferredTool. */
  tool_name: string;
  /** Runtime target when it differs from the provider-facing name. */
  effective_tool_name?: string;
}

export type EarlyDetectedToolEvent = BaseToolEvent<'EarlyDetected'>;

export interface ParamsPartialToolEvent extends BaseToolEvent<'ParamsPartial'> {
  params: string;
}

export function normalizeParamsPartialFragment(params: unknown): string {
  return typeof params === 'string' ? params : '';
}

export interface QueuedToolEvent extends BaseToolEvent<'Queued'> {
  position: number;
}

export interface WaitingToolEvent extends BaseToolEvent<'Waiting'> {
  dependencies: string[];
}

export interface StartedToolEvent extends BaseToolEvent<'Started'> {
  params: unknown;
  timeout_seconds?: number;
}

export interface ProgressToolEvent extends BaseToolEvent<'Progress'> {
  message: string;
  percentage: number;
}

export interface StreamingToolEvent extends BaseToolEvent<'Streaming'> {
  chunks_received: number;
}

export interface StreamChunkToolEvent extends BaseToolEvent<'StreamChunk'> {
  data: unknown;
}

export interface ConfirmationNeededToolEvent extends BaseToolEvent<'ConfirmationNeeded'> {
  params: unknown;
  timeout_at?: number;
}

export type ConfirmedToolEvent = BaseToolEvent<'Confirmed'>;

export type RejectedToolEvent = BaseToolEvent<'Rejected'>;

export interface CompletedToolEvent extends BaseToolEvent<'Completed'> {
  result: unknown;
  result_for_assistant?: string;
  image_attachments?: Array<{
    mime_type: string;
    data_base64: string;
  }>;
  duration_ms: number;
  queue_wait_ms?: number;
  preflight_ms?: number;
  confirmation_wait_ms?: number;
  execution_ms?: number;
}

export interface FailedToolEvent extends BaseToolEvent<'Failed'> {
  error: string;
  error_detail?: { code: string; kind: string };
  duration_ms?: number;
  queue_wait_ms?: number;
  preflight_ms?: number;
  confirmation_wait_ms?: number;
  execution_ms?: number;
}

export interface CancelledToolEvent extends BaseToolEvent<'Cancelled'> {
  reason: string;
  duration_ms?: number;
  queue_wait_ms?: number;
  preflight_ms?: number;
  confirmation_wait_ms?: number;
  execution_ms?: number;
}

export type FlowToolEvent =
  | EarlyDetectedToolEvent
  | ParamsPartialToolEvent
  | QueuedToolEvent
  | WaitingToolEvent
  | StartedToolEvent
  | ProgressToolEvent
  | StreamingToolEvent
  | StreamChunkToolEvent
  | ConfirmationNeededToolEvent
  | ConfirmedToolEvent
  | RejectedToolEvent
  | CompletedToolEvent
  | FailedToolEvent
  | CancelledToolEvent;

export interface TextChunkEventData {
  sessionId: string;
  turnId: string;
  roundId: string;
  attemptId?: string;
  attemptIndex?: number;
  text: string;
  contentType: 'text' | 'thinking';
  reasoningKind?: 'reasoning' | 'summary';
  isThinkingEnd?: boolean;
}

export interface ToolEventData {
  sessionId: string;
  turnId: string;
  roundId: string;
  attemptId?: string;
  attemptIndex?: number;
  toolEvent: FlowToolEvent;
}

function resolveAttemptMergeToken(data: { attemptId?: string; attemptIndex?: number }): string {
  if (typeof data.attemptId === 'string' && data.attemptId.length > 0) {
    return encodeURIComponent(data.attemptId);
  }
  if (typeof data.attemptIndex === 'number' && Number.isFinite(data.attemptIndex)) {
    return `idx-${data.attemptIndex}`;
  }
  return 'none';
}

/**
 * Generate merge key for TextChunk events
 * 
 * Key structure:
 * - Text chunk: text:{sessionId}:{roundId}:{contentType}:{reasoningKind}:{attemptToken}
 */
export function generateTextChunkKey(data: TextChunkEventData): string {
  const { sessionId, roundId, contentType, reasoningKind = 'none' } = data;
  return `text:${sessionId}:${roundId}:${contentType}:${reasoningKind}:${resolveAttemptMergeToken(data)}`;
}

/**
 * Generate merge key for ToolEvent events
 * 
 * Returns null if the event doesn't need batching (isolated event)
 * 
 * Key structure:
 * - Tool params: tool:params:{sessionId}:{toolUseId}:{attemptToken}
 * - Tool progress: tool:progress:{sessionId}:{toolUseId}:{attemptToken}
 */
export function generateToolEventKey(data: ToolEventData): { key: string; strategy: MergeStrategy } | null {
  const { sessionId, toolEvent } = data;
  const toolUseId = toolEvent.tool_id;
  const eventType = toolEvent.event_type;
  const attemptToken = resolveAttemptMergeToken(data);

  const isolatedEvents: ToolEventType[] = ['EarlyDetected', 'Started', 'Completed', 'Failed', 'Cancelled', 'Rejected', 'ConfirmationNeeded'];
  if (isolatedEvents.includes(eventType)) {
    return null;
  }

  if (eventType === 'ParamsPartial') {
    return {
      key: `tool:params:${sessionId}:${toolUseId}:${attemptToken}`,
      strategy: 'accumulate'
    };
  }
  if (eventType === 'Progress') {
    return {
      key: `tool:progress:${sessionId}:${toolUseId}:${attemptToken}`,
      strategy: 'replace'
    };
  }

  return null;
}

/**
 * Parse event key to extract event type information.
 */
export function parseEventKey(key: string): {
  eventType: 'text' | 'tool:params' | 'tool:progress';
  ids: Record<string, string>;
} | null {
  if (key.startsWith('text:')) {
    const parts = key.split(':');
    if (parts.length >= 4) {
      return {
        eventType: 'text',
        ids: {
          sessionId: parts[1],
          roundId: parts[2],
          contentType: parts[3],
          reasoningKind: parts[4]
        }
      };
    }
  } else if (key.startsWith('tool:params:')) {
    const parts = key.split(':');
    if (parts.length >= 4) {
      return {
        eventType: 'tool:params',
        ids: {
          sessionId: parts[2],
          toolUseId: parts[3]
        }
      };
    }
  } else if (key.startsWith('tool:progress:')) {
    const parts = key.split(':');
    if (parts.length >= 4) {
      return {
        eventType: 'tool:progress',
        ids: {
          sessionId: parts[2],
          toolUseId: parts[3]
        }
      };
    }
  }

  return null;
}
