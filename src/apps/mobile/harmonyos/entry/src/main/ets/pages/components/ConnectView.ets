import { MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { CloudAccountDevice } from '../../services/CloudAccountClient';
import { ConnectAccountDevicePage } from './ConnectAccountDevicePage';
import { AppActionButton, AppActionStyle } from './AppActionButton';
import {
  ConnectSheetLandingPolicy,
  ConnectSheetStatusPolicy,
  ConnectSheetStep
} from '../policy/ConnectSheetLandingPolicy';
import { CONNECT_HERO_ACCENT, CONNECT_HERO_BG, CONNECT_HERO_SECONDARY,
  CONNECT_HERO_SURFACE, INK, MUTED, SOFT, STATUS_DANGER, STATUS_SUCCESS, SUBTLE } from './Theme';
import { WindowInsetsBinding } from '../../services/WindowSystemBarService';

/**
 * The hero band's height, in vp. The wash is the sheet's own top edge — it runs
 * the full width of the content area, from the platform title bar down — so its
 * height is its own geometry, not a card's.
 */
const CONNECT_HERO_HEIGHT: number = 236;

/**
 * Connect sheet. A signed-in phone picks a desktop from the account device
 * directory; a signed-out phone is sent to account sign-in. The phone no
 * longer creates pairings from a scanned or pasted link. A link persisted by
 * an older version is still shown in the status strip and can be retried.
 *
 * The sheet's title, its close icon and its background are the platform's (see
 * `AppShell.connectSheetOptions`), so this content names nothing twice and draws
 * no way out of itself: the sign-in/step-back control the header used to carry
 * was the same dismissal the system chrome already offers.
 */
@ComponentV2
export struct ConnectView {
  @Param remoteUrl: string = '';
  @Param userId: string = '';
  @Param statusText: string = RemoteI18n.t('status.waitingConnection');
  @Param connectionState: string = 'idle';
  @Param connectionFailureKind: string = '';
  @Param isBusy: boolean = false;
  @Param isConnected: boolean = false;
  @Param desktopName: string = '';
  @Param deviceId: string = '';
  @Param accountUserId: string = '';
  @Param controlTargetDeviceId: string = '';
  @Event onOpenAccount: () => void = () => {};
  @Event onConnect: () => void = () => {};
  @Event cloudListDevices: () => Promise<CloudAccountDevice[]> = async (): Promise<CloudAccountDevice[]> => [];
  @Event cloudSelectDevice: (device: CloudAccountDevice) => Promise<void> =
    async (_device: CloudAccountDevice): Promise<void> => {};
  /**
   * The sheet's own bottom edge, in vp. The connect sheet is full-height and
   * its status strip is the fixed control at that edge, so the strip keeps the
   * navigation bar clear itself.
   */
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
    Stack() {
      if (this.currentStep() === ConnectSheetStep.Account) {
        this.AccountDeviceSelectionPage()
      } else {
        this.IntroPairingPage()
      }
    }
    .width('100%')
    .height('100%')
    // No fill of its own: the Connect sheet is the platform's, and its background
    // is the band this content sits on.
  }

  @Builder
  private AccountDeviceSelectionPage() {
    ConnectAccountDevicePage({
      deviceId: this.deviceId,
      controlTargetDeviceId: this.controlTargetDeviceId,
      connectionState: this.connectionState,
      cloudListDevices: this.cloudListDevices,
      cloudSelectDevice: this.cloudSelectDevice,
    })
  }

  /**
   * The signed-out step: the hero wash is the sheet's top edge and carries the
   * desktop glyph, and the sign-in action is the one control below it.
   *
   * The step names itself nowhere: the platform title bar says
   * `connect.chooseConnectionTitle`, which is the heading this page used to draw
   * under its own copy of it.
   */
  @Builder
  private IntroPairingPage() {
    Column() {
      this.HeroWash()

      Column({ space: 18 }) {
        AppActionButton({
          label: RemoteI18n.t('sidebar.signInOpenBitFunAccount'),
          style: AppActionStyle.Secondary,
          actionHeight: 58,
          onAction: (): void => {
            this.onOpenAccount();
          }
        })
          .width('82%')
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Center)
      .justifyContent(FlexAlign.Center)

      if (this.shouldShowStatusStrip()) {
        this.StatusStrip()
      }
    }
    .width('100%')
    .height('100%')
    // The page's fill runs to the sheet's bottom edge, and the status strip is
    // the fixed control there: it keeps the navigation bar clear itself.
    .padding({ bottom: this.insets.bottomPadding(28) })
  }

  /**
   * The full-bleed wash at the top of the sheet.
   *
   * It used to be a 36vp-rounded card holding the content's rounded top corners,
   * which the platform title bar has since taken over: a card there is a card
   * inside a card, with its corner radius showing as a notch under the title bar.
   * The band now starts at the content area's own top edge and runs its width.
   *
   * Its blobs are anchored to the band's edges — two on the left, one on the
   * right — rather than to x offsets measured on one window, so the wash holds
   * its shape in the phone's sheet and in the wide centered dialog alike; the
   * bleed off every edge is deliberate and `clip` keeps it inside the band.
   * The glyph is the hero's subject, so it is centered in it.
   */
  @Builder
  private HeroWash() {
    Stack({ alignContent: Alignment.TopStart }) {
      Text('')
        .width(260)
        .height(142)
        .backgroundColor(CONNECT_HERO_SURFACE)
        .opacity(0.7)
        .borderRadius(72)
        .position({ x: -48, y: 22 })
      Row() {
        Text('')
          .width(188)
          .height(134)
          .backgroundColor(CONNECT_HERO_ACCENT)
          .opacity(0.42)
          .borderRadius(68)
      }
      .width('100%')
      .height(134)
      .justifyContent(FlexAlign.Start)
      .position({ x: -56, y: CONNECT_HERO_HEIGHT - 104 })
      Row() {
        Text('')
          .width(188)
          .height(126)
          .backgroundColor(CONNECT_HERO_SECONDARY)
          .opacity(0.54)
          .borderRadius(64)
      }
      .width('100%')
      .height(126)
      .justifyContent(FlexAlign.End)
      .position({ x: 44, y: 0 })
      Row() {
        this.DesktopGlyph()
      }
      .width('100%')
      .height('100%')
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center)
      // The glyph is the hero's only subject now that the heading has moved to the
      // platform title bar, so it takes a little more presence: scaled rather than
      // redrawn, which keeps its own geometry the design's.
      .scale({ x: 1.18, y: 1.18 })
    }
    .width('100%')
    .height(CONNECT_HERO_HEIGHT)
    .backgroundColor(CONNECT_HERO_BG)
    .clip(true)
  }

  @Builder
  private DesktopGlyph() {
    Stack() {
      Text('')
        .width(58)
        .height(39)
        .borderRadius(8)
        .border({ width: 5, color: INK })
        .position({ x: 5, y: 0 })
      Text('')
        .width(26)
        .height(13)
        .border({ width: 5, color: INK })
        .position({ x: 21, y: 38 })
    }
    .width(68)
    .height(55)
  }

  @Builder
  private StatusStrip() {
    Column({ space: 8 }) {
      Row({ space: 8 }) {
        Text('●')
          .fontSize(MobileDesignTypography.labelSmall.size)
          .fontColor(this.statusDotColor())
        Text(this.statusDetail())
          .fontSize(MobileDesignTypography.bodySmall.size)
          .fontColor(this.isConnectError() ? INK : MUTED)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .height(30)
      .padding({ left: 12, right: 12 })
      .backgroundColor(SOFT)
      .borderRadius(15)
      .onClick(() => {
        this.handleStatusClick();
      })
      if (this.isConnectError() && this.failureHint().length > 0) {
        Text(this.failureHint())
          .fontSize(MobileDesignTypography.labelSmall.size)
          .lineHeight(MobileDesignTypography.labelSmall.lineHeight)
          .fontColor(MUTED)
          .textAlign(TextAlign.Center)
          .width('78%')
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Center)
  }

  private statusDotColor(): ResourceColor {
    if (this.isConnected) {
      return STATUS_SUCCESS;
    }
    if (this.isConnectError()) {
      return STATUS_DANGER;
    }
    if (this.isBusy || this.connectionState === 'parsing' || this.connectionState === 'pairing' || this.connectionState === 'reconnecting') {
      return INK;
    }
    return SUBTLE;
  }

  private statusDetail(): string {
    if (this.remoteUrl.trim().length === 0) {
      return RemoteI18n.t('connect.noDesktopDetail');
    }
    if (this.isConnected) {
      return RemoteI18n.f2('connect.connectedTo', this.userId || this.deviceId, this.desktopName);
    }
    if (this.isBusy || this.connectionState === 'parsing' || this.connectionState === 'pairing' || this.connectionState === 'reconnecting') {
      return this.statusText || RemoteI18n.t('connect.connecting');
    }
    if (this.isConnectError()) {
      return this.statusText || RemoteI18n.t('connect.cannotConnectDesktop');
    }
    if (this.connectionState === 'disconnected') {
      return this.statusText || RemoteI18n.t('connect.desktopDisconnected');
    }
    return RemoteI18n.t('connect.waitingDesktop');
  }

  private handleStatusClick(): void {
    if (this.isBusy) {
      return;
    }
    if (this.remoteUrl.trim().length > 0) {
      this.onConnect();
      return;
    }
    if (!this.isAccountAuthenticated()) {
      this.onOpenAccount();
    }
  }

  private currentStep(): string {
    return ConnectSheetLandingPolicy.step(this.isAccountAuthenticated());
  }

  private isAccountAuthenticated(): boolean {
    return this.accountUserId.trim().length > 0;
  }

  private shouldShowStatusStrip(): boolean {
    return this.remoteUrl.trim().length > 0 ||
      this.isBusy ||
      this.isConnected ||
      this.isConnectError() ||
      this.connectionState === 'disconnected' ||
      this.connectionState === 'reconnecting';
  }

  private isConnectError(): boolean {
    return ConnectSheetStatusPolicy.isConnectError(
      this.connectionState,
      this.isBusy,
      this.isConnected,
      this.statusText,
      RemoteI18n.t('common.failed'),
      RemoteI18n.t('errors.remoteUrlMissingParams'),
      RemoteI18n.t('errors.remoteUrlRequired')
    );
  }

  private failureHint(): string {
    const key = ConnectSheetStatusPolicy.failureHintKey(this.connectionFailureKind);
    return key.length > 0 ? RemoteI18n.t(key) : '';
  }
}
