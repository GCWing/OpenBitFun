/** One host's queue replica. Timers observe; only the host dispatches work. */
export type QueueStatus = 'queued' | 'blocked' | 'steering_pending' | 'steered'
  | 'started' | 'interrupted' | 'completed' | 'failed' | 'cancelled';
export interface QueueAttachment { kind: string; id: string; metadata: Record<string, unknown> }
export interface QueueMessage {
  turnId: string;
  content: string;
  displayContent?: string;
  agentType: string;
  attachments: QueueAttachment[];
  metadata: Record<string, unknown>;
}
export interface QueueItem {
  turnId: string; displayContent: string; previewTruncated: boolean; attachmentCount: number;
  agentType: string; createdAtMs: number; status: QueueStatus; reason: string | null;
  targetTurnId: string | null; steeringId: string | null;
  /** Optional host-authoritative display receipt; absent on older hosts. */
  steeringDisplay?: { targetTurnId: string; content: string; composerPresentation?: unknown };
}
export interface QueueSnapshot {
  sessionId: string; queueEpoch: string; revision: number; activeTurnId: string | null;
  items: QueueItem[]; supportsReorder?: boolean; capacity: number; used: number; receipt: QueueItem | null;
}
export type QueueAction = { action: 'list' } | { action: 'get'; turnId: string }
  | { action: 'submit'; message: QueueMessage }
  | { action: 'reorder'; turnId: string; beforeTurnId: string | null; operationId: string; expectedRevision: number }
  | { action: 'cancel'; turnId: string; operationId: string }
  | { action: 'promote'; turnId: string; operationId: string; expectedActiveTurnId: string | null };
export type QueueRequest = QueueAction & { sessionId: string; queueEpoch?: string };
export interface QueueOutboxRecord {
  key: string; scope: string; request: QueueRequest; accepted?: boolean; restoreIntent?: boolean; draft?: unknown;
  /**
   * The current queue owner confirmed it has no receipt for this submit: it was
   * not sent, as opposed to an unconfirmed delivery. Additive; older builds
   * ignore it and treat the record as unconfirmed.
   */
  notSubmitted?: boolean;
}
export interface HostDialogQueueOptions {
  /**
   * Whether the session transcript already holds this Turn. A message that
   * already ran needs no delivery recovery, even after the owner restarted.
   */
  hasTurn?: (turnId: string) => boolean;
  /**
   * Resolve unconfirmed submits on refresh by asking the current owner for
   * their receipt. Opt-in so existing callers keep explicit retry recovery.
   */
  resolveUnconfirmed?: boolean;
}
export interface QueueStorage {
  list(scope: string): Promise<QueueOutboxRecord[]>;
  put(record: QueueOutboxRecord): Promise<void>;
  remove(key: string): Promise<void>;
}
/**
 * Receipt reads for one unconfirmed submit back off after each read that found
 * no receipt (or failed), so a long-lived "not sent" record does not cost an
 * RPC on every refresh. Retrying the record starts a new attempt.
 */
const RECEIPT_READ_BASE_DELAY_MS = 5_000;
const RECEIPT_READ_MAX_DELAY_MS = 5 * 60_000;
const DB_NAME = 'openbitfun.host-dialog-queue.v1';
const STORE = 'outbox';
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Queue storage unavailable'));
    request.onblocked = () => reject(new Error('Queue storage is blocked by another browser tab'));
  });
}
async function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error ?? request.error ?? new Error('Queue storage failed'));
      tx.onabort = () => reject(tx.error ?? new Error('Queue storage transaction aborted'));
    });
  } finally { db.close(); }
}
export const queueStorage: QueueStorage = {
  async list(scope) {
    const records = await transaction<QueueOutboxRecord[]>('readonly', store => store.getAll());
    return records.filter(record => record.scope === scope);
  },
  async put(record) { await transaction('readwrite', store => store.put(record)); },
  async remove(key) { await transaction('readwrite', store => store.delete(key)); },
};
export interface QueueView { snapshot: QueueSnapshot | null; error: string | null; pending: QueueOutboxRecord[] }
const newId = (): string => {
  // `crypto.randomUUID` exists only in secure contexts, so a page served over
  // plain HTTP (LAN remote control) or an older WebView must still queue sends.
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
/** A stable queue Turn ID a caller can hold before submitting. */
export const newQueueTurnId = (): string => newId();
function messageIdentity(message: Omit<QueueMessage, 'turnId'>): string {
  // Reopening the composer can allocate fresh image IDs. An ambiguous retry
  // must send the stored payload, including its original IDs, unchanged.
  return JSON.stringify({ ...message, attachments: message.attachments.map(({ kind, metadata }) => ({ kind, metadata })) });
}
export class HostDialogQueue {
  private view: QueueView = { snapshot: null, error: null, pending: [] };
  private listeners = new Set<() => void>();
  private refreshing: Promise<QueueSnapshot> | null = null;
  private mutation: Promise<unknown> = Promise.resolve();
  // Durable outbox entries also exist during healthy RPCs. Only unresolved
  // delivery needs recovery UI; a new page has no live RPCs and shows all of it.
  private inFlight = new Set<string>();
  private pendingRead = 0;
  /** Next allowed receipt read per unconfirmed outbox key. In memory only. */
  private receiptReads = new Map<string, { misses: number; nextAtMs: number }>();
  constructor(readonly scope: string, readonly sessionId: string,
    private invoke: (request: QueueRequest) => Promise<QueueSnapshot>, private storage: QueueStorage = queueStorage,
    private options: HostDialogQueueOptions = {}) {}
  getSnapshot = (): QueueView => this.view;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  };
  private publish(patch: Partial<QueueView>): void {
    this.view = { ...this.view, ...patch }; for (const listener of this.listeners) listener();
  }
  private async publishPending(): Promise<void> {
    const read = ++this.pendingRead;
    const records = await this.storage.list(this.scope);
    if (read !== this.pendingRead) return;
    this.publish({ pending: records.filter(record => !this.inFlight.has(record.key)
      && (!record.accepted || record.restoreIntent)) });
  }
  private accept(snapshot: QueueSnapshot, authoritative: boolean): void {
    if (snapshot.sessionId !== this.sessionId || !snapshot.queueEpoch || !Number.isSafeInteger(snapshot.revision)) {
      throw new Error('Invalid host queue snapshot');
    }
    const previous = this.view.snapshot;
    if (previous && snapshot.queueEpoch !== previous.queueEpoch && !authoritative) return;
    if (previous?.queueEpoch === snapshot.queueEpoch && snapshot.revision < previous.revision) return;
    this.publish({ snapshot, error: null });
  }
  async refresh(): Promise<QueueSnapshot> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.readAndReconcile(true).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  /**
   * Read the owner's queue and reconcile the outbox with it. Receipt reads for
   * unconfirmed submits are optional: a submit only needs the current epoch and
   * must not wait behind recovery of older records.
   */
  private async readAndReconcile(readReceipts: boolean): Promise<QueueSnapshot> {
    try {
      const snapshot = await this.invoke({ sessionId: this.sessionId, action: 'list' });
      this.accept(snapshot, true);
      const records = await this.storage.list(this.scope);
      const current = this.view.snapshot!;
      for (const record of records) {
        if (this.inFlight.has(record.key) || record.restoreIntent || record.request.action !== 'submit') continue;
        const turnId = record.request.message.turnId;
        if (this.options.hasTurn?.(turnId)) {
          // The message already ran; its transcript Turn is the outcome.
          await this.storage.remove(record.key);
          this.receiptReads.delete(record.key);
          continue;
        }
        const listed = current.items.some(item => item.turnId === turnId);
        if (!record.accepted) {
          if (!this.options.resolveUnconfirmed || record.request.queueEpoch !== current.queueEpoch) continue;
          if (listed) {
            // The owner's own list holds the Turn: that is its receipt.
            await this.markAccepted(record);
          } else if (readReceipts && this.receiptReadDue(record.key)) {
            await this.resolveUnconfirmed(record, current.queueEpoch);
          }
          continue;
        }
        if (record.request.queueEpoch !== current.queueEpoch) {
          // A restarted owner cannot vouch for an accepted in-memory message.
          // Preserve the original draft and require an explicit user decision.
          await this.storage.put({ ...record, accepted: false });
        } else if (!listed) {
          await this.storage.remove(record.key);
        }
      }
      await this.publishPending();
      return current;
    } catch (error) { this.publish({ error: String(error) }); throw error; }
  }
  private receiptReadDue(key: string): boolean {
    const next = this.receiptReads.get(key);
    return !next || Date.now() >= next.nextAtMs;
  }
  private deferReceiptRead(key: string): void {
    const misses = (this.receiptReads.get(key)?.misses ?? 0) + 1;
    const delay = Math.min(RECEIPT_READ_BASE_DELAY_MS * 2 ** (misses - 1), RECEIPT_READ_MAX_DELAY_MS);
    this.receiptReads.set(key, { misses, nextAtMs: Date.now() + delay });
  }
  private async markAccepted(record: QueueOutboxRecord): Promise<void> {
    const { notSubmitted: _notSubmitted, ...accepted } = record;
    this.receiptReads.delete(record.key);
    await this.storage.put({ ...accepted, accepted: true });
  }
  /**
   * Ask the owner that issued this epoch for the submit's receipt. A receipt
   * means it was accepted; none means this owner never received it.
   */
  private async resolveUnconfirmed(record: QueueOutboxRecord, queueEpoch: string): Promise<void> {
    if (record.request.action !== 'submit') return;
    const turnId = record.request.message.turnId;
    let result: QueueSnapshot;
    try {
      result = await this.invoke({ sessionId: this.sessionId, queueEpoch, action: 'get', turnId });
    } catch {
      // Still unconfirmed; a later refresh asks again.
      this.deferReceiptRead(record.key);
      return;
    }
    if (result.queueEpoch !== queueEpoch || this.inFlight.has(record.key)) return;
    if (result.receipt?.turnId === turnId) {
      this.accept(result, false);
      await this.markAccepted(record);
      return;
    }
    this.deferReceiptRead(record.key);
    if (!record.notSubmitted) await this.storage.put({ ...record, notSubmitted: true });
  }
  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(run, run);
    this.mutation = result.catch(() => undefined);
    return result;
  }
  private async transmit(sending: QueueOutboxRecord): Promise<QueueSnapshot> {
    // A new attempt reopens the outcome; never carry an older "not sent" fact.
    const { notSubmitted: _notSubmitted, ...record } = sending;
    this.inFlight.add(record.key);
    this.receiptReads.delete(record.key);
    try {
      // The transaction commits before an RPC is permitted to leave this client.
      await this.storage.put(record);
      await this.publishPending();
      const snapshot = await this.invoke(record.request);
      if (snapshot.queueEpoch !== record.request.queueEpoch) throw new Error('queue_scope_expired: host queue owner changed');
      if (record.request.action === 'submit' && snapshot.receipt?.turnId !== record.request.message.turnId) {
        throw new Error('Host did not acknowledge the submitted message');
      }
      this.accept(snapshot, false);
      if (record.request.action === 'submit') await this.storage.put({ ...record, accepted: true });
      else await this.storage.remove(record.key);
      return snapshot;
    } catch (error) {
      const text = String(error);
      if (/queue_conflict:|too_late:|idempotency_conflict:|Message queue is full|Queue is blocked by interrupted/.test(text)) {
        await this.storage.remove(record.key);
      }
      this.publish({ error: text }); throw error;
    } finally {
      this.inFlight.delete(record.key);
      await this.publishPending();
    }
  }
  submit(message: Omit<QueueMessage, 'turnId'>, draft?: unknown, requestedTurnId?: string,
    preparedSnapshot?: QueueSnapshot): Promise<QueueSnapshot> {
    return this.serialize(async () => {
      const snapshot = preparedSnapshot ?? await this.readAndReconcile(false);
      if (snapshot.sessionId !== this.sessionId || !snapshot.queueEpoch
        || (preparedSnapshot && this.view.snapshot?.queueEpoch !== snapshot.queueEpoch)) {
        throw new Error('queue_scope_expired: refresh the host queue; do not automatically resend');
      }
      const previous = this.pendingSubmission(message);
      if (previous) return this.retryRecord(previous, snapshot);
      const turnId = requestedTurnId?.trim() || newId();
      return this.transmit({ scope: this.scope, key: JSON.stringify([this.scope, turnId]), draft,
        request: { sessionId: this.sessionId, queueEpoch: snapshot.queueEpoch, action: 'submit', message: { ...message, turnId } } });
    });
  }
  /** The unresolved outbox record that submitting this payload would retry instead. */
  pendingSubmission(message: Omit<QueueMessage, 'turnId'>): QueueOutboxRecord | undefined {
    const identity = messageIdentity(message);
    return this.view.pending.find(record => {
      if (record.restoreIntent || record.request.action !== 'submit') return false;
      const { turnId: _id, ...payload } = record.request.message;
      return messageIdentity(payload) === identity;
    });
  }
  act(item: QueueItem, action: 'cancel' | 'promote'): Promise<QueueSnapshot> {
    const observed = this.view;
    return this.serialize(async () => {
      const snapshot = observed.snapshot;
      if (!snapshot || observed.error) throw new Error('Refresh the host queue before changing it');
      const previous = this.view.pending.find(record => record.request.action === action
        && 'turnId' in record.request && record.request.turnId === item.turnId);
      if (previous) return this.retryRecord(previous, snapshot);
      const operationId = newId();
      const request: QueueRequest = action === 'cancel'
        ? { sessionId: this.sessionId, queueEpoch: snapshot.queueEpoch, action, turnId: item.turnId, operationId }
        : { sessionId: this.sessionId, queueEpoch: snapshot.queueEpoch, action, turnId: item.turnId, operationId,
          expectedActiveTurnId: snapshot.activeTurnId };
      return this.transmit({ scope: this.scope, key: JSON.stringify([this.scope, operationId]), request });
    });
  }
  reorder(turnId: string, beforeTurnId: string | null, expected = this.view.snapshot): Promise<QueueSnapshot> {
    return this.serialize(async () => {
      if (!expected?.supportsReorder) throw new Error('queue_reorder_unsupported: update the execution host to reorder messages');
      if (this.view.error || expected.queueEpoch !== this.view.snapshot?.queueEpoch) {
        throw new Error('queue_conflict: refresh the host queue before reordering');
      }
      const operationId = newId();
      return this.transmit({ scope: this.scope, key: JSON.stringify([this.scope, operationId]), request: {
        sessionId: this.sessionId, queueEpoch: expected.queueEpoch, action: 'reorder',
        turnId, beforeTurnId, operationId, expectedRevision: expected.revision,
      } });
    });
  }
  retry(record: QueueOutboxRecord): Promise<QueueSnapshot> {
    // The retried record reads its own receipt; do not wait for the others'.
    return this.serialize(async () => this.retryRecord(record, await this.readAndReconcile(false)));
  }
  private async retryRecord(record: QueueOutboxRecord, snapshot: QueueSnapshot): Promise<QueueSnapshot> {
    if (record.scope !== this.scope || record.request.sessionId !== this.sessionId) throw new Error('Queue target changed');
    if (record.request.queueEpoch !== snapshot.queueEpoch) {
      throw new Error('queue_scope_expired: host restarted; delivery is unknown. Restore the draft before submitting again.');
    }
    if (record.request.action === 'submit') {
      const result = await this.invoke({ sessionId: this.sessionId, queueEpoch: snapshot.queueEpoch,
        action: 'get', turnId: record.request.message.turnId });
      if (result.receipt) {
        this.accept(result, false);
        await this.markAccepted(record);
        await this.publishPending();
        return result;
      }
    }
    return this.transmit(record);
  }
  /** Commit edit intent before cancelling remotely, so a lost reply cannot
   * let background refresh garbage-collect the only complete draft. */
  async prepareRestore(record: QueueOutboxRecord): Promise<void> {
    if (record.scope !== this.scope) throw new Error('Queue target changed');
    await this.storage.put({ ...record, restoreIntent: true });
    await this.publishPending();
  }
  async receipt(turnId: string, expectedEpoch?: string): Promise<QueueItem | null> {
    const snapshot = await this.refresh();
    if (expectedEpoch && snapshot.queueEpoch !== expectedEpoch) throw new Error('queue_scope_expired: host queue owner changed');
    const result = await this.invoke({ sessionId: this.sessionId, queueEpoch: snapshot.queueEpoch, action: 'get', turnId });
    this.accept(result, false);
    return result.receipt;
  }
  async savedDraft(turnId: string): Promise<QueueOutboxRecord | undefined> {
    return (await this.storage.list(this.scope)).find(record => record.request.action === 'submit' && record.request.message.turnId === turnId);
  }

  /** Explicitly dismiss an unresolved record; never sends or cancels host work. */
  async dismiss(record: QueueOutboxRecord): Promise<void> {
    if (record.scope !== this.scope) throw new Error('Queue target changed');
    await this.storage.remove(record.key);
    await this.publishPending();
  }
}

/** Refresh only while observed. Closing the view cancels no host work. */
export function observeHostQueue(queue: HostDialogQueue): () => void {
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  const refresh = async () => {
    if (closed || running) return;
    if (timer) clearTimeout(timer);
    // A hidden window is refreshed when it is shown again.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    running = true;
    let delay = 10_000;
    try {
      // Watch closely only while something is queued; an empty queue changes
      // through this window's own sends (which refresh it) or rarely elsewhere.
      const snapshot = await queue.refresh();
      if ((snapshot?.items?.length ?? 0) > 0 || snapshot?.activeTurnId) delay = 2_000;
    } catch { delay = 10_000; }
    finally { running = false; if (!closed) timer = setTimeout(() => void refresh(), delay); }
  };
  const wake = () => { if (document.visibilityState !== 'hidden') void refresh(); };
  window.addEventListener('online', wake);
  window.addEventListener('focus', wake);
  document.addEventListener('visibilitychange', wake);
  void refresh();
  return () => { closed = true; if (timer) clearTimeout(timer);
    window.removeEventListener('online', wake); window.removeEventListener('focus', wake);
    document.removeEventListener('visibilitychange', wake); };
}
