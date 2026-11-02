import { RemoteLogger } from './RemoteLogger';
import { CommandStatusResponse } from '../model/RemoteModels';

/** Stream id of the host's workspace/session catalog. */
export const HOST_CATALOG_ID: string = '@host/catalog';
export const HOST_STREAM_CHANGED_EVENT: string = 'host-stream-changed';
export const REMOTE_CAPABILITY_HOST_STREAM_V1: string = 'host_stream_v1';
/** Hosts keep hint subscriptions alive for 10 minutes; renew well before. */
const HOST_STREAM_KEEPALIVE_MS: number = 4 * 60 * 1000;

/**
 * How many pages one history request may read while it has not yet shown the
 * reader anything it did not already have.
 *
 * Host pages are cut by sequence, and a record's sequence is the moment it was
 * last updated, so one long turn owns every record it produced: a page of
 * history can be nothing but more records of the turn that is already on
 * screen. Reading exactly one page per request then looks like "history loaded"
 * while the transcript above stayed the same. The budget keeps that walk bounded
 * (a request is a user gesture, not an unbounded download); the next request
 * continues from where this one stopped. Mirrors `MAX_HISTORY_PAGES_PER_REQUEST`
 * in the shared core transport.
 */
export const MAX_HISTORY_PAGES_PER_REQUEST: number = 4;

/** One record as consumed by reducers; `session_id` is the stream id. */
export interface HostSessionEvent { session_id: string; event: string; payload: Object; }

export interface HostStreamEventWire { seq: number; event: string; payload: Object; }
/** `RemoteResponse::StreamPage`, flattened, as answered to `read_stream`. */
export interface HostStreamPage extends CommandStatusResponse {
  stream_id: string;
  epoch: number;
  events: HostStreamEventWire[];
  has_more: boolean;
  cursor: number;
  oldest_seq: number;
  truncated?: boolean;
}
export interface HostStreamReadRequest { after?: number; before?: number; epoch?: number; }
/** A decrypted `host-stream-changed` device event. */
export interface HostStreamHint { sourceDeviceId: string; streamId: string; epoch: number; cursor: number; }

/** Host-facing calls of one stream; production is pairwise-encrypted device RPC. */
export interface HostSessionSource {
  /** Device id of the host whose hints apply to this stream. */
  target: string;
  read: (request: HostStreamReadRequest) => Promise<HostStreamPage>;
  unsubscribe: () => Promise<void>;
  onHint: (listener: (hint: HostStreamHint) => void) => (() => void);
  onReconnect: (listener: () => void) => (() => void);
}
export interface HostSessionCallbacks {
  onEvent: (event: HostSessionEvent) => Promise<void>;
  onCaughtUp: () => Promise<void>;
  onResumed?: () => Promise<void>;
  onError: (error: Error) => void;
  onHistory?: (hasMore: boolean) => void;
  /** Local reducer boundary; separate from time spent awaiting the history RPC. */
  onHistoryReplay?: (active: boolean) => void;
  onHistoryState?: (loading: boolean, failed: boolean) => void;
  /** The host restarted the stream; drop derived state before the latest page is replayed. */
  onGap?: (reason: string) => Promise<void>;
}

/** Decrypted body of a `device_event` RPC frame. */
export interface HostStreamHintPlaintext { cmd?: string; event?: string; payload?: HostStreamHintPayload; }
export interface HostStreamHintPayload { stream_id?: string; epoch?: number; cursor?: number; }

/** Text an older host answers `read_stream` with; there is no capability bit on that path. */
export function isUnknownStreamCommandRejection(message: string): boolean {
  return message.indexOf('invalid RPC command') >= 0 || message.indexOf('unknown variant') >= 0 ||
    message.indexOf('Could not parse device command') >= 0;
}

export class HostStreamUnsupportedError extends Error {
  constructor(message: string) { super(message); this.name = 'HostStreamUnsupportedError'; }
}

/** Parses a decrypted `device_event` plaintext; undefined for anything that is not a stream hint. */
export function parseHostStreamHint(sourceDeviceId: string, plaintext: HostStreamHintPlaintext): HostStreamHint | undefined {
  if (plaintext.cmd !== 'device_event' || plaintext.event !== HOST_STREAM_CHANGED_EVENT) return undefined;
  const payload = plaintext.payload;
  if (!payload || typeof payload.stream_id !== 'string' || typeof payload.epoch !== 'number' ||
    typeof payload.cursor !== 'number') return undefined;
  return { sourceDeviceId: sourceDeviceId, streamId: payload.stream_id, epoch: payload.epoch, cursor: payload.cursor };
}

/** The part of a host record this reader needs: the turn it belongs to. */
interface HostStreamTurnHeader { turnId?: string; }
interface HostStreamRecordTurn { turn?: HostStreamTurnHeader; }

/**
 * The turn a stream event belongs to, for the reader's "is this older than what
 * the caller already has" check. `session-record` payloads always carry
 * `turn.turnId`; control events belong to no turn and are ignored.
 */
export function hostStreamEventTurnId(event: HostStreamEventWire): string | undefined {
  if (event.event !== 'session-record') return undefined;
  const turnId = (event.payload as HostStreamRecordTurn).turn?.turnId;
  return typeof turnId === 'string' ? turnId : undefined;
}

/** Rejects a page the host did not accept and asserts it answers this stream. */
export function checkHostStreamPage(streamId: string, page: HostStreamPage): HostStreamPage {
  if (page.resp === 'error') {
    const message = page.message || 'Remote device command failed.';
    if (isUnknownStreamCommandRejection(message)) throw new HostStreamUnsupportedError(message);
    throw new Error(message);
  }
  if (page.resp !== undefined && page.resp !== 'stream_page') throw new Error(`Unexpected stream response: ${page.resp}`);
  if (page.stream_id !== streamId || !Number.isSafeInteger(page.epoch) || !Number.isSafeInteger(page.cursor) ||
    !Array.isArray(page.events) || typeof page.has_more !== 'boolean') throw new Error('Invalid stream page');
  for (const event of page.events) {
    if (!Number.isSafeInteger(event.seq) || typeof event.event !== 'string') throw new Error('Invalid stream event');
  }
  return page;
}

/**
 * Controller-side reader of one host-owned stream.
 *
 * Wire contract shared with `remote_connect/host_stream.rs` and the Web
 * `HostStream.ts`: every page is read from the online desktop (`read_stream`),
 * and the desktop pushes `host-stream-changed` hints naming only the stream,
 * its epoch and newest sequence. The relay forwards ciphertext and stores
 * nothing; this stream keeps no cache either, so closing it forgets the
 * transcript. One reader runs at a time; hints, reconnects, the keepalive and
 * history requests share that lane so pages never interleave.
 */
export class HostSessionStream {
  private stopped: boolean = false;
  private running: boolean = false;
  private dirty: boolean = true;
  private resumed: boolean = true;
  private initialized: boolean = false;
  private epoch: number = 0;
  private cursor: number = 0;
  private oldest: number = 1;
  private hasOlder: boolean = false;
  private truncated: boolean = false;
  /** Turns already emitted to the caller, i.e. already part of the transcript. */
  private emittedTurns: Set<string> = new Set<string>();
  private historyRequested: boolean = false;
  private retryTimer: number = -1;
  private keepaliveTimer: number = -1;
  private retryMs: number = 1000;
  private unsubscribeHint: () => void;
  private unsubscribeReconnect: () => void;

  private streamId: string;
  private source: HostSessionSource;
  private callbacks: HostSessionCallbacks;

  constructor(streamId: string, source: HostSessionSource, callbacks: HostSessionCallbacks) {
    this.streamId = streamId;
    this.source = source;
    this.callbacks = callbacks;
    this.unsubscribeHint = source.onHint((hint: HostStreamHint) => {
      if (hint.sourceDeviceId !== this.source.target || hint.streamId !== this.streamId) return;
      if (this.initialized && hint.epoch === this.epoch && hint.cursor <= this.cursor) return;
      this.wake();
    });
    this.unsubscribeReconnect = source.onReconnect(() => { this.resumed = true; this.wake(); });
    this.keepaliveTimer = setInterval(() => { this.wake(); }, HOST_STREAM_KEEPALIVE_MS);
    this.wake();
  }

  isClosed(): boolean { return this.stopped; }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribeHint();
    this.unsubscribeReconnect();
    if (this.retryTimer !== -1) clearTimeout(this.retryTimer);
    if (this.keepaliveTimer !== -1) clearInterval(this.keepaliveTimer);
    this.retryTimer = -1;
    this.keepaliveTimer = -1;
    // Best effort: the host also drops idle subscriptions on its own.
    if (this.initialized) this.source.unsubscribe().catch((): void => {});
  }

  loadOlder(): void {
    if (this.stopped || !this.hasOlder || this.historyRequested) return;
    this.historyRequested = true;
    this.callbacks.onHistoryState?.(true, false);
    if (!this.running) void this.catchUp();
  }

  wake(): void {
    if (this.stopped) return;
    this.dirty = true;
    if (this.retryTimer !== -1) { clearTimeout(this.retryTimer); this.retryTimer = -1; }
    if (!this.running) void this.catchUp();
  }

  private async read(request: HostStreamReadRequest): Promise<HostStreamPage> {
    let page: HostStreamPage;
    try {
      page = await this.source.read(request);
    } catch (error) {
      // The transport surfaces the host's `resp: 'error'` as a thrown Error;
      // an older host rejects `read_stream` as an unknown command there.
      const failure = error instanceof Error ? error : new Error(String(error));
      if (isUnknownStreamCommandRejection(failure.message)) throw new HostStreamUnsupportedError(failure.message);
      throw failure;
    }
    return checkHostStreamPage(this.streamId, page);
  }

  private async emitPage(page: HostStreamPage): Promise<void> {
    for (const event of page.events) {
      if (this.stopped) return;
      await this.callbacks.onEvent({ session_id: this.streamId, event: event.event, payload: event.payload });
      const turnId = hostStreamEventTurnId(event);
      if (turnId !== undefined) this.emittedTurns.add(turnId);
    }
  }

  /** Latest page first, like opening a chat at its bottom. */
  private async resync(): Promise<void> {
    const page = await this.read({});
    if (this.stopped) return;
    this.epoch = page.epoch;
    this.cursor = page.cursor;
    this.oldest = page.events.length > 0 ? page.events[0].seq : page.cursor + 1;
    this.hasOlder = page.has_more;
    this.truncated = page.truncated === true;
    this.initialized = true;
    await this.emitPage(page);
    this.callbacks.onHistory?.(this.hasOlder);
  }

  /** False when the host restarted the stream and a resync is required. */
  private async forward(): Promise<boolean> {
    while (!this.stopped) {
      const page = await this.read({ after: this.cursor, epoch: this.epoch });
      if (this.stopped) return true;
      if (page.epoch !== this.epoch) return false;
      await this.emitPage(page);
      if (page.events.length > 0) this.cursor = Math.max(this.cursor, page.events[page.events.length - 1].seq);
      if (!page.has_more) {
        // The newest sequence may belong to an evicted control event; adopt it
        // so the next hint compares against the host's view.
        this.cursor = Math.max(this.cursor, page.cursor);
        return true;
      }
    }
    return true;
  }

  private async gap(): Promise<void> {
    await this.callbacks.onGap?.('host stream restarted');
  }

  private async older(): Promise<void> {
    let pages = 0;
    try {
      while (this.hasOlder && pages < MAX_HISTORY_PAGES_PER_REQUEST && !this.stopped) {
        const before = this.oldest;
        RemoteLogger.info(`history page request stream=${this.streamId} before=${before} epoch=${this.epoch}`);
        const page = await this.read({ before: before, epoch: this.epoch });
        RemoteLogger.info(`history page received stream=${this.streamId} before=${before} events=${page.events.length} first=${page.events[0]?.seq} hasMore=${page.has_more} epoch=${page.epoch}`);
        if (this.stopped) return;
        if (page.epoch !== this.epoch) {
          await this.gap();
          await this.resync();
          throw new Error('Session history restarted on the host; reloaded from its latest page');
        }
        // A page that only repeats turns the transcript already has is not
        // progress: keep reading until the caller gets an older turn, the host
        // runs out of history, or this request's budget is spent.
        const showsAnOlderTurn = page.events.some((event) => {
          const turnId = hostStreamEventTurnId(event);
          return turnId !== undefined && !this.emittedTurns.has(turnId);
        });
        if (pages === 0) this.callbacks.onHistoryReplay?.(true);
        await this.emitPage(page);
        if (page.events.length > 0) this.oldest = page.events[0].seq;
        this.hasOlder = page.has_more;
        this.truncated = page.truncated === true;
        pages++;
        if (showsAnOlderTurn) break;
      }
    } finally {
      if (pages > 0) this.callbacks.onHistory?.(this.hasOlder);
      this.callbacks.onHistoryReplay?.(false);
    }
  }

  private async catchUp(): Promise<void> {
    this.running = true;
    try {
      while ((this.dirty || this.historyRequested) && !this.stopped) {
        if (this.dirty) {
          this.dirty = false;
          if (this.resumed && this.initialized) { await this.callbacks.onResumed?.(); }
          if (!this.initialized) {
            await this.resync();
          } else if (!(await this.forward())) {
            await this.gap();
            await this.resync();
          }
          if (this.stopped) return;
          this.resumed = false;
          await this.callbacks.onCaughtUp();
        }
        if (this.historyRequested && !this.stopped) {
          await this.older(); this.historyRequested = false;
          this.callbacks.onHistoryState?.(false, false);
        }
        this.retryMs = 1000;
      }
    } catch (error) {
      if (this.stopped) return;
      if (this.historyRequested) { this.historyRequested = false; this.callbacks.onHistoryState?.(false, true); }
      if (error instanceof HostStreamUnsupportedError) {
        // Nothing on this side can make an older host answer; stop instead of
        // polling it every 30 seconds.
        this.callbacks.onError(error as Error);
        this.close();
        return;
      }
      this.dirty = true;
      this.callbacks.onError(error as Error);
      this.retryTimer = setTimeout(() => { this.retryTimer = -1; this.wake(); }, this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 30000);
    } finally {
      this.running = false;
      if ((this.dirty || this.historyRequested) && !this.stopped && this.retryTimer === -1) void this.catchUp();
    }
  }
}
