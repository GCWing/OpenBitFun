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
import {
  CARD,
  INK,
  LINE,
  MUTED,
  SHADOW_SUBTLE,
  STATUS_DANGER,
} from './Theme';
import { ChatMessageBubble, ChatUserMessageRow } from './ChatMessageBubble';
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
  private followTimerId: number = 0;
  private followedActiveTurnKey: string = '';
  private userScrollActive: boolean = false;
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
  }

  // A new turn means the user has just sent a message and expects to follow its
  // answer even if opening the keyboard changed the List viewport. Subsequent
  // revisions keep following only until the user deliberately scrolls away.
  @Monitor('timelineRevision')
  onTimelineChanged(): void {
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
                if (!this.historyLoading) this.onLoadOlder();
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
      // A streaming reply grows in place rather than arriving as a new item, so
      // the bottom of the list has to be the anchor — otherwise the text the
      // agent is writing right now renders below the fold and never comes back.
      .stackFromEnd(true)
      // Keeps the read position when older messages are prepended above.
      .maintainVisibleContentPosition(true)
      .scrollBar(BarState.Off)
      .cachedCount(4)
      .onWillScroll((_scrollOffset: number, _scrollState: ScrollState, scrollSource: ScrollSource) => {
        if (this.isUserScrollSource(scrollSource)) {
          this.userScrollActive = true;
        }
      })
      .onDidScroll((_scrollOffset: number, scrollState: ScrollState) => {
        if (this.listScroller.isAtEnd()) {
          this.stickToBottom = true;
        } else if (this.userScrollActive) {
          this.stickToBottom = false;
        }
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

  private requestFollowToBottom(reason: string): void {
    if (!this.stickToBottom || this.followTimerId !== 0) {
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
