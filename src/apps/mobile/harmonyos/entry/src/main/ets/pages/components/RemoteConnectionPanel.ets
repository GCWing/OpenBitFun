import { RemoteI18n } from '../../i18n/RemoteI18n';
import { MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { BrandMark } from './BrandMark';
import { INK, MUTED, TRANSPARENT } from './Theme';

/** Shared welcome composition for phone home and an empty wide master pane. */
@ComponentV2
export struct RemoteConnectionPanel {
  @Param title: string = '';
  @Param detail: string = '';
  @Param busy: boolean = false;
  @BuilderParam primaryAction: () => void = this.EmptyAction;
  @Event onMiniApps: () => void = () => {};

  build() {
    Column() {
      Scroll() {
        Column({ space: 16 }) {
          BrandMark({ markSize: 104 })
            .margin({ bottom: 12 })
          Text(this.title)
            .fontSize(MobileDesignTypography.headlineLarge.size).fontWeight(FontWeight.Medium).fontColor(INK)
            .textAlign(TextAlign.Center)
          Text(this.detail)
            .fontSize(MobileDesignTypography.bodyMedium.size)
            .lineHeight(23).fontColor(MUTED).textAlign(TextAlign.Center)
            .constraintSize({ maxWidth: 300 })
          if (this.busy) {
            LoadingProgress().width(20).height(20).color(MUTED)
          }
        }
        .width('100%').padding({ top: 32, bottom: 32, left: 12, right: 12 })
      }
      .width('100%').layoutWeight(1).scrollBar(BarState.Off)
      .align(Alignment.Center)

      Column({ space: 10 }) {
        this.primaryAction()
        Button({ type: ButtonType.Normal }) {
          Row({ space: 9 }) {
            SymbolGlyph($r('sys.symbol.square_grid_2x2')).fontSize(18).fontColor([MUTED])
            Text(RemoteI18n.t('home.exploreMiniApps'))
              .fontSize(MobileDesignTypography.bodyMedium.size).fontColor(MUTED)
          }
          .justifyContent(FlexAlign.Center)
        }
        .width('100%').height(48).backgroundColor(TRANSPARENT)
        .borderRadius(24).onClick(this.onMiniApps)
        Text(RemoteI18n.t('home.miniAppsHint'))
          .fontSize(MobileDesignTypography.labelSmall.size).fontColor(MUTED)
          .textAlign(TextAlign.Center)
      }
      .width('100%').constraintSize({ maxWidth: 360 })
      .padding({ top: 12, bottom: 24 })
    }
    .width('100%').height('100%').constraintSize({ maxWidth: 560 })
    .padding({ left: 24, right: 24 }).alignItems(HorizontalAlign.Center)
  }

  @Builder
  private EmptyAction() { Row() {} }
}
