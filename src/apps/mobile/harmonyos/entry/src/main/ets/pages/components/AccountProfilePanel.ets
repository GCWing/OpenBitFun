import { MobileDesignGeometry, MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { CloudAccountDevice } from '../../services/CloudAccountClient';
import { AccountDeviceSelectionPolicy } from '../policy/AccountDeviceSelectionPolicy';
import { CARD, STATUS_SUCCESS, INK, LINE, MUTED, PAGE_BG, STATUS_DANGER, SOFT } from './Theme';
import { DefaultAccountAvatar } from './DefaultAccountAvatar';

/** Account identity and device management shared by Settings and account entry. */
@ComponentV2
export struct AccountProfilePanel {
  @Param accountUsername: string = '';
  @Param accountAvatarUrl: string = '';
  @Param accountUserId: string = '';
  @Param fallbackUserId: string = '';
  @Param deviceId: string = '';
  @Param controlTargetType: string = 'none';
  @Param controlTargetDeviceId: string = '';
  @Param connectionState: string = 'idle';
  @BuilderParam preferences: () => void = this.EmptyBuilder;
  @BuilderParam connection: () => void = this.EmptyBuilder;
  @BuilderParam about: () => void = this.EmptyBuilder;
  @Event onLoggedOut: () => void = () => {};
  @Event onOpenAccount: () => void = () => {};
  @Event onReconnect: () => void = () => {};
  @Event cloudLogout: () => Promise<void> = async (): Promise<void> => {};
  @Event cloudListDevices: () => Promise<CloudAccountDevice[]> =
    async (): Promise<CloudAccountDevice[]> => [];
  @Event cloudSelectDevice: (device: CloudAccountDevice) => Promise<void> =
    async (_device: CloudAccountDevice): Promise<void> => {};
  @Local accountDevices: CloudAccountDevice[] = [];
  @Local accountDevicesBusy: boolean = false;
  @Local accountDevicesError: string = '';
  @Local switchingDeviceId: string = '';
  @Local logoutBusy: boolean = false;

  aboutToAppear(): void {
    if (this.isAccountAuthenticated()) {
      this.refreshAccountDevices();
    }
  }

  build() {
    Column({ space: 0 }) {
      this.CompactIdentityCard()
      this.connection()
      this.preferences()
      this.DeviceManagementSection()
      this.about()
      if (this.isAccountAuthenticated()) {
        this.LogoutAction()
      }
    }
    .width('100%')
  }

  @Builder
  private CompactIdentityCard() {
    this.EmbeddedSectionTitle(RemoteI18n.t('settings.account.section'))
    Row({ space: 14 }) {
      DefaultAccountAvatar({ avatarSize: 46, avatarUrl: this.accountAvatarUrl })
      Column({ space: 4 }) {
        Text(this.isAccountAuthenticated() ? this.profileName() :
          RemoteI18n.t('settings.account.currentIdentity'))
          .fontSize(MobileDesignTypography.bodyLarge.size)
          .fontWeight(FontWeight.Medium)
          .fontColor(INK)
          .width('100%')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(this.isAccountAuthenticated() ? RemoteI18n.f('remote.settings.githubId', this.accountUserId) :
          this.shortProfileIdentifier())
          .fontSize(MobileDesignTypography.bodySmall.size)
          .fontColor(MUTED)
          .width('100%')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
      Row({ space: 6 }) {
        Text(this.compactAccountStatus())
          .fontSize(MobileDesignTypography.bodySmall.size)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.isAccountAuthenticated() ? STATUS_SUCCESS : MUTED)
        if (!this.isAccountAuthenticated()) {
          SymbolGlyph($r('sys.symbol.chevron_right'))
            .fontSize(13)
            .fontColor([MUTED])
        }
      }
    }
    .width('100%')
    .constraintSize({ minHeight: 72 })
    .padding({ left: 18, right: 18, top: 12, bottom: 12 })
    .alignItems(VerticalAlign.Center)
    .backgroundColor(CARD)
    .borderRadius(MobileDesignGeometry.settingsCardRadius)
    .margin({ bottom: 24 })
    .onClick(() => {
      if (!this.isAccountAuthenticated()) {
        this.onOpenAccount();
      }
    })
  }

  @Builder
  private EmbeddedSectionTitle(title: string) {
    Text(title)
      .fontSize(MobileDesignTypography.bodySmall.size)
      .lineHeight(MobileDesignTypography.bodySmall.lineHeight)
      .fontWeight(FontWeight.Medium)
      .fontColor(MUTED)
      .width('100%')
      .margin({ left: 8, bottom: 10 })
  }

  @Builder
  private DeviceManagementSection() {
    Column({ space: 8 }) {
      Row() {
        Text(RemoteI18n.t('settings.devices.section'))
          .fontSize(MobileDesignTypography.titleSmall.size)
          .lineHeight(MobileDesignTypography.titleSmall.lineHeight)
          .fontWeight(FontWeight.Medium)
          .fontColor(MUTED)
        Blank()
        Button() {
          SymbolGlyph($r('sys.symbol.arrow_clockwise'))
            .fontSize(18)
            .fontColor([this.accountDevicesBusy ? MUTED : INK])
        }
          .width(MobileDesignGeometry.controlTouchSize)
          .height(MobileDesignGeometry.controlTouchSize)
          .padding(0)
          .type(ButtonType.Circle)
          .backgroundColor(PAGE_BG)
          .opacity(this.accountDevicesBusy ? 0.55 : 1)
          .enabled(!this.accountDevicesBusy)
          .accessibilityText(RemoteI18n.t('common.refresh'))
          .onClick(async () => {
            await this.refreshAccountDevices();
          })
      }
      .width('100%')
      .constraintSize({ minHeight: 48 })
      .padding({ left: 8, right: 4 })

      Column({ space: 4 }) {
        if (!this.isAccountAuthenticated()) {
          Text(RemoteI18n.t('remote.settings.deviceLoginRequired'))
            .fontSize(MobileDesignTypography.bodySmall.size).lineHeight(MobileDesignTypography.bodySmall.lineHeight).fontColor(MUTED).width('100%')
        } else if (this.accountDevicesBusy && this.accountDevices.length === 0) {
          Text(RemoteI18n.t('remote.settings.deviceLoading'))
            .fontSize(MobileDesignTypography.bodySmall.size).fontColor(MUTED).width('100%')
        } else if (this.desktopDevices().length === 0) {
          Text(this.accountDevicesError || RemoteI18n.t('remote.settings.deviceEmpty'))
            .fontSize(MobileDesignTypography.bodySmall.size).lineHeight(MobileDesignTypography.bodySmall.lineHeight).fontColor(MUTED).width('100%')
        } else {
          ForEach(this.desktopDevices(), (device: CloudAccountDevice) => {
            this.AccountDeviceRow(device)
          }, (device: CloudAccountDevice): string =>
            `${device.deviceId}:${device.online ? 'online' : 'offline'}:${device.lastSeenAt || 0}:${device.deviceName}`)
        }
        if (this.accountDevicesError.length > 0 && this.desktopDevices().length > 0) {
          Text(this.accountDevicesError)
            .fontSize(MobileDesignTypography.bodySmall.size).lineHeight(MobileDesignTypography.bodySmall.lineHeight).fontColor(STATUS_DANGER).width('100%')
        }
      }
      .width('100%')
      .padding({ left: 8, right: 8, top: 8, bottom: 8 })
      .backgroundColor(CARD)
      .borderRadius(MobileDesignGeometry.settingsCardRadius)
    }
    .width('100%')
    .margin({ bottom: 24 })
  }

  @Builder
  private AccountDeviceRow(device: CloudAccountDevice) {
    Row({ space: 12 }) {
      Stack({ alignContent: Alignment.Center }) {
        SymbolGlyph($r('sys.symbol.desktop'))
          .fontSize(20)
          .fontColor([this.isCurrentControlDevice(device) ? INK : MUTED])
          .opacity(this.isCurrentControlDevice(device) ? 0.9 : 0.66)
      }
      .width(28)
      .height(28)
      Column({ space: 2 }) {
        Text(device.deviceName || device.deviceId)
          .fontSize(MobileDesignTypography.titleSmall.size).fontWeight(FontWeight.Medium).fontColor(INK)
          .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(this.deviceStatus(device))
          .fontSize(MobileDesignTypography.bodySmall.size).fontColor(device.online ? STATUS_SUCCESS : MUTED)
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
      if (this.shouldShowDeviceConnectAction(device)) {
        Text(this.switchingDeviceId === device.deviceId ?
          RemoteI18n.t('remote.settings.deviceConnecting') : RemoteI18n.t('connect.connect'))
          .fontSize(MobileDesignTypography.bodyMedium.size).fontColor(INK)
          .padding({ left: 10, right: 10, top: 6, bottom: 6 })
          .backgroundColor(SOFT).borderRadius(14)
      }
    }
    .width('100%')
    .constraintSize({ minHeight: 62 })
    .padding({ left: 10, right: 10, top: 10, bottom: 10 })
    .alignItems(VerticalAlign.Center)
    .backgroundColor(this.isCurrentControlDevice(device) ? SOFT : CARD)
    .borderRadius(MobileDesignGeometry.settingsCompactCardRadius)
    .opacity(device.online ? 1 : 0.48)
    .onClick(() => {
      void this.connectAccountDevice(device);
    })
  }

  @Builder
  private LogoutAction() {
    Divider()
      .strokeWidth(1)
      .color(LINE)
      .margin({ left: 8, right: 8, top: 24 })
    Row({ space: 14 }) {
      SymbolGlyph($r('sys.symbol.arrow_right_and_square'))
        .fontSize(22).fontColor([STATUS_DANGER]).width(24).height(24)
      Text(this.logoutBusy ? RemoteI18n.t('remote.settings.accountLoggingOut') :
        RemoteI18n.t('remote.settings.accountLogout'))
        .fontSize(MobileDesignTypography.titleMedium.size).fontWeight(FontWeight.Medium).fontColor(STATUS_DANGER)
    }
    .width('100%')
    .constraintSize({ minHeight: 62 })
    .padding({ left: 20, right: 20, top: 12, bottom: 12 })
    .backgroundColor(PAGE_BG)
    .margin({ top: 4, bottom: 8 })
    .opacity(this.logoutBusy ? 0.55 : 1)
    .enabled(!this.logoutBusy)
    .onClick(async () => {
      this.logoutBusy = true;
      try {
        await this.cloudLogout();
        this.onLoggedOut();
      } finally {
        this.logoutBusy = false;
      }
    })
  }

  private async refreshAccountDevices(): Promise<void> {
    if (!this.isAccountAuthenticated() || this.accountDevicesBusy) return;
    this.accountDevicesBusy = true;
    this.accountDevicesError = '';
    try {
      this.accountDevices = await this.cloudListDevices();
    } catch (err) {
      this.accountDevicesError = err instanceof Error ? err.message :
        RemoteI18n.t('remote.settings.deviceLoadFailed');
    } finally {
      this.accountDevicesBusy = false;
    }
  }

  private desktopDevices(): CloudAccountDevice[] {
    return this.accountDevices.filter((device: CloudAccountDevice): boolean =>
      device.deviceId !== this.deviceId && device.deviceName !== 'HarmonyOS Phone');
  }

  private canActivateAccountDevice(device: CloudAccountDevice): boolean {
    return AccountDeviceSelectionPolicy.canActivate(
      device.online,
      device.deviceId,
      this.deviceId,
      this.controlTargetDeviceId,
      this.connectionState,
      this.switchingDeviceId
    );
  }

  private shouldShowDeviceConnectAction(device: CloudAccountDevice): boolean {
    return AccountDeviceSelectionPolicy.shouldShowConnectAction(
      device.online,
      device.deviceId,
      this.deviceId,
      this.controlTargetDeviceId,
      this.connectionState
    );
  }

  private async connectAccountDevice(device: CloudAccountDevice): Promise<void> {
    if (!this.canActivateAccountDevice(device)) return;
    this.switchingDeviceId = device.deviceId;
    this.accountDevicesError = '';
    try {
      if (AccountDeviceSelectionPolicy.canSelectOnline(
        device.online, device.deviceId, this.deviceId, ''
      )) {
        await this.cloudSelectDevice(device);
      } else {
        this.onReconnect();
      }
    } catch (err) {
      this.accountDevicesError = err instanceof Error ? err.message :
        RemoteI18n.t('remote.settings.deviceSwitchFailed');
    } finally {
      this.switchingDeviceId = '';
    }
  }

  private deviceStatus(device: CloudAccountDevice): string {
    if (device.deviceId === this.deviceId) return RemoteI18n.t('remote.settings.deviceCurrent');
    const presence = device.online ? RemoteI18n.t('remote.settings.deviceOnline') :
      RemoteI18n.t('remote.settings.deviceOffline');
    if (device.deviceId === this.controlTargetDeviceId && this.connectionState === 'connected') {
      return `${RemoteI18n.t('remote.settings.deviceControlling')} · ${presence}`;
    }
    if (device.deviceId === this.controlTargetDeviceId) {
      return `${RemoteI18n.t('connect.deviceLastUsed')} · ${presence}`;
    }
    return presence;
  }

  private isCurrentControlDevice(device: CloudAccountDevice): boolean {
    return device.deviceId === this.controlTargetDeviceId && this.connectionState === 'connected';
  }

  private profileName(): string {
    return this.accountUsername && this.accountUsername !== this.accountUserId ? `@${this.accountUsername}` :
      RemoteI18n.t('remote.settings.githubAccount');
  }

  private profileIdentifier(): string {
    return this.accountUserId || this.fallbackUserId || this.deviceId || '-';
  }

  private shortProfileIdentifier(): string {
    const identifier = this.profileIdentifier();
    if (identifier.length <= 22) return identifier;
    return `${identifier.slice(0, 18)}…`;
  }

  private compactAccountStatus(): string {
    if (this.isAccountAuthenticated()) {
      return RemoteI18n.t('remote.settings.accountSignedIn');
    }
    if (this.controlTargetType === 'room') {
      return RemoteI18n.t('remote.settings.accountTemporary');
    }
    return RemoteI18n.t('remote.settings.accountNotSignedIn');
  }

  private isAccountAuthenticated(): boolean {
    return this.accountUserId.trim().length > 0;
  }

  @Builder
  private EmptyBuilder() {
    Column() {
    }
  }

  @Monitor('accountUserId')
  private handleAccountUserChanged(): void {
    if (this.isAccountAuthenticated() && this.accountDevices.length === 0) {
      this.refreshAccountDevices();
    }
  }
}
