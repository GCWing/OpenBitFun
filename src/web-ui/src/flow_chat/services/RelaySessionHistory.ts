import { remoteConnectAPI } from '@/infrastructure/api/service-api/RemoteConnectAPI';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import type { SessionRecord } from '../session-stream/SessionRecordReplica';
import { createLogger } from '@/shared/utils/logger';
import { resourceBudget } from '@/shared/utils/resourceBudget';

const log = createLogger('RelaySessionHistory');

/**
 * One frame. `setTimeout`, not `requestAnimationFrame`: a hidden window suspends
 * animation frames, and live records must keep applying while it is hidden.
 */
const RECORD_FLUSH_DELAY_MS = 16;

/**
 * How long opening may wait for the host's first page. Past it, opening fails
 * with a retryable error instead of parking the surface in hydration.
 */
const FIRST_PAGE_TIMEOUT_MS = 15_000;

/** The host did not deliver the first page in time; retrying opens a fresh read. */
export class RelayHistoryFirstPageOverdueError extends Error {
  readonly retryable = true;
  constructor(readonly sessionId: string) {
    super(`Relay session first page overdue: ${sessionId}`);
    this.name = 'RelayHistoryFirstPageOverdueError';
  }
}

/**
 * A session stream opened before its device is rendered: a cross-device open
 * starts it on click, so the host reads the session while the switch runs.
 * Events are buffered until the session's history owner adopts the stream.
 */
interface WarmSessionStream {
  subscription: Promise<string>;
  events: Array<{ kind: 'record' | 'gap' | 'syncError' | 'ready' | 'interaction'; value: unknown }>;
  dispose: () => void;
  timer: ReturnType<typeof setTimeout>;
}

/** A warm stream nobody adopted (the open failed or moved on) closes after this. */
const WARM_STREAM_TTL_MS = 30_000;
const warmStreams = new Map<string, WarmSessionStream>();
const warmKey = (surfaceId: string, sessionId: string) => `${surfaceId}\u0000${sessionId}`;

/** Start reading `sessionId` on `surfaceId` (a peer) before that device is rendered. */
export function prewarmRelaySessionHistory(surfaceId: string, sessionId: string): void {
  const key = warmKey(surfaceId, sessionId);
  if (warmStreams.has(key)) return;
  const events: WarmSessionStream['events'] = [];
  const forThisSession = (value: unknown) => (value as { sessionId?: unknown } | null)?.sessionId === sessionId;
  const disposers = [
    remoteConnectAPI.onSessionRecord(value => { if (forThisSession(value)) events.push({ kind: 'record', value }); }),
    remoteConnectAPI.onSessionGap(value => { if (forThisSession(value)) events.push({ kind: 'gap', value }); }),
    remoteConnectAPI.onSessionSyncError(value => { if (forThisSession(value)) events.push({ kind: 'syncError', value }); }),
    remoteConnectAPI.onSessionReady(value => { if (forThisSession(value)) events.push({ kind: 'ready', value }); }),
    remoteConnectAPI.onSessionInteractionChanged(value => { if (forThisSession(value)) events.push({ kind: 'interaction', value }); }),
  ];
  const subscription = remoteConnectAPI.subscribeSession(surfaceId, sessionId);
  const stream: WarmSessionStream = {
    subscription,
    events,
    dispose: () => disposers.splice(0).forEach(dispose => dispose()),
    timer: setTimeout(() => {
      if (warmStreams.get(key) !== stream) return;
      warmStreams.delete(key);
      stream.dispose();
      void subscription.then(id => remoteConnectAPI.unsubscribeSession(id)).catch(() => undefined);
    }, WARM_STREAM_TTL_MS),
  };
  // A failed warm read is not an error: the owner opens its own stream.
  void subscription.catch(error => {
    if (warmStreams.get(key) !== stream) return;
    warmStreams.delete(key);
    clearTimeout(stream.timer);
    stream.dispose();
    log.debug('Session stream prewarm failed', { sessionId, error });
  });
  warmStreams.set(key, stream);
}

function takeWarmStream(surfaceId: string, sessionId: string): WarmSessionStream | undefined {
  const key = warmKey(surfaceId, sessionId);
  const stream = warmStreams.get(key);
  if (!stream) return undefined;
  warmStreams.delete(key);
  clearTimeout(stream.timer);
  stream.dispose();
  return stream;
}

export interface RelayHistoryReady {
  sessionId: string;
  hasMore: boolean;
  oldestSeq: number;
  cursor: number;
  historyBatches?: boolean;
}

/** One session subscription, shared by opening history and receiving live records. */
export class RelaySessionHistory {
  private readonly scope = getActiveSurfaceScope();
  private readonly listeners: Array<() => void> = [];
  private subscriptionId: string | null = null;
  private closed = false;
  private failed = false;
  private ready: RelayHistoryReady | null = null;
  private resolveReady!: () => void;
  private rejectReady!: (error: unknown) => void;
  private readonly firstPage = new Promise<void>((resolve, reject) => {
    this.resolveReady = resolve;
    this.rejectReady = reject;
  });
  private opening: Promise<void> | null = null;
  private older: Promise<boolean> | null = null;
  private historyTimer: ReturnType<typeof setTimeout> | null = null;
  private pageApplied: (() => void) | null = null;
  private rejectPage: ((error: unknown) => void) | null = null;
  private visible = false;
  private presented = false;
  private prefetchCredit = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  // History enters the replica only at ready. Otherwise direct runtime/mailbox
  // flushes can expose half a Turn even when this owner's timer is disabled.
  private collectingHistory = true;
  private historyRecords: SessionRecord[] = [];
  private readonly fail: (error: unknown) => void;
  private readonly resumeInteraction: (() => Promise<void>) | undefined;
  private readonly warm: WarmSessionStream | undefined;
  private readonly handlers: Partial<Record<WarmSessionStream['events'][number]['kind'], (value: any) => void>> = {};

  /**
   * `onRecord` must only reduce the record: the host sends each record of a page
   * as its own event, so rendering there is quadratic in the items of a long
   * turn. It returns true for a record that cannot wait for the next frame.
   * `onFlush` renders what was reduced. Live pages have no ready event, so the
   * timer is what publishes them; a replayed page flushes before its ready event
   * so a reader never sees ready without records.
   */
  constructor(
    readonly sessionId: string,
    onRecord: (record: SessionRecord) => boolean | void,
    onReady: (ready: RelayHistoryReady) => void,
    onError: (error: unknown) => void,
    onResumed?: () => Promise<void>,
    private readonly onFlush?: () => void,
    onResync?: () => void,
  ) {
    this.fail = error => {
      if (this.failed) return;
      this.failed = true;
      this.rejectReady(error); this.rejectPage?.(error); onError(error);
    };
    this.resumeInteraction = onResumed;
    // Taken before this owner listens, so no event is both buffered and live.
    this.warm = takeWarmStream(this.scope.surfaceId, sessionId);
    // Register before asking Rust to replay its cache or fetch the first page.
    this.listeners.push(remoteConnectAPI.onSessionRecord(this.handlers.record = value => {
      if (!this.isCurrent() || this.failed) return;
      const record = value as SessionRecord;
      if (record.sessionId !== this.sessionId) return;
      try {
        if ((record as SessionRecord & { historyReplay?: boolean }).historyReplay === true
          || (this.collectingHistory && this.ready?.historyBatches !== true)) {
          this.historyRecords.push(record);
          return;
        }
        if (onRecord(record) === true) this.flush();
        else this.scheduleFlush();
      } catch (error) { this.fail(error); }
    }));
    // A restarted host stream replays its latest page under fresh revisions and
    // sends no tombstones for what it dropped (a rollback, undo, or history
    // rewrite). Records already received are rendered first; the replay that
    // follows, up to its ready event, is then the whole truth.
    this.listeners.push(remoteConnectAPI.onSessionGap(this.handlers.gap = gap => {
      if (!this.isCurrent() || gap.sessionId !== this.sessionId || gap.resync !== true) return;
      this.flush();
      this.collectingHistory = true;
      this.historyRecords = [];
      try { onResync?.(); } catch (error) { this.fail(error); }
    }));
    this.listeners.push(remoteConnectAPI.onSessionSyncError(this.handlers.syncError = error => {
      if (!this.isCurrent() || error.sessionId !== this.sessionId || error.targetDeviceId !== this.scope.surfaceId) return;
      // Records received before the failure stay rendered.
      this.flush();
      this.fail(new Error(error.message));
    }));
    this.listeners.push(remoteConnectAPI.onSessionReady(this.handlers.ready = ready => {
      if (!this.isCurrent() || this.failed || ready.sessionId !== this.sessionId) return;
      try {
        for (const record of this.historyRecords) onRecord(record);
        this.historyRecords = [];
        this.collectingHistory = false;
      } catch (error) { this.fail(error); return; }
      if (!this.flush()) return;
      const resumed = this.ready !== null && this.pageApplied === null;
      this.ready = ready;
      if (resumed && onResumed) void onResumed().catch(error => {
        log.warn('Session interaction mailbox refresh failed', { sessionId: this.sessionId, error });
      });
      onReady(ready);
      this.resolveReady();
      this.pageApplied?.();
    }));
    this.listeners.push(remoteConnectAPI.onSessionInteractionChanged(this.handlers.interaction = event => {
      if (!this.isCurrent() || event.sessionId !== this.sessionId || !onResumed) return;
      void onResumed().catch(error => log.warn('Session interaction mailbox refresh failed', {sessionId:this.sessionId,error}));
    }));
    // A closed subscription may never have had an open() caller.
    void this.firstPage.catch(() => {});
    if (typeof document !== 'undefined') {
      const onVisibilityChanged = () => {
        // Hidden windows throttle the flush timer; never leave a returning view stale.
        if (this.flushTimer !== null) this.flush();
        if (document.visibilityState !== 'hidden') this.scheduleHistoryPrefetch();
      };
      document.addEventListener('visibilitychange', onVisibilityChanged);
      this.listeners.push(() => document.removeEventListener('visibilitychange', onVisibilityChanged));
    }
  }

  private isCurrent(): boolean { return !this.closed && this.scope.isCurrent(); }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => this.flush(), RECORD_FLUSH_DELAY_MS);
  }

  private flush(): boolean {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.isCurrent()) return false;
    try { this.onFlush?.(); return true; } catch (error) { this.fail(error); return false; }
  }

  /** Visibility gates optional history IO only; live records/mailboxes stay subscribed. */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (visible) { this.prefetchCredit = 1; this.scheduleHistoryPrefetch(); }
    else {
      this.presented = false;
      if (this.historyTimer !== null) clearTimeout(this.historyTimer);
      this.historyTimer = null;
    }
  }

  /** The viewport's paint acknowledgement, not a timer or mounted lease. */
  markPresented(): void {
    this.presented = true;
    this.scheduleHistoryPrefetch();
  }

  open(): Promise<void> {
    if (!this.opening) this.opening = this.start();
    return this.opening;
  }

  private async start(): Promise<void> {
    this.scope.assertCurrent('open relay session history');
    if (this.closed) throw new Error('Session subscription is closed');
    // History may span several transport pages on an older host. Its blocking
    // interactions must be answerable while the complete Turn is still loading.
    if (this.resumeInteraction) void this.resumeInteraction().catch(error => {
      log.warn('Session interaction mailbox refresh failed', { sessionId: this.sessionId, error });
    });
    try {
      // A stream warmed by the click: what it buffered is applied first, in order.
      const warm = this.warm;
      if (warm) for (const event of warm.events.splice(0)) this.handlers[event.kind]?.(event.value);
      const id = warm
        ? await warm.subscription.catch(() => remoteConnectAPI.subscribeSession(this.scope.surfaceId, this.sessionId))
        : await remoteConnectAPI.subscribeSession(this.scope.surfaceId, this.sessionId);
      if (!this.isCurrent()) {
        await remoteConnectAPI.unsubscribeSession(id);
        this.scope.assertCurrent('finish opening relay session history');
        throw new Error('Session subscription is closed');
      }
      this.subscriptionId = id;
      await this.waitForFirstPage();
      this.scheduleHistoryPrefetch();
    } catch (error) {
      this.rejectReady(error);
      this.close();
      throw error;
    }
  }

  /**
   * A stalled host stream must not park the surface in hydration, and must not
   * be reported as a complete empty history either. Records already received
   * stay rendered, the interaction mailbox is read directly so a blocking
   * question stays answerable, and opening fails with a retryable error.
   */
  private async waitForFirstPage(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const overdue = new Promise<'overdue'>(resolve => {
      timer = setTimeout(() => resolve('overdue'), FIRST_PAGE_TIMEOUT_MS);
    });
    try {
      const outcome = await Promise.race([this.firstPage.then(() => 'ready' as const), overdue]);
      if (outcome === 'ready') return;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
    const error = new RelayHistoryFirstPageOverdueError(this.sessionId);
    if (!this.isCurrent()) throw error;
    log.warn('Relay session first page overdue; failing the open as retryable', { sessionId: this.sessionId });
    this.flush();
    this.fail(error);
    throw error;
  }

  // Warm one adjacent page after a visible open or reader request. Never drain
  // an entire remote transcript merely because its live subscription is open.
  private scheduleHistoryPrefetch(): void {
    if (!this.isCurrent() || !this.visible || !this.presented || this.prefetchCredit === 0
      || !this.ready?.hasMore || this.historyTimer !== null || !resourceBudget.canPrefetch()) return;
    this.historyTimer = setTimeout(() => {
      this.historyTimer = null;
      if (!this.isCurrent() || !this.visible || !this.presented || !resourceBudget.canPrefetch()
        || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
      this.prefetchCredit = 0;
      void this.loadOlder(true).catch(error => {
        log.warn('Session history prefetch stopped', { sessionId: this.sessionId, error });
      });
    }, 250);
  }

  loadOlder(prefetch = false): Promise<boolean> {
    if (!this.older) this.older = this.readOlder().finally(() => {
      this.older = null;
      if (!prefetch) { this.prefetchCredit = 1; this.scheduleHistoryPrefetch(); }
    });
    return this.older;
  }

  private async readOlder(): Promise<boolean> {
    await this.open();
    this.scope.assertCurrent('load older relay history');
    if (!this.ready?.hasMore) return false;
    if (!this.subscriptionId) throw new Error('Session subscription is closed');
    if (this.flushTimer !== null) this.flush();
    this.collectingHistory = true;
    const applied = new Promise<void>((resolve, reject) => { this.pageApplied = resolve; this.rejectPage = reject; });
    try {
      await Promise.all([remoteConnectAPI.loadOlderSession(this.subscriptionId), applied]);
    } catch (error) {
      this.fail(error);
      this.close();
      throw error;
    } finally { this.pageApplied = null; this.rejectPage = null; }
    this.scope.assertCurrent('finish loading older relay history');
    return true;
  }

  close(): void {
    if (this.closed) return;
    // After a surface change the store keeps these pending for the next ready.
    if (this.flushTimer !== null) this.flush();
    if (this.closed) return;
    this.closed = true;
    this.historyRecords = [];
    if (this.historyTimer !== null) clearTimeout(this.historyTimer);
    this.historyTimer = null;
    this.listeners.splice(0).forEach(unlisten => unlisten());
    this.rejectReady(new Error('Session subscription closed'));
    this.rejectPage?.(new Error('Session subscription closed'));
    if (this.subscriptionId) {
      void remoteConnectAPI.unsubscribeSession(this.subscriptionId).catch(error => log.warn('Session unsubscribe failed', { error }));
      this.subscriptionId = null;
    }
  }
}
