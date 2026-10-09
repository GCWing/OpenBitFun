import { ChatMessage, RemoteModelCatalog } from '../../model/RemoteModels';
import { ChatTimelineRowStore, ObservableChatTimelineItem } from '../../model/ChatTimelineModels';
import { ChatSessionController, ChatSessionSnapshot } from '../../services/ChatSessionController';
import { ChatTimelineStore } from '../../services/ChatTimelineStore';
import { HostSessionCallbacks, HostSessionStream } from '../../services/HostSessionStream';
import { RemoteSessionManager } from '../../services/RemoteSessionManager';
import { ChatMessageStructurePolicy, StructuredRenderGroup } from '../policy/ChatMessageStructurePolicy';
import {
  ConversationUiMessage,
  ConversationUiMessageItem,
  toConversationUiMessage
} from '../state/ConversationUiModels';
import { ChatTimeline } from '../components/ChatTimeline';
import { ComposerBar } from '../components/ComposerBar';
import { INK, PAGE_BG } from '../components/Theme';
import { SWARM_PARENT_SESSION, SwarmLedger, SwarmScript } from './SubagentSwarmFixture';

/** How long one beat of the swarm waits before it publishes; device capture is manual too. */
const SWARM_BEAT_INTERVAL_MS: number = 900;
const SWARM_PREVIEW_CATALOG: RemoteModelCatalog = { version: 1, models: [], default_models: {} };

/**
 * The runtime connection, over the fixture's pages.
 *
 * Only stream opening and the model catalog are answered: the controller reads
 * every session — the one on screen and every spawned worker — through the same
 * call production makes, so the fixture exercises the production stream reader,
 * reducer, timeline store, projection and card instead of a preview-only path.
 */
class SwarmSessionSource extends RemoteSessionManager {
  private fixture: SwarmLedger;

  constructor(fixture: SwarmLedger) {
    super();
    this.fixture = fixture;
  }

  subscribeSession(sessionId: string, callbacks: HostSessionCallbacks): HostSessionStream {
    return this.fixture.openStream(sessionId, callbacks);
  }

  async getModelCatalog(_sessionId?: string): Promise<RemoteModelCatalog> {
    return SWARM_PREVIEW_CATALOG;
  }
}

/**
 * A swarm session rendered by the production transcript.
 *
 * The fixture publishes a parent session whose delegation items name the child
 * sessions they started, and those children publish their own records on their
 * own streams. Nothing here hands the timeline a prepared branch: the records go
 * through the controller, the reducer and the store, and what the card draws is
 * what a live session draws.
 */
@ComponentV2
export struct SubagentProcessPreview {
  private fixture: SwarmLedger = new SwarmLedger();
  private script: SwarmScript = new SwarmScript(this.fixture);
  private source: SwarmSessionSource = new SwarmSessionSource(this.fixture);
  private timeline: ChatTimelineStore = new ChatTimelineStore();
  private rowStore: ChatTimelineRowStore = new ChatTimelineRowStore();
  private controller?: ChatSessionController;
  private timer: number = -1;
  @Local rows: ObservableChatTimelineItem[] = [];
  @Local revision: number = 0;
  @Local summary: string = '';
  @Local connectionState: string = 'connected';
  @Local active: boolean = true;
  @Local paused: boolean = false;
  @Local failure: string = '';
  @Local stopRequests: number = 0;

  aboutToAppear(): void {
    this.timeline.reset(SWARM_PARENT_SESSION);
    // The turn's own opening records are published before the session is read,
    // like a history page; every later beat arrives as a live publication.
    this.script.advance();
    this.controller = new ChatSessionController(this.source, {
      onSnapshot: (snapshot: ChatSessionSnapshot): void => { this.applySnapshot(snapshot); },
      canPoll: (_sessionId: string): boolean => true,
      onError: (error: Object): void => { this.report(error); }
    }, { initialPollDelayMs: 0 });
    this.controller.start(SWARM_PARENT_SESSION, {
      pollVersion: 0, knownMessageCount: 0, knownModelCatalogVersion: 0
    });
    this.timer = setInterval((): void => { this.tick(); }, SWARM_BEAT_INTERVAL_MS);
  }

  aboutToDisappear(): void {
    if (this.timer !== -1) {
      clearInterval(this.timer);
      this.timer = -1;
    }
    this.controller?.stop();
  }

  private tick(): void {
    if (this.paused) return;
    if (!this.script.advance()) {
      this.pause();
      return;
    }
  }

  private pause(): void {
    this.paused = true;
    if (this.timer !== -1) {
      clearInterval(this.timer);
      this.timer = -1;
    }
    this.refreshSummary();
  }

  private applySnapshot(snapshot: ChatSessionSnapshot): void {
    this.timeline.applySnapshot(snapshot);
    this.rows = this.rowStore.reconcile(this.timeline.project(false));
    this.revision++;
    const state = this.timeline.snapshot();
    this.active = state.activeTurn !== undefined;
    this.refreshSummary();
  }

  /**
   * A stream failure stays visible instead of stopping the fixture: the band
   * states it, and the swarm keeps publishing, so a broken child stream cannot
   * be mistaken for a worker that had nothing to say.
   */
  private report(error: Object): void {
    this.failure = (error as Error).message || 'stream failed';
    this.refreshSummary();
  }

  /**
   * What the transcript currently holds, read back through the production
   * grouping policy: how many cards the turn draws and how many steps each of
   * them has. A worker's step count only rises while its stream is live, which
   * is the evidence a screenshot alone cannot state.
   */
  private refreshSummary(): void {
    const cards = this.branchCards();
    const steps = cards.map((card: ConversationUiMessageItem) => (card.subItems || []).length).join(',');
    this.summary = `swarm step=${this.script.position()}/${this.script.beatCount()} paused=${this.paused ? 1 : 0} ` +
      `rows=${this.rows.length} cards=${cards.length} steps=[${steps}]` +
      (this.failure.length > 0 ? ` failure=${this.failure}` : '');
  }

  private branchCards(): ConversationUiMessageItem[] {
    const state = this.timeline.snapshot();
    let answer = state.activeTurn;
    if (!answer) {
      state.persistedMessages.forEach((message: ChatMessage) => {
        if (message.role === 'assistant') answer = message;
      });
    }
    if (!answer) return [];
    const message: ConversationUiMessage = toConversationUiMessage(answer);
    const groups: StructuredRenderGroup[] = ChatMessageStructurePolicy.structuredGroups(
      message.items || [], 'item', (message.status || '') === 'active', message.status || 'done');
    return groups
      .filter((group: StructuredRenderGroup) => group.type === 'item' && group.items.length === 1)
      .map((group: StructuredRenderGroup) => group.items[0])
      .filter((entry: ConversationUiMessageItem) => ChatMessageStructurePolicy.isSubagentEntry(entry));
  }

  build() {
    Column({ space: 6 }) {
      Text(this.summary).id('subagent-summary').fontSize(10).fontColor(INK).width('100%')
      Row({ space: 8 }) {
        Button('Next beat').id('subagent-next').onClick(() => { this.tick(); })
        Button(this.paused ? 'Resume' : 'Pause').id('subagent-pause').onClick(() => {
          if (this.paused) {
            this.paused = false;
            if (this.timer === -1) this.timer = setInterval((): void => { this.tick(); }, SWARM_BEAT_INTERVAL_MS);
            this.refreshSummary();
          } else {
            this.pause();
          }
        })
        Button('Host offline').id('subagent-offline').onClick(() => { this.connectionState = 'reconnecting'; })
        Button('Host returned').id('subagent-returned').onClick(() => { this.connectionState = 'connected'; })
      }
      Text(`${this.connectionState} stops=${this.stopRequests}`).id('subagent-host-state').fontSize(10).fontColor(INK)
      ChatTimeline({
        timelineItems: this.rows, timelineRevision: this.revision,
        connectionState: this.connectionState, isBusy: this.active
      }).layoutWeight(1)
      ComposerBar({
        canStop: this.active, connectionState: this.connectionState,
        onStop: () => { this.stopRequests++; }
      })
    }.width('100%').height('100%').backgroundColor(PAGE_BG)
  }
}
