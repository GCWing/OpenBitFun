import { WelcomeHome } from '../components/WelcomeHome';
import { MobileDesignGeometry, MobileDesignTypography } from '../../generated/MobileDesignTokens';
import {
  MobilePreviewMessage,
  MobilePreviewScenario,
  MobilePreviewScenarios
} from '../../generated/MobilePreviewScenarios';
import { ComposerBar, ComposerPresentation } from '../components/ComposerBar';
import { ConversationHeader } from '../components/ConversationHeader';
import { INK, LINE, MUTED, PAGE_BG, SOFT, TRANSPARENT } from '../components/Theme';

@Entry
@ComponentV2
struct MobileDesignGallery {
  @Param scenario: MobilePreviewScenario = MobilePreviewScenarios.connectedConversation;

  private resolvedScenario(): MobilePreviewScenario {
    switch (AppStorage.get<string>('scenarioId') ?? '') {
      case 'streaming-dark':
        return MobilePreviewScenarios.streamingDark;
      case 'reconnecting-wide':
        return MobilePreviewScenarios.reconnectingWide;
      case 'narrow-multiline': return MobilePreviewScenarios.narrowMultiline;
      case 'fold-context': return MobilePreviewScenarios.foldContext;
      case 'long-reading': return MobilePreviewScenarios.longReading;
      case 'connected-conversation':
        return MobilePreviewScenarios.connectedConversation;
      default:
        return this.scenario;
    }
  }

  build() {
    if (AppStorage.get<string>('scenarioId') === 'welcome-home') {
      WelcomeHome()
    } else {
      this.ConversationPreview()
    }
  }

  @Builder
  private ConversationPreview() {
    Column() {
      this.PlatformLabel()
      ConversationHeader({
        title: this.resolvedScenario().headerTitle,
        subtitle: this.resolvedScenario().headerSubtitle,
        showSidebarButton: true,
        showActions: true
      })
      Column({ space: MobileDesignGeometry.messageSpacing }) {
        ForEach(this.resolvedScenario().messages, (message: MobilePreviewMessage) => {
          this.MessageRow(message)
        }, (message: MobilePreviewMessage) => `${message.role}:${message.text}`)
      }
      .layoutWeight(1)
      .width('100%')
      .alignItems(HorizontalAlign.Start)
      .padding({
        left: MobileDesignGeometry.contentGutter,
        right: MobileDesignGeometry.contentGutter,
        top: MobileDesignGeometry.timelineTopPadding
      })
      ComposerBar({
        presentation: ComposerPresentation.Compact,
        chatInput: this.resolvedScenario().composerDraft,
        isBusy: this.resolvedScenario().streaming,
        canStop: this.resolvedScenario().streaming,
        connectionState: this.resolvedScenario().connectionPhase
      })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(PAGE_BG)
  }

  @Builder
  private PlatformLabel() {
    Row({ space: 8 }) {
      Text('HarmonyOS')
        .fontSize(MobileDesignTypography.labelMedium.size)
        .fontWeight(FontWeight.Medium)
        .fontColor(INK)
      Text('BASELINE')
        .fontSize(MobileDesignTypography.labelSmall.size)
        .fontColor(MUTED)
        .padding({ left: 8, right: 8, top: 4, bottom: 4 })
        .backgroundColor(SOFT)
        .borderRadius(10)
      Blank()
      Text(`${this.resolvedScenario().viewportWidth} × ${this.resolvedScenario().viewportHeight}`)
        .fontSize(MobileDesignTypography.labelSmall.size)
        .fontColor(MUTED)
    }
    .width('100%')
    .height(MobileDesignGeometry.connectionStripHeight)
    .padding({ left: MobileDesignGeometry.contentGutter, right: MobileDesignGeometry.contentGutter })
    .border({ width: { bottom: 1 }, color: LINE })
  }

  @Builder
  private MessageRow(message: MobilePreviewMessage) {
    Row() {
      if (message.role === 'user') {
        Blank()
      }
      Text(message.text)
        .fontSize(MobileDesignTypography.bodyLarge.size)
        .fontColor(INK)
        .lineHeight(MobileDesignTypography.bodyLarge.lineHeight)
        .constraintSize({
          maxWidth: message.role === 'user' ? MobileDesignGeometry.messageBubbleMaxWidth : '100%'
        })
        .padding({
          left: message.role === 'user' ? MobileDesignGeometry.messageBubbleHorizontalPadding : 0,
          right: message.role === 'user' ? MobileDesignGeometry.messageBubbleHorizontalPadding : 0,
          top: message.role === 'user' ? MobileDesignGeometry.messageBubbleVerticalPadding : 2,
          bottom: message.role === 'user' ? MobileDesignGeometry.messageBubbleVerticalPadding : 2
        })
        .backgroundColor(message.role === 'user' ? SOFT : TRANSPARENT)
        .borderRadius(message.role === 'user' ? MobileDesignGeometry.messageBubbleRadius : 0)
      if (message.role !== 'user') {
        Blank()
      }
    }
    .width('100%')
  }
}

@Preview({
  title: 'OpenBitFun Mobile · Compact',
  width: 390,
  height: 844
})
@ComponentV2
struct MobileDesignCompactPreview {
  build() {
    MobileDesignGallery({ scenario: MobilePreviewScenarios.connectedConversation })
  }
}

@Preview({
  title: 'OpenBitFun Mobile · Dark',
  width: 390,
  height: 844
})
@ComponentV2
struct MobileDesignStreamingDarkPreview {
  build() {
    MobileDesignGallery({ scenario: MobilePreviewScenarios.streamingDark })
  }
}

@Preview({
  title: 'OpenBitFun Mobile · Wide',
  width: 1024,
  height: 768
})
@ComponentV2
struct MobileDesignWidePreview {
  build() {
    MobileDesignGallery({ scenario: MobilePreviewScenarios.reconnectingWide })
  }
}
