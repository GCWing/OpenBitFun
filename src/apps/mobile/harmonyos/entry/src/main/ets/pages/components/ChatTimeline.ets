import { InteractionMailboxState } from '../../model/InteractionMailbox';
import { MobileDesignGeometry, MobileDesignTypography } from '../../generated/MobileDesignTokens';
import {
  ConversationUiMessage,
  ConversationUiMessageItem,
  ConversationUiQuestionAnswer,
  ObservableConversationUiMessage,
  toConversationUiMessage
} from '../state/ConversationUiModels';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import {
  ChatTimelineItem,
  ChatTimelineRevisionTracker,
  ObservableChatTimelineItem
} from '../../model/ChatTimelineModels';
import { ChatSurface } from '../state/ChatSurface';
import { MessageCopyScope } from '../actions/ConversationIntent';
import {
  CARD,
  INK,
  LINE,
  MUTED,
  SHADOW_SUBTLE,
  STATUS_DANGER,
} from './Theme';
import { ChatMessageBubble, ChatUserMessageRow } from './ChatMessageBubble';
import { HistoryPageArrivalTracker } from '../policy/HistoryPageArrivalTracker';
import { RemoteLogger } from '../../services/RemoteLogger';

/**
 * Repeat retains this adapter by row identity while the observed row mutates.
 * Keep one observable presentation message for the whole reusable lifetime:
 * aboutToAppear covers a new instance, aboutToReuse covers an instance thawed
 * from Repeat's pool, and the monitor covers an already-visible row update.
 */
@ReusableV2
@ComponentV2
struct ChatAssistantTimelineRow {
  @Param interactionMailbox: InteractionMailboxState = new InteractionMailboxState();
  @Param row: ObservableChatTimelineItem = new ObservableChatTimelineItem({
    id: '',
    type: 'empty_state',
    isStreaming: false,
    isFinalizing: false
  });
  @Param renderRevision: number = 0;
  @Param isBusy: boolean = false;
  @Param downloadingFilePath: string = '';
  @Param downloadedFilePath: string = '';
  @Param fileDownloadStatus: string = '';
  @Param activeFilePreviewPath: string = '';
  @Param activeFilePreviewLoading: boolean = false;
  @Local uiMessage: ObservableConversationUiMessage = new ObservableConversationUiMessage();
  @Event onApproveTool: (toolId: string, updatedInput?: Object) => void =
    (_toolId: string, _updatedInput?: Object) => {};
  @Event onRejectTool: (toolId: string) => void = (_toolId: string) => {};
  @Event onCancelTool: (toolId: string) => void = (_toolId: string) => {};
  @Event onAnswerQuestion: (toolId: string, answers: ConversationUiQuestionAnswer) => void =
    (_toolId: string, _answers: ConversationUiQuestionAnswer) => {};
  @Event onCopyMessage: (text: string) => void = (_text: string) => {};
  @Event onCopyMessageScoped: (text: string, scope: MessageCopyScope) => void =
    (_text: string, _scope: MessageCopyScope) => {};
  @Event onOpenFullText: (text: string) => void = (_text: string) => {};
  @Event onRetryMessage: (text: string) => void = (_text: string) => {};
  @Event onOpenFilePreview: (path: string, label: string) => void = (_path: string, _label: string) => {};
  @Event onBuildPlan: (path: string, name: string) => void = (_path: string, _name: string) => {};
  @Event onDownloadFile: (path: string) => void = (_path: string) => {};

  aboutToAppear(): void {
    this.synchronizeMessage();
  }

  aboutToReuse(): void {
    this.synchronizeMessage();
  }

  @Monitor('row.id', 'row.message', 'renderRevision')
  private onMessageChanged(): void {
    this.synchronizeMessage();
  }

  build() {
    // The parent only creates this row for a renderable message. Do not put a
    // second structural condition around the reusable subtree: a V2 component
    // can be thawed before its retained @Local state has been synchronized,
    // and omitting the child at that point leaves a permanently hollow row.
    ChatMessageBubble({
      interactionMailbox: this.interactionMailbox,
      item: this.uiMessage,
      renderRevision: this.renderRevision,
      isStreaming: this.row.isStreaming,
      isFinalizing: this.row.isFinalizing,
      showRetryAction: this.row.showRetryAction,
      isBusy: this.isBusy,
      downloadingFilePath: this.downloadingFilePath,
      downloadedFilePath: this.downloadedFilePath,
      fileDownloadStatus: this.fileDownloadStatus,
      activeFilePreviewPath: this.activeFilePreviewPath,
      activeFilePreviewLoading: this.activeFilePreviewLoading,
      onApproveTool: this.onApproveTool,
      onRejectTool: this.onRejectTool,
      onCancelTool: this.onCancelTool,
      onAnswerQuestion: this.onAnswerQuestion,
      onCopyMessage: this.onCopyMessage,
      onCopyMessageScoped: this.onCopyMessageScoped,
      onOpenFullText: this.onOpenFullText,
      onRetryMessage: this.onRetryMessage,
      onOpenFilePreview: this.onOpenFilePreview,
      onBuildPlan: this.onBuildPlan,
      onDownloadFile: this.onDownloadFile
    })
  }

  private synchronizeMessage(): void {
    if (this.row.message) {
      this.uiMessage.updateFrom(toConversationUiMessage(this.row.message));
    }
  }
}

@ComponentV2
export struct ChatTimeline {
  @Param interactionMailbox: InteractionMailboxState = new InteractionMailboxState();
  private readonly listScroller: Scroller = new Scroller();
  private readonly historyArrival: HistoryPageArrivalTracker = new HistoryPageArrivalTracker();
  private followTimerId: number = 0;
  private followedActiveTurnKey: string = '';
  private userScrollActive: boolean = false;
  private historyTouchActive: boolean = false;
  private firstVisibleIndex: number = 0;
  private historyRestoreKey: string = '';
  private historyRestoreTop: number = 0;
  private lastVisibleIndex: number = 0;
  private historyRestoreTimer: number = 0;
  private historyRestoreAttempts: number = 0;
  private historyStableFrames: number = 0;
  // Whether new content should pull the viewport down with it. True until the
  // user scrolls up to read back through the transcript: at that point taking
  // the viewport away from them would be worse than letting the reply grow off
  // screen, and the chevron button below gives them the way back.
  @Local stickToBottom: boolean = true;
  @Param surface: ChatSurface = ChatSurface.Remote;
  @Param timelineItems: ObservableChatTimelineItem[] = [];
  @Param timelineRevision: number = 0;
  @Param hasMoreMessages: boolean = false;
  @Param historyLoading: boolean = false;
  @Param historyFailed: boolean = false;
  @Param isBusy: boolean = false;
  @Param connectionState: string = 'connected';
  @Param statusText: string = '';
  @Param downloadingFilePath: string = '';
  @Param downloadedFilePath: string = '';
  @Param fileDownloadStatus: string = '';
  @Param activeFilePreviewPath: string = '';
  @Param activeFilePreviewLoading: boolean = false;
  @Param maxContentWidth: number = 0;
  /**
   * How much of the pane the floating header and composer cover. The list runs
   * the full height behind them, so without these the first and last messages
   * would sit under a capsule and never come out from under it.
   */
  @Param topInset: number = 0;
  @Param bottomInset: number = 0;
  @Event onLoadOlder: () => void = () => {};
  @Event onApproveTool: (toolId: string, updatedInput?: Object) => void =
    (_toolId: string, _updatedInput?: Object) => {};
  @Event onRejectTool: (toolId: string) => void = (_toolId: string) => {};
  @Event onCancelTool: (toolId: string) => void = (_toolId: string) => {};
  @Event onAnswerQuestion: (toolId: string, answers: ConversationUiQuestionAnswer) => void =
    (_toolId: string, _answers: ConversationUiQuestionAnswer) => {};
  @Event onCopyMessage: (text: string) => void = (_text: string) => {};
  @Event onCopyMessageScoped: (text: string, scope: MessageCopyScope) => void =
    (_text: string, _scope: MessageCopyScope) => {};
  @Event onOpenFullText: (text: string) => void = (_text: string) => {};
  @Event onRetryMessage: (text: string) => void = (_text: string) => {};
  @Event onOpenFilePreview: (path: string, label: string) => void = (_path: string, _label: string) => {};
  @Event onBuildPlan: (path: string, name: string) => void = (_path: string, _name: string) => {};
  @Event onDownloadFile: (path: string) => void = (_path: string) => {};

  // Says whether an open reuses this subtree or rebuilds it. A rebuild means
  // every bubble is constructed from nothing, and the cost of that is the
  // difference between the two readings.
  aboutToAppear(): void {
    RemoteLogger.info(`chat timeline mounted surface=${this.surface} items=${this.timelineItems.length}`);
    this.logTimelineProjection('mount');
  }

  aboutToDisappear(): void {
    RemoteLogger.info(`chat timeline disposed items=${this.timelineItems.length}`);
    this.clearFollowTimer();
    this.cancelHistoryAnchor();
  }

  // A new turn means the user has just sent a message and expects to follow its
  // answer even if opening the keyboard changed the List viewport. Subsequent
  // revisions keep following only until the user deliberately scrolls away.
  @Monitor('timelineRevision', 'historyLoading')
  onTimelineChanged(): void {
    this.restoreHistoryAnchorIfNeeded();
    this.logTimelineProjection('revision');
    const activeTurnKey = this.activeTurnKey();
    if (activeTurnKey.length > 0 && activeTurnKey !== this.followedActiveTurnKey) {
      this.followedActiveTurnKey = activeTurnKey;
      this.userScrollActive = false;
      this.stickToBottom = true;
      RemoteLogger.info(
        `chat timeline follow start revision=${this.timelineRevision} turn=${activeTurnKey}`
      );
    }
    this.requestFollowToBottom('revision');
  }

  build() {
    Stack({ alignContent: Alignment.Bottom }) {
      List({ space: MobileDesignGeometry.messageSpacing, scroller: this.listScroller }) {
        if (this.hasMoreMessages) {
          ListItem() {
            Text(this.historyLoading ? RemoteI18n.t('common.loading') : RemoteI18n.t(this.historyFailed ? 'chat.loadOlderFailed' : 'chat.loadOlder'))
              .fontSize(MobileDesignTypography.bodySmall.size)
              .fontColor(MUTED)
              .textAlign(TextAlign.Center)
              .width('100%')
              .padding({ top: 10, bottom: 10 })
              .onClick(() => {
                if (!this.historyLoading) {
                  this.historyArrival.cancelArrival();
                  this.stickToBottom = false;
                  this.captureHistoryAnchor();
                  this.onLoadOlder();
                }
              })
          }
        }
        Repeat<ObservableChatTimelineItem>(this.historyTimelineItems())
          .virtualScroll()
          .each((repeatItem: RepeatItem<ObservableChatTimelineItem>) => {
            // Repeat must own the reusable row directly. Routing its item
            // through an @Builder snapshots the nested component subtree on
            // current ArkUI builds, so streaming message params never update.
            if (repeatItem.item.type === 'empty_state') {
              ListItem() {
                this.EmptyChatState()
              }
              .onAppear(() => {
                this.logRenderedItem(repeatItem.item);
              })
            } else if (repeatItem.item.message) {
              ListItem() {
                if (repeatItem.item.message!.role === 'user') {
                  ChatUserMessageRow({
                    item: toConversationUiMessage(repeatItem.item.message!),
                    showRetryAction: repeatItem.item.showRetryAction === true,
                    onCopyMessage: (text: string) => {
                      this.onCopyMessage(text);
                    },
                    onOpenFullText: (text: string) => {
                      this.onOpenFullText(text);
                    },
                    onRetryMessage: (text: string) => {
                      this.onRetryMessage(text);
                    }
                  })
                  .reuse({ reuseId: () => 'chat_user' })
                } else {
                  ChatAssistantTimelineRow({
                    interactionMailbox: this.interactionMailbox,
                    row: repeatItem.item,
                    renderRevision: this.timelineRevision,
                    isBusy: this.isBusy,
                    downloadingFilePath: this.downloadingFilePath,
                    downloadedFilePath: this.downloadedFilePath,
                    fileDownloadStatus: this.fileDownloadStatus,
                    activeFilePreviewPath: this.activeFilePreviewPath,
                    activeFilePreviewLoading: this.activeFilePreviewLoading,
                    onApproveTool: (toolId: string, updatedInput?: Object) => {
                      this.onApproveTool(toolId, updatedInput);
                    },
                    onRejectTool: (toolId: string) => {
                      this.onRejectTool(toolId);
                    },
                    onCancelTool: (toolId: string) => {
                      this.onCancelTool(toolId);
                    },
                    onAnswerQuestion: (toolId: string, answers: ConversationUiQuestionAnswer) => {
                      this.onAnswerQuestion(toolId, answers);
                    },
                    onCopyMessage: (text: string) => {
                      this.onCopyMessage(text);
                    },
                    onCopyMessageScoped: (text: string, scope: MessageCopyScope) => {
                      this.onCopyMessageScoped(text, scope);
                    },
                    onOpenFullText: (text: string) => {
                      this.onOpenFullText(text);
                    },
                    onRetryMessage: (text: string) => {
                      this.onRetryMessage(text);
                    },
                    onOpenFilePreview: (path: string, label: string) => {
                      this.onOpenFilePreview(path, label);
                    },
                    onBuildPlan: (path: string, name: string) => {
                      this.onBuildPlan(path, name);
                    },
                    onDownloadFile: (path: string) => {
                      this.onDownloadFile(path);
                    }
                  })
                  .reuse({ reuseId: () => 'chat_assistant' })
                }
              }
              .onAppear(() => {
                this.logRenderedItem(repeatItem.item);
              })
            }
          })
          .key((item: ObservableChatTimelineItem, _index: number) => ChatTimelineRevisionTracker.itemKey(item))

        // Keep the single volatile row outside Repeat.virtualScroll(). Feed it
        // through the same observed adapter as history rows: passing a mapped
        // temporary object through an @Builder freezes the first empty active
        // snapshot on current ArkUI builds.
        ForEach(this.activeTimelineItems(), (item: ObservableChatTimelineItem) => {
          if (item.message) {
            ListItem() {
              ChatAssistantTimelineRow({
                interactionMailbox: this.interactionMailbox,
                row: item,
                renderRevision: this.timelineRevision,
                isBusy: this.isBusy,
                downloadingFilePath: this.downloadingFilePath,
                downloadedFilePath: this.downloadedFilePath,
                fileDownloadStatus: this.fileDownloadStatus,
                activeFilePreviewPath: this.activeFilePreviewPath,
                activeFilePreviewLoading: this.activeFilePreviewLoading,
                onApproveTool: this.onApproveTool,
                onRejectTool: this.onRejectTool,
                onCancelTool: this.onCancelTool,
                onAnswerQuestion: this.onAnswerQuestion,
                onCopyMessage: this.onCopyMessage,
                onCopyMessageScoped: this.onCopyMessageScoped,
                onOpenFullText: this.onOpenFullText,
                onRetryMessage: this.onRetryMessage,
                onOpenFilePreview: this.onOpenFilePreview,
                onBuildPlan: this.onBuildPlan,
                onDownloadFile: this.onDownloadFile
              })
            }
            .onAppear(() => {
              this.logRenderedItem(item);
            })
            .onAreaChange((oldArea: Area, newArea: Area) => {
              if (Math.abs(this.areaLength(newArea.height) - this.areaLength(oldArea.height)) > 0.5) {
                this.requestFollowToBottom('active-height');
              }
            })
          }
        }, (item: ObservableChatTimelineItem) => ChatTimelineRevisionTracker.itemKey(item))

      }
      .width('100%')
      .height('100%')
      .padding({
        left: MobileDesignGeometry.contentGutter,
        right: MobileDesignGeometry.contentGutter,
        bottom: this.bottomInset > 0 ? 0 : 12
      })
      // Content offsets, not padding: padding shrinks the viewport, so the
      // transcript would stop at the floating header and composer instead of
      // running underneath them. These reserve the space at rest and still let
      // the content scroll through — ArkUI's equivalent of Compose's
      // contentPadding and SwiftUI's safeAreaInset.
      .contentStartOffset(this.topInset)
      .contentEndOffset(this.bottomInset)
      // Keep short transcripts at the content start. Active turns and explicit
      // follow-to-bottom calls still place streaming content at the tail.
      .stackFromEnd(false)
      .id('chat-timeline-list')
      // Keeps the read position when older messages are prepended above.
      .maintainVisibleContentPosition(false)
      .edgeEffect(EdgeEffect.Spring, { alwaysEnabled: true })
      .scrollBar(BarState.Off)
      .cachedCount(4)
      .onTouch((event: TouchEvent) => {
        if (event.type === TouchType.Down) {
          if (!this.historyLoading) this.cancelHistoryAnchor();
          this.historyTouchActive = true;
          this.historyArrival.beginGesture();
          RemoteLogger.info(`history gesture begin loading=${this.historyLoading} offset=${this.listScroller.currentOffset().yOffset}`);
        } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
          this.historyTouchActive = false;
        }
      })
      .onWillScroll((_scrollOffset: number, _scrollState: ScrollState, scrollSource: ScrollSource) => {
        if (this.isUserScrollSource(scrollSource)) {
          this.userScrollActive = true;
        }
      })
      .onScrollIndex((start: number, end: number, _center: number) => {
        this.firstVisibleIndex = start;
        this.lastVisibleIndex = end;
      })
      .onDidScroll((_scrollOffset: number, scrollState: ScrollState) => {
        if (this.listScroller.isAtEnd()) {
          this.stickToBottom = true;
        } else if (this.userScrollActive) {
          this.stickToBottom = false;
        }
        this.evaluateHistoryStart();
        if (scrollState === ScrollState.Idle) {
          this.userScrollActive = false;
        }
      })

      if (this.surface === ChatSurface.Remote && !this.stickToBottom) {
        Stack({ alignContent: Alignment.Center }) {
          SymbolGlyph($r('sys.symbol.chevron_down'))
            .fontSize(18)
            .fontColor([INK])
        }
        .id('chat-timeline-jump')
        .width(42)
        .height(42)
        .backgroundColor(CARD)
        .borderRadius(21)
        .shadow({ radius: 14, color: SHADOW_SUBTLE, offsetY: 5 })
        // Rides above the floating composer rather than hiding behind it.
        .margin({ bottom: this.bottomInset + 4 })
        .onClick(() => {
          this.stickToBottom = true;
          this.userScrollActive = false;
          this.requestFollowToBottom('jump-button');
        })
      }
    }
    .layoutWeight(1)
    .width('100%')
    .constraintSize({ maxWidth: this.maxContentWidth > 0 ? this.maxContentWidth : 10000 })
    .alignSelf(ItemAlign.Center)
  }

  @Builder
  EmptyChatState() {
    Row({ space: 12 }) {
      Text(this.emptyChatIcon())
        .width(38)
        .height(38)
        .fontSize(MobileDesignTypography.headlineSmall.size)
        .fontColor(this.connectionState === 'failed' ? STATUS_DANGER : MUTED)
        .textAlign(TextAlign.Center)
        .backgroundColor(CARD)
        .borderRadius(14)
        .border({ width: 1, color: LINE })
      Column({ space: 5 }) {
        Text(this.emptyChatTitle())
          .fontSize(MobileDesignTypography.titleSmall.size)
          .fontWeight(FontWeight.Medium)
          .fontColor(INK)
        Text(this.emptyChatText())
          .fontSize(MobileDesignTypography.bodySmall.size)
          .lineHeight(MobileDesignTypography.bodySmall.lineHeight)
          .fontColor(MUTED)
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .padding(14)
    .backgroundColor(CARD)
    .borderRadius(18)
    .border({ width: 1, color: LINE })
  }

  private historyTimelineItems(): ObservableChatTimelineItem[] {
    return this.timelineItems.filter((item: ObservableChatTimelineItem) => !this.isVolatileItem(item));
  }

  private activeTimelineItems(): ObservableChatTimelineItem[] {
    return this.timelineItems.filter((item: ObservableChatTimelineItem) => this.isVolatileItem(item));
  }

  private isVolatileItem(item: ChatTimelineItem): boolean {
    return item.type === 'assistant_live_turn' && (item.isStreaming || item.isFinalizing);
  }

  private activeTurnKey(): string {
    const activeItems = this.activeTimelineItems();
    if (activeItems.length === 0) {
      return '';
    }
    return ChatTimelineRevisionTracker.itemKey(activeItems[activeItems.length - 1]);
  }

  /**
   * Asks for the next history page when the reader arrives at the start.
   *
   * What counts is the reader's position, not the content's: the list keeps the
   * visible content in place while a page is prepended above it, so the arrival
   * it answered is spent by it and reaching the start again is a deliberate
   * scroll back. A timeline still following the tail is excluded — a first page
   * that does not fill the viewport sits at the start without the reader having
   * gone there — except while the reader is dragging, where the arrival is
   * theirs even if the drag never leaves the end.
   */
  private evaluateHistoryStart(): void {
    const atStart: boolean = this.listScroller.currentOffset().yOffset <= 0;
    const readerOwnsPosition: boolean = this.historyTouchActive && this.userScrollActive;
    if (atStart && this.historyTouchActive) {
      RemoteLogger.info(`history start check owns=${readerOwnsPosition} loading=${this.historyLoading} hasMore=${this.hasMoreMessages} failed=${this.historyFailed}`);
    }
    if (!this.historyArrival.arrived(atStart && readerOwnsPosition)) {
      return;
    }
    if (this.hasMoreMessages && !this.historyLoading && !this.historyFailed) {
      this.stickToBottom = false;
      this.captureHistoryAnchor();
      this.onLoadOlder();
      return;
    }
    // A drag made while busy is consumed, not queued for after completion.
  }

  private cancelHistoryAnchor(): void {
    if (this.historyRestoreTimer !== 0) clearTimeout(this.historyRestoreTimer);
    this.historyRestoreTimer = 0;
    this.historyRestoreKey = '';
    this.historyRestoreAttempts = 0;
    this.historyStableFrames = 0;
  }

  private captureHistoryAnchor(): void {
    const history = this.historyTimelineItems();
    const header = this.hasMoreMessages ? 1 : 0;
    // A page can extend the first assistant row upwards without adding rows.
    // Preserve the lower visible row's trailing edge, not that row's changing head.
    const index = Math.min(history.length - 1, Math.max(0, this.lastVisibleIndex - header));
    const item = history[index];
    if (!item) return;
    try {
      const rect = this.listScroller.getItemRect(index + header);
      if (rect.height <= 0) return;
      this.historyRestoreKey = ChatTimelineRevisionTracker.itemKey(item);
      this.historyRestoreTop = rect.y + rect.height;
      this.historyRestoreAttempts = 0;
      this.historyStableFrames = 0;
      this.clearFollowTimer();
      this.stickToBottom = false;
      RemoteLogger.info(
        `history viewport capture key=${this.historyRestoreKey} index=${index} bottom=${this.historyRestoreTop} rows=${history.length}`
      );
    } catch (_) {
      RemoteLogger.warn('History viewport capture unavailable');
    }
  }

  private restoreHistoryAnchorIfNeeded(): void {
    if (!this.historyRestoreKey || this.historyLoading || this.historyRestoreTimer !== 0) return;
    this.historyRestoreTimer = setTimeout(() => {
      this.historyRestoreTimer = 0;
      const key = this.historyRestoreKey;
      const history = this.historyTimelineItems();
      const index = history.findIndex((item: ObservableChatTimelineItem) =>
        ChatTimelineRevisionTracker.itemKey(item) === key);
      if (index < 0 || this.historyFailed) {
        this.cancelHistoryAnchor();
        return;
      }
      this.historyRestoreAttempts++;
      try {
        const listIndex = index + (this.hasMoreMessages ? 1 : 0);
        const rect = this.listScroller.getItemRect(listIndex);
        if (rect.height <= 0) {
          // Mount the identity's new virtual position before measuring it.
          this.listScroller.scrollToIndex(listIndex, false, ScrollAlign.END);
          this.historyStableFrames = 0;
        } else {
          const actual = rect.y + rect.height;
          const delta = actual - this.historyRestoreTop;
          RemoteLogger.info(
            `history viewport measure key=${key} rows=${history.length} actual=${actual} expected=${this.historyRestoreTop} delta=${delta} attempt=${this.historyRestoreAttempts}`
          );
          if (Math.abs(delta) > 0.5) {
            this.historyStableFrames = 0;
            this.listScroller.scrollBy(0, delta);
          } else {
            this.historyStableFrames++;
          }
        }
      } catch (_) {
        this.listScroller.scrollToIndex(index + (this.hasMoreMessages ? 1 : 0), false, ScrollAlign.END);
      }
      if (this.historyStableFrames >= 3 || this.historyRestoreAttempts >= 30) {
        RemoteLogger.info(`history viewport settle stable=${this.historyStableFrames} attempts=${this.historyRestoreAttempts}`);
        this.cancelHistoryAnchor();
      } else {
        this.restoreHistoryAnchorIfNeeded();
      }
    }, 16);
  }

  private requestFollowToBottom(reason: string): void {
    // Explicit navigation supersedes a pending history-position restoration.
    // Jump now even if the host response is still pending; ordinary revisions
    // resume tail following when historyLoading clears, including on failure.
    if (reason === 'jump-button') {
      this.cancelHistoryAnchor();
    }
    if (this.historyRestoreKey || (this.historyLoading && reason !== 'jump-button') ||
      !this.stickToBottom || this.followTimerId !== 0) {
      return;
    }
    this.followTimerId = setTimeout(() => {
      this.followTimerId = 0;
      if (!this.stickToBottom) {
        return;
      }
      const wasAtEnd = this.listScroller.isAtEnd();
      this.listScroller.scrollEdge(Edge.Bottom);
      if (!wasAtEnd || reason === 'jump-button') {
        RemoteLogger.info(
          `chat timeline follow apply reason=${reason} revision=${this.timelineRevision} ` +
          `wasAtEnd=${wasAtEnd ? 1 : 0}`
        );
      }
    }, 0);
  }

  private clearFollowTimer(): void {
    if (this.followTimerId !== 0) {
      clearTimeout(this.followTimerId);
      this.followTimerId = 0;
    }
  }

  private isUserScrollSource(source: ScrollSource): boolean {
    return source === ScrollSource.DRAG || source === ScrollSource.FLING ||
      source === ScrollSource.EDGE_EFFECT || source === ScrollSource.OTHER_USER_INPUT;
  }

  private areaPosition(position: Object): number {
    const value = (position as Record<string, Object>)?.y;
    return this.areaLength(value === undefined ? 0 : value);
  }

  private areaLength(value: Object): number {
    const parsed = Number.parseFloat(`${value}`);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  private logRenderedItem(item: ChatTimelineItem): void {
    const message = item.message;
    const uiMessage = message ? toConversationUiMessage(message) : undefined;
    const thinkingLength = uiMessage && uiMessage.thinking ? uiMessage.thinking.length : 0;
    const toolCount = uiMessage && uiMessage.tools ? uiMessage.tools.length : 0;
    const itemCount = uiMessage && uiMessage.items ? uiMessage.items.length : 0;
    RemoteLogger.info(
      `chat timeline item appear revision=${this.timelineRevision} type=${item.type} id=${item.id} ` +
      `status=${uiMessage ? uiMessage.status : ''} textLength=${uiMessage ? uiMessage.text.length : 0} ` +
      `thinkingLength=${thinkingLength} toolCount=${toolCount} itemCount=${itemCount} ` +
      `itemTypes=${this.itemTypeSummary(uiMessage && uiMessage.items ? uiMessage.items : [])}`
    );
  }

  private itemTypeSummary(items: ConversationUiMessageItem[]): string {
    if (items.length === 0) {
      return '';
    }
    const parts: string[] = [];
    items.forEach((entry: ConversationUiMessageItem) => {
      if (entry.tool && entry.tool.name) {
        parts.push(entry.tool.name);
      } else if ((entry.type || '').length > 0) {
        parts.push(entry.type || '');
      } else {
        parts.push('item');
      }
    });
    const summary = parts.join(',');
    if (summary.length > 80) {
      return summary.substring(0, 80);
    }
    return summary;
  }

  private logTimelineProjection(reason: string): void {
    const parts: string[] = [];
    this.timelineItems.forEach((item: ChatTimelineItem) => {
      const message = item.message;
      parts.push(
        `${item.type}:${item.id}:role=${message ? message.role : 'none'}:` +
        `text=${message && message.text ? message.text.length : -1}:` +
        `thinking=${message && message.thinking ? message.thinking.length : 0}:` +
        `tools=${message && message.tools ? message.tools.length : 0}:` +
        `items=${message && message.items ? message.items.length : 0}`
      );
    });
    const summary = parts.join(' | ');
    RemoteLogger.info(
      `chat timeline project reason=${reason} revision=${this.timelineRevision} ` +
      `count=${this.timelineItems.length} ${summary.length > 600 ? summary.substring(0, 600) : summary}`
    );
  }

  private emptyChatIcon(): string {
    if (this.isBusy) {
      return '◌';
    }
    if (this.connectionState === 'failed') {
      return '!';
    }
    if (this.connectionState === 'reconnecting') {
      return '◌';
    }
    return '∅';
  }

  private emptyChatTitle(): string {
    if (this.isBusy) {
      return RemoteI18n.t('chat.emptySyncing');
    }
    if (this.connectionState === 'failed') {
      return RemoteI18n.t('chat.emptyConnectionError');
    }
    if (this.connectionState === 'reconnecting') {
      return RemoteI18n.t('chat.emptyReconnecting');
    }
    return RemoteI18n.t('chat.emptyNoMessages');
  }

  private emptyChatText(): string {
    if (this.isBusy) {
      return this.statusText || RemoteI18n.t('chat.emptyLoadingMessages');
    }
    if (this.connectionState === 'failed') {
      return this.statusText || RemoteI18n.t('chat.emptyReconnectFromHome');
    }
    if (this.connectionState === 'reconnecting') {
      return RemoteI18n.t('chat.emptyReconnectSync');
    }
    return RemoteI18n.t('chat.emptyFirstMessage');
  }
}
