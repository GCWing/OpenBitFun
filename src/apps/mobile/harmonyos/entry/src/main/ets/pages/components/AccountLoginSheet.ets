import { PAGE_BG } from './Theme';
import { OpenBitFunAccountLoginPage } from './OpenBitFunAccountLoginPage';
import { SHEET_TOP_RADIUS } from './SheetLayout';

/**
 * Signed-out account request (settings mode 'account'). Settings itself is a
 * single page; this sheet only hosts the separate login step and hands back to
 * that page once the account settles.
 */
@ComponentV2
export struct AccountLoginSheet {
  @Event onClose: () => void = () => {};
  /** Account login finished: return to the single settings page. */
  @Event onAccountSettled: () => void = () => {};
  @Event cloudCancelLogin: () => void = () => {};
  @Event cloudLogin: () => Promise<string> = async (): Promise<string> => '';

  build() {
    Stack() {
      OpenBitFunAccountLoginPage({
        cloudLogin: this.cloudLogin,
        cloudCancelLogin: this.cloudCancelLogin,
        onClose: this.onClose,
        onLoginSuccess: this.onAccountSettled
      })
    }
    .width('100%')
    .backgroundColor(PAGE_BG)
    .borderRadius({ topLeft: SHEET_TOP_RADIUS, topRight: SHEET_TOP_RADIUS })
  }
}
