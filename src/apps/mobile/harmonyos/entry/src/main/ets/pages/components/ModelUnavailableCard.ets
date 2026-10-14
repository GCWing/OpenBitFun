import { MobileDesignGeometry, MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { CARD, INK, SOFT, STATUS_DANGER } from './Theme';

/**
 * Why a model page cannot be answered, and the way to ask again.
 *
 * Both pages of the device model settings can be open when the desktop stops
 * answering: the settings page when the phone is not connected to it, and the
 * picker on top of it when the link drops while the list is up. The reason
 * belongs to neither page — the controller already decided which sentence
 * describes the state — so it is rendered here, once, in the sheet's own card
 * language.
 *
 * The retry is offered only when repeating the read can actually help, which the
 * caller decides: a gate that is closed re-arms by itself when the desktop comes
 * back, and a button that cannot do anything is worse than no button.
 */
@ComponentV2
export struct ModelUnavailableCard {
  /** The controller's resolved reason, or the host's own words for a failed read. */
  @Param reason: string = '';
  /** Repeat the read that failed. */
  @Param canRetry: boolean = false;
  /** A request is in flight, so the page does not take a second one. */
  @Param busy: boolean = false;
  /** Distinguishes the two pages' cards in the layout hierarchy. */
  @Param cardId: string = 'model-unavailable';
  @Event onRetry: () => void = () => {};

  build() {
    Column({ space: 10 }) {
      Text(this.reason)
        .width('100%')
        .fontSize(MobileDesignTypography.bodySmall.size)
        .lineHeight(MobileDesignTypography.bodySmall.lineHeight)
        .fontColor(STATUS_DANGER)
        .maxLines(3)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      if (this.canRetry) {
        Text(RemoteI18n.t('common.retry'))
          .fontSize(MobileDesignTypography.bodyMedium.size)
          .fontWeight(FontWeight.Medium)
          .fontColor(INK)
          .padding({ left: 10, right: 10, top: 6, bottom: 6 })
          .backgroundColor(SOFT)
          .borderRadius(14)
          .id(`${this.cardId}-retry`)
          .enabled(!this.busy)
          .opacity(this.busy ? 0.6 : 1)
          .onClick(() => {
            this.onRetry();
          })
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding({ left: 18, right: 18, top: 16, bottom: 16 })
    .backgroundColor(CARD)
    .borderRadius(MobileDesignGeometry.settingsCardRadius)
    .id(this.cardId)
  }
}
