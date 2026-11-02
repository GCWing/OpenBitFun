/** Controller-side reader of one host-owned stream.
 *
 * Wire contract shared with `remote_connect/host_stream.rs`: every page is read
 * from the online host over pairwise-encrypted device RPC (`read_stream`), and
 * the host pushes `host-stream-changed` hints naming only the stream, its
 * epoch and newest sequence. The Relay forwards ciphertext and stores nothing;
 * this client keeps no cache either, so closing it forgets the transcript. */

export const HOST_CATALOG_ID = '@host/catalog';
export const HOST_STREAM_CHANGED_EVENT = 'host-stream-changed';
export const REMOTE_CAPABILITY_HOST_STREAM_V1 = 'host_stream_v1';
export const UNSUPPORTED_HOST_MESSAGE = 'The controlled device runs an older OpenBitFun version that does not support on-demand session streaming. Update OpenBitFun on that device to continue.';
/** Hosts keep hint subscriptions alive for 10 minutes; renew well before. */
const KEEPALIVE_MS = 4 * 60 * 1000;

/** How many pages one history request may read while it has not yet shown the
 * reader anything it did not already have.
 *
 * Host pages are cut by sequence, and a record's sequence is the moment it was
 * last updated, so one long turn owns every record it produced: a page of
 * history can be nothing but more records of the turn that is already on
 * screen. Reading exactly one page per request then looks like "history loaded"
 * while the transcript above stayed the same. The budget keeps that walk bounded
 * (a request is a user gesture, not an unbounded download); the next request
 * continues from where this one stopped. Mirrors `MAX_HISTORY_PAGES_PER_REQUEST`
 * in the mobile core transport. */
const MAX_HISTORY_PAGES_PER_REQUEST = 4;

export interface StreamEvent { seq: number; event: string; payload: unknown }
export interface StreamPage {
  stream_id: string;
  epoch: number;
  events: StreamEvent[];
  has_more: boolean;
  cursor: number;
  oldest_seq: number;
  truncated: boolean;
}
export interface StreamReadRequest {
  stream_id: string;
  after?: number;
  before?: number;
  epoch?: number;
  limit?: number;
  subscribe: boolean;
}
export interface StreamHint { sourceDeviceId: string; stream_id: string; epoch: number; cursor: number }

/** The turn a stream event belongs to, for the reader's "is this older than what
 * the caller already has" check. `session-record` payloads always carry
 * `turn.turnId`; control events belong to no turn and are ignored. */
export function streamEventTurnId(event: StreamEvent): string | null {
  if (event.event !== 'session-record') return null;
  const turn = (event.payload as { turn?: { turnId?: unknown } } | undefined)?.turn;
  return typeof turn?.turnId === 'string' ? turn.turnId : null;
}

/** Event as consumed by product reducers; `session_id` is the stream id. */
export interface SessionEvent { session_id: string; event: string; payload: unknown }
export interface SessionHistoryState { hasMore: boolean; oldestSeq: number; cursor: number; truncated: boolean }
export interface SessionStreamHandle { close(): void; wake(): void; loadOlder(): Promise<void> }

/** Host-facing calls of one reader; production is encrypted device RPC. */
export interface HostStreamTransport {
  readStream(request: StreamReadRequest): Promise<StreamPage>;
  unsubscribeStream(streamId: string): Promise<void>;
}
/** Wake sources: decrypted hints and connection recoveries. */
export interface HostStreamSignals {
  onHint(listener: (hint: StreamHint) => void): () => void;
  onReconnect(listener: () => void): () => void;
}

export interface HostStreamOptions {
  transport: HostStreamTransport;
  signals: HostStreamSignals;
  /** Device id of the host whose hints apply to this reader. */
  target: string;
  streamId: string;
  onEvent: (event: SessionEvent) => void;
  onError: (error: unknown) => void;
  /** Called after every completed catch-up, including the opening page. */
  onCaughtUp?: () => void;
  onHistoryState?: (state: SessionHistoryState) => void;
  /** Called on every wake that re-reads the host (hint, reconnect, visibility). */
  onResumed?: () => void;
  /** The host restarted the stream; consumers must drop derived state before
   * the latest page is replayed through `onEvent`. */
  onGap?: (reason: string) => void;
  /** Page visibility owner; defaults to `document` when present. */
  visibility?: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'> | null;
}

/** Map an older host's "unknown command" rejection to an actionable message. */
export function describeHostStreamError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (text.includes('invalid RPC command') || text.includes('unknown variant') || text.includes('Could not parse device command')) {
    return UNSUPPORTED_HOST_MESSAGE;
  }
  return text;
}

export function parseStreamHint(sourceDeviceId: string, event: string, payload: unknown): StreamHint | null {
  if (event !== HOST_STREAM_CHANGED_EVENT || !payload || typeof payload !== 'object') return null;
  const hint = payload as { stream_id?: unknown; epoch?: unknown; cursor?: unknown };
  if (typeof hint.stream_id !== 'string' || typeof hint.epoch !== 'number' || typeof hint.cursor !== 'number') return null;
  return { sourceDeviceId, stream_id: hint.stream_id, epoch: hint.epoch, cursor: hint.cursor };
}

export function parseStreamPage(value: unknown): StreamPage {
  const page = value as Partial<StreamPage> & { resp?: unknown; message?: unknown };
  if (!page || typeof page !== 'object') throw new Error('Invalid stream page');
  if (page.resp === 'error') throw new Error(typeof page.message === 'string' ? page.message : 'Remote error');
  if (page.resp !== undefined && page.resp !== 'stream_page') throw new Error(`Unexpected stream response: ${String(page.resp)}`);
  if (typeof page.stream_id !== 'string' || !Number.isSafeInteger(page.epoch) || !Array.isArray(page.events)
    || typeof page.has_more !== 'boolean' || !Number.isSafeInteger(page.cursor) || !Number.isSafeInteger(page.oldest_seq)) {
    throw new Error('Invalid stream page');
  }
  for (const event of page.events) {
    const item = event as Partial<StreamEvent>;
    if (!item || typeof item !== 'object' || !Number.isSafeInteger(item.seq) || typeof item.event !== 'string' || !('payload' in item)) {
      throw new Error('Invalid stream event');
    }
  }
  return {
    stream_id: page.stream_id, epoch: page.epoch!, events: page.events as StreamEvent[], has_more: page.has_more!,
    cursor: page.cursor!, oldest_seq: page.oldest_seq!, truncated: page.truncated === true,
  };
}

class Reader {
  epoch = 0;
  cursor = 0;
  oldest = 1;
  hasMore = false;
  truncated = false;
  /** Turns already emitted to the caller, i.e. already part of the transcript. */
  private readonly emittedTurns = new Set<string>();
  constructor(private readonly options: HostStreamOptions) {}

  private async read(request: Omit<StreamReadRequest, 'stream_id' | 'subscribe'>): Promise<StreamPage> {
    const page = await this.options.transport.readStream({ stream_id: this.options.streamId, subscribe: true, ...request });
    if (page.stream_id !== this.options.streamId) throw new Error('Stream page identity mismatch');
    return page;
  }
  private emitPage(page: StreamPage): void {
    for (const event of page.events) {
      this.options.onEvent({ session_id: this.options.streamId, event: event.event, payload: event.payload });
      const turnId = streamEventTurnId(event);
      if (turnId !== null) this.emittedTurns.add(turnId);
    }
  }
  private emitHistory(): void {
    this.options.onHistoryState?.({ hasMore: this.hasMore, oldestSeq: this.oldest, cursor: this.cursor, truncated: this.truncated });
  }
  /** Latest page first, like opening a chat at its bottom. */
  async resync(): Promise<void> {
    const page = await this.read({});
    this.epoch = page.epoch;
    this.cursor = page.cursor;
    this.oldest = page.events[0]?.seq ?? page.cursor + 1;
    this.hasMore = page.has_more;
    this.truncated = page.truncated;
    this.emitPage(page);
    this.emitHistory();
  }
  /** False when the host restarted the stream and a resync is required. */
  private async catchUp(): Promise<boolean> {
    for (;;) {
      const page = await this.read({ after: this.cursor, epoch: this.epoch });
      if (page.epoch !== this.epoch) return false;
      this.emitPage(page);
      const last = page.events[page.events.length - 1];
      if (last) this.cursor = Math.max(this.cursor, last.seq);
      if (!page.has_more) {
        // The newest sequence may belong to an evicted control event; adopt
        // it so the next hint compares against the host's view.
        this.cursor = Math.max(this.cursor, page.cursor);
        return true;
      }
    }
  }
  async refresh(): Promise<void> {
    if (await this.catchUp()) return;
    this.options.onGap?.('host stream restarted');
    await this.resync();
  }
  async loadOlder(): Promise<void> {
    let pages = 0;
    while (this.hasMore && pages < MAX_HISTORY_PAGES_PER_REQUEST) {
      const page = await this.read({ before: this.oldest, epoch: this.epoch });
      if (page.epoch !== this.epoch) {
        this.options.onGap?.('host stream restarted');
        await this.resync();
        throw new Error('Session history restarted on the host; reloaded from its latest page');
      }
      // A page that only repeats turns the transcript already has is not
      // progress: keep reading until the caller gets an older turn, the host
      // runs out of history, or this request's budget is spent.
      const showsAnOlderTurn = page.events.some(event => {
        const turnId = streamEventTurnId(event);
        return turnId !== null && !this.emittedTurns.has(turnId);
      });
      this.emitPage(page);
      if (page.events[0]) this.oldest = page.events[0].seq;
      this.hasMore = page.has_more;
      this.truncated = page.truncated;
      pages++;
      if (showsAnOlderTurn) break;
    }
    // One settled report for the whole request: the caller asked once, so it
    // hears one history state, not one per page.
    if (pages > 0) this.emitHistory();
  }
  hintIsNew(hint: StreamHint): boolean {
    return hint.sourceDeviceId === this.options.target && hint.stream_id === this.options.streamId
      && (hint.epoch !== this.epoch || hint.cursor > this.cursor);
  }
}

/** Open one host stream. The first page is awaited so an offline or older
 * host fails the call instead of retrying silently in the background. */
export async function openHostStream(options: HostStreamOptions): Promise<SessionStreamHandle> {
  const reader = new Reader(options);
  let active = true;
  try { await reader.resync(); } catch (error) { throw new Error(describeHostStreamError(error)); }
  options.onCaughtUp?.();

  // One reader in flight and one dirty successor (Happy InvalidateSync);
  // older-page requests share the same lane so pages never interleave.
  let dirty = false;
  let running: Promise<void> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let retryDelay = 1000;
  const olderRequests: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  const drain = async () => {
    while (active && (dirty || olderRequests.length)) {
      if (dirty) {
        dirty = false;
        await reader.refresh();
        if (active) options.onCaughtUp?.();
      }
      const older = olderRequests.shift();
      if (!older) continue;
      try { await reader.loadOlder(); older.resolve(); } catch (error) { older.reject(error); }
    }
  };
  const wake = () => {
    if (!active || running || retry) return;
    running = drain().then(() => { retryDelay = 1000; }).catch(error => {
      if (!active) return;
      dirty = true;
      retry = setTimeout(() => { retry = null; wake(); }, retryDelay);
      retryDelay = Math.min(30000, retryDelay * 2);
      options.onError(new Error(describeHostStreamError(error)));
    }).finally(() => {
      running = null;
      if (active && (dirty || olderRequests.length) && !retry) wake();
    });
  };
  const invalidate = () => { if (!active) return; dirty = true; wake(); };
  const resumed = () => { if (!active) return; options.onResumed?.(); invalidate(); };

  const stopHints = options.signals.onHint(hint => { if (active && reader.hintIsNew(hint)) invalidate(); });
  const stopReconnect = options.signals.onReconnect(resumed);
  const keepalive = setInterval(invalidate, KEEPALIVE_MS);
  const visibility = options.visibility === undefined ? (typeof document === 'undefined' ? null : document) : options.visibility;
  const onVisible = () => { if (visibility?.visibilityState === 'visible') resumed(); };
  visibility?.addEventListener('visibilitychange', onVisible);

  return {
    close() {
      if (!active) return;
      active = false;
      stopHints(); stopReconnect(); clearInterval(keepalive);
      visibility?.removeEventListener('visibilitychange', onVisible);
      if (retry) clearTimeout(retry);
      for (const older of olderRequests.splice(0)) older.reject(new Error('Session stream closed'));
      void options.transport.unsubscribeStream(options.streamId).catch(() => {});
    },
    wake: invalidate,
    loadOlder() {
      if (!active) return Promise.resolve();
      return new Promise<void>((resolve, reject) => { olderRequests.push({ resolve, reject }); wake(); });
    },
  };
}
