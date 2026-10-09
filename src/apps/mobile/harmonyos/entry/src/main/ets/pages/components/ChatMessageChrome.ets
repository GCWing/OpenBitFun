import { MobileDesignGeometry, MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { MessageCopyScope } from '../actions/ConversationIntent';
import { MarkdownParser } from '../../services/MarkdownParser';
import {
  AssistantMessageCopyMenuItem,
  AssistantMessageCopyMenuPolicy
} from '../policy/AssistantMessageCopyMenuPolicy';
import {
  UserMessageMenuAction,
  UserMessageMenuItem,
  UserMessageMenuPolicy
} from '../policy/UserMessageMenuPolicy';
import { UserMessageTruncationPolicy } from '../policy/UserMessageTruncationPolicy';
import { ConversationUiMessage } from '../state/ConversationUiModels';
import { MessageImageGallery } from './ChatMessageContent';
import {
  ACCENT,
  CARD,
  INK,
  LINE,
  MUTED,
  CONTENT_ON_ACTION,
  SHADOW_SUBTLE,
  SOFT,
  STATUS_DANGER,
  TRANSPARENT,
  FILE_LINK
} from './Theme';

@ComponentV2
export struct ChatTypingDots {
  @Local phase: number = 0;
  private timerId: number = 0;

  aboutToAppear(): void {
    this.timerId = setInterval(() => {
      this.phase = (this.phase + 1) % 3;
    }, 360);
  }

  aboutToDisappear(): void {
    if (this.timerId !== 0) {
      clearInterval(this.timerId);
      this.timerId = 0;
    }
  }

  build() {
    Row({ space: 5 }) {
      ForEach([0, 1, 2], (index: number) => {
        Text('•')
          .width(6)
          .height(18)
          .fontSize(MobileDesignTypography.bodyLarge.size)
          .fontColor(MUTED)
          .opacity(this.phase === index ? 1.0 : 0.34)
          .animation({ duration: 180, curve: Curve.EaseInOut })
      })
    }
    .height(24)
    .padding({ left: 2 })
  }
}

@ComponentV2
export struct ChatMessageRetryAction {
  @Param assistant: boolean = false;
  @Param retryText: string = '';
  @Event onRetry: (text: string) => void = (_text: string) => {};

  build() {
    Row({ space: 8 }) {
      Text(this.assistant ? RemoteI18n.t('generalChat.replyInterrupted') : RemoteI18n.t('chat.sendFailed'))
        .fontSize(MobileDesignTypography.labelSmall.size)
        .fontColor(STATUS_DANGER)
      Text(RemoteI18n.t('common.retry'))
        .fontSize(MobileDesignTypography.labelSmall.size)
        .fontColor(CONTENT_ON_ACTION)
        .height(28)
        .padding({ left: 10, right: 10 })
        .backgroundColor(ACCENT)
        .borderRadius(14)
        .onClick(() => this.onRetry(this.retryText))
    }
  }
}

@ComponentV2
export struct ChatUserMessageBubble {
  @Param item: ConversationUiMessage = {
    id: '',
    role: 'user',
    text: '',
    status: '',
    detail: ''
  };
  @Param showRetryAction: boolean = false;
  @Event onCopyMessage: (text: string) => void = (_text: string) => {};
  @Event onOpenFullText: (text: string) => void = (_text: string) => {};
  @Event onRetryMessage: (text: string) => void = (_text: string) => {};

  build() {
    Row() {
      Blank()
      Column({ space: 6 }) {
        if (this.visibleText().length > 0 || (this.item.images && this.item.images.length > 0)) {
          Column({ space: 8 }) {
            if (this.item.images && this.item.images.length > 0) {
              MessageImageGallery({ images: this.item.images, userStyle: true })
            }
            if (this.visibleText().length > 0) {
              if (UserMessageTruncationPolicy.shouldTruncate(this.visibleText())) {
                this.TruncatedText()
              } else {
                // A short message is the ordinary selectable Text: a long press
                // raises the system selection menu and its handles.
                this.PlainText()
              }
            }
          }
          .padding({
            left: MobileDesignGeometry.messageBubbleHorizontalPadding,
            right: MobileDesignGeometry.messageBubbleHorizontalPadding,
            top: MobileDesignGeometry.messageBubbleVerticalPadding,
            bottom: MobileDesignGeometry.messageBubbleVerticalPadding
          })
          .backgroundColor(SOFT)
          .borderRadius(MobileDesignGeometry.messageBubbleRadius)
          .alignItems(HorizontalAlign.Start)
        }
        if (this.item.status === 'failed' && this.showRetryAction) {
          ChatMessageRetryAction({ retryText: this.item.text, onRetry: this.onRetryMessage })
        }
      }
      .constraintSize({ maxWidth: MobileDesignGeometry.messageBubbleMaxWidth })
      .alignItems(HorizontalAlign.End)
    }
    .width('100%')
    .padding({ top: 2, bottom: 2 })
  }

  @Builder
  private PlainText() {
    Text(this.visibleText())
      .fontSize(MobileDesignTypography.bodyLarge.size)
      .lineHeight(MobileDesignTypography.bodyLarge.lineHeight)
      .fontColor(INK)
      .copyOption(CopyOptions.LocalDevice)
  }

  /**
   * The truncated bubble. The cut is made by the policy rather than by
   * `maxLines` ellipsis: the full-text affordance has to sit inline after the
   * ellipsis, and an ellipsized Text cannot host an appended clickable span.
   *
   * This Text carries no `copyOption`: the frozen design keeps selection
   * handles off a bubble whose text continues past what is drawn, and answers a
   * long press with the menu below instead. Handles belong to the panel.
   *
   * It also carries no `width`: a percentage width resolves against the row the
   * bubble sits in rather than the bubble's own content box, so the Text was
   * measured wider than the fill behind it. Measured on device, the bubble's
   * fill ended at 1215 of a 1256-wide screen while the Text's own box ran to
   * 1256, and the appended affix — the only content on the last line that
   * reaches past the fill — was drawn outside the bubble and clipped there. At
   * the content's own width the line breaks inside the bubble, and the
   * affordance wraps onto the next line when it does not fit, which is the shape
   * the frozen design specifies.
   */
  @Builder
  private TruncatedText() {
    Text() {
      Span(UserMessageTruncationPolicy.truncatedPreview(this.visibleText()))
        .fontColor(INK)
      Span(` ${RemoteI18n.t('chat.fullText')}`)
        .fontSize(MobileDesignTypography.bodyMedium.size)
        .fontColor(FILE_LINK)
        .decoration({ type: TextDecorationType.Underline, color: FILE_LINK })
        .onClick(() => {
          this.onOpenFullText(this.visibleText());
        })
    }
    .fontSize(MobileDesignTypography.bodyLarge.size)
    .lineHeight(MobileDesignTypography.bodyLarge.lineHeight)
    .bindContextMenu(this.TruncatedMenu(), ResponseType.LongPress)
  }

  @Builder
  private TruncatedMenu() {
    Menu() {
      ForEach(UserMessageMenuPolicy.items(), (entry: UserMessageMenuItem) => {
        MenuItem({ content: RemoteI18n.t(entry.labelKey) })
          .onClick(() => {
            this.runMenuAction(entry.action);
          })
      }, (entry: UserMessageMenuItem) => entry.action)
    }
  }

  private runMenuAction(action: UserMessageMenuAction): void {
    if (action === UserMessageMenuAction.CopyFullText) {
      this.onCopyMessage(this.visibleText());
    }
  }

  private visibleText(): string {
    const text = this.item.text.trim();
    return text === '(空消息)' || text === '(empty message)' ? '' : text;
  }
}

/**
 * The assistant message's copy affordance: the SOFT-weakened capsule of the
 * bottom action row, beside the retry pill's ACCENT one.
 *
 * It opens an anchored popover rather than a bottom sheet, because the frozen
 * design keeps a lightweight action list at its trigger on compact and wide
 * layouts alike. The popup is bound to the control it was opened from, so it
 * points at that control, dismisses on an outside tap, and carries the same
 * short transition as the conversation header's menu. A row thawed from the
 * reusable pool closes its menu first: the pool hands a kept `@Local` back to a
 * different message.
 *
 * The bubble passes the message's Markdown source as the transcript holds it.
 * Only the plain entry renders it down, through the parser's existing
 * Markdown-to-text pass; the other two copy the source itself.
 */
@ComponentV2
export struct AssistantMessageCopyAction {
  @Param source: string = '';
  @Event onCopyScoped: (text: string, scope: MessageCopyScope) => void =
    (_text: string, _scope: MessageCopyScope) => {};
  @Local showMenu: boolean = false;

  aboutToReuse(): void {
    this.showMenu = false;
  }

  build() {
    Text(RemoteI18n.t('common.copy'))
      .fontSize(MobileDesignTypography.labelSmall.size)
      .fontWeight(FontWeight.Medium)
      .fontColor(INK)
      .height(28)
      .padding({ left: 10, right: 10 })
      .backgroundColor(SOFT)
      .borderRadius(14)
      .accessibilityText(RemoteI18n.t('common.copy'))
      .onClick(() => {
        this.showMenu = !this.showMenu;
      })
      .bindPopup(this.showMenu, {
        builder: () => {
          this.CopyMenu();
        },
        placement: Placement.BottomLeft,
        popupColor: TRANSPARENT,
        enableArrow: false,
        autoCancel: true,
        mask: false,
        targetSpace: 8,
        onStateChange: (event: PopupStateChangeParam) => {
          this.showMenu = event.isVisible;
        }
      })
  }

  // Keep the three copy scopes compact while preserving 44vp touch targets.
  @Builder
  private CopyMenu() {
    Column() {
      ForEach(AssistantMessageCopyMenuPolicy.items(), (entry: AssistantMessageCopyMenuItem) => {
        Text(RemoteI18n.t(entry.labelKey))
          .width('100%')
          .height(44)
          .padding({ left: 8, right: 8 })
          .fontSize(MobileDesignTypography.bodySmall.size)
          .fontColor(INK)
          .textAlign(TextAlign.Start)
          .borderRadius(10)
          .onClick(() => {
            this.runMenuAction(entry);
          })
      }, (entry: AssistantMessageCopyMenuItem) => entry.action)
    }
    .width(196)
    .padding({ left: 8, right: 8, top: 4, bottom: 4 })
    .backgroundColor(CARD)
    .border({ width: 0.5, color: LINE })
    .borderRadius(16)
    .shadow({ radius: 18, color: SHADOW_SUBTLE, offsetY: 7 })
    .transition(TransitionEffect.opacity(0).animation({ duration: 150, curve: Curve.EaseOut }))
  }

  private runMenuAction(entry: AssistantMessageCopyMenuItem): void {
    this.showMenu = false;
    this.onCopyScoped(this.payloadFor(entry.scope), entry.scope);
  }

  private payloadFor(scope: MessageCopyScope): string {
    return scope === MessageCopyScope.Plain ? MarkdownParser.formatInlineText(this.source) : this.source;
  }
}
