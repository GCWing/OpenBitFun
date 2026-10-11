import { MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { CloudAccountDevice } from '../../services/CloudAccountClient';
import { ConnectAccountDevicePage } from './ConnectAccountDevicePage';
import { AppActionButton, AppActionStyle } from './AppActionButton';
import { NavigationBackButton } from './NavigationBackButton';
import {
  ConnectSheetLandingPolicy,
  ConnectSheetStatusPolicy,
  ConnectSheetStep
} from '../policy/ConnectSheetLandingPolicy';
import { CARD, CONNECT_HERO_ACCENT, CONNECT_HERO_BG, CONNECT_HERO_SECONDARY,
  CONNECT_HERO_SURFACE, INK, MUTED, SOFT, STATUS_DANGER, STATUS_SUCCESS, SUBTLE } from './Theme';
import { WindowInsetsBinding } from '../../services/WindowSystemBarService';

/**
 * Connect sheet. A signed-in phone picks a desktop from the account device
 * directory; a signed-out phone is sent to account sign-in. The phone no
 * longer creates pairings from a scanned or pasted link. A link persisted by
 * an older version is still shown in the status strip and can be retried.
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
  @Event onBack: () => void = () => {};
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
    .backgroundColor(CARD)
  }

  @Builder
  AccountDeviceSelectionPage() {
    ConnectAccountDevicePage({
      deviceId: this.deviceId,
      controlTargetDeviceId: this.controlTargetDeviceId,
      connectionState: this.connectionState,
      cloudListDevices: this.cloudListDevices,
      cloudSelectDevice: this.cloudSelectDevice,
      onBack: () => {
        this.onBack();
      },
    })
  }

  @Builder
  IntroPairingPage() {
    Column() {
      Stack() {
        this.HeroWash()
        this.BackButton()
      }
      .width('100%')
      .height(250)

      Column({ space: 18 }) {
        this.DesktopGlyph()
        Text(RemoteI18n.t('connect.chooseConnectionTitle'))
          .fontSize(MobileDesignTypography.displayLarge.size)
          .fontWeight(FontWeight.Bold)
          .fontColor(INK)
          .textAlign(TextAlign.Center)
          .width('100%')

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
      .margin({ top: -24 })

      if (this.shouldShowStatusStrip()) {
        this.StatusStrip()
      }
    }
    .width('100%')
    .height('100%')
    // The sheet's fill runs to its bottom edge; the status strip is the fixed
    // control there, and it keeps the navigation bar clear itself.
    .padding({ bottom: this.insets.bottomPadding(28) })
    .backgroundColor(CARD)
  }

  @Builder
  HeroWash() {
    Stack() {
      Text('')
        .width('100%')
        .height(282)
        .backgroundColor(CONNECT_HERO_BG)
        .borderRadius(36)
      Text('')
        .width(260)
        .height(142)
        .backgroundColor(CONNECT_HERO_SURFACE)
        .opacity(0.7)
        .borderRadius(72)
        .position({ x: 112, y: 26 })
      Text('')
        .width(188)
        .height(134)
        .backgroundColor(CONNECT_HERO_ACCENT)
        .opacity(0.42)
        .borderRadius(68)
        .position({ x: -42, y: 198 })
      Text('')
        .width(188)
        .height(126)
        .backgroundColor(CONNECT_HERO_SECONDARY)
        .opacity(0.54)
        .borderRadius(64)
        .position({ x: 258, y: 0 })
    }
    .width('100%')
    .height(282)
  }

  @Builder
  BackButton() {
    NavigationBackButton({
      controlSize: 48,
      onBack: (): void => {
        this.onBack();
      }
    })
      .position({ x: 28, y: 18 })
  }

  @Builder
  DesktopGlyph() {
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
    .margin({ bottom: 4 })
  }

  @Builder
  StatusStrip() {
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
