import { ChatMessage, RemoteModelCatalog } from '../../model/RemoteModels';
import { ChatTimelineRowStore, ObservableChatTimelineItem } from '../../model/ChatTimelineModels';
import { ChatSessionController, ChatSessionSnapshot } from '../../services/ChatSessionController';
import { ChatTimelineStore } from '../../services/ChatTimelineStore';
import { HostSessionCallbacks, HostSessionStream } from '../../services/HostSessionStream';
import { RemoteChatBranchCache } from '../../services/RemoteChatBranchCache';
import { RemoteChatCache } from '../../services/RemoteChatCache';
import { RemoteChatLocalRdbStore } from '../../services/RemoteChatLocalRdbStore';
import { RemoteLogger } from '../../services/RemoteLogger';
import { RemoteSessionManager } from '../../services/RemoteSessionManager';
import { SubagentFollowState } from '../../services/SubagentStreamCoordinator';
import { ChatMessageStructurePolicy, StructuredRenderGroup } from '../policy/ChatMessageStructurePolicy';
import {
  ConversationUiMessage,
  ConversationUiMessageItem,
  toConversationUiMessage
} from '../state/ConversationUiModels';
import { SubagentBranchExpansionState } from '../state/SubagentBranchExpansionState';
import { ChatTimeline } from '../components/ChatTimeline';
import { ComposerBar } from '../components/ComposerBar';
import { INK, PAGE_BG } from '../components/Theme';
import {
  SWARM_PREVIEW_DEVICE_KEY,
  SwarmBeatScript,
  SwarmLedger,
  SwarmScript,
  SWARM_WIDE_WORKERS,
  SwarmWideScript,
  wideSpawnId
} from './SubagentSwarmFixture';

/** How long one beat of the swarm waits before it publishes; device capture is manual too. */
const SWARM_BEAT_INTERVAL_MS: number = 900;
/**
 * How far the preview's own controls sit below the top of the screen.
 *
 * The page draws under the system status bar, and this band is the fixture's
 * controls plus the reading a capture has to carry: starting them at the very
 * top puts both under the clock and the battery indicator, where half a line is
 * unreadable and a control half covered by an overlay is a control that cannot
 * be pressed.
 */
const PREVIEW_TOP_INSET: number = 148;
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
 *
 * Three variants of it are launchable, chosen by the `previewOption` ability
 * parameter rather than by a scenario id of their own:
 *
 * - nothing (`subagent-swarm`): the three-worker swarm, one beat at a time, which
 *   is the walk through a launch, a running worker and a settled launch;
 * - `wide`: the ten-worker delegation, published at once, which is what the
 *   per-session follow cap is for;
 * - `restart`: the same swarm with every worker's own stream answering nothing,
 *   the way a phone that just started finds them, so every step a card still
 *   shows came out of the transcript cache.
 */
@ComponentV2
export struct SubagentProcessPreview {
  private fixture: SwarmLedger = new SwarmLedger();
  private script: SwarmBeatScript = new SwarmScript(this.fixture);
  private source: SwarmSessionSource = new SwarmSessionSource(this.fixture);
  private timeline: ChatTimelineStore = new ChatTimelineStore();
  private rowStore: ChatTimelineRowStore = new ChatTimelineRowStore();
  private transcriptCache: RemoteChatCache =
    new RemoteChatCache(new RemoteChatLocalRdbStore(), (): string => SWARM_PREVIEW_DEVICE_KEY);
  private branchCache: RemoteChatBranchCache = new RemoteChatBranchCache(this.transcriptCache);
  private controller?: ChatSessionController;
  private timer: number = -1;
  private option: string = '';
  private sessionId: string = '';
  /** The reader's disclosures, kept by this preview exactly as the conversation keeps them. */
  @Local expanded: SubagentBranchExpansionState = new SubagentBranchExpansionState();
  @Local rows: ObservableChatTimelineItem[] = [];
  @Local revision: number = 0;
  @Local summary: string = '';
  @Local connectionState: string = 'connected';
  @Local active: boolean = true;
  @Local paused: boolean = false;
  @Local failure: string = '';
  @Local stopRequests: number = 0;
  @Local followCursor: number = 0;

  async aboutToAppear(): Promise<void> {
    this.option = AppStorage.get<string>('previewOption') ?? '';
    if (this.option === 'wide') this.script = new SwarmWideScript(this.fixture);
    this.sessionId = this.script.parentSession();
    this.timeline.reset(this.sessionId);
    // The turn's own opening records are published before the session is read,
    // like a history page; every later beat arrives as a live publication.
    this.script.advance();
    if (this.option === 'restart') {
      this.fixture.muteSessions(this.script.childSessions());
    }
    const hostContext = this.getUIContext().getHostContext();
    if (hostContext) await this.transcriptCache.init(hostContext);
    this.controller = new ChatSessionController(this.source, {
      onSnapshot: (snapshot: ChatSessionSnapshot): void => { this.applySnapshot(snapshot); },
      canPoll: (_sessionId: string): boolean => true,
      onError: (error: Object): void => { this.report(error); }
    }, { initialPollDelayMs: 0, branchCache: this.branchCache });
    this.controller.start(this.sessionId, {
      pollVersion: 0, knownMessageCount: 0, knownModelCatalogVersion: 0
    });
    if (this.option === 'wide' || this.option === 'restart') {
      // Nothing is left to play beat by beat: the whole delegation is published,
      // and what the cards then hold is what the preview is here to state.
      this.script.drain();
      this.pause();
      return;
    }
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
    this.nextBeat();
  }

  /**
   * Publishes the next beat, whether the automatic beats are running or held.
   *
   * Stepping by hand is what a capture needs: a card can only be opened while its
   * worker is mid-turn if the beats stand still while the reader does it, and a
   * held fixture that could not be stepped would make every capture start again.
   */
  private nextBeat(): void {
    if (!this.script.advance()) {
      this.pause();
      return;
    }
    // The reading follows the script, not only the snapshots: a beat that moves a
    // worker without moving the parent transcript publishes no snapshot, and the
    // line a capture carries has to keep up with the beats that were played.
    this.refreshSummary();
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
   * Asks for one card's worker to be followed, the way opening a card does.
   *
   * The follow cap releases the oldest working child when a wider delegation
   * arrives, so a card can be drawn from a branch whose stream is not open. The
   * request is the same one the card raises when the reader opens it, and it is
   * idempotent for a worker already being followed.
   */
  private followOneCard(): void {
    const children = this.script.childSessions();
    if (children.length === 0) return;
    const index = this.followCursor % children.length;
    this.followCursor++;
    const branchId = this.option === 'wide' ? wideSpawnId(index) : 'swarm-docs-spawn';
    this.controller?.ensureBranchSubscribed(branchId);
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
   *
   * The follow reading is the other half of that evidence: how many branches the
   * session has, how many of their child streams are open, how many are waiting
   * for a slot, and how many steps a card is drawing out of the transcript cache
   * rather than off a stream.
   */
  /**
   * Opens or closes one card's disclosure, exactly as the card's own header does.
   *
   * The preview carries this because the emulator's own input tool cannot deliver
   * a tap to a row inside this list: every coordinate inside a card header is
   * reported as a clickable node and still reaches nothing, while the controls
   * above the list work. The gesture is the card's — the same keyed disclosure,
   * the same request to follow the worker — so what a capture then shows is the
   * card reading state that outlived its row.
   */
  private toggleCard(index: number): void {
    const cards = this.branchCards();
    if (cards.length === 0) return;
    const card = cards[(index + cards.length) % cards.length];
    const branchId = card.tool?.id || '';
    if (branchId.length === 0) return;
    if (this.expanded.toggle(branchId)) this.controller?.ensureBranchSubscribed(branchId);
    this.refreshSummary();
  }

  private refreshSummary(): void {
    const cards = this.branchCards();
    const steps = cards.map((card: ConversationUiMessageItem) => (card.subItems || []).length).join(',');
    const statuses = cards.map((card: ConversationUiMessageItem) => card.tool?.status || '').join(',');
    const follow: SubagentFollowState | undefined = this.controller?.subagentFollowState();
    const followText = follow === undefined ? 'streams=?' :
      `streams=${follow.subscribed}/${follow.branches} waiting=${follow.waiting} restored=${follow.restored}`;
    const open = this.expanded.expandedKeys().join(',');
    this.summary = `swarm option=${this.option.length > 0 ? this.option : 'live'} ` +
      `step=${this.script.position()}/${this.script.beatCount()} paused=${this.paused ? 1 : 0} ` +
      `rows=${this.rows.length} cards=${cards.length} steps=[${steps}] status=[${statuses}] ` +
      `open=[${open}] ${followText}` +
      (this.failure.length > 0 ? ` failure=${this.failure}` : '');
    // The same reading into the device log, so a run can be checked as text and
    // not only as pixels: what a capture shows is one frame of this sequence.
    RemoteLogger.info(this.summary);
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
      Row({ space: 8 }) {
        Button('Next beat').id('subagent-next').onClick(() => { this.nextBeat(); })
        Button(this.paused ? 'Resume' : 'Pause').id('subagent-pause').onClick(() => {
          if (this.paused) {
            this.paused = false;
            if (this.timer === -1) this.timer = setInterval((): void => { this.tick(); }, SWARM_BEAT_INTERVAL_MS);
            this.refreshSummary();
          } else {
            this.pause();
          }
        })
        Button(this.option === 'wide' ? `Follow card ${this.followCursor % SWARM_WIDE_WORKERS}` : 'Follow docs card')
          .id('subagent-follow-card').onClick(() => { this.followOneCard(); })
      }
      Row({ space: 8 }) {
        Button('Refresh state').id('subagent-refresh').onClick(() => { this.refreshSummary(); })
        Button('Toggle card').id('subagent-toggle-card').onClick(() => { this.toggleCard(-1); })
        Button('Host offline').id('subagent-offline').onClick(() => { this.connectionState = 'reconnecting'; })
        Button('Host returned').id('subagent-returned').onClick(() => { this.connectionState = 'connected'; })
      }
      // Below the controls rather than above them: the reading is the evidence a
      // capture has to carry, and the line above the buttons sits under the
      // system status bar where half of it cannot be read.
      Text(this.summary).id('subagent-summary').fontSize(10).fontColor(INK).width('100%')
      Text(`${this.connectionState} stops=${this.stopRequests}`).id('subagent-host-state').fontSize(10).fontColor(INK)
      ChatTimeline({
        timelineItems: this.rows, timelineRevision: this.revision,
        connectionState: this.connectionState, isBusy: this.active,
        subagentBranches: this.expanded,
        onBranchExpanded: (branchId: string): void => {
          this.controller?.ensureBranchSubscribed(branchId);
        }
      }).layoutWeight(1)
      ComposerBar({
        canStop: this.active, connectionState: this.connectionState,
        onStop: () => { this.stopRequests++; }
      })
    }.width('100%').height('100%').backgroundColor(PAGE_BG).padding({ top: PREVIEW_TOP_INSET })
  }
}
