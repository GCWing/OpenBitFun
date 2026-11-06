import { MessageQueueAction, MessageQueueItem, MessageQueueRequest, MessageQueueSnapshot, MessageQueueState } from '../model/MessageQueue';
import { RemoteSessionManager } from './RemoteSessionManager';
import { Encoding } from './Encoding';

/** A controller replica; the execution host owns both receipts and dispatch order. */
export class MessageQueueStore {
  private client: RemoteSessionManager;
  private onChange: (state: MessageQueueState) => void;
  private canPoll: (sessionId: string) => boolean;
  private state: MessageQueueState = new MessageQueueState();
  private snapshot?: MessageQueueSnapshot;
  private generation: number = 0;
  private timer: number = -1;
  private reading: boolean = false;
  private readVersion: number = 0;
  constructor(client: RemoteSessionManager, onChange: (state: MessageQueueState) => void, canPoll: (sessionId: string) => boolean) {
    this.client = client; this.onChange = onChange; this.canPoll = canPoll;
  }
  select(sessionId: string): void {
    this.generation++;
    if (this.timer >= 0) clearTimeout(this.timer);
    this.timer = -1; this.reading = false; this.snapshot = undefined;
    this.state = new MessageQueueState(); this.state.sessionId = sessionId; this.publish();
    if (sessionId) void this.refresh();
  }
  private accept(value: MessageQueueSnapshot): void {
    if (value.sessionId !== this.state.sessionId || !value.queueEpoch || !Array.isArray(value.items)) throw new Error('Invalid queue snapshot');
    if (this.snapshot?.queueEpoch === value.queueEpoch && this.snapshot.revision > value.revision) return;
    this.snapshot = value; this.state.revisionKey = `${value.queueEpoch}:${value.revision}`; this.state.items = value.items.slice(); this.state.supportsReorder = value.supportsReorder === true;
    this.state.failure = ''; this.publish();
  }
  async refresh(): Promise<void> {
    if (this.reading || this.state.busy || !this.state.sessionId) return;
    if (this.timer >= 0) clearTimeout(this.timer);
    const ticket = this.generation;
    const version = this.readVersion;
    this.reading = true;
    try {
      if (!this.canPoll(this.state.sessionId)) {
        this.state.failure = 'offline'; this.publish();
      } else if (!this.client.supportsMessageQueue()) {
        if (this.state.items.length > 0) { this.state.failure = 'unsupported'; this.state.supportsReorder = false; this.publish(); }
      } else {
        const value = await this.client.manageMessageQueue({ sessionId: this.state.sessionId, action: 'list' });
        if (ticket === this.generation && version === this.readVersion) this.accept(value);
      }
    } catch (_error) { if (ticket === this.generation && version === this.readVersion) { this.state.failure = 'load'; this.publish(); } }
    finally {
      if (ticket === this.generation) {
        this.reading = false;
        this.timer = setTimeout((): void => { void this.refresh(); }, this.state.items.length > 0 ? 2000 : 10000);
      }
    }
  }
  async dispatch(action: MessageQueueAction): Promise<void> {
    if (action.sessionId !== this.state.sessionId) return;
    if (action.action === 'list') { await this.refresh(); return; }
    const observed = this.snapshot;
    if (!observed || this.state.busy || this.state.failure) return;
    if (!this.canPoll(action.sessionId)) { this.state.failure = 'offline'; this.publish(); return; }
    const item = this.state.items.find((value: MessageQueueItem): boolean => value.turnId === action.turnId);
    if (!item || (item.status !== 'queued' && item.status !== 'blocked')) return;
    if (action.action === 'reorder' && (!observed.supportsReorder || item.status !== 'queued')) {
      this.state.failure = 'unsupported'; this.publish(); return;
    }
    const ticket = this.generation;
    this.readVersion++;
    this.state.busy = true; this.publish();
    const request: MessageQueueRequest = { sessionId: action.sessionId, action: action.action, queueEpoch: observed.queueEpoch,
      turnId: item.turnId, operationId: Encoding.randomId('queue'), beforeTurnId: action.beforeTurnId,
      expectedRevision: observed.revision, expectedActiveTurnId: observed.activeTurnId };
    try {
      const value = await this.client.manageMessageQueue(request);
      if (ticket !== this.generation) return;
      if (value.queueEpoch !== observed.queueEpoch) throw new Error('Queue owner changed');
      this.accept(value);
    } catch (_error) { if (ticket === this.generation) { this.state.failure = 'unknown'; this.publish(); } }
    finally {
      if (ticket === this.generation) { this.state.busy = false; this.publish(); void this.refresh(); }
    }
  }
  private publish(): void {
    const next = new MessageQueueState();
    next.sessionId = this.state.sessionId; next.items = this.state.items.slice(); next.supportsReorder = this.state.supportsReorder;
    next.revisionKey = this.state.revisionKey; next.busy = this.state.busy; next.failure = this.state.failure; this.onChange(next);
  }
}
