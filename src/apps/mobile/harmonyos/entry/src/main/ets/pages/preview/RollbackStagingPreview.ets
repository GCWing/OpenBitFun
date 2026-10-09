import { ChatMessage, SelectedImageAttachment, SessionRolledBackResult } from '../../model/RemoteModels';
import { ObservableChatTimelineItem } from '../../model/ChatTimelineModels';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { DeviceApiLevelService } from '../../services/DeviceApiLevelService';
import { RemoteChatCache, RemoteChatCacheSlice, RemoteChatCacheStore } from '../../services/RemoteChatCache';
import { RemoteChatCommandController } from '../../services/RemoteChatCommandController';
import { RollbackFailureKind, RollbackOutcomePolicy } from '../../services/RollbackOutcomePolicy';
import { ConversationIntent, ConversationIntentType, SessionRollbackRequest } from '../actions/ConversationIntent';
import { ComposerPresentation } from '../components/ComposerBar';
import { ConversationView } from '../components/ConversationView';
import { ConversationViewOptions } from '../components/ConversationViewContract';
import { INK, LINE, MUTED, PAGE_BG, SOFT } from '../components/Theme';
import { WideLayoutGeometry } from '../layout/WideLayoutGeometry';
import { AdaptiveLayoutInput } from '../policy/AdaptiveLayoutInput';
import { ConversationLayoutPolicy } from '../policy/ConversationLayoutPolicy';
import { RollbackEntryFacts, RollbackPresentationPolicy } from '../policy/RollbackPresentationPolicy';
import { SessionRollbackEventType } from '../policy/SessionRollbackPolicy';
import {
  SettingsPlacement,
  SettingsPlacementPolicy,
  SettingsSheetKind
} from '../policy/SettingsPlacementPolicy';
import { ChatSurface } from '../state/ChatSurface';
import { REMOTE_CHAT_COMPOSER_CAPABILITIES } from '../state/ChatComposerCapabilities';
import { ConversationViewState } from '../state/ConversationViewState';
import {
  RollbackPreviewScenario,
  RollbackPreviewTranscript,
  RollbackPreviewTransport,
  RollbackPreviewVariant
} from './RollbackPreviewScenario';

/**
 * The staged rollback on a device, over a mock host.
 *
 * The frozen interaction (`.openbitfun/plans/mobile-copy-rollback.plan.md`,
 * decision 4) is a chain of things a screenshot can only half show: the entry
 * lives inside a system selection menu, the staging is a local preview that sends
 * nothing, and the three exits differ in what they do to the composer and to the
 * timeline. The production `ConversationView` draws all of it here unchanged; what
 * the fixture replaces is the host behind it.
 *
 * The fake sits at the seam `ComposerSubmissionPreview` already uses — the
 * `RemoteChatCommandClient` the production `RemoteChatCommandController` owns — so
 * both steps of the send-while-staging exit run through the production command
 * layer, and the transport records what it was asked for, in order. The strip
 * above the pane prints that record, because "the rollback reached the host before
 * the send did" is not a claim the pixels of the pane can carry.
 *
 * A scenario id picks the mock's answer and nothing else: the pane, the
 * presentation and the sheet placement follow the real window, so the same fixture
 * covers a phone and a tablet. Colour mode is a launch-level fact owned by
 * `EntryAbility`, which is what the `-dark` suffixes are for.
 */
@ComponentV2
export struct RollbackStagingPreview {
  @Local state: ConversationViewState = new ConversationViewState();
  @Local placement: SettingsPlacement =
    SettingsPlacementPolicy.compactBottom(SettingsSheetKind.UserMessageFullText);
  @Local apiLevel: number = 0;
  @Local variantLabel: string = '';
  @Local intentLog: string = '(none)';
  @Local hostLog: string = '(none)';
  @Local recoveryLog: string = '(none)';
  @Local draftLog: string = '(empty)';
  @Local noticeLog: string = '(none)';
  @Local toastLog: string = '(none)';
  @Local statusLog: string = '(none)';
  @Local viewportWidth: number = 0;

  private variant: RollbackPreviewVariant = RollbackPreviewVariant.Success;
  private transport: RollbackPreviewTransport =
    new RollbackPreviewTransport(RollbackPreviewVariant.Success);
  private command: RemoteChatCommandController = this.buildCommand(this.transport);
  /**
   * The mock transcript as the pane is showing it. A successful rollback takes the
   * retired rows out of it and a send adds its optimistic row, which is what the
   * production client does to its own rows behind a refetch.
   */
  private rows: ChatMessage[] = RollbackPreviewTranscript.messages();
  private draft: string = RollbackPreviewScenario.INITIAL_DRAFT;
  private notice: string = '';
  private outcome: string = '';
  private outcomeSeq: number = 0;
  private failedLocalId: string = '';
  private busy: boolean = false;
  private revision: number = 1;
  private sentRowCount: number = 0;

  aboutToAppear(): void {
    const scenarioId = this.scenarioId();
    this.variant = RollbackPreviewScenario.variant(scenarioId);
    this.variantLabel = `${RollbackPreviewScenario.baseId(scenarioId)} · ${this.variant}`;
    // The command layer is rebuilt over the variant's transport so the strip reads
    // the same call log the mock host writes.
    this.transport = new RollbackPreviewTransport(this.variant);
    this.command = this.buildCommand(this.transport);
    this.busy = RollbackPreviewScenario.sessionBusy(this.variant);
    this.draft = RollbackPreviewScenario.initialDraft(this.variant);
    this.apiLevel = DeviceApiLevelService.sdkApiVersion();
    this.project();
  }

  /**
   * The production command layer over the mock transport.
   *
   * The callbacks are the ones the app wires: the draft is captured before the RPC
   * and put back only if the send is refused, and a refused send marks its own row
   * while the draft stays editable.
   */
  private buildCommand(transport: RollbackPreviewTransport): RemoteChatCommandController {
    return new RemoteChatCommandController(transport, {
      onMessagesLoaded: () => {},
      onMessageCountKnown: () => {},
      onTimelineReady: () => {},
      onComposerPrepared: (_sessionId: string, rawText: string, _images: SelectedImageAttachment[]) => ({
        commit: (): void => {
          this.setDraft('');
        },
        rollback: (): void => {
          this.setDraft(rawText);
        }
      }),
      onSendSucceeded: (turnId: string, _pendingActiveId: string, _localMessageId: string) => {
        this.recoveryLog =
          RollbackStagingPreview.appendLog(this.recoveryLog, `send accepted -> ${turnId}`);
      },
      onSendFailed: (rawText: string, _images: SelectedImageAttachment[], localMessageId: string,
        _pendingActiveId: string) => {
        this.setDraft(rawText);
        this.markFailed(localMessageId);
        this.recoveryLog = RollbackStagingPreview.appendLog(this.recoveryLog, 'send failed, draft kept');
        this.statusLog = RemoteI18n.t('chat.sendFailed');
      },
      onActiveSession: () => {},
      onSessionTitleChanged: () => {},
      onStatusText: (statusText: string) => {
        this.statusLog = statusText.length > 0 ? statusText : '(none)';
      },
      onToast: () => {},
      onBusy: () => {},
      onPollRequested: () => {}
    }, new RemoteChatCache(new RollbackPreviewCacheStore(), () => 'rollback-preview'));
  }

  private scenarioId(): string {
    return AppStorage.get<string>('scenarioId') ?? RollbackPreviewScenario.DEFAULT_ID;
  }

  private isWideViewport(): boolean {
    return this.viewportWidth >= ConversationLayoutPolicy.MD_MIN_WIDTH;
  }

  private refreshGeometry(width: number, height: number): void {
    this.viewportWidth = width;
    this.placement = SettingsPlacementPolicy.resolve(
      new AdaptiveLayoutInput(width, height, 0, false, false, false, this.isWideViewport(), [], []),
      SettingsSheetKind.UserMessageFullText
    );
  }

  private options(): ConversationViewOptions {
    const options = new ConversationViewOptions();
    options.showSidebarButton = true;
    options.showBackButton = false;
    options.composerPresentation =
      this.isWideViewport() ? ComposerPresentation.Floating : ComposerPresentation.Compact;
    options.fullTextSheetPlacement = this.placement;
    return options;
  }

  /**
   * One fresh projection, the way the page does it: `ConversationViewState` is a
   * plain class the controller re-projects on every change, so a new object is what
   * re-renders the pane and what carries a host outcome into it.
   */
  private project(): void {
    const next = new ConversationViewState();
    next.surface = ChatSurface.Remote;
    next.connectionState = 'connected';
    next.activeSession = {
      sessionId: RollbackPreviewTranscript.SESSION_ID,
      title: 'Rollback staging',
      workspacePath: '/workspace',
      agentType: 'code'
    };
    next.desktopName = 'Studio';
    next.composerCapabilities = REMOTE_CHAT_COMPOSER_CAPABILITIES;
    next.timelineItems = this.timeline();
    next.timelineRevision = this.revision;
    next.chatInput = this.draft;
    next.isBusy = this.busy;
    next.canStop = this.busy;
    next.rollbackGate = new RollbackEntryFacts(
      RollbackPreviewScenario.hostCapabilities(this.variant), this.busy, false);
    next.rollbackNotice = this.notice;
    next.rollbackOutcome = this.outcome;
    next.rollbackOutcomeSeq = this.outcomeSeq;
    this.state = next;
    this.draftLog = this.draft.length > 0 ?
      `"${RollbackStagingPreview.head(this.draft)}" len=${this.draft.length}` : '(empty)';
    this.hostLog = this.transport.order();
    this.noticeLog = this.notice.length > 0 ? this.notice : '(none)';
  }

  private timeline(): ObservableChatTimelineItem[] {
    return this.rows.map((message: ChatMessage): ObservableChatTimelineItem => {
      return new ObservableChatTimelineItem({
        id: message.id,
        type: message.role === 'user' ? 'user_message' : 'assistant_message',
        message,
        isStreaming: false,
        isFinalizing: false,
        showRetryAction: message.id === this.failedLocalId
      });
    });
  }

  private async handleIntent(intent: ConversationIntent): Promise<void> {
    if (intent.type === ConversationIntentType.ChatInputChanged) {
      this.draft = intent.value;
      this.project();
      return;
    }
    if (intent.type === ConversationIntentType.RollbackSession) {
      const request: SessionRollbackRequest | undefined = intent.rollbackRequest;
      await this.runRollback(request ? request.targetTurnId : '', request ? request.sendText : '');
      return;
    }
    if (intent.type === ConversationIntentType.RollbackResync) {
      // What the pane asks for after a refusal: the authoritative transcript, which
      // for a mock host that never rewrote it is the transcript it began with.
      this.rows = RollbackPreviewTranscript.messages();
      this.failedLocalId = '';
      this.revision += 1;
      this.recoveryLog = RollbackStagingPreview.appendLog(this.recoveryLog, 'resync');
      this.project();
      return;
    }
    if (intent.type === ConversationIntentType.RollbackNotice) {
      // A refusal the pane says out loud. It is a toast in the app; here it is also
      // the strip, because a toast outlives its screenshot by two seconds.
      this.toastLog = RemoteI18n.t(intent.value);
      this.intentLog = `notice ${intent.value}`;
      return;
    }
    if (intent.type === ConversationIntentType.Send) {
      await this.sendFromComposer();
      return;
    }
    this.intentLog = `intent ${intent.type}`;
  }

  /**
   * One staged exit, run the way `RemoteTranscriptController.rollbackRemoteSession`
   * runs it: the rollback first, then the message it was staged with.
   *
   * That order is the contract — the host has to retire the turn before a message
   * may be appended to it — and the transport records the calls it received so the
   * strip can show `rollback→send` afterwards. The pane has already left staging by
   * then (that is the frozen interaction), so the answer comes back as a
   * projection: a notice row on success, a host outcome on a refusal.
   */
  private async runRollback(targetTurnId: string, sendText: string): Promise<void> {
    const target = targetTurnId.trim();
    const text = sendText.trim();
    this.intentLog = text.length > 0 ?
      `rollback_session then send (${text.length} chars)` : 'rollback_session';
    try {
      const result: SessionRolledBackResult = await this.command.rollbackSessionToTurn(
        RollbackPreviewTranscript.SESSION_ID, target);
      // The host rewrote history; the production client refetches the transcript
      // after a success, and this stands in for that refetch.
      this.rows = RollbackPreviewTranscript.rowsBefore(target);
      this.revision += 1;
      const notice = RemoteI18n.f2(
        RollbackPresentationPolicy.ROLLED_BACK_NOTICE_KEY,
        `${result.retiredTurnIds.length}`,
        `${result.restoredFiles.length}`
      );
      if (text.length > 0) {
        this.setDraft(text);
        // Production publishes the optimistic bubble before the RPC, so the row is
        // on screen whether or not the send reaches the host.
        const localMessageId = this.appendSentRow(text);
        await this.command.sendPreparedMessage(
          RollbackPreviewTranscript.SESSION_ID, text, 'code', text, [], [], localMessageId, '', false, true);
      }
      // Set after the send, the same way the production path does: a rollback that
      // succeeded still reports what it withdrew when the send fails.
      this.notice = notice;
      this.recoveryLog = RollbackStagingPreview.appendLog(
        this.recoveryLog, result.changed ? 'history rewritten' : 'history unchanged');
      this.project();
    } catch (err) {
      const kind = RollbackOutcomePolicy.failureKind(err);
      this.outcome = kind === RollbackFailureKind.StaleView ?
        SessionRollbackEventType.StaleViewDetected : SessionRollbackEventType.RollbackFailed;
      this.outcomeSeq += 1;
      this.intentLog = `rollback refused: ${RollbackOutcomePolicy.messageOf(err)}`;
      // The projection is what the pane reads the outcome from, and what makes it
      // resync and, for a failure, say so out loud.
      this.project();
    }
  }

  /** The ordinary send, for a session with no rollback staged. */
  private async sendFromComposer(): Promise<void> {
    const text = this.draft.trim();
    if (text.length === 0) {
      return;
    }
    this.intentLog = `send (${text.length} chars)`;
    const localMessageId = this.appendSentRow(text);
    await this.command.sendPreparedMessage(
      RollbackPreviewTranscript.SESSION_ID, text, 'code', text, [], [], localMessageId, '', false, true);
    this.project();
  }

  private setDraft(value: string): void {
    this.draft = value;
  }

  private appendSentRow(text: string): string {
    const id = `preview-sent-${this.sentRowCount}`;
    this.sentRowCount += 1;
    const row: ChatMessage = {
      id,
      role: 'user',
      text,
      status: 'sent',
      turnId: RollbackPreviewScenario.ACCEPTED_TURN_ID,
      detail: '',
      timestamp: '0'
    };
    this.rows = this.rows.concat([row]);
    this.revision += 1;
    return id;
  }

  /** Marks the optimistic row the way the app marks one the host refused. */
  private markFailed(localMessageId: string): void {
    this.failedLocalId = localMessageId;
    const updated: ChatMessage[] = [];
    for (let index = 0; index < this.rows.length; index += 1) {
      const row = this.rows[index];
      if (row.id !== localMessageId) {
        updated.push(row);
        continue;
      }
      updated.push({
        id: row.id,
        role: row.role,
        text: row.text,
        status: 'failed',
        turnId: row.turnId,
        detail: row.text,
        timestamp: row.timestamp
      });
    }
    this.rows = updated;
    this.revision += 1;
  }

  private static appendLog(log: string, entry: string): string {
    return log === '(none)' ? entry : `${log} · ${entry}`;
  }

  private static head(text: string): string {
    return text.replace(/\s+/g, ' ').substring(0, 24);
  }

  build() {
    Column() {
      this.Diagnostics()
      // The pane takes what is left of the window rather than the whole height: the
      // chat page puts its own overlay at the bottom of whatever box it is given,
      // so a pane measured at the window's height draws its composer off screen.
      Column() {
        this.Conversation()
      }
      .width('100%')
      .layoutWeight(1)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(PAGE_BG)
    .onAreaChange((_oldArea: Area, newArea: Area) => {
      this.refreshGeometry(
        WideLayoutGeometry.areaLength(newArea.width),
        WideLayoutGeometry.areaLength(newArea.height)
      );
    })
  }

  @Builder
  private Conversation() {
    ConversationView({
      state: this.state,
      options: this.options(),
      onIntent: (intent: ConversationIntent): void => {
        void this.handleIntent(intent);
      }
    })
  }

  /**
   * The report strip: what the mock host was asked for, in order, and what the
   * composer and the notice hold after each exit. It sits above the pane so nothing
   * it draws can be mistaken for the surface under test, and every line carries an
   * id so a layout dump can be read against the screenshot.
   */
  @Builder
  private Diagnostics() {
    Column({ space: 2 }) {
      Text(`scenario=${this.scenarioId()} variant=${this.variantLabel} api=${this.apiLevel} ` +
        `w=${Math.round(this.viewportWidth)} busy=${this.busy ? 1 : 0} ` +
        `caps=${RollbackPreviewScenario.hostCapabilities(this.variant).length}`)
        .id('rollback-preview-scenario')
        .fontSize(10)
        .fontColor(MUTED)
        .width('100%')
        .maxLines(2)
      Text(`intent=${this.intentLog}`)
        .id('rollback-preview-intent')
        .fontSize(10)
        .fontColor(INK)
        .width('100%')
        .maxLines(2)
      Text(`host=${this.hostLog} recovery=${this.recoveryLog}`)
        .id('rollback-preview-host')
        .fontSize(10)
        .fontColor(INK)
        .width('100%')
        .maxLines(2)
      Text(`draft=${this.draftLog}`)
        .id('rollback-preview-draft')
        .fontSize(10)
        .fontColor(INK)
        .width('100%')
        .maxLines(1)
      Text(`notice=${this.noticeLog}`)
        .id('rollback-preview-notice')
        .fontSize(10)
        .fontColor(INK)
        .width('100%')
        .maxLines(2)
      Text(`toast=${this.toastLog} status=${this.statusLog}`)
        .id('rollback-preview-toast')
        .fontSize(10)
        .fontColor(INK)
        .width('100%')
        .maxLines(2)
    }
    .width('100%')
    // The shell is immersive, so the strip starts at the window's top edge and has
    // to clear the status bar itself.
    .padding({ left: 12, right: 12, top: 48, bottom: 6 })
    .backgroundColor(SOFT)
    .border({ width: { bottom: 0.5 }, color: LINE })
  }
}

/** A transcript store the fixture never reads from and never writes to. */
class RollbackPreviewCacheStore implements RemoteChatCacheStore {
  async init(_context: Context): Promise<void> {}
  async loadSlice(): Promise<RemoteChatCacheSlice> { return { messages: [], lastMessageId: '' }; }
  async appendMessages(): Promise<void> {}
  async replaceMessages(): Promise<void> {}
  async deleteSession(): Promise<void> {}
  async pruneSessions(): Promise<void> {}
  async clearAll(): Promise<void> {}
}
