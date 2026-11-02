import { InteractionMailboxPanel } from './InteractionMailboxPanel';
import { InteractionMailboxAction } from '../../model/InteractionMailbox';
import { MobileDesignGeometry, MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { ComponentContent, KeyboardAvoidMode, UIContext } from '@kit.ArkUI';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { ChatTimelineItem, ChatTimelineRevisionTracker, ObservableChatTimelineItem } from '../../model/ChatTimelineModels';
import { ConnectionStatusPresenter } from '../../services/ConnectionStatusPresenter';
import { RemoteLogger } from '../../services/RemoteLogger';
import { ChatComposerCapabilities } from '../state/ChatComposerCapabilities';
import { ChatSurface } from '../state/ChatSurface';
import { ConversationViewState } from '../state/ConversationViewState';
import { ConversationIntent, ConversationIntents, ConversationIntentType, MessageCopyScope } from '../actions/ConversationIntent';
import { SettingsPlacement } from '../policy/SettingsPlacementPolicy';
import {
  RollbackBarPresentation,
  RollbackGhostRow,
  RollbackPresentationPolicy
} from '../policy/RollbackPresentationPolicy';
import {
  SessionRollbackEffect,
  SessionRollbackEffectType,
  SessionRollbackEvent,
  SessionRollbackEventType,
  SessionRollbackIdleState,
  SessionRollbackPolicy,
  SessionRollbackStage,
  SessionRollbackState,
  SessionRollbackStagingState
} from '../policy/SessionRollbackPolicy';
import { RollbackStagingBar } from './RollbackStagingBar';
import { AdaptiveSheetOptions } from './AdaptiveSheetOptions';
import { ImmersiveSurfaceSupport } from './ImmersiveSurfaceSupport';
import { ImmersiveSurfaceScene } from '../policy/ImmersiveMaterialPolicy';
import { ChatTimeline } from './ChatTimeline';
import { ConversationLoadingState } from './ConversationLoadingState';
import { UserMessageFullTextSheet } from './UserMessageFullTextSheet';
import { WindowInsetsBinding } from '../../services/WindowSystemBarService';
import {
  ConversationViewContract,
  ConversationViewOptions
} from './ConversationViewContract';
import {
  ConversationUiModelCatalog,
  ConversationUiQuestionAnswer,
  ConversationUiSelectedImage,
  ConversationUiSession
} from '../state/ConversationUiModels';
import { ComposerBar, ComposerPresentation } from './ComposerBar';
import { ConversationHeader } from './ConversationHeader';
import {
  ConversationHeaderMenuAction,
  ConversationHeaderMenuItem,
  ConversationHeaderPolicy,
  ConversationHeaderPresentation
} from '../policy/ConversationHeaderPolicy';
import { HdsTitleBarPolicy, HdsTitleBarScene } from '../policy/HdsTitleBarPolicy';
import {
  CONVERSATION_HEADER_MENU_ANCHOR_ID,
  ConversationHeaderMenu,
  ConversationHeaderMenuParams,
  conversationHeaderMenuBuilder
} from './ConversationHeaderMenu';
import {
  MUTED,
  PAGE_BG,
  PAGE_BG_FADE,
  PAGE_BG_OVERLAY,
  STATUS_DANGER,
  STATUS_SUCCESS,
} from './Theme';

/**
 * The half-pixel line along the bottom of the self-drawn top band.
 *
 * Geometry, not a colour: the design draft for the wide band draws it as an inset
 * half-pixel edge on the band's own box (`artifacts/ui-drafts/wide-topband/option-b.html`,
 * `.topband-b__surface`), which is the boundary between the band and the fade that
 * carries it into the transcript. It is drawn on every device — see
 * `ImmersiveSurfaceSupport.surfaceHairline`.
 */
const TOP_BAND_HAIRLINE_WIDTH: number = 0.5;

@ComponentV2
export struct ConversationView {
  @Param state: ConversationViewState = new ConversationViewState();
  @Param options: ConversationViewOptions = new ConversationViewOptions();
  @Event onIntent: (intent: ConversationIntent) => void = (_intent: ConversationIntent) => {};
  @Event onRestoreSidebar: () => void = () => {};
  @Local showHeaderActions: boolean = false;
  /**
   * How many times the menu has been asked for from outside this pane.
   *
   * The compact conversation's menu trigger is in the platform title bar, which
   * is not this component, so the pane cannot see the tap: the root reports it
   * through projected state (`state.conversationHeaderMenuSeq`) and this is the
   * count of reports already opened, so a rebuild never reopens one.
   */
  @Local handledMenuSeq: number = 0;
  /** Counts the pane's own requests for the rename editor, which the header holds. */
  @Local renameRequest: number = 0;
  /**
   * The node behind an open platform menu, so a chosen row can dismiss it.
   *
   * `closeMenu` takes the same content node `openMenu` was given, and an item
   * that opens the rename editor has to close the menu it was chosen from.
   */
  private platformMenuContent: ComponentContent<ConversationHeaderMenuParams> | undefined = undefined;
  /**
   * The user message whose full text is open, as a panel over the conversation.
   *
   * One panel at a time is the whole reason this is state of the conversation
   * rather than of the row that was long-pressed: the rows are virtualized and
   * reused, and a sheet bound per row would fight the pool instead of the
   * message it belongs to. It is view state, so it never becomes a projected
   * field or an intent: nothing outside this pane reads it.
   */
  @Local showFullText: boolean = false;
  @Local fullTextMessage: string = '';
  /**
   * The turn the open full-text panel belongs to.
   *
   * The panel is a second rollback entry on the same message, and a rollback
   * addresses the turn rather than what the message displays, so the turn travels
   * with the text that opened the panel.
   */
  @Local fullTextTurnId: string = '';
  /**
   * The staged rollback, held as three primitives rather than as one state object.
   *
   * The reducer stays the owner of the staging rules — which exits exist, what
   * each one does to the composer, what a host outcome means after the exit — and
   * these three fields are only what this pane has to keep between events:
   * `stagingTargetTurnId` also answers "is a rollback staged", since the entry
   * refuses to stage a message that has no turn to address. They are re-projected
   * into a `SessionRollbackState` for every event, so the snapshot rule (the first
   * snapshot wins, a second entry keeps it) is still applied in exactly one place.
   */
  @Local stagingTargetTurnId: string = '';
  @Local stagingTargetText: string = '';
  @Local composerSnapshot: string = '';
  /**
   * The last host rollback outcome this pane has already acted on.
   *
   * A confirm leaves staging before the host answers, so the refusal has to come
   * back through projected state and be consumed exactly once — compared by
   * sequence, because the same refusal twice is two outcomes.
   */
  @Local handledRollbackOutcomeSeq: number = 0;
  private rollbackContextIdentity: string = '';
  /**
   * How much of the pane the two floating layers cover, measured rather than
   * assumed: the composer grows with multiline text and attachments, and the
   * mailbox appears without warning. The transcript runs the full height behind
   * them and borrows these as its content insets, so a stale number would leave
   * the first or last message stuck under a capsule.
   */
  @Local topInset: number = 0;
  @Local bottomInset: number = 0;
  /**
   * The window's own insets, in vp. The shell is immersive, so the page draws
   * from the top of the window and the composer keeps its distance from the
   * bottom edge itself, which is what lets the transcript and its fade run to the
   * very bottom of the screen without carrying the composer down with them. The
   * header band reserves the top strip for the same reason: the band's own box is
   * what the transcript borrows as its content start offset.
   */
  @Local insets: WindowInsetsBinding = new WindowInsetsBinding();
  private previousKeyboardAvoidMode: KeyboardAvoidMode = KeyboardAvoidMode.OFFSET;

  private get topSafeInset(): number {
    return this.insets.top;
  }

  private get bottomSafeInset(): number {
    return this.insets.bottom;
  }

  aboutToAppear(): void {
    RemoteLogger.info(`conversation view mounted surface=${this.surface}`);
    this.previousKeyboardAvoidMode = this.getUIContext().getKeyboardAvoidMode();
    this.getUIContext().setKeyboardAvoidMode(KeyboardAvoidMode.RESIZE);
    const context = this.getUIContext().getHostContext();
    if (context) {
      this.insets.bind(this.getUIContext(), context);
    }
    // Anything the host reported while this pane was away is already in the past
    // for it: mounting is not a reason to resync a transcript it never showed, or
    // to repeat a refusal the reader was already told about.
    this.handledRollbackOutcomeSeq = this.state.rollbackOutcomeSeq;
    this.rollbackContextIdentity = `${this.state.surface}:${this.state.activeSession.sessionId}:${this.state.sessionContextRevision}`;
  }

  aboutToDisappear(): void {
    RemoteLogger.info('conversation view disposed');
    this.insets.unbind();
    this.getUIContext().setKeyboardAvoidMode(this.previousKeyboardAvoidMode);
  }

  build() {
    Stack({ alignContent: Alignment.Top }) {
      if (this.hoverOperateMode) {
        this.HalfFoldedLayout()
      } else {
        this.FloatingLayout()
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(PAGE_BG)
    .bindSheet($$this.showFullText, this.FullTextSheet(), this.fullTextSheetOptions())
  }

  @Builder
  private FullTextSheet() {
    UserMessageFullTextSheet({
      text: this.fullTextMessage,
      onRollback: () => {
        this.onRollbackMessage(this.fullTextTurnId, this.fullTextMessage);
      }
    })
  }

  /**
   * The transcript owns the whole pane; the header and the composer float over
   * it and the transcript scrolls underneath both, fading out as it reaches
   * either edge. Stack paints in order, so the body goes down first and the two
   * overlay layers land on top of it.
   */
  @Builder
  private FloatingLayout() {
    Column() {
      this.ConversationBody()
    }
    .width('100%')
    .height('100%')

    // A full-height layer that pins its content to the bottom. Stack aligns
    // every child the same way, so the bottom layer carries its own alignment
    // rather than fighting `alignContent`. It is see-through to touches above
    // the composer, otherwise it would swallow every tap on the transcript.
    Column() {
      this.BottomOverlay()
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.End)
    .hitTestBehavior(HitTestMode.Transparent)

    Column() {
      this.TopOverlay()
    }
    .width('100%')
  }

  /**
   * Half-folded on a foldable the screen is physically two panes, and the
   * transcript and the composer already have one each. Floating one over the
   * other has nothing left to win there, so this layout stays stacked.
   */
  @Builder
  private HalfFoldedLayout() {
    Column() {
      this.Header()
      this.Mailbox()
      FolderStack() {
        Column() {
          this.ConversationBody()
        }
        .width('100%')
        .height('100%')
        .padding({ bottom: 12 })
        Column() {
          this.InlineStatusLine()
          this.Composer()
        }
        .width('100%')
        // The composer pane of a half-folded screen is the bottom edge too, so it
        // keeps the same distance from it as the floating layer does.
        .padding({ bottom: this.bottomSafeInset })
      }
      .alignContent(Alignment.Bottom)
      .layoutWeight(1)
      .width('100%')
      .enableAnimation(true)
      .autoHalfFold(true)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(PAGE_BG)
  }

  @Builder
  private TopOverlay() {
    Column() {
      if (this.platformBar) {
        this.PlatformTopBand()
      } else {
        this.SelfDrawnTopBand()
      }
    }
    .width('100%')
    // Named so a layout dump can be read against the pixels, the way the bottom
    // fade is: this box is what says where the page's top edge sits and how far
    // the transcript's content starts below it, and the side padding the band
    // carries is only visible in a dump as an offset between the box and its
    // first child. The name sits on the wrapper rather than on either band
    // because both bands are the same box, and two nodes may not share one id.
    .id('conversation-top-band')
    .onAreaChange((_oldArea: Area, newArea: Area) => {
      this.topInset = newArea.height as number;
    })
  }

  /**
   * The band under the platform's own title bar.
   *
   * Where the chrome is the platform's — the compact conversation route — this
   * band paints nothing at all. Painting the page's overlay colour and blurring
   * here would be the second glass over the title bar's own material, which is
   * what the plan forbids outright; the platform's own bar is the one that paints
   * the floor and draws the blur, and it has a floor at every offset because this
   * transcript runs *under* the band rather than below it.
   *
   * What is left is the band's own box, which is still the transcript's content
   * start offset and still carries the window's side strips. Its top padding is
   * the platform bar's height: that is what keeps the rename row (and only the
   * rename row, which is this band's only content here) out from under the
   * chrome, while the transcript itself scrolls up into it. The status bar needs
   * no reservation of its own: the platform band avoids the strip, so the band's
   * content and this pane's content both start below it.
   */
  @Builder
  private PlatformTopBand() {
    Column() {
      this.Header()
      this.Mailbox()
    }
    .width('100%')
    .padding({
      left: this.insets.leftPadding(0),
      right: this.insets.rightPadding(0),
      top: this.topBandOffset()
    })
  }

  /**
   * The band a host that draws its own header gets.
   *
   * This is the wide composition's top band — the page's own top edge, and a
   * *content* surface rather than a navigation bar: it is not a destination's
   * `titleBar`, and the app is the thing that decides what it is made of. It is a
   * content surface on every device, so the platform material is not drawn on it and
   * the band paints the whole of its own glass, every value asked of the shared surface
   * support so a recipe change moves them together:
   *
   * - the page overlay colour is the floor, through the recipe;
   * - the recipe's thin blur does the separating, through the recipe;
   * - the band's own half-pixel hairline closes the box at the bottom, and the fade
   *   below it carries the band into the transcript.
   *
   * The design draft for this surface (`artifacts/ui-drafts/wide-topband/option-b.html`)
   * is where the floor, the blur and the hairline were read from. The material channel
   * belongs to the platform's own band, which is the compact route's `titleBar` and a
   * different surface entirely — one surface, one channel.
   */
  @Builder
  private SelfDrawnTopBand() {
    Column() {
      // One chain, and it is the glass this band paints itself. The band is a content
      // surface the app draws, so the policy answers no material for it: adopting one
      // would drop the fill, the blur and the edge below, and a component's material
      // is accepted and then not drawn — the bare band, with the transcript reading
      // through it at full contrast. Every value here is the recipe's, so the band
      // answers to the top-chrome glass and not to this file.
      Column() {
        this.TopBandContent()
      }
      .width('100%')
      // Carried by the band that owns the background, not by the wrapper: the
      // band is what has to reach the status bar, and its measured height is
      // what the transcript borrows as its content start offset. Its sides are
      // the window's wherever this page *is* the window — the compact layout,
      // and the wide compositions that put it flush against an edge — so it
      // reserves the side strips as well; the header's own gutter lives inside
      // it and is not restated here.
      //
      // In the usual wide layout this page is the detail pane instead, and then
      // only its right edge is the window's: the left one is the master pane's.
      // A layout dump of that posture reads the left strip as a 21.14vp indent
      // on a band that never touches that edge (see the note on `FlowPlaceholder`
      // in RemoteSurfaceHost — the padding model cannot drop one side per edge,
      // and dropping both would put the compact header back under the cutout).
      .padding({ left: this.insets.leftPadding(0), right: this.insets.rightPadding(0), top: this.topSafeInset })
      .backgroundColor(ImmersiveSurfaceSupport.surfaceFill(ImmersiveSurfaceScene.TOP_CHROME, PAGE_BG_OVERLAY))
      .backgroundBlurStyle(ImmersiveSurfaceSupport.surfaceBlur(ImmersiveSurfaceScene.TOP_CHROME))
      .border(ImmersiveSurfaceSupport.surfaceHairline(ImmersiveSurfaceScene.TOP_CHROME, TOP_BAND_HAIRLINE_WIDTH))
      this.TopEdgeFade()
    }
    .width('100%')
  }

  /**
   * The band's contents, mounted by its decoration chain.
   *
   * The surface is a property of the band, not of what sits on it, so the header and
   * the mailbox are stated once, here, and a change to either reaches every device.
   */
  @Builder
  private TopBandContent() {
    this.Header()
    this.Mailbox()
  }

  @Builder
  private BottomOverlay() {
    Column() {
      this.InlineStatusLine()
      this.Composer()
    }
    .width('100%')
    // The composer keeps the distance from the screen edge it had while the page
    // area ended above the navigation bar, and the layer's own box grows by that
    // strip: the gradient below is the layer's background, so it fills the strip
    // and the transcript behind it reaches the bottom of the screen. Wherever the
    // layer's sides are the window's — the compact layout, and the wide
    // compositions that put the page flush against an edge — they are the
    // layer's own business as well: the composer's gutter is inside it, and on a
    // rotated device the camera cutout would otherwise sit over the first control
    // of the row. In the usual wide layout the layer is the detail pane's width
    // instead, so only its right edge is the window's and the left strip is an
    // indent nothing needs; see the note on `TopOverlay` above.
    .padding({
      left: this.insets.leftPadding(0),
      right: this.insets.rightPadding(0),
      bottom: this.bottomSafeInset
    })
    // The fade covers the whole layer, not just a strip above it: the transcript
    // runs behind the composer, so anything short of that leaves a line of text
    // sitting crisp and legible beside the pill after it has already faded out
    // higher up. It stops short of the page colour so the pill's blur still has
    // something to work with.
    //
    // Every stop is asked of the bottom-chrome surface, because this layer is the
    // backdrop the pill sits on and the two share one answer. All three stops are the
    // colours this layer has always painted: the pill paints its own glass on every
    // device, so there is no posture left in which this layer has to stand down.
    //
    // The note this replaces recorded the opposite as an accepted consequence — while
    // the pill adopted a material this layer painted nothing, and the status line above
    // it and the strip below it stood on no backing. That posture is gone with the
    // component material, so the consequence is gone with it: the fade is back on every
    // device, and the legibility floor it used to cost is not a trade this app makes.
    .linearGradient({
      angle: 180,
      colors: [
        [ImmersiveSurfaceSupport.surfaceFill(ImmersiveSurfaceScene.BOTTOM_CHROME, PAGE_BG_FADE), 0.0],
        [ImmersiveSurfaceSupport.surfaceFill(ImmersiveSurfaceScene.BOTTOM_CHROME, PAGE_BG_OVERLAY), 0.45],
        [ImmersiveSurfaceSupport.surfaceFill(ImmersiveSurfaceScene.BOTTOM_CHROME, PAGE_BG_OVERLAY), 1.0]
      ]
    })
    // This layer owns the bottom edge of the screen, so it is allowed to paint
    // into it. Where the immersive layout already puts the page area there the
    // two overlap and nothing extra is drawn; on a window that still ends above
    // the navigation bar this is what keeps the strip from being bare page
    // colour under the fade. The cutout is a separate avoid area, so the fade
    // claims it as well: a device that rotated its camera onto an edge the fade
    // reaches would otherwise show the page colour beside the gradient. Both of
    // its sides are named because `expandSafeArea` is per edge and only takes
    // effect where this box's own boundary meets that edge's safe-area
    // boundary: a side the compact layer owns expands, and the same claim on the
    // detail pane's left side — where the master pane is in between — draws
    // nothing. `TOP` is deliberately absent: this layer is only as tall as the
    // status line and the composer and sits at the bottom of the pane, so its
    // top edge is nowhere near the window's top avoid area and naming it would
    // claim a strip the fade never touches.
    .expandSafeArea([SafeAreaType.SYSTEM, SafeAreaType.CUTOUT],
      [SafeAreaEdge.START, SafeAreaEdge.END, SafeAreaEdge.BOTTOM])
    // Named so a layout dump can be read against the pixels: the fade's own box
    // is what says where the chat page's bottom edge sits and how far the
    // transcript can scroll, and neither is visible in the composer's bounds.
    .id('conversation-bottom-fade')
    .onAreaChange((_oldArea: Area, newArea: Area) => {
      this.bottomInset = newArea.height as number;
    })
  }

  /**
   * Carries the header's opaque band down into the transcript. Without it a
   * line of text is cut in half at the band's edge and reads as clipped rather
   * than as continuing underneath. Never takes a touch: the transcript below
   * it is still the thing being pointed at. The bottom layer needs no strip of
   * its own — its whole background is the gradient.
   */
  @Builder
  private TopEdgeFade() {
    Column()
      .width('100%')
      .height(MobileDesignGeometry.conversationEdgeFadeHeight)
      .hitTestBehavior(HitTestMode.None)
      .linearGradient({
        angle: 180,
        colors: [[PAGE_BG, 0.0], [PAGE_BG_FADE, 1.0]]
      })
  }

  @Builder
  private InlineStatusLine() {
    if (this.inlineStatusText.length > 0 && !this.shouldCenterInlineStatus()) {
      Text(this.inlineStatusText)
        .fontSize(MobileDesignTypography.labelSmall.size)
        .lineHeight(MobileDesignTypography.labelSmall.lineHeight)
        .fontColor(MUTED)
        .width('100%')
        .padding({ left: 20, right: 20, bottom: 8 })
    }
  }

  @Builder
  private Mailbox() {
    if (this.surface === ChatSurface.Remote && this.state.interactionMailbox.sessionId === this.state.activeSession.sessionId) {
      InteractionMailboxPanel({ state: this.state.interactionMailbox,
        onAction: (action: InteractionMailboxAction): void => this.onIntent(ConversationIntents.mailbox(action)) })
    }
  }

  @Builder
  private ConversationBody() {
    if (this.shouldCenterInlineStatus()) {
      this.CenteredInlineStatus()
    } else {
      // Keep the list subtree alive while a slow transcript is loading. The
      // former top-level conditional destroyed and rebuilt ChatTimeline every
      // time the 140 ms loading gate opened, losing its scroll state and making
      // rapid session switches visibly flash.
      Stack() {
        Column() {
          this.MessageList()
        }
        .width('100%')
        .height('100%')
        if (this.isLoadingTranscript) {
          ConversationLoadingState({
            maxContentWidth: this.composerPresentation === ComposerPresentation.Floating ? 760 : 0,
            topInset: this.hoverOperateMode ? 0 : this.topInset
          })
            .width('100%')
            .height('100%')
            .backgroundColor(PAGE_BG)
        }
      }
      .width('100%')
      .height('100%')
    }
  }

  @Builder
  Header() {
    ConversationHeader({
      translucent: true,
      // Where the platform owns the top edge this header is only the rename
      // row; its title, its back control and its menu are the title bar's.
      platformBar: this.platformBar,
      renameRequest: this.renameRequest,
      title: this.headerTitle(),
      subtitle: this.headerSubtitle(),
      titleFallback: this.headerFallback(),
      allowRename: this.headerAllowRename(),
      showActions: this.headerShowActions(),
      showSidebarButton: this.showSidebarButton,
      showBackButton: this.showBackButton,
      showSidebarRestoreButton: this.showSidebarRestoreButton,
      showActionsMenu: this.showHeaderActions,
      actionsMenu: () => {
        this.HeaderActionsMenu();
      },
      onOpenSidebar: () => {
        this.onOpenSidebar();
      },
      onRestoreSidebar: () => {
        this.onRestoreSidebar();
      },
      onBack: () => {
        this.onBack();
      },
      onOpenActions: () => {
        this.showHeaderActions = !this.showHeaderActions;
      },
      onActionsMenuStateChange: (visible: boolean) => {
        this.showHeaderActions = visible;
      },
      onRenameSession: (title: string) => {
        this.onRenameSession(title);
      }
    })
  }

  @Builder
  MessageList() {
    ChatTimeline({
      interactionMailbox: this.state.interactionMailbox,
      surface: this.surface,
      timelineItems: this.visibleTimelineItems(),
      timelineRevision: this.timelineRevision,
      hasMoreMessages: this.hasMoreMessages,
      historyLoading: this.state.historyLoading,
      historyFailed: this.state.historyFailed,
      isBusy: this.isBusy || this.isLoadingConversation,
      connectionState: this.connectionState,
      statusText: this.statusText,
      downloadingFilePath: this.downloadingFilePath,
      downloadedFilePath: this.downloadedFilePath,
      fileDownloadStatus: this.fileDownloadStatus,
      activeFilePreviewPath: this.activeFilePreviewPath,
      activeFilePreviewLoading: this.activeFilePreviewLoading,
      maxContentWidth: this.composerPresentation === ComposerPresentation.Floating ? 760 : 0,
      topInset: this.hoverOperateMode ? 0 : this.topInset,
      bottomInset: this.hoverOperateMode ? 0 : this.bottomInset,
      ghostRowKeys: this.ghostRowKeys(),
      rollbackNotice: this.state.rollbackNotice,
      onLoadOlder: () => {
        this.onLoadOlder();
      },
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
      onOpenFullText: (text: string, turnId: string) => {
        this.onOpenFullText(text, turnId);
      },
      onRollbackMessage: (turnId: string, text: string) => {
        this.onRollbackMessage(turnId, text);
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
  }

  @Builder
  CenteredInlineStatus() {
    Stack({ alignContent: Alignment.Center }) {
      Text(this.inlineStatusText)
        .fontSize(MobileDesignTypography.bodyMedium.size)
        .lineHeight(MobileDesignTypography.bodyMedium.lineHeight)
        .fontColor(MUTED)
        .textAlign(TextAlign.Center)
        .maxLines(2)
    }
    .width('100%')
    .height('100%')
    .padding({ left: 32, right: 32, bottom: 48 })
  }

  @Builder
  Composer() {
    Column() {
      // Above the composer in both presentations: the compact pill and the wide
      // floating one both live in this column, so one placement covers both. The
      // bar draws nothing at all while no rollback is staged.
      RollbackStagingBar({
        presentation: this.composerPresentation,
        bar: this.rollbackBar(),
        onConfirm: () => {
          this.applyRollbackEvent({ type: SessionRollbackEventType.ConfirmRollback });
        },
        onClose: () => {
          this.applyRollbackEvent({ type: SessionRollbackEventType.CloseStaging });
        }
      })
      ComposerBar({
      presentation: this.composerPresentation,
      capabilities: this.composerCapabilities,
      inputId: this.composerInputId,
      chatInput: this.chatInput,
      promptSuggestion: this.stagingTargetTurnId.length > 0 ? '' : this.state.promptSuggestion,
      selectedImages: this.selectedImages,
      isBusy: this.isBusy,
      canStop: this.canStop,
      connectionState: this.connectionState,
      isVoiceListening: this.isVoiceListening,
      modelCatalog: this.modelCatalog,
      selectedModelId: this.selectedModelId,
      onPickImages: () => {
        this.onPickImages();
      },
      onRemoveImage: (imageId: string) => {
        this.onRemoveImage(imageId);
      },
      onSend: () => {
        this.onSend();
      },
      onStop: () => {
        this.onStop();
      },
      onVoiceInput: () => {
        this.onVoiceInput();
      },
      onSelectModel: (modelId: string) => {
        this.onSelectModel(modelId);
      },
      onChatInputChange: (value: string) => {
        this.onChatInputChange(value);
      }
      })
    }
    .width('100%')
  }

  /**
   * The conversation's menu where this pane still owns the trigger.
   *
   * The wide pane draws its own header, so its overflow control anchors a popup
   * and the popover bubble carries the material — the menu root then paints the
   * fallback card the same way every other self-presented surface does. Where
   * the platform title bar owns the trigger (`openTitleBarMenu` below) the same
   * rows are handed to `promptAction.openMenu` instead, and only the paint
   * differs: one menu, two presentations, no second set of rows.
   */
  @Builder
  HeaderActionsMenu() {
    ConversationHeaderMenu({
      items: this.menuItems(),
      sectionLabel: RemoteI18n.t('chat.sessionSection'),
      paintsOwnCard: true,
      onSelect: (id: string) => {
        this.onHeaderMenuSelect(id);
      }
    })
  }

  private menuItems(): ConversationHeaderMenuItem[] {
    return ConversationHeaderPolicy.menu(
      this.surface,
      this.isSessionPinned,
      this.canStop,
      this.connectionState === 'connected'
    );
  }

  /**
   * One chosen row, whichever chrome presented the menu.
   *
   * Rename is the row the header's own title used to carry: the title is the
   * platform's text now and tapping it is not a control the platform offers, so
   * the row asks the content area's editor to open instead. Everything else is
   * the intent this menu has always sent.
   */
  private onHeaderMenuSelect(id: string): void {
    this.closePlatformMenu();
    this.showHeaderActions = false;
    if (id === ConversationHeaderMenuAction.Rename) {
      this.renameRequest += 1;
      return;
    }
    if (id === ConversationHeaderMenuAction.Pin) {
      this.onTogglePinSession();
      return;
    }
    if (id === ConversationHeaderMenuAction.UploadedFiles) {
      this.onShowUploadedFiles();
      return;
    }
    if (id === ConversationHeaderMenuAction.Archive) {
      this.onArchiveSession();
      return;
    }
    if (id === ConversationHeaderMenuAction.Delete) {
      this.onDeleteSession();
      return;
    }
    if (id === ConversationHeaderMenuAction.Stop) {
      this.onStop();
    }
  }

  /**
   * Opens the conversation's menu against the platform title bar's trigger.
   *
   * The trigger is the bar's own icon, so it cannot be a `bindPopup` anchor: the
   * platform's `openMenu` is the API for exactly this, and it takes the node the
   * menu renders plus the id the bar gave that icon. The menu's own background
   * and material come from the shared floating-menu options, so this path and the
   * popover path resolve the material the same way.
   */
  private openTitleBarMenu(): void {
    this.showHeaderActions = false;
    const uiContext: UIContext = this.getUIContext();
    const params = new ConversationHeaderMenuParams(
      this.menuItems(),
      RemoteI18n.t('chat.sessionSection'),
      (id: string): void => {
        this.onHeaderMenuSelect(id);
      }
    );
    try {
      const content = new ComponentContent<ConversationHeaderMenuParams>(
        uiContext,
        wrapBuilder<[ConversationHeaderMenuParams]>(conversationHeaderMenuBuilder),
        params
      );
      this.platformMenuContent = content;
      uiContext.getPromptAction().openMenu(
        content,
        { id: CONVERSATION_HEADER_MENU_ANCHOR_ID },
        ImmersiveSurfaceSupport.menuOptions(ImmersiveSurfaceScene.FLOATING_MENU)
      );
    } catch (err) {
      this.platformMenuContent = undefined;
      RemoteLogger.error(`Conversation menu open failed: ${err}`);
    }
  }

  /**
   * Takes the platform's menu down, if this pane opened one.
   *
   * A row that opens something else — the rename editor — must not leave the
   * menu standing over it, and `closeMenu` needs the node `openMenu` was given,
   * which is why the node is kept rather than rebuilt.
   */
  private closePlatformMenu(): void {
    const content: ComponentContent<ConversationHeaderMenuParams> | undefined = this.platformMenuContent;
    if (content === undefined) {
      return;
    }
    this.platformMenuContent = undefined;
    try {
      this.getUIContext().getPromptAction().closeMenu(content);
    } catch (err) {
      RemoteLogger.error(`Conversation menu close failed: ${err}`);
    }
  }

  private shouldCenterInlineStatus(): boolean {
    return this.inlineStatusText.length > 0 &&
      !this.isBusy &&
      !ConversationViewContract.hasRealTimelineItem(this.timelineItems);
  }

  private visibleTimelineItems(): ObservableChatTimelineItem[] {
    return ConversationViewContract.visibleTimelineItems(this.timelineItems);
  }

  /**
   * The staged rollback as the reducer sees it.
   *
   * Rebuilt per event rather than stored, so this pane owns only what it must
   * remember between events and the policy keeps every rule about transitions.
   */
  private rollbackState(): SessionRollbackState {
    if (this.stagingTargetTurnId.length === 0) {
      return new SessionRollbackIdleState();
    }
    return new SessionRollbackStagingState(
      this.stagingTargetTurnId,
      this.stagingTargetText,
      this.composerSnapshot
    );
  }

  /** Adopts the reducer's state back into the three locals that stand for it. */
  private adoptRollbackState(state: SessionRollbackState): void {
    if (state.stage === SessionRollbackStage.Staging) {
      this.stagingTargetTurnId = state.targetTurnId;
      this.stagingTargetText = state.targetText;
      this.composerSnapshot = state.composerSnapshot;
      return;
    }
    // Leaving staging is what clears the preview: the ghost rows are derived from
    // the target, so dropping it clears them without a second list to keep.
    this.stagingTargetTurnId = '';
    this.stagingTargetText = '';
    this.composerSnapshot = '';
  }

  /**
   * One staged-rollback event: reduce, adopt the new state, then apply the effects.
   *
   * The send-while-staging exit states itself as two effects in order — rollback,
   * then send — and the viewmodel runs both inside one command, because the host
   * has to retire the turn before a message may be appended to it. The text is
   * therefore read out of the second effect and handed over with the first.
   */
  private applyRollbackEvent(event: SessionRollbackEvent): void {
    const transition = SessionRollbackPolicy.reduce(this.rollbackState(), event);
    this.adoptRollbackState(transition.state);
    let sendText: string = '';
    for (let index = 0; index < transition.effects.length; index++) {
      const effect = transition.effects[index];
      if (effect.type === SessionRollbackEffectType.SendMessageAfterRollback) {
        sendText = effect.text || '';
      }
    }
    for (let index = 0; index < transition.effects.length; index++) {
      this.runRollbackEffect(transition.effects[index], sendText);
    }
  }

  private runRollbackEffect(effect: SessionRollbackEffect, sendText: string): void {
    switch (effect.type) {
      case SessionRollbackEffectType.RefillComposer:
      case SessionRollbackEffectType.RestoreComposerSnapshot:
        this.onChatInputChange(effect.text || '');
        return;
      case SessionRollbackEffectType.KeepComposerText:
        return;
      case SessionRollbackEffectType.ShowGhostRows:
        this.stagingTargetTurnId = effect.targetTurnId || this.stagingTargetTurnId;
        return;
      case SessionRollbackEffectType.ClearGhostRows:
        // Already done by adopting the idle state: no ghost row outlives staging.
        return;
      case SessionRollbackEffectType.SendRollbackCommand:
        this.onIntent(ConversationIntents.rollback(effect.targetTurnId || '', sendText));
        return;
      case SessionRollbackEffectType.SendMessageAfterRollback:
        // Handed to the rollback command above; sending here would append the
        // message before the host retired the turn.
        return;
      case SessionRollbackEffectType.ResyncTimeline:
        this.onIntent(ConversationIntents.rollbackResync());
        return;
      case SessionRollbackEffectType.ShowDegradeNotice:
        this.onIntent(ConversationIntents.rollbackNotice(RollbackPresentationPolicy.FAILED_KEY));
        return;
      default:
        return;
    }
  }

  /**
   * The rollback entry on a user message was tapped.
   *
   * The decision is resolved here, at tap time, rather than when the row was
   * drawn: a session that became busy in between is judged as it is now. A
   * refusal is always said out loud — an entry that silently does nothing is
   * indistinguishable from a broken one — while an allowed tap stages locally and
   * sends nothing.
   */
  private onRollbackMessage(turnId: string, text: string): void {
    const decision = this.state.rollbackGate.resolve();
    if (!decision.allowed) {
      this.onIntent(ConversationIntents.rollbackNotice(RollbackPresentationPolicy.denyMessageKey(decision.reason)));
      return;
    }
    const target = turnId.trim();
    if (target.length === 0) {
      // The entry is still offered here — the session is usable, this message is
      // just not addressable as a turn — so the refusal is the honest answer.
      this.onIntent(ConversationIntents.rollbackNotice(RollbackPresentationPolicy.FAILED_KEY));
      return;
    }
    // Staging takes the pane over: the panel that was opened from this message
    // closes, because the preview belongs to the conversation behind it.
    this.showFullText = false;
    this.applyRollbackEvent({
      type: SessionRollbackEventType.EnterStaging,
      targetTurnId: target,
      targetText: text,
      composerSnapshot: this.chatInput
    });
  }

  /**
   * The rows the staged preview weakens: the target turn and every row after it.
   *
   * Derived, never stored: the rows are virtualized and their identity is the
   * only thing stable about them, so the cut is expressed as row keys against the
   * list the pane is showing right now.
   */
  private ghostRowKeys(): string[] {
    if (this.stagingTargetTurnId.length === 0) {
      return [];
    }
    const rows: RollbackGhostRow[] = this.visibleTimelineItems().map(
      (row: ObservableChatTimelineItem): RollbackGhostRow => new RollbackGhostRow(
        ChatTimelineRevisionTracker.itemKey(row),
        row.message ? row.message.turnId || '' : ''
      )
    );
    return RollbackPresentationPolicy.ghostRowKeys(rows, this.stagingTargetTurnId);
  }

  private rollbackBar(): RollbackBarPresentation {
    return RollbackPresentationPolicy.bar(this.rollbackState());
  }

  /**
   * Consumes a host outcome that arrived after staging was already over.
   *
   * Confirm and send leave staging before the host answers, which is the point:
   * the preview is local and must react instantly. The answer therefore comes
   * back through projected state rather than through the transition that sent it,
   * and it must be applied even while idle — a stale target and a refusal both
   * mean this client's transcript is describing history the host no longer has.
   */
  @Monitor('state')
  onViewStateChanged(): void {
    const identity = `${this.state.surface}:${this.state.activeSession.sessionId}:${this.state.sessionContextRevision}`;
    if (identity !== this.rollbackContextIdentity) {
      this.rollbackContextIdentity = identity;
      // A reused wide pane must drop A's preview without restoring its draft
      // through an intent now routed to B. Resizing the same session keeps it.
      this.stagingTargetTurnId = '';
      this.stagingTargetText = '';
      this.composerSnapshot = '';
      this.showFullText = false;
      this.fullTextMessage = '';
      this.fullTextTurnId = '';
      this.showHeaderActions = false;
      this.handledRollbackOutcomeSeq = this.state.rollbackOutcomeSeq;
      // The menu belongs to the session that asked for it: a trigger another
      // session never pressed must not open this one's menu.
      this.handledMenuSeq = this.state.conversationHeaderMenuSeq;
      this.closePlatformMenu();
      return;
    }
    this.consumePlatformMenuRequest();
    const sequence = this.state.rollbackOutcomeSeq;
    if (sequence <= this.handledRollbackOutcomeSeq) {
      return;
    }
    this.handledRollbackOutcomeSeq = sequence;
    if (this.state.rollbackOutcome === SessionRollbackEventType.StaleViewDetected) {
      this.applyRollbackEvent({ type: SessionRollbackEventType.StaleViewDetected });
      return;
    }
    if (this.state.rollbackOutcome === SessionRollbackEventType.RollbackFailed) {
      this.applyRollbackEvent({ type: SessionRollbackEventType.RollbackFailed });
    }
  }

  /**
   * Opens the menu for a trigger this pane cannot see.
   *
   * The platform title bar's overflow control is the app root's chrome, so the
   * tap reaches this pane as a projected sequence and is consumed exactly once,
   * the same way a rollback outcome is: an unrelated rebuild carries the same
   * number and must not reopen anything.
   */
  private consumePlatformMenuRequest(): void {
    const sequence = this.state.conversationHeaderMenuSeq;
    if (sequence <= this.handledMenuSeq) {
      return;
    }
    this.handledMenuSeq = sequence;
    if (this.platformBar) {
      this.openTitleBarMenu();
    }
  }

  private statusLine(): string {
    if (this.canStop && this.connectionState === 'connected') {
      return RemoteI18n.t('chat.executing');
    }
    return ConnectionStatusPresenter.detail(this.connectionState, this.statusText, '', '');
  }

  private headerTitle(): string {
    return this.headerPresentation().title;
  }

  private headerSubtitle(): string {
    return this.headerPresentation().subtitle;
  }

  private headerFallback(): string {
    return RemoteI18n.t(this.headerPresentation().fallbackKey);
  }

  private headerAllowRename(): boolean {
    return this.headerPresentation().allowRename;
  }

  private headerShowActions(): boolean {
    return this.headerPresentation().showActions;
  }

  private headerPresentation(): ConversationHeaderPresentation {
    return ConversationHeaderPolicy.present(
      this.surface,
      this.activeSession.title,
      this.desktopName,
      this.workspaceBranch,
      ConversationViewContract.hasRealTimelineItem(this.timelineItems)
    );
  }

  private connectionColor(): ResourceColor {
    const tone = ConnectionStatusPresenter.tone(this.connectionState);
    if (tone === 'ok') {
      return STATUS_SUCCESS;
    }
    if (tone === 'error') {
      return STATUS_DANGER;
    }
    return MUTED;
  }

  private get surface(): ChatSurface { return this.state.surface; }
  private get activeSession(): ConversationUiSession { return this.state.activeSession; }
  private get desktopName(): string { return this.state.desktopName; }
  private get workspaceBranch(): string { return this.state.workspaceBranch; }
  private get statusText(): string { return this.state.statusText; }
  private get inlineStatusText(): string { return this.state.inlineStatusText; }
  private get connectionState(): string { return this.state.connectionState; }
  private get composerCapabilities(): ChatComposerCapabilities { return this.state.composerCapabilities; }
  private get isBusy(): boolean { return this.state.isBusy; }
  private get isLoadingConversation(): boolean { return this.state.isLoadingConversation; }
  /**
   * The skeleton stands for a body with nothing in it yet, which is true both
   * while the session is being identified and while its transcript is still
   * crossing the relay. Only the first of those blanks the header.
   */
  private get isLoadingTranscript(): boolean {
    return this.state.isLoadingConversation || this.state.isLoadingTranscript;
  }
  private get canStop(): boolean { return this.state.canStop; }
  private get hasMoreMessages(): boolean { return this.state.hasMoreMessages; }
  private get timelineItems(): ObservableChatTimelineItem[] { return this.state.timelineItems; }
  private get timelineRevision(): number { return this.state.timelineRevision; }
  private get modelCatalog(): ConversationUiModelCatalog { return this.state.modelCatalog; }
  private get selectedModelId(): string { return this.state.selectedModelId; }
  private get downloadingFilePath(): string { return this.state.downloadingFilePath; }
  private get downloadedFilePath(): string { return this.state.downloadedFilePath; }
  private get fileDownloadStatus(): string { return this.state.fileDownloadStatus; }
  private get selectedImages(): ConversationUiSelectedImage[] { return this.state.selectedImages; }
  private get isVoiceListening(): boolean { return this.state.isVoiceListening; }
  private get chatInput(): string { return this.state.chatInput; }
  private get isSessionPinned(): boolean { return this.state.isSessionPinned; }
  private get activeFilePreviewPath(): string { return this.options.activeFilePreviewPath; }
  private get activeFilePreviewLoading(): boolean { return this.options.activeFilePreviewLoading; }
  private get showSidebarButton(): boolean { return this.options.showSidebarButton; }
  private get showBackButton(): boolean { return this.options.showBackButton; }
  private get showSidebarRestoreButton(): boolean { return this.options.showSidebarRestoreButton; }
  private get composerPresentation(): ComposerPresentation { return this.options.composerPresentation; }
  private get composerInputId(): string { return this.options.composerInputId; }
  private get hoverOperateMode(): boolean { return this.options.hoverOperateMode; }
  private get fullTextSheetPlacement(): SettingsPlacement { return this.options.fullTextSheetPlacement; }
  /**
   * Whether the platform's title bar owns this pane's top edge.
   *
   * True only on the compact conversation route, where the app root hands the
   * band to `HdsNavDestination.titleBar`. Everything else — the wide pane, the
   * design preview — keeps the header this pane draws, and this is the one flag
   * the two shapes are separated by, so neither can drift into painting the
   * other's chrome.
   */
  private get platformBar(): boolean { return this.options.platformBar; }

  /**
   * The top the band's content starts at.
   *
   * Under the platform's bar that is the bar plus the system strip above it: the bar
   * avoids the strip (`HdsTitleBarSupport` asks the platform for that), so the pane
   * below has to start below both. The bar overlays the page, so this offset is what
   * keeps the rename row out from under the chrome while the transcript still scrolls
   * up into it. Where this pane draws its own band, it is the status bar strip the
   * band has to reach.
   *
   * The strip comes from the shared binding, which is the app's one measurement
   * point; the table adds the bar's own height to it.
   */
  private topBandOffset(): number {
    return this.platformBar ?
      HdsTitleBarPolicy.reservedBandHeight(HdsTitleBarScene.Conversation, this.topSafeInset) : this.topSafeInset;
  }
  private onOpenSidebar(): void { this.dispatchSimple(ConversationIntentType.OpenSidebar); }
  private onBack(): void { this.dispatchSimple(ConversationIntentType.Back); }
  private onTogglePinSession(): void { this.dispatchSimple(ConversationIntentType.TogglePin); }
  private onArchiveSession(): void { this.dispatchSimple(ConversationIntentType.Archive); }
  private onDeleteSession(): void { this.dispatchSimple(ConversationIntentType.Delete); }
  private onShowUploadedFiles(): void { this.dispatchSimple(ConversationIntentType.ShowUploadedFiles); }
  private onStop(): void { this.dispatchSimple(ConversationIntentType.Stop); }
  private onLoadOlder(): void { this.dispatchSimple(ConversationIntentType.LoadOlder); }
  private onApproveTool(toolId: string, updatedInput?: Object): void {
    this.onIntent(ConversationIntents.approveTool(toolId, updatedInput));
  }
  private onRejectTool(toolId: string): void {
    this.onIntent(ConversationIntents.tool(ConversationIntentType.RejectTool, toolId));
  }
  private onCancelTool(toolId: string): void {
    this.onIntent(ConversationIntents.tool(ConversationIntentType.CancelTool, toolId));
  }
  private onAnswerQuestion(toolId: string, answers: ConversationUiQuestionAnswer): void {
    this.onIntent(ConversationIntents.answerQuestion(toolId, answers));
  }
  private onRenameSession(title: string): void {
    this.dispatchValue(ConversationIntentType.RenameSession, title);
  }
  private onCopyMessage(text: string): void { this.dispatchValue(ConversationIntentType.CopyMessage, text); }
  private onCopyMessageScoped(text: string, scope: MessageCopyScope): void {
    this.onIntent(ConversationIntents.copyMessage(text, scope));
  }
  private onRetryMessage(text: string): void { this.dispatchValue(ConversationIntentType.RetryMessage, text); }
  private onOpenFullText(text: string, turnId: string): void {
    if (text.length === 0) {
      return;
    }
    this.fullTextMessage = text;
    this.fullTextTurnId = turnId;
    this.showFullText = true;
  }
  private fullTextSheetOptions(): SheetOptions {
    // The panel's own heading is the platform title bar's now, so the sheet is
    // asked for it here: the adaptive contract supplies the placement's geometry
    // and leaves the background, the scrim and the close icon to the platform.
    return ImmersiveSurfaceSupport.sheetOptions(
      ImmersiveSurfaceScene.MODAL_SHEET,
      AdaptiveSheetOptions.fromPlacement(this.fullTextSheetPlacement, RemoteI18n.t('chat.fullText'))
    );
  }
  private onOpenFilePreview(path: string, label: string): void {
    this.onIntent(ConversationIntents.openFilePreview(path, label));
  }
  private onBuildPlan(path: string, name: string): void {
    this.onIntent(ConversationIntents.buildPlan(path, name));
  }
  private onSelectModel(modelId: string): void { this.dispatchValue(ConversationIntentType.SelectModel, modelId); }
  private onPickImages(): void { this.dispatchSimple(ConversationIntentType.PickImages); }
  private onRemoveImage(imageId: string): void { this.dispatchValue(ConversationIntentType.RemoveImage, imageId); }
  private onDownloadFile(path: string): void { this.dispatchValue(ConversationIntentType.DownloadFile, path); }
  /**
   * Send is the third exit of the staged rollback.
   *
   * While a rollback is staged the button means "roll back first, then send what
   * is in the composer from there": the reducer states those two steps in that
   * order and the viewmodel runs them as one command, so the message can never
   * beat the rollback it was sent after.
   */
  private onSend(): void {
    if (this.stagingTargetTurnId.length > 0) {
      this.applyRollbackEvent({
        type: SessionRollbackEventType.SendWhileStaging,
        text: this.chatInput.trim()
      });
      return;
    }
    this.dispatchSimple(ConversationIntentType.Send);
  }
  private onVoiceInput(): void { this.dispatchSimple(ConversationIntentType.VoiceInput); }
  private onChatInputChange(value: string): void {
    this.dispatchValue(ConversationIntentType.ChatInputChanged, value);
  }

  private dispatchSimple(type: ConversationIntentType): void {
    this.onIntent(ConversationIntents.simple(type));
  }

  private dispatchValue(type: ConversationIntentType, value: string): void {
    this.onIntent(ConversationIntents.value(type, value));
  }
}
