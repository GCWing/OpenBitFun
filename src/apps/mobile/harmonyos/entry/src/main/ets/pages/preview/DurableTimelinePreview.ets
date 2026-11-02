import { ChatMessage } from '../../model/RemoteModels';
import { ChatTimelineRowStore, ObservableChatTimelineItem } from '../../model/ChatTimelineModels';
import { DurableSessionReducer, SessionRecord } from '../../services/DurableSessionReducer';
import { ChatTimelineStore } from '../../services/ChatTimelineStore';
import { HostSessionEvent } from '../../services/HostSessionStream';
import { ChatTimeline } from '../components/ChatTimeline';
import { ComposerBar } from '../components/ComposerBar';
import { INK, PAGE_BG } from '../components/Theme';

/** Network-free replay through the production reducer, store and native rows. */
@ComponentV2
export struct DurableTimelinePreview {
  private reducer: DurableSessionReducer = new DurableSessionReducer();
  private timeline: ChatTimelineStore = new ChatTimelineStore();
  private rowStore: ChatTimelineRowStore = new ChatTimelineRowStore();
  @Local rows: ObservableChatTimelineItem[] = [];
  @Local revision: number = 0;
  @Local step: number = 0;
  @Local summary: string = '';
  @Local connectionState: string = 'connected';
  @Local active: boolean = true;
  @Local stopRequests: number = 0;

  aboutToAppear(): void {
    this.timeline.reset('preview');
    this.reducer.apply(this.record('reason', 'thinking', 0, 1, 'Reason probe'));
    this.reducer.apply(this.record('answer', 'text', 2, 2, 'Answer probe'));
    this.publish();
  }

  private record(id: string, type: string, order: number, revision: number,
    content: string, status: string = 'inprogress'): HostSessionEvent {
    const payload: SessionRecord = {
      sessionId: 'preview', id: `item/${id}`, revision,
      turn: { turnId: 'turn', turnIndex: 0, sessionId: 'preview', timestamp: 1,
        userMessage: { id: 'user', content: 'Timeline probe', timestamp: 1 }, status },
      round: { id: 'round', turnId: 'turn', roundIndex: 0, timestamp: 2, status: 'completed' },
      item: { type, data: { id, orderIndex: order, timestamp: 3, content,
        toolName: 'Read', toolCall: { id, input: new Object() }, status: 'completed' } }
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
    const answer = state.activeTurn || state.persistedMessages.find((message: ChatMessage) => message.role === 'assistant');
    this.summary = `step=${this.step} blocks=${answer?.items?.length || 0} active=${state.activeTurn ? 1 : 0}`;
  }

  private next(): void {
    this.step++;
    if (this.step === 1) this.reducer.apply(this.record('tool', 'tool', 1, 3, ''));
    if (this.step === 2) {
      for (let index = 0; index < 30; index++) this.publish();
    }
    if (this.step === 3) this.reducer.apply(this.record('answer', 'text', 2, 4, 'Corrected probe'));
    if (this.step === 4) {
      const payload: SessionRecord = { sessionId: 'preview', id: 'item/reason', revision: 5, deleted: true };
      this.reducer.apply({ session_id: 'preview', event: 'session-record', payload });
    }
    if (this.step === 5) this.reducer.apply(this.record('answer', 'text', 2, 6, 'Final probe', 'completed'));
    this.publish();
  }

  build() {
    Column({ space: 8 }) {
      Button('Next replay').id('timeline-next').onClick(() => { this.next(); })
      Text(this.summary).id('timeline-summary').fontColor(INK)
      Row({ space: 8 }) {
        Button('Host offline').id('host-offline').onClick(() => { this.connectionState = 'reconnecting'; })
        Button('Host returned').id('host-returned').onClick(() => {
          this.reducer.apply(this.record('answer', 'text', 2, 100, 'Interrupted probe', 'cancelled'));
          this.connectionState = 'connected';
          this.publish();
        })
      }
      Text(`${this.connectionState} stops=${this.stopRequests}`).id('host-state').fontColor(INK)
      ChatTimeline({ timelineItems: this.rows, timelineRevision: this.revision,
        connectionState: this.connectionState, isBusy: this.active }).layoutWeight(1)
      ComposerBar({ canStop: this.active, connectionState: this.connectionState,
        onStop: () => { this.stopRequests++; } })
    }.width('100%').height('100%').backgroundColor(PAGE_BG)
  }
}
