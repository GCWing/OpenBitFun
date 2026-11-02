import {
  ChatMessage,
  ChatMessageItemResponse,
  ImageAttachment,
  RemoteModelCatalog,
  RemoteToolStatusResponse
} from '../model/RemoteModels';
import { ChatSessionCursor, ChatSessionSnapshot } from './ChatSessionController';
import { ChatTimelineItem, ChatTimelineProjector } from './ChatTimelineProjector';
import { RemoteUiState } from './RemoteUiState';
import { ConversationEvent } from './ConversationEvent';

// Marks the placeholder turn shown between sending a message and hearing back
// which turn the desktop opened for it. Everything after the prefix is a local
// message id, so it must never be mistaken for a server-issued turn id.
export const PENDING_ACTIVE_TURN_ID_PREFIX: string = 'active-pending-';

export type ChatSyncPhase =
  | 'idle'
  | 'loading'
  | 'sending'
  | 'streaming'
  | 'finalizing'
  | 'reconnecting'
  | 'error';

export interface ChatTimelineState {
  sessionId: string;
  persistedMessages: ChatMessage[];
  optimisticMessages: ChatMessage[];
  activeTurn?: ChatMessage;
  syncPhase: ChatSyncPhase;
  cursor: ChatSessionCursor;
  modelCatalog: RemoteModelCatalog;
  selectedModelId: string;
}

export class ChatTimelineStore {
  private state: ChatTimelineState = ChatTimelineStore.emptyState('');
  // The optimistic message the active turn is replying to. Kept out of
  // `ChatTimelineState` because nothing but the projection needs it: it exists
  // so a message sent mid-run renders below the running reply instead of
  // jumping up beside the message that started it.
  private activeTurnAnchor: string = '';

  reset(sessionId: string = ''): void {
    this.state = ChatTimelineStore.emptyState(sessionId);
    this.activeTurnAnchor = '';
  }

  snapshot(): ChatTimelineState {
    return {
      sessionId: this.state.sessionId,
      persistedMessages: this.state.persistedMessages.slice(),
      optimisticMessages: this.state.optimisticMessages.slice(),
      activeTurn: this.state.activeTurn,
      syncPhase: this.state.syncPhase,
      cursor: {
        pollVersion: this.state.cursor.pollVersion,
        knownMessageCount: this.state.cursor.knownMessageCount,
        knownModelCatalogVersion: this.state.cursor.knownModelCatalogVersion
      },
      modelCatalog: this.state.modelCatalog,
      selectedModelId: this.state.selectedModelId
    };
  }

  setSyncPhase(syncPhase: ChatSyncPhase): void {
    this.state = {
      sessionId: this.state.sessionId,
      persistedMessages: this.state.persistedMessages,
      optimisticMessages: this.state.optimisticMessages,
      activeTurn: this.state.activeTurn,
      syncPhase,
      cursor: this.state.cursor,
      modelCatalog: this.state.modelCatalog,
      selectedModelId: this.state.selectedModelId
    };
  }

  setCursor(cursor: ChatSessionCursor): void {
    this.state = {
      sessionId: this.state.sessionId,
      persistedMessages: this.state.persistedMessages,
      optimisticMessages: this.state.optimisticMessages,
      activeTurn: this.state.activeTurn,
      syncPhase: this.state.syncPhase,
      cursor: {
        pollVersion: cursor.pollVersion,
        knownMessageCount: cursor.knownMessageCount,
        knownModelCatalogVersion: cursor.knownModelCatalogVersion
      },
      modelCatalog: this.state.modelCatalog,
      selectedModelId: this.state.selectedModelId
    };
  }

  setModelCatalog(modelCatalog: RemoteModelCatalog, selectedModelId: string): void {
    this.state = {
      sessionId: this.state.sessionId,
      persistedMessages: this.state.persistedMessages,
      optimisticMessages: this.state.optimisticMessages,
      activeTurn: this.state.activeTurn,
      syncPhase: this.state.syncPhase,
      cursor: {
        pollVersion: this.state.cursor.pollVersion,
        knownMessageCount: this.state.cursor.knownMessageCount,
        knownModelCatalogVersion: modelCatalog.version || 0
      },
      modelCatalog,
      selectedModelId
    };
  }

  setSelectedModelId(selectedModelId: string): void {
    this.state = {
      sessionId: this.state.sessionId,
      persistedMessages: this.state.persistedMessages,
      optimisticMessages: this.state.optimisticMessages,
      activeTurn: this.state.activeTurn,
      syncPhase: this.state.syncPhase,
      cursor: this.state.cursor,
      modelCatalog: this.state.modelCatalog,
      selectedModelId
    };
  }

  /**
   * Binds the optimistic user bubble to the host turn acknowledged by the
   * send response. New hosts preserve the client turn id, while older hosts
   * generate a replacement id. Handling both here also closes the race where
   * polling publishes the persisted message before the send response arrives.
   */
  acknowledgeOptimisticTurn(localMessageId: string, turnId: string): void {
    const normalizedLocalId = localMessageId.trim();
    const normalizedTurnId = turnId.trim();
    if (normalizedLocalId.length === 0 || normalizedTurnId.length === 0) {
      return;
    }
    const persistedAlreadyArrived = this.state.persistedMessages.some((message: ChatMessage) => {
      return message.role === 'user' && (message.turnId || '').trim() === normalizedTurnId;
    });
    const optimisticMessages = persistedAlreadyArrived ?
      this.state.optimisticMessages.filter((message: ChatMessage) => message.id !== normalizedLocalId) :
      this.state.optimisticMessages.map((message: ChatMessage) => {
        if (message.id !== normalizedLocalId) {
          return message;
        }
        return {
          id: message.id,
          turnId: normalizedTurnId,
          role: message.role,
          text: message.text,
          status: message.status,
          renderVersion: message.renderVersion,
          detail: message.detail,
          error: message.error,
          timestamp: message.timestamp,
          thinking: message.thinking,
          tools: message.tools,
          items: message.items,
          images: message.images
        };
      });
    this.state = {
      sessionId: this.state.sessionId,
      persistedMessages: this.state.persistedMessages,
      optimisticMessages,
      activeTurn: this.state.activeTurn,
      syncPhase: this.state.syncPhase,
      cursor: this.state.cursor,
      modelCatalog: this.state.modelCatalog,
      selectedModelId: this.state.selectedModelId
    };
  }

  setPersistedMessages(messages: ChatMessage[]): void {
    const persistedMessages = ChatTimelineStore.carrySteeringItems(
      this.state.activeTurn,
      ChatTimelineStore.realMessages(messages)
    );
    const previousIds = new Set<string>();
    this.state.persistedMessages.forEach((message: ChatMessage) => previousIds.add(message.id));
    const newlyPersistedMessages = persistedMessages.filter((message: ChatMessage) => !previousIds.has(message.id));
    const activeTurnCovered = this.coveredByPersistedMessage(this.state.activeTurn, persistedMessages) ||
      this.coveredByNewAssistantContent(this.state.activeTurn, newlyPersistedMessages);
    this.state = {
      sessionId: this.state.sessionId,
      persistedMessages,
      optimisticMessages: ChatTimelineStore.optimisticMessagesNotPersisted(
        this.state.optimisticMessages,
        newlyPersistedMessages
      ),
      activeTurn: activeTurnCovered ? undefined : this.state.activeTurn,
      syncPhase: this.state.syncPhase,
      cursor: this.state.cursor,
      modelCatalog: this.state.modelCatalog,
      selectedModelId: this.state.selectedModelId
    };
  }

  mergePersistedMessages(messages: ChatMessage[]): void {
    const incomingMessages = ChatTimelineStore.realMessages(messages);
    const previousIds = new Set<string>();
    this.state.persistedMessages.forEach((message: ChatMessage) => previousIds.add(message.id));
    // Only this delivery can acknowledge an optimistic message. Replayed
    // history with the same text must not consume a message the user just sent.
    const newlyPersistedMessages = incomingMessages.filter((message: ChatMessage) => !previousIds.has(message.id));
    const persistedMessages = ChatTimelineStore.carrySteeringItems(
      this.state.activeTurn,
      RemoteUiState.mergeMessages(this.state.persistedMessages, incomingMessages)
    );
    const activeTurnCovered = this.coveredByPersistedMessage(this.state.activeTurn, persistedMessages) ||
      this.coveredByNewAssistantContent(this.state.activeTurn, newlyPersistedMessages);
    this.state = {
      sessionId: this.state.sessionId,
      persistedMessages,
      optimisticMessages: ChatTimelineStore.optimisticMessagesNotPersisted(
        this.state.optimisticMessages,
        newlyPersistedMessages
      ),
      activeTurn: activeTurnCovered ? undefined : this.state.activeTurn,
      syncPhase: this.state.syncPhase,
      cursor: this.state.cursor,
      modelCatalog: this.state.modelCatalog,
      selectedModelId: this.state.selectedModelId
    };
  }

  appendOptimisticMessage(message: ChatMessage): void {
    this.state = {
      sessionId: this.state.sessionId,
      persistedMessages: this.state.persistedMessages,
      optimisticMessages: this.state.optimisticMessages.concat([message]),
      activeTurn: this.state.activeTurn,
      syncPhase: 'sending',
      cursor: this.state.cursor,
      modelCatalog: this.state.modelCatalog,
      selectedModelId: this.state.selectedModelId
    };
  }

  appendSteeringItem(
    turnId: string,
    steeringId: string,
    content: string,
    images: ImageAttachment[]
  ): boolean {
    const active = this.state.activeTurn;
    if (!active || ChatTimelineStore.cancelableTurnId(active) !== turnId || steeringId.length === 0) {
      return false;
    }
    const items = active.items ? active.items.slice() : [];
    const existingIndex = items.findIndex((item: ChatMessageItemResponse) => {
      return (item.type || '').toLowerCase() === 'user-steering' && item.steering_id === steeringId;
    });
    const steeringItem: ChatMessageItemResponse = {
      type: 'user-steering',
      steering_id: steeringId,
      content,
      images: images.slice()
    };
    if (existingIndex >= 0) {
      items[existingIndex] = steeringItem;
    } else {
      items.push(steeringItem);
    }
    this.setActiveTurn({
      id: active.id,
      turnId: active.turnId,
      role: active.role,
      text: active.text,
      status: active.status,
      detail: active.detail,
      error: active.error,
      timestamp: active.timestamp,
      thinking: active.thinking,
      tools: active.tools,
      items,
      images: active.images,
      renderVersion: (active.renderVersion || 0) + 1
    });
    return true;
  }

  markOptimisticMessageFailed(messageId: string): void {
    this.state = {
      sessionId: this.state.sessionId,
      persistedMessages: this.state.persistedMessages,
      optimisticMessages: RemoteUiState.markMessageFailed(this.state.optimisticMessages, messageId),
      activeTurn: this.state.activeTurn,
      syncPhase: 'error',
      cursor: this.state.cursor,
      modelCatalog: this.state.modelCatalog,
      selectedModelId: this.state.selectedModelId
    };
  }

  setLocalActiveTurn(turnId: string): void {
    const normalizedTurnId = turnId.trim();
    if (normalizedTurnId.length === 0) {
      return;
    }
    const activeId = `active-${normalizedTurnId}`;
    if (this.state.activeTurn && this.state.activeTurn.id === activeId) {
      const existing = this.state.activeTurn;
      const activeTurn: ChatMessage = {
        id: existing.id,
        turnId: existing.turnId && existing.turnId.length > 0 ? existing.turnId : normalizedTurnId,
        role: existing.role,
        text: existing.text,
        status: existing.status || 'active',
        detail: existing.detail,
        error: existing.error,
        timestamp: existing.timestamp,
        thinking: existing.thinking,
        tools: existing.tools,
        items: existing.items,
        images: existing.images
      };
      this.state = {
        sessionId: this.state.sessionId,
        persistedMessages: this.state.persistedMessages,
        optimisticMessages: this.state.optimisticMessages,
        activeTurn,
        syncPhase: ChatTimelineStore.phaseForActiveTurn(activeTurn, 'streaming'),
        cursor: this.state.cursor,
        modelCatalog: this.state.modelCatalog,
        selectedModelId: this.state.selectedModelId
      };
      return;
    }
    if (this.state.activeTurn && this.state.activeTurn.id.length > 0 &&
      this.state.activeTurn.id !== activeId &&
      !ChatTimelineStore.isLocalPendingActiveTurn(this.state.activeTurn)) {
      return;
    }
    // Promoting the placeholder keeps the message it was opened for; a turn
    // that appears without one belongs to the newest thing the user sent.
    if (!this.state.activeTurn || !ChatTimelineStore.isLocalPendingActiveTurn(this.state.activeTurn)) {
      this.activeTurnAnchor = this.lastOptimisticMessageId();
    }
    const activeTurn: ChatMessage = {
      id: activeId,
      turnId: normalizedTurnId,
      role: 'assistant',
      text: '',
      status: 'active',
      detail: ''
    };
    this.state = {
      sessionId: this.state.sessionId,
      persistedMessages: this.state.persistedMessages,
      optimisticMessages: this.state.optimisticMessages,
      activeTurn,
      syncPhase: 'streaming',
      cursor: this.state.cursor,
      modelCatalog: this.state.modelCatalog,
      selectedModelId: this.state.selectedModelId
    };
  }

  setPendingActiveTurn(localId: string): string {
    const normalizedLocalId = localId.trim();
    if (normalizedLocalId.length === 0) {
      return '';
    }
    const activeId = `${PENDING_ACTIVE_TURN_ID_PREFIX}${normalizedLocalId}`;
    if (this.state.activeTurn && this.state.activeTurn.id.length > 0 &&
      this.state.activeTurn.id !== activeId &&
      !ChatTimelineStore.isLocalPendingActiveTurn(this.state.activeTurn)) {
      return '';
    }
    this.activeTurnAnchor = normalizedLocalId;
    const activeTurn: ChatMessage = {
      id: activeId,
      role: 'assistant',
      text: '',
      status: 'active',
      detail: ''
    };
    this.state = {
      sessionId: this.state.sessionId,
      persistedMessages: this.state.persistedMessages,
      optimisticMessages: this.state.optimisticMessages,
      activeTurn,
      syncPhase: 'streaming',
      cursor: this.state.cursor,
      modelCatalog: this.state.modelCatalog,
      selectedModelId: this.state.selectedModelId
    };
    return activeId;
  }

  clearPendingActiveTurn(activeId: string): void {
    if (!this.state.activeTurn || this.state.activeTurn.id !== activeId ||
      !ChatTimelineStore.isLocalPendingActiveTurn(this.state.activeTurn)) {
      return;
    }
    this.activeTurnAnchor = '';
    this.state = {
      sessionId: this.state.sessionId,
      persistedMessages: this.state.persistedMessages,
      optimisticMessages: this.state.optimisticMessages,
      activeTurn: undefined,
      syncPhase: 'idle',
      cursor: this.state.cursor,
      modelCatalog: this.state.modelCatalog,
      selectedModelId: this.state.selectedModelId
    };
  }

  setActiveTurn(activeTurn?: ChatMessage): void {
    const normalized = activeTurn && activeTurn.id.length > 0 ? activeTurn : undefined;
    const merged = ChatTimelineStore.activeTurnForUpdate(this.state.activeTurn, normalized);
    const nextActiveTurn = this.activeTurnForState(merged);
    this.state = {
      sessionId: this.state.sessionId,
      persistedMessages: this.state.persistedMessages,
      optimisticMessages: this.state.optimisticMessages,
      activeTurn: nextActiveTurn,
      syncPhase: ChatTimelineStore.phaseForActiveTurn(nextActiveTurn, this.state.syncPhase),
      cursor: this.state.cursor,
      modelCatalog: this.state.modelCatalog,
      selectedModelId: this.state.selectedModelId
    };
  }

  clearActiveTurn(): void {
    this.activeTurnAnchor = '';
    this.state = {
      sessionId: this.state.sessionId,
      persistedMessages: this.state.persistedMessages,
      optimisticMessages: this.state.optimisticMessages,
      activeTurn: undefined,
      syncPhase: 'idle',
      cursor: this.state.cursor,
      modelCatalog: this.state.modelCatalog,
      selectedModelId: this.state.selectedModelId
    };
  }

  applySnapshot(snapshot: ChatSessionSnapshot): void {
    this.setCursor(snapshot.cursor);
    if (snapshot.messageSnapshot !== undefined) {
      // The durable reducer already resolves identity, ordering, revisions and
      // tombstones. Replace its complete projection, as the shared mobile
      // session store does, rather than merging it as a legacy partial poll.
      // Clear before persisted messages too: stale active/steering blocks must
      // not be carried into an authoritative completed turn. Pending user
      // messages remain separate until a host record acknowledges them.
      this.clearActiveTurn();
      this.setPersistedMessages(snapshot.messageSnapshot);
    } else if (snapshot.newMessages.length > 0) {
      this.mergePersistedMessages(snapshot.newMessages);
    }
    this.setActiveTurn(snapshot.activeTurn);
    if (snapshot.modelCatalog) {
      const selected = RemoteUiState.selectedModelIdForCatalog(snapshot.modelCatalog, this.state.selectedModelId);
      this.setModelCatalog(snapshot.modelCatalog, selected);
    }
  }

  /** Applies transport-neutral conversation events from local or remote adapters. */
  applyEvent(event: ConversationEvent): void {
    switch (event.type) {
      case 'user_message':
        if (event.persisted) {
          this.mergePersistedMessages([event.message]);
        } else {
          this.appendOptimisticMessage(event.message);
        }
        return;
      case 'turn_started':
        if (this.acceptsSession(event.sessionId)) {
          this.setLocalActiveTurn(event.turnId);
        }
        return;
      case 'assistant_delta':
        if (!this.acceptsSession(event.sessionId)) {
          return;
        }
        this.appendAssistantDelta(event.turnId, event.delta);
        return;
      case 'assistant_message':
        this.mergePersistedMessages([event.message]);
        this.clearActiveTurn();
        return;
      case 'active_turn_updated':
        if (this.acceptsSession(event.sessionId)) {
          this.setActiveTurn(event.message);
        }
        return;
      case 'tool_started':
        if (this.acceptsSession(event.sessionId)) {
          this.updateActiveTool(event.turnId, event.tool);
        }
        return;
      case 'tool_finished':
        if (this.acceptsSession(event.sessionId)) {
          this.updateActiveTool(event.turnId, event.tool);
        }
        return;
      case 'turn_finished':
        if (event.message) {
          this.mergePersistedMessages([event.message]);
          this.clearActiveTurn();
        } else if (this.acceptsSession(event.sessionId)) {
          const active = this.state.activeTurn;
          if (active && active.turnId === event.turnId) {
            this.setActiveTurn({
              id: active.id,
              turnId: active.turnId,
              role: active.role,
              text: active.text,
              status: 'completed',
              detail: active.detail,
              error: active.error,
              timestamp: active.timestamp,
              thinking: active.thinking,
              tools: active.tools,
              items: active.items,
              images: active.images
            });
          }
        }
        return;
      case 'session_updated':
        if (this.state.sessionId.length === 0 || this.state.sessionId === event.session.sessionId) {
          return;
        }
        return;
      case 'error':
        this.setSyncPhase('error');
        return;
    }
  }

  activeTurnOrEmpty(): ChatMessage {
    return this.state.activeTurn || RemoteUiState.emptyActiveTurn();
  }

  project(hasMoreMessages: boolean): ChatTimelineItem[] {
    return ChatTimelineProjector.project(
      this.state.persistedMessages,
      this.state.optimisticMessages,
      this.activeTurnOrEmpty(),
      hasMoreMessages,
      this.activeTurnAnchor
    );
  }

  /** The optimistic message the running turn answers, or '' once it persisted. */
  activeTurnAnchorId(): string {
    return this.activeTurnAnchor;
  }

  private lastOptimisticMessageId(): string {
    const messages = this.state.optimisticMessages;
    return messages.length > 0 ? messages[messages.length - 1].id : '';
  }

  private acceptsSession(sessionId: string): boolean {
    return sessionId.length === 0 || this.state.sessionId.length === 0 || this.state.sessionId === sessionId;
  }

  private appendAssistantDelta(turnId: string, delta: string): void {
    if (delta.length === 0) {
      return;
    }
    if (!this.state.activeTurn || this.state.activeTurn.turnId !== turnId) {
      this.setLocalActiveTurn(turnId);
    }
    const active = this.state.activeTurn;
    if (!active) {
      return;
    }
    this.setActiveTurn({
      id: active.id,
      turnId: active.turnId,
      role: active.role,
      text: `${active.text || ''}${delta}`,
      status: 'active',
      detail: active.detail,
      error: active.error,
      timestamp: active.timestamp,
      thinking: active.thinking,
      tools: active.tools,
      items: active.items,
      images: active.images,
      renderVersion: (active.renderVersion || 0) + delta.length
    });
  }

  private updateActiveTool(turnId: string, tool: RemoteToolStatusResponse): void {
    if (!this.state.activeTurn || this.state.activeTurn.turnId !== turnId) {
      this.setLocalActiveTurn(turnId);
    }
    const active = this.state.activeTurn;
    if (!active) {
      return;
    }
    const tools = (active.tools || []).filter((item: RemoteToolStatusResponse) => item.id !== tool.id);
    tools.push(tool);
    this.setActiveTurn({
      id: active.id,
      turnId: active.turnId,
      role: active.role,
      text: active.text,
      status: 'active',
      detail: active.detail,
      error: active.error,
      timestamp: active.timestamp,
      thinking: active.thinking,
      tools,
      items: active.items,
      images: active.images,
      renderVersion: (active.renderVersion || 0) + 1
    });
  }

  static optimisticMessagesNotPersisted(optimisticMessages: ChatMessage[], persistedMessages: ChatMessage[]): ChatMessage[] {
    // Consume acknowledgements one-to-one so two identical queued sends do not
    // both disappear when the first persisted message arrives.
    const acknowledgedPersistedIndexes = new Set<number>();
    return optimisticMessages.filter((pending: ChatMessage) => {
      const acknowledgedIndex = persistedMessages.findIndex((message: ChatMessage, index: number) => {
        return !acknowledgedPersistedIndexes.has(index) &&
          ChatTimelineStore.isPersistedUserDuplicate(pending, message);
      });
      if (acknowledgedIndex < 0) {
        return true;
      }
      acknowledgedPersistedIndexes.add(acknowledgedIndex);
      return false;
    });
  }

  static isActiveTurnCoveredByMessages(activeTurn: ChatMessage, messages: ChatMessage[]): boolean {
    if (activeTurn.id.length === 0) {
      return true;
    }
    return messages.some((message: ChatMessage) => {
      return ChatTimelineStore.isPersistedAssistantDuplicate(activeTurn, message);
    });
  }

  private coveredByPersistedMessage(activeTurn: ChatMessage | undefined, messages: ChatMessage[]): boolean {
    if (!activeTurn || activeTurn.id.length === 0) {
      return false;
    }
    return ChatTimelineStore.isActiveTurnCoveredByMessages(activeTurn, messages);
  }

  private coveredByNewAssistantContent(activeTurn: ChatMessage | undefined, messages: ChatMessage[]): boolean {
    if (!activeTurn || activeTurn.id.length === 0) {
      return false;
    }
    const activeText = (activeTurn.text || '').trim();
    if (activeText.length === 0) {
      return false;
    }
    return messages.some((message: ChatMessage) => {
      return message.role === 'assistant' && ChatTimelineStore.hasDisplayableAssistantFinal(message) &&
        (message.text || '').trim() === activeText;
    });
  }

  private activeTurnForState(activeTurn: ChatMessage | undefined): ChatMessage | undefined {
    if (activeTurn && activeTurn.id.length > 0) {
      return this.coveredByPersistedMessage(activeTurn, this.state.persistedMessages) ? undefined : activeTurn;
    }
    if (this.state.activeTurn && ChatTimelineStore.shouldHoldCompletedTurn(this.state.activeTurn) &&
      !this.coveredByPersistedMessage(this.state.activeTurn, this.state.persistedMessages)) {
      return this.state.activeTurn;
    }
    return undefined;
  }

  // The turn id to ask the desktop to cancel, or '' for "whatever is running
  // now". A placeholder turn carries a local message id rather than a turn id,
  // and offering that as one gets the cancel rejected as stale while the task
  // keeps going — so the placeholder window has to fall through to no id.
  static cancelableTurnId(activeTurn: ChatMessage): string {
    if (activeTurn.turnId && activeTurn.turnId.length > 0) {
      return activeTurn.turnId;
    }
    if (activeTurn.id.indexOf(PENDING_ACTIVE_TURN_ID_PREFIX) === 0) {
      return '';
    }
    return activeTurn.id.indexOf('active-') === 0 ? activeTurn.id.slice('active-'.length) : '';
  }

  private static isLocalPendingActiveTurn(activeTurn: ChatMessage): boolean {
    return activeTurn.id.indexOf(PENDING_ACTIVE_TURN_ID_PREFIX) === 0 &&
      (!activeTurn.turnId || activeTurn.turnId.length === 0);
  }

  private static emptyState(sessionId: string): ChatTimelineState {
    return {
      sessionId,
      persistedMessages: [],
      optimisticMessages: [],
      syncPhase: 'idle',
      cursor: {
        pollVersion: 0,
        knownMessageCount: 0,
        knownModelCatalogVersion: 0
      },
      modelCatalog: RemoteUiState.emptyModelCatalog(),
      selectedModelId: ''
    };
  }

  private static realMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.filter((message: ChatMessage) => {
      return !(message.id.indexOf('system-') === 0 && message.role === 'assistant');
    });
  }

  private static carrySteeringItems(
    activeTurn: ChatMessage | undefined,
    messages: ChatMessage[]
  ): ChatMessage[] {
    if (!activeTurn || !(activeTurn.items || []).some((item: ChatMessageItemResponse) =>
      (item.type || '').toLowerCase() === 'user-steering')) {
      return messages;
    }
    const activeTurnId = ChatTimelineStore.cancelableTurnId(activeTurn);
    if (activeTurnId.length === 0) {
      return messages;
    }
    return messages.map((message: ChatMessage) => {
      if (message.role !== 'assistant' || (message.turnId || '') !== activeTurnId) {
        return message;
      }
      return {
        id: message.id,
        turnId: message.turnId,
        role: message.role,
        text: message.text,
        status: message.status,
        renderVersion: (message.renderVersion || 0) + 1,
        detail: message.detail,
        error: message.error,
        timestamp: message.timestamp,
        thinking: message.thinking,
        tools: message.tools,
        items: ChatTimelineStore.mergeActiveItems(activeTurn.items || [], message.items || []),
        images: message.images
      };
    });
  }

  private static phaseForActiveTurn(activeTurn: ChatMessage | undefined, fallback: ChatSyncPhase): ChatSyncPhase {
    if (!activeTurn || activeTurn.id.length === 0) {
      return fallback === 'sending' ? 'sending' : 'idle';
    }
    const status = (activeTurn.status || '').toLowerCase();
    if (status === 'active') {
      return 'streaming';
    }
    if (status === 'completed') {
      return 'finalizing';
    }
    return fallback;
  }

  private static activeTurnForUpdate(previous: ChatMessage | undefined, incoming: ChatMessage | undefined): ChatMessage | undefined {
    if (!incoming || incoming.id.length === 0) {
      return undefined;
    }
    if (previous && previous.id.length > 0 && ChatTimelineStore.sameActiveTurn(previous, incoming)) {
      return ChatTimelineStore.mergeActiveTurn(previous, incoming);
    }
    return incoming;
  }

  private static sameActiveTurn(previous: ChatMessage, incoming: ChatMessage): boolean {
    const previousTurnId = previous.turnId || '';
    const incomingTurnId = incoming.turnId || '';
    if (previousTurnId.length > 0 && incomingTurnId.length > 0 && previousTurnId === incomingTurnId) {
      return true;
    }
    return previous.id === incoming.id &&
      ChatTimelineStore.isActiveTurnId(previous.id) &&
      ChatTimelineStore.isActiveTurnId(incoming.id);
  }

  private static mergeActiveTurn(previous: ChatMessage, incoming: ChatMessage): ChatMessage {
    const text = ChatTimelineStore.monotonicText(previous.text || '', incoming.text || '');
    const thinking = ChatTimelineStore.monotonicText(previous.thinking || '', incoming.thinking || '');
    const items = ChatTimelineStore.mergeActiveItems(previous.items || [], incoming.items || []);
    const images = incoming.images && incoming.images.length > 0 ? incoming.images : previous.images;
    const tools = incoming.tools !== undefined ? incoming.tools : previous.tools;
    const activeTurn: ChatMessage = {
      id: incoming.id,
      turnId: incoming.turnId || previous.turnId,
      role: incoming.role || previous.role,
      text,
      status: incoming.status || previous.status,
      detail: incoming.detail,
      error: incoming.error || previous.error,
      timestamp: incoming.timestamp || previous.timestamp,
      thinking: thinking.length > 0 ? thinking : undefined,
      tools,
      items,
      images,
      renderVersion: incoming.renderVersion
    };
    return activeTurn;
  }

  private static mergeActiveItems(
    previousItems: ChatMessageItemResponse[],
    incomingItems: ChatMessageItemResponse[]
  ): ChatMessageItemResponse[] {
    if (incomingItems.length === 0) {
      return previousItems;
    }
    // Poll snapshots can temporarily omit an item while the desktop turn is
    // being assembled. Keep the existing order and merge tool rows by their
    // stable id instead of treating the array index as identity.
    const merged = previousItems.slice();
    const matched = new Set<number>();
    incomingItems.forEach((incoming: ChatMessageItemResponse, incomingIndex: number) => {
      let matchIndex = -1;
      const incomingToolId = incoming.tool ? (incoming.tool.id || '') : '';
      const incomingSteeringId = incoming.steering_id || '';
      if (incomingSteeringId.length > 0) {
        matchIndex = previousItems.findIndex((previous: ChatMessageItemResponse, index: number) => {
          return !matched.has(index) && previous.steering_id === incomingSteeringId;
        });
      } else if (incomingToolId.length > 0) {
        matchIndex = previousItems.findIndex((previous: ChatMessageItemResponse, index: number) => {
          return !matched.has(index) && previous.tool !== undefined &&
            (previous.tool.id || '') === incomingToolId;
        });
      } else if (incomingIndex < previousItems.length &&
        !matched.has(incomingIndex) &&
        ChatTimelineStore.sameActiveItem(previousItems[incomingIndex], incoming)) {
        matchIndex = incomingIndex;
      }
      if (matchIndex >= 0) {
        merged[matchIndex] = ChatTimelineStore.mergeActiveItem(previousItems[matchIndex], incoming);
        matched.add(matchIndex);
      } else {
        merged.push(incoming);
      }
    });
    return merged;
  }

  private static mergeActiveItem(
    previous: ChatMessageItemResponse,
    incoming: ChatMessageItemResponse
  ): ChatMessageItemResponse {
    const content = ChatTimelineStore.shouldMergeItemContent(previous, incoming)
      ? ChatTimelineStore.monotonicText(previous.content || '', incoming.content || '')
      : (incoming.content !== undefined ? incoming.content : previous.content);
    const subItems = ChatTimelineStore.mergeActiveItems(previous.subItems || [], incoming.subItems || []);
    const item: ChatMessageItemResponse = {
      type: incoming.type !== undefined ? incoming.type : previous.type,
      steering_id: incoming.steering_id !== undefined ? incoming.steering_id : previous.steering_id,
      round_index: incoming.round_index !== undefined ? incoming.round_index : previous.round_index,
      content,
      tool: incoming.tool !== undefined
        ? ChatTimelineStore.mergeTool(previous.tool, incoming.tool)
        : previous.tool,
      is_subagent: incoming.is_subagent !== undefined ? incoming.is_subagent : previous.is_subagent,
      subItems,
      images: incoming.images !== undefined ? incoming.images : previous.images
    };
    return item;
  }

  private static sameActiveItem(previous: ChatMessageItemResponse, incoming: ChatMessageItemResponse): boolean {
    const previousType = (previous.type || '').toLowerCase();
    const incomingType = (incoming.type || '').toLowerCase();
    if (previousType !== incomingType) {
      return false;
    }
    const previousSteeringId = previous.steering_id || '';
    const incomingSteeringId = incoming.steering_id || '';
    if (previousSteeringId.length > 0 || incomingSteeringId.length > 0) {
      return previousSteeringId === incomingSteeringId;
    }
    const previousToolId = previous.tool ? (previous.tool.id || '') : '';
    const incomingToolId = incoming.tool ? (incoming.tool.id || '') : '';
    if (previousToolId.length > 0 || incomingToolId.length > 0) {
      return previousToolId === incomingToolId;
    }
    return true;
  }

  private static shouldMergeItemContent(previous: ChatMessageItemResponse, incoming: ChatMessageItemResponse): boolean {
    return ChatTimelineStore.isTextLikeItem(previous) && ChatTimelineStore.isTextLikeItem(incoming);
  }

  private static isTextLikeItem(item: ChatMessageItemResponse): boolean {
    const type = (item.type || '').toLowerCase();
    return type === 'text' || type === 'message' || type === 'thinking';
  }

  private static monotonicText(previous: string, incoming: string): string {
    if (incoming.length === 0) {
      return previous;
    }
    if (incoming.indexOf(previous) === 0) {
      return incoming;
    }
    if (previous.indexOf(incoming) === 0) {
      return previous;
    }
    if (incoming.length > previous.length && previous.length === 0) {
      return incoming;
    }
    return previous;
  }

  private static mergeTool(
    previous: RemoteToolStatusResponse | undefined,
    incoming: RemoteToolStatusResponse | undefined
  ): RemoteToolStatusResponse | undefined {
    if (!incoming) {
      return previous;
    }
    if (!previous) {
      return incoming;
    }
    const previousStatus = (previous.status || '').toLowerCase();
    const incomingStatus = (incoming.status || '').toLowerCase();
    const rank = (status: string): number => {
      if (status === 'pending_confirmation' || status === 'needs_confirmation' || status === 'pending') {
        return 1;
      }
      if (status === 'running' || status === 'active') {
        return 2;
      }
      if (status === 'completed' || status === 'success' || status === 'finished') {
        return 3;
      }
      if (status === 'rejected' || status === 'cancelled' || status === 'canceled' || status === 'error' || status === 'failed') {
        return 4;
      }
      return 0;
    };
    // A delayed poll must not move a completed tool back to running/pending.
    if (rank(incomingStatus) < rank(previousStatus)) {
      return previous;
    }
    // Completion snapshots from older desktop builds may carry only status and
    // result fields. Preserve the invocation metadata already observed while
    // the tool was running so Task/subagent titles do not collapse to "Task".
    return {
      id: incoming.id !== undefined ? incoming.id : previous.id,
      permission_request_id: incoming.permission_request_id,
      name: incoming.name !== undefined ? incoming.name : previous.name,
      status: incoming.status !== undefined ? incoming.status : previous.status,
      duration_ms: incoming.duration_ms !== undefined ? incoming.duration_ms : previous.duration_ms,
      start_ms: incoming.start_ms !== undefined ? incoming.start_ms : previous.start_ms,
      input_preview: (incoming.input_preview || '').length > 0 ? incoming.input_preview : previous.input_preview,
      tool_input: incoming.tool_input !== undefined ? incoming.tool_input : previous.tool_input,
      stdout: (incoming.stdout || '').length > 0 ? incoming.stdout : previous.stdout,
      stderr: (incoming.stderr || '').length > 0 ? incoming.stderr : previous.stderr,
      tool_output: incoming.tool_output !== undefined ? incoming.tool_output : previous.tool_output,
      result_preview: (incoming.result_preview || '').length > 0 ? incoming.result_preview : previous.result_preview,
      error_preview: (incoming.error_preview || '').length > 0 ? incoming.error_preview : previous.error_preview,
      exit_code: incoming.exit_code !== undefined ? incoming.exit_code : previous.exit_code,
      plan: incoming.plan !== undefined ? incoming.plan : previous.plan
    };
  }

  private static isActiveTurnId(id: string): boolean {
    return id.indexOf('active-') === 0;
  }

  private static isPersistedAssistantDuplicate(activeTurn: ChatMessage, message: ChatMessage): boolean {
    if (message.role !== 'assistant') {
      return false;
    }
    if (!ChatTimelineStore.hasDisplayableAssistantFinal(message)) {
      return false;
    }
    if (message.id === activeTurn.id) {
      return true;
    }
    if (activeTurn.turnId && activeTurn.turnId.length > 0 && message.id === `${activeTurn.turnId}_assistant`) {
      return true;
    }
    return activeTurn.turnId !== undefined && activeTurn.turnId.length > 0 &&
      message.turnId !== undefined && message.turnId === activeTurn.turnId;
  }

  private static shouldHoldCompletedTurn(activeTurn: ChatMessage): boolean {
    const status = (activeTurn.status || '').toLowerCase();
    return (status === 'completed' || status === 'done' || status === 'success') &&
      ChatTimelineStore.hasDisplayableAssistantFinal(activeTurn);
  }

  private static hasDisplayableAssistantFinal(message: ChatMessage): boolean {
    if ((message.text || '').trim().length > 0 && (message.text || '').trim() !== (message.thinking || '').trim()) {
      return true;
    }
    return ChatTimelineStore.lastTopLevelText(message.items || []).length > 0;
  }

  private static lastTopLevelText(items: ChatMessageItemResponse[]): string {
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index];
      const type = (item.type || '').toLowerCase();
      if ((item.content || '').trim().length > 0 &&
        !item.tool &&
        item.is_subagent !== true &&
        type !== 'thinking' &&
        type !== 'user-steering' &&
        type !== 'tool' &&
        type !== 'subagent' &&
        type !== 'agent') {
        return (item.content || '').trim();
      }
    }
    return '';
  }

  private static isPersistedUserDuplicate(pending: ChatMessage, message: ChatMessage): boolean {
    if (pending.role !== 'user' || message.role !== 'user') {
      return false;
    }
    if (pending.id === message.id) {
      return true;
    }
    const pendingTurnId = (pending.turnId || '').trim();
    const messageTurnId = (message.turnId || '').trim();
    if (pendingTurnId.length > 0 && messageTurnId.length > 0) {
      return pendingTurnId === messageTurnId;
    }
    const pendingText = (pending.text || '').trim();
    const messageText = (message.text || '').trim();
    if (pendingText.length === 0 || pendingText !== messageText) {
      return false;
    }
    return ChatTimelineStore.imageSignature(pending.images || []) === ChatTimelineStore.imageSignature(message.images || []);
  }

  private static imageSignature(images: ImageAttachment[]): string {
    return images.map((image: ImageAttachment) => {
      return `${image.name || ''}:${image.data_url || ''}`;
    }).sort().join('|');
  }
}
