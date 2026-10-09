import { MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { WindowInsetsBinding } from '../../services/WindowSystemBarService';
import { RollbackSelectionMenu } from './RollbackSelectionMenu';
import { SheetCloseHeader } from './SheetCloseHeader';
import { SHEET_HORIZONTAL_PADDING, SHEET_TOP_RADIUS } from './SheetLayout';
import { INK, PAGE_BG } from './Theme';

/**
 * One user message in full, opened from the truncated bubble's inline "full
 * text" affordance.
 *
 * The body is a plain selectable Text on purpose: this is the surface where a
 * long message is read and selected with the system selection menu and its
 * handles, so it carries `CopyOptions.LocalDevice` while the truncated bubble
 * it was opened from deliberately does not. Nothing else lives here — the
 * sheet's placement, scrim and drag bar belong to the adaptive sheet contract
 * the conversation binds it with.
 *
 * The panel also carries the rollback entry, on the same system selection menu
 * the short bubble uses and through the same shared item: a message too long to
 * read in its bubble is exactly the one a reader goes looking for that entry on.
 * The panel closes as staging begins — the pane that owns the staging state is
 * the conversation behind this sheet, and the preview belongs to it.
 */
@ComponentV2
export struct UserMessageFullTextSheet {
  @Param text: string = '';
  @Event onClose: () => void = () => {};
  @Event onRollback: () => void = () => {};
  /**
   * The panel's own text controller, so the rollback item dismisses the system
   * selection menu it was tapped in instead of leaving it over the conversation the
   * staging belongs to (see `RollbackSelectionMenu`).
   */
  private readonly selectionController: TextController = new TextController();
  // The sheet is a bottom sheet under the immersive shell, so it reads the
  // navigation-bar strip itself and ends in a tail that rests the text above it.
  @Local insets: WindowInsetsBinding = new WindowInsetsBinding();

  aboutToAppear(): void {
    const context = this.getUIContext().getHostContext();
    if (context) {
      this.insets.bind(this.getUIContext(), context);
    }
  }

  aboutToDisappear(): void {
    this.insets.unbind();
  }

  build() {
    Column() {
      SheetCloseHeader({
        title: RemoteI18n.t('chat.fullText'),
        showDivider: true,
        onClose: this.onClose
      })
      Scroll() {
        Text(this.text, { controller: this.selectionController })
          .width('100%')
          .fontSize(MobileDesignTypography.bodyLarge.size)
          .lineHeight(MobileDesignTypography.bodyLarge.lineHeight)
          .fontColor(INK)
          .copyOption(CopyOptions.LocalDevice)
          .editMenuOptions(RollbackSelectionMenu.options(this.selectionController, () => {
            this.onRollback();
          }))
          .padding({
            left: SHEET_HORIZONTAL_PADDING,
            right: SHEET_HORIZONTAL_PADDING,
            top: 18,
            bottom: this.insets.tailSpacing(24)
          })
      }
      .width('100%')
      .layoutWeight(1)
      .align(Alignment.TopStart)
      .scrollBar(BarState.Off)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(PAGE_BG)
    .borderRadius({ topLeft: SHEET_TOP_RADIUS, topRight: SHEET_TOP_RADIUS })
  }
}
