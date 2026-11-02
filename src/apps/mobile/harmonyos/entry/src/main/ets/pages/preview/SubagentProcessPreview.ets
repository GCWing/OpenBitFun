import { ChatMessage } from '../../model/RemoteModels';
import { ChatTimelineRowStore, ObservableChatTimelineItem } from '../../model/ChatTimelineModels';
import { DurableSessionReducer, SessionRecord } from '../../services/DurableSessionReducer';
import { ChatTimelineStore } from '../../services/ChatTimelineStore';
import { HostSessionEvent } from '../../services/HostSessionStream';
import { ChatMessageStructurePolicy, StructuredRenderGroup } from '../policy/ChatMessageStructurePolicy';
import {
  ConversationUiMessage,
  ConversationUiMessageItem,
  toConversationUiMessage
} from '../state/ConversationUiModels';
import { ChatTimeline } from '../components/ChatTimeline';
import { ComposerBar } from '../components/ComposerBar';
import { INK, PAGE_BG } from '../components/Theme';

/** Typed fixtures for the tool payloads a Task branch is titled and read from. */
interface PreviewTaskInput {
  description: string;
  subagent_type: string;
}

interface PreviewReadInput {
  path: string;
}

/**
 * A running Task whose subagent process is published flat behind it.
 *
 * The fixture is the host's own durable record shape: the owner Task tool item
 * carries the child Session id, and every process record the child produces
 * repeats it, so the branch owner and its children both arrive marked. The
 * preview mounts the production reducer, timeline store and rows, so what it
 * draws is what a live session draws.
 */
@ComponentV2
export struct SubagentProcessPreview {
  private reducer: DurableSessionReducer = new DurableSessionReducer();
  private timeline: ChatTimelineStore = new ChatTimelineStore();
  private rowStore: ChatTimelineRowStore = new ChatTimelineRowStore();
  private taskCallId: string = 'task_call_preview';
  private childSessionId: string = 'child-session-preview';
  @Local rows: ObservableChatTimelineItem[] = [];
  @Local revision: number = 0;
  @Local step: number = 0;
  @Local summary: string = '';
  @Local connectionState: string = 'connected';
  @Local active: boolean = true;
  @Local stopRequests: number = 0;

  aboutToAppear(): void {
    this.timeline.reset('preview');
    this.reducer.apply(this.taskRecord(1, 'running', 'inprogress'));
    this.publish();
  }

  private taskRecord(revision: number, status: string, turnStatus: string): HostSessionEvent {
    const input: PreviewTaskInput = { description: 'Audit the payment module', subagent_type: 'Explore' };
    const payload: SessionRecord = {
      sessionId: 'preview', id: `item/${this.taskCallId}`, revision,
      turn: { turnId: 'turn', turnIndex: 0, sessionId: 'preview', timestamp: 1,
        userMessage: { id: 'user', content: 'Audit the payment module', timestamp: 1 }, status: turnStatus },
      round: { id: 'round', turnId: 'turn', roundIndex: 0, timestamp: 2, status: turnStatus },
      item: { type: 'tool', data: { id: this.taskCallId, orderIndex: 0, timestamp: 3,
        toolName: 'Task', startTime: 3, status,
        subagentSessionId: this.childSessionId,
        toolCall: { id: this.taskCallId, input } } }
    };
    return { session_id: 'preview', event: 'session-record', payload };
  }

  private childRecord(id: string, type: string, order: number, revision: number,
    content: string, toolName: string, status: string): HostSessionEvent {
    const input: PreviewReadInput = { path: 'src/payments.ts' };
    const payload: SessionRecord = {
      sessionId: 'preview', id: `item/${id}`, revision,
      turn: { turnId: 'turn', turnIndex: 0, sessionId: 'preview', timestamp: 1,
        userMessage: { id: 'user', content: 'Audit the payment module', timestamp: 1 }, status: 'inprogress' },
      round: { id: 'round', turnId: 'turn', roundIndex: 0, timestamp: 2, status: 'inprogress' },
      item: { type, data: { id, orderIndex: order, timestamp: 3, content,
        subagentSessionId: this.childSessionId,
        toolName, toolCall: { id, input }, status } }
    };
    return { session_id: 'preview', event: 'session-record', payload };
  }

  private publish(): void {
    const messages = this.reducer.messages();
    const active = messages.find((message: ChatMessage) => message.role === 'assistant' && message.status === 'active');
    this.timeline.applySnapshot({ sessionId: 'preview', cursor: {
      pollVersion: 0, knownMessageCount: messages.length, knownModelCatalogVersion: 0
    }, changed: true, title: '', sessionState: active ? 'active' : 'idle', newMessages: [],
      messageSnapshot: messages.filter((message: ChatMessage) => message !== active), activeTurn: active,
      shouldSyncAfterTurnEnded: false, historyRewritten: false, completedTurnId: '' });
    this.rows = this.rowStore.reconcile(this.timeline.project(false));
    this.revision++;
    const state = this.timeline.snapshot();
    this.active = state.activeTurn !== undefined;
    this.summary = this.summarize(state.activeTurn || state.persistedMessages
      .filter((message: ChatMessage) => message.role === 'assistant')
      .pop());
  }

  /**
   * The branch the bubble would draw, read through the production grouping
   * policy so the line states what is on screen rather than what was published.
   */
  private summarize(answer?: ChatMessage): string {
    if (!answer) {
      return 'step=0 children=0 phase=none';
    }
    const message: ConversationUiMessage = toConversationUiMessage(answer);
    const groups: StructuredRenderGroup[] = ChatMessageStructurePolicy.structuredGroups(
      message.items || [], 'item', (message.status || '') === 'active', message.status || 'done');
    const card = groups
      .filter((group: StructuredRenderGroup) => group.type === 'item' && group.items.length === 1)
      .map((group: StructuredRenderGroup) => group.items[0])
      .find((entry: ConversationUiMessageItem) => !!entry.tool && entry.tool.name === 'Task');
    const children = card && card.subItems ? card.subItems.length : 0;
    return `step=${this.step} children=${children} phase=${message.status || 'done'}`;
  }

  private next(): void {
    this.step++;
    if (this.step === 1) {
      this.reducer.apply(this.childRecord('child-think', 'thinking', 1, 2,
        'Reading the payment module', 'Read', 'running'));
    }
    if (this.step === 2) {
      this.reducer.apply(this.childRecord('child-read', 'tool', 2, 3,
        '', 'Read', 'completed'));
    }
    if (this.step === 3) {
      this.reducer.apply(this.childRecord('child-text', 'text', 3, 4,
        'Found no hard-coded keys', 'Read', 'completed'));
    }
    if (this.step === 4) {
      this.reducer.apply(this.childRecord('child-grep', 'tool', 4, 5,
        '', 'Grep', 'running'));
    }
    if (this.step === 5) {
      this.reducer.apply(this.childRecord('child-grep', 'tool', 4, 6,
        '', 'Grep', 'completed'));
    }
    if (this.step === 6) {
      this.reducer.apply(this.taskRecord(7, 'completed', 'completed'));
    }
    this.publish();
  }

  build() {
    Column({ space: 8 }) {
      Button('Next step').id('subagent-next').onClick(() => { this.next(); })
      Text(this.summary).id('subagent-summary').fontColor(INK)
      Row({ space: 8 }) {
        Button('Host offline').id('subagent-offline').onClick(() => { this.connectionState = 'reconnecting'; })
        Button('Host returned').id('subagent-returned').onClick(() => {
          this.connectionState = 'connected';
          this.publish();
        })
      }
      Text(`${this.connectionState} stops=${this.stopRequests}`).id('subagent-host-state').fontColor(INK)
      ChatTimeline({ timelineItems: this.rows, timelineRevision: this.revision,
        connectionState: this.connectionState, isBusy: this.active }).layoutWeight(1)
      ComposerBar({ canStop: this.active, connectionState: this.connectionState,
        onStop: () => { this.stopRequests++; } })
    }.width('100%').height('100%').backgroundColor(PAGE_BG)
  }
}
