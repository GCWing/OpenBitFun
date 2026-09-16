import { CommandStatusResponse } from '../model/RemoteModels';
import { Encoding } from './Encoding';

export interface SessionKeyGrant extends CommandStatusResponse {
  session_id: string;
  relay_session_id: string;
  key: string;
}
export interface DurableSessionEvent { session_id: string; event: string; payload: Object; }
export interface SessionCiphertext { nonce: string; data: string; }
interface SessionContent { t: string; c: string; }
interface SessionMessage { seq: number; content: SessionContent; }
export interface SessionMessagePage { messages: SessionMessage[]; hasMore: boolean; }
interface SessionFragment { v: number; eventId: string; index: number; count: number; data: string; }
interface SessionUpdateBody { sid?: string; message?: SessionMessage; }
interface SessionUpdate { body?: SessionUpdateBody; }
export interface DurableSessionSource {
  grant: () => Promise<SessionKeyGrant>;
  read: (relayId: string, after: number) => Promise<SessionMessagePage>;
  readBefore?: (relayId: string, before: number) => Promise<SessionMessagePage>;
  decrypt: (content: SessionCiphertext, key: string) => Promise<DurableSessionEvent>;
  onUpdate: (listener: (event: string, data: Object) => void) => (() => void);
  onReconnect: (listener: () => void) => (() => void);
}
export interface DurableSessionCallbacks {
  onEvent: (event: DurableSessionEvent) => Promise<void>;
  onCaughtUp: () => Promise<void>;
  onResumed?: () => Promise<void>;
  onError: (error: Error) => void;
  onHistory?: (hasMore: boolean) => void;
  onHistoryState?: (loading: boolean, failed: boolean) => void;
}

/** Account WS provides wakeups; the encrypted durable log is the authority.
 * A stream has one catch-up worker and only commits a cursor after application.
 * Disconnects never clear the cursor or replay mutations. */
export class DurableSessionStream {
  private resumed: boolean = true;
  private stopped: boolean = false;
  private running: boolean = false;
  private dirty: boolean = false;
  private grant?: SessionKeyGrant;
  private readSeq: number = 0;
  private initialized: boolean = false;
  private oldestSeq: number = 0;
  private hasOlder: boolean = false;
  private historyRequested: boolean = false;
  private committedSeq: number = 0;
  private fragmentId: string = '';
  private fragmentCount: number = 0;
  private fragments: Uint8Array[] = [];
  private pending: Map<number, SessionMessage> = new Map();
  private retryTimer: number = -1;
  private historyPrefetchTimer: number = -1;
  private retryMs: number = 1000;
  private unsubscribeUpdate: () => void;
  private unsubscribeReconnect: () => void;

  private logicalId: string;
  private source: DurableSessionSource;
  private callbacks: DurableSessionCallbacks;

  constructor(logicalId: string, source: DurableSessionSource, callbacks: DurableSessionCallbacks) {
    this.logicalId = logicalId;
    this.source = source;
    this.callbacks = callbacks;
    this.unsubscribeUpdate = source.onUpdate((_event: string, data: Object) => {
      const update = data as SessionUpdate;
      if (!this.grant) { this.wake(); return; }
      if (update.body?.sid !== this.grant.relay_session_id) return;
      const message = update.body.message;
      if (!message) { this.wake(); return; }
      if (message.seq <= this.readSeq) return;
      this.pending.set(message.seq, message);
      if (message.seq > this.readSeq + 1 && !this.pending.has(this.readSeq + 1)) this.dirty = true;
      if (!this.running && !this.stopped) this.catchUp();
    });
    this.unsubscribeReconnect = source.onReconnect(() => { this.resumed = true; this.wake(); });
    this.wake();
  }

  isClosed(): boolean { return this.stopped; }

  close(): void {
    this.stopped = true;
    this.unsubscribeUpdate();
    this.unsubscribeReconnect();
    if (this.retryTimer !== -1) clearTimeout(this.retryTimer);
    this.cancelHistoryPrefetch();
    this.fragments = [];
    this.pending.clear();
    this.grant = undefined;
  }

  loadOlder(): void {
    if (this.stopped || !this.hasOlder) return;
    this.cancelHistoryPrefetch();
    if (this.historyRequested) {
      if (this.retryTimer !== -1) {
        clearTimeout(this.retryTimer); this.retryTimer = -1;
        this.callbacks.onHistoryState?.(true, false); this.wake();
      }
      return;
    }
    this.historyRequested = true;
    this.callbacks.onHistoryState?.(true, false);
    if (!this.running) this.catchUp();
  }

  private cancelHistoryPrefetch(): void {
    if (this.historyPrefetchTimer !== -1) clearTimeout(this.historyPrefetchTimer);
    this.historyPrefetchTimer = -1;
  }

  private scheduleHistoryPrefetch(): void {
    if (this.stopped || !this.hasOlder || this.historyRequested ||
      this.historyPrefetchTimer !== -1 || this.logicalId === '@host/catalog') return;
    // Match mobile-web: render the newest page first, then use the same
    // serialized history request for background prefetch and user scrolls.
    this.historyPrefetchTimer = setTimeout(() => {
      this.historyPrefetchTimer = -1;
      this.loadOlder();
    }, 250);
  }

  private async backward(before: number): Promise<SessionMessagePage> {
    if (!this.source.readBefore || !this.grant) throw new Error('History pagination is unavailable');
    let page = await this.source.readBefore(this.grant.relay_session_id, before);
    let rows = page.messages.slice().sort((a: SessionMessage, b: SessionMessage) => a.seq - b.seq);
    if (rows.length > 0 && rows[rows.length - 1].seq >= before) throw new Error('History pagination did not advance');
    // A wire page may start in the middle of a large record. Fetch only its
    // missing prefix before applying; never discard a partial event.
    while (rows.length > 0) {
      const first = Encoding.parseJsonObject<SessionFragment>(rows[0].content.c);
      if (first.index === 0) break;
      if (!page.hasMore) throw new Error('Session history has an incomplete fragment prefix');
      const boundary = rows[0].seq;
      page = await this.source.readBefore(this.grant.relay_session_id, boundary);
      if (page.messages.length === 0) throw new Error('Session history pagination stalled');
      if (page.messages.some((message: SessionMessage): boolean => message.seq >= boundary)) {
        throw new Error('History pagination did not advance');
      }
      rows = page.messages.concat(rows).sort((a: SessionMessage, b: SessionMessage) => a.seq - b.seq);
    }
    return { messages: rows, hasMore: page.hasMore };
  }

  private async applyHistory(initial: boolean): Promise<void> {
    const page = await this.backward(initial ? Number.MAX_SAFE_INTEGER : this.oldestSeq);
    if (this.stopped) return;
    const savedFragments = this.fragments;
    const savedId = this.fragmentId;
    const savedCount = this.fragmentCount;
    if (!initial) { this.fragments = []; this.fragmentId = ''; this.fragmentCount = 0; }
    try {
      let previous = page.messages.length > 0 ? page.messages[0].seq - 1 : 0;
      if (initial) { this.readSeq = previous; this.committedSeq = previous; }
      for (const message of page.messages) {
        if (message.seq !== previous + 1) throw new Error('Session history sequence gap');
        await this.apply(message);
        if (this.stopped) return;
        previous = message.seq;
        if (initial) {
          this.readSeq = message.seq;
          if (this.fragments.length === 0) this.committedSeq = message.seq;
        }
      }
      if (!initial && this.fragments.length > 0) throw new Error('Session history has an incomplete event tail');
      if (page.messages.length > 0) this.oldestSeq = page.messages[0].seq;
      this.hasOlder = page.hasMore;
      this.callbacks.onHistory?.(this.hasOlder);
    } finally {
      if (!initial) { this.fragments = savedFragments; this.fragmentId = savedId; this.fragmentCount = savedCount; }
    }
  }

  wake(): void {
    if (this.stopped) return;
    this.dirty = true;
    if (this.retryTimer !== -1) { clearTimeout(this.retryTimer); this.retryTimer = -1; }
    if (!this.running) this.catchUp();
  }

  private async catchUp(): Promise<void> {
    this.running = true;
    try {
      while ((this.dirty || this.pending.size > 0 || this.historyRequested) && !this.stopped) {
        if (!this.grant) {
          const grant = await this.source.grant();
          if (this.stopped) return;
          if (grant.session_id !== this.logicalId || !grant.relay_session_id || Encoding.base64ToBytes(grant.key).length !== 32) {
            throw new Error('Invalid session key grant');
          }
          this.grant = grant;
        }
        if (!this.initialized) {
          if (this.source.readBefore) {
            this.dirty = false;
            await this.applyHistory(true);
          }
          this.initialized = true;
          this.pending.forEach((_message: SessionMessage, seq: number) => { if (seq <= this.readSeq) this.pending.delete(seq); });
        }
        let next = this.pending.get(this.readSeq + 1);
        while (next && !this.stopped) {
          await this.apply(next);
          if (this.stopped) return;
          this.readSeq = next.seq;
          if (this.fragments.length === 0) this.committedSeq = this.readSeq;
          this.pending.delete(next.seq);
          next = this.pending.get(this.readSeq + 1);
        }
        let more = this.dirty;
        this.dirty = false;
        while (more && !this.stopped) {
          const page = await this.source.read(this.grant.relay_session_id, this.readSeq);
          if (this.stopped) return;
          for (const message of page.messages) {
            if (this.stopped) return;
            if (message.seq <= this.readSeq) continue;
            if (message.seq !== this.readSeq + 1) throw new Error('Session log sequence gap');
            await this.apply(message);
            if (this.stopped) return;
            this.pending.delete(message.seq);
            this.readSeq = message.seq;
            if (this.fragments.length === 0) this.committedSeq = this.readSeq;
          }
          more = page.hasMore;
          if (more && page.messages.length === 0) throw new Error('Session log returned an empty continuation');
        }
        if (this.historyRequested) {
          this.callbacks.onHistoryState?.(true, false);
          await this.applyHistory(false); this.historyRequested = false;
          this.callbacks.onHistoryState?.(false, false);
        }
        if (this.pending.size > 0 && !this.pending.has(this.readSeq + 1)) throw new Error('Session log sequence gap');
        if (!this.stopped && this.fragments.length === 0) {
          if (this.resumed) { await this.callbacks.onResumed?.(); this.resumed = false; }
          await this.callbacks.onCaughtUp();
          this.scheduleHistoryPrefetch();
        }
        this.retryMs = 1000;
      }
    } catch (error) {
      if (!this.stopped) {
        this.cancelHistoryPrefetch();
        if (this.historyRequested) this.callbacks.onHistoryState?.(false, true);
        this.dirty = true;
        this.pending.clear();
        this.readSeq = this.committedSeq;
        this.fragments = [];
        this.fragmentId = '';
        this.callbacks.onError(error as Error);
        this.retryTimer = setTimeout(() => { this.retryTimer = -1; this.wake(); }, this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, 30000);
      }
    } finally {
      this.running = false;
      if ((this.dirty || this.pending.size > 0 || this.historyRequested) && !this.stopped && this.retryTimer === -1) this.wake();
    }
  }

  private async apply(message: SessionMessage): Promise<void> {
    if (message.content.t !== 'encrypted') throw new Error('Unexpected session content type');
    const fragment = Encoding.parseJsonObject<SessionFragment>(message.content.c);
    if (fragment.v !== 1 || !Number.isSafeInteger(fragment.count) || fragment.count < 1 ||
      fragment.index !== this.fragments.length || (this.fragmentId.length > 0 &&
      (fragment.eventId !== this.fragmentId || fragment.count !== this.fragmentCount))) {
      throw new Error('Invalid session fragment ordering');
    }
    this.fragmentId = fragment.eventId;
    this.fragmentCount = fragment.count;
    this.fragments.push(Encoding.base64ToBytes(fragment.data));
    if (this.fragments.length < this.fragmentCount) return;
    const size = this.fragments.reduce((total: number, bytes: Uint8Array) => total + bytes.length, 0);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of this.fragments) { bytes.set(chunk, offset); offset += chunk.length; }
    const encrypted = Encoding.parseJsonObject<SessionCiphertext>(Encoding.bytesToUtf8(bytes));
    const event = await this.source.decrypt(encrypted, this.grant!.key);
    if (this.stopped) return;
    if (event.session_id !== this.logicalId) throw new Error('Session event identity mismatch');
    await this.callbacks.onEvent(event);
    this.fragments = [];
    this.fragmentId = '';
  }
}
