import { MobileDesignGeometry, MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import {
  UserMessageMenuAction,
  UserMessageMenuItem,
  UserMessageMenuPolicy
} from '../policy/UserMessageMenuPolicy';
import { UserMessageTruncationPolicy } from '../policy/UserMessageTruncationPolicy';
import { ConversationUiMessage } from '../state/ConversationUiModels';
import { MessageImageGallery } from './ChatMessageContent';
import { ACCENT, INK, MUTED, CONTENT_ON_ACTION, STATUS_DANGER, SOFT, FILE_LINK } from './Theme';

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
    .width('100%')
    .textAlign(TextAlign.Start)
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
