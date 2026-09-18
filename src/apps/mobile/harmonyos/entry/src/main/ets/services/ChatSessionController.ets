import { InteractionMailboxStore } from './InteractionMailboxStore';
import { InteractionMailboxAction, InteractionMailboxState } from '../model/InteractionMailbox';
import { DurableSessionReducer } from './DurableSessionReducer';
import { HostSessionStream, HostSessionEvent } from './HostSessionStream';
import {
  ChatMessage,
  RemoteModelCatalog
} from '../model/RemoteModels';
import { RemoteSessionManager } from './RemoteSessionManager';

export interface ChatSessionCursor {
  pollVersion: number;
  knownMessageCount: number;
  knownModelCatalogVersion: number;
}

export interface ChatSessionSnapshot {
  sessionId: string;
  cursor: ChatSessionCursor;
  changed: boolean;
  title: string;
  sessionState: string;
  newMessages: ChatMessage[];
  messageSnapshot?: ChatMessage[];
  activeTurn?: ChatMessage;
  modelCatalog?: RemoteModelCatalog;
  shouldSyncAfterTurnEnded: boolean;
  // The desktop now holds fewer messages than this session had counted, so the
  // transcript it was handing out tails of is no longer the one on screen.
  // Nothing below can resume from an offset into a list that shrank.
  historyRewritten: boolean;
  /** Exact completed turn whose terminal assistant is now durable. */
  completedTurnId: string;
  hasMoreMessages?: boolean;
  historyLoading?: boolean;
  historyFailed?: boolean;
}

export interface ChatSessionControllerCallbacks {
  onSnapshot: (snapshot: ChatSessionSnapshot) => void;
  onMailbox?: (state: InteractionMailboxState) => void;
  onError: (error: Object) => void;
  canPoll: (sessionId: string) => boolean;
}

export interface ChatSessionControllerOptions {
  /** Stabilization window before the first idle poll after selecting a session. */
  initialPollDelayMs: number;
}


/** Like Happy's normalized message reducer, history and realtime are one
 * stable-id collection. No separately timed transcript snapshot is merged in. */

export class ChatSessionController {
  private sessionManager: RemoteSessionManager;
  private callbacks: ChatSessionControllerCallbacks;
  private sessionId: string = '';
  private cursor: ChatSessionCursor = { pollVersion: 0, knownMessageCount: 0, knownModelCatalogVersion: 0 };
  private stream?: HostSessionStream;
  private reducer: DurableSessionReducer = new DurableSessionReducer();
  private mailbox: InteractionMailboxStore;
  private generation: number = 0;
  private stopped: boolean = true;
  private caughtUp: boolean = false;
  private sessionState: string = 'idle';
  private completedTurnId: string = '';
  private hasMoreMessages: boolean = false;
  private historyLoading: boolean = false;
  private historyFailed: boolean = false;
  private modelReadVersion: number = 0;
  private pendingModelCatalog?: RemoteModelCatalog;

  constructor(sessionManager: RemoteSessionManager, callbacks: ChatSessionControllerCallbacks,
    _options?: ChatSessionControllerOptions) {
    this.sessionManager = sessionManager; this.callbacks = callbacks;
    this.mailbox = new InteractionMailboxStore(sessionManager, (state: InteractionMailboxState): void => { this.callbacks.onMailbox?.(state); });
  }
  start(sessionId: string, cursor: ChatSessionCursor, _activeTurn?: ChatMessage): void {
    if (!this.stopped && this.sessionId === sessionId && this.stream && !this.stream.isClosed()) {
      this.stream.wake(); return;
    }
    this.stop(); this.sessionId = sessionId; this.cursor = cursor;
    this.reducer = new DurableSessionReducer(); this.mailbox.select(sessionId); this.stopped = false; this.caughtUp = false;
    this.sessionState = 'idle'; this.completedTurnId = ''; this.hasMoreMessages = false;
    this.historyLoading = false; this.historyFailed = false;
    this.pendingModelCatalog = undefined;
    const epoch = this.generation;
    void this.loadInitialModelCatalog(sessionId, epoch);
    try {
      this.stream = this.sessionManager.subscribeSession(sessionId, {
        onEvent: async (event: HostSessionEvent): Promise<void> => {
          if (!this.current(epoch) || event.session_id !== sessionId) return;
          // Mailbox RPCs are independently coalesced and generation-fenced. They
          // must not delay the serial transcript stream or its durable cursor.
          if (event.event === 'session-interaction-changed') { void this.mailbox.refresh(); return; }
          if (!this.reducer.apply(event)) return;
          if (this.caughtUp) this.publish();
        },
        onResumed: async (): Promise<void> => { if (this.current(epoch)) void this.mailbox.refresh(); },
        onGap: async (): Promise<void> => {
          // The desktop restarted the stream: everything reduced so far came
          // from its previous epoch and is replayed from the latest page.
          if (!this.current(epoch)) return;
          this.reducer = new DurableSessionReducer(); this.hasMoreMessages = false;
        },
        onCaughtUp: async (): Promise<void> => {
          if (!this.current(epoch)) return;
          this.caughtUp = true; this.publish();
        },
        onHistory: (hasMore: boolean): void => { this.hasMoreMessages = hasMore; },
        onHistoryState: (loading: boolean, failed: boolean): void => {
          if (!this.current(epoch)) return;
          this.historyLoading = loading; this.historyFailed = failed;
          if (this.caughtUp) this.publish();
        },
        onError: (error: Error): void => { if (this.current(epoch)) this.callbacks.onError(error); }
      });
    } catch (error) { this.callbacks.onError(error); }
  }
  async refreshModelCatalog(): Promise<void> {
    if (!this.stopped) await this.loadInitialModelCatalog(this.sessionId, this.generation);
  }
  private async loadInitialModelCatalog(sessionId: string, epoch: number): Promise<void> {
    const version = ++this.modelReadVersion;
    try {
      const catalog = await this.sessionManager.getModelCatalog(sessionId);
      if (!this.current(epoch) || version !== this.modelReadVersion) return;
      this.pendingModelCatalog = catalog;
      if (this.caughtUp) this.publish();
    } catch (error) {
      if (this.current(epoch) && version === this.modelReadVersion) this.callbacks.onError(error);
    }
  }
  stop(_clearActiveTurn: boolean = true): void {
    this.generation++; this.stopped = true; this.mailbox.select(''); this.stream?.close(); this.stream = undefined;
  }
  loadOlder(): void { this.stream?.loadOlder(); }
  nudge(): void { this.stream?.wake(); }
  updateCursor(cursor: ChatSessionCursor): void { this.cursor = cursor; }
  updateKnownModelCatalogVersion(version: number): void {
    this.modelReadVersion++;
    this.pendingModelCatalog = undefined;
    this.cursor.knownModelCatalogVersion = version;
  }
  setKnownMessageCount(count: number): void { this.cursor.knownMessageCount = count; }
  clearActiveTurn(): void { /* Runtime message/state events own turn lifetime. */ }
  async dispatchMailbox(action: InteractionMailboxAction): Promise<void> {
    if (!this.stopped && action.sessionId === this.sessionId) await this.mailbox.dispatch(action);
  }
  private current(epoch: number): boolean { return epoch === this.generation && !this.stopped; }
  async pollNow(): Promise<void> { this.stream?.wake(); }
  private publish(): void {
    if (this.stopped || !this.callbacks.canPoll(this.sessionId)) return;
    const persisted: ChatMessage[] = [];
    let active: ChatMessage | undefined = undefined;
    this.reducer.messages().forEach((message: ChatMessage) => {
      if (message.role === 'assistant' && (message.status === 'active' || message.status === 'running')) active = message;
      else {
        persisted.push(message);
        if (message.role === 'assistant') this.completedTurnId = message.turnId || '';
      }
    });
    this.cursor.knownMessageCount = persisted.length;
    const catalog = this.pendingModelCatalog;
    this.pendingModelCatalog = undefined;
    if (catalog) this.cursor.knownModelCatalogVersion = catalog.version || 0;
    this.callbacks.onSnapshot({
      sessionId: this.sessionId, cursor: this.cursor, changed: true, title: '', modelCatalog: catalog,
      sessionState: active ? 'active' : this.sessionState, newMessages: [],
      activeTurn: active, messageSnapshot: persisted, shouldSyncAfterTurnEnded: false,
      historyRewritten: false, completedTurnId: this.completedTurnId, hasMoreMessages: this.hasMoreMessages,
      historyLoading: this.historyLoading, historyFailed: this.historyFailed
    });
  }
}
