import { MobileDesignGeometry, MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { SettingsSheetState } from '../state/SettingsSheetState';
import { CARD, INK, LINE, MUTED, PAGE_BG, STATUS_DANGER } from './Theme';
import { CurrentControlSection } from './CurrentControlSection';
import { AccountProfilePanel } from './AccountProfilePanel';
import { LanguageSettingsPanel } from './LanguageSettingsPanel';
import { SheetCloseHeader } from './SheetCloseHeader';
import { SHEET_HORIZONTAL_PADDING, SHEET_TOP_RADIUS } from './SheetLayout';
import { CloudAccountDevice } from '../../services/CloudAccountClient';
import { WindowInsetsBinding } from '../../services/WindowSystemBarService';
import { RemoteDefaultModels, RemoteModelCatalog, RemotePermissionMode } from '../../model/RemoteModels';
import { RemotePermissionSection } from './RemotePermissionSection';

@ComponentV2
export struct SettingsSheet {
  @Param sheetState: SettingsSheetState = new SettingsSheetState();
  @Param accountUsername: string = '';
  @Param accountAvatarUrl: string = '';
  @Param authenticatedUserId: string = '';
  @Param fallbackUserId: string = '';
  @Param desktopName: string = '';
  @Param desktopId: string = '';
  @Param deviceId: string = '';
  @Param controlTargetType: string = 'none';
  @Param controlTargetDeviceId: string = '';
  @Param connectionState: string = 'idle';
  /** The connected desktop advertises `device_model_defaults_v1`. */
  @Param supportsDeviceModelDefaults: boolean = false;
  @Param statusText: string = '';
  @Event onClose: () => void = () => {};
  @Event onOpenAccount: () => void = () => {};
  @Event onDisconnect: () => void = () => {};
  @Event onClearPairing: () => void = () => {};
  @Event onReconnect: () => void = () => {};
  @Event cloudLogout: () => Promise<void> = async (): Promise<void> => {};
  @Event cloudListDevices: () => Promise<CloudAccountDevice[]> =
    async (): Promise<CloudAccountDevice[]> => [];
  @Event cloudSelectDevice: (device: CloudAccountDevice) => Promise<void> =
    async (_device: CloudAccountDevice): Promise<void> => {};
  @Event getPermissionMode: () => Promise<RemotePermissionMode> = async (): Promise<RemotePermissionMode> => 'ask';
  @Event setPermissionMode: (mode: RemotePermissionMode) => Promise<RemotePermissionMode> =
    async (mode: RemotePermissionMode): Promise<RemotePermissionMode> => mode;
  /** Device-level model catalog of the connected desktop (no session id). */
  @Event getDeviceModelCatalog: () => Promise<RemoteModelCatalog> =
    async (): Promise<RemoteModelCatalog> => ({ version: 0, models: [], default_models: {} });
  /** Whole-object write of the three phone-managed model slots. */
  @Event setDeviceModelDefaults: (
    primary: string | null,
    fast: string | null,
    imageUnderstanding: string | null
  ) => Promise<RemoteDefaultModels> = async (
    primary: string | null,
    fast: string | null,
    imageUnderstanding: string | null
  ): Promise<RemoteDefaultModels> => {
    return {
      primary,
      fast,
      image_understanding: imageUnderstanding
    };
  };
  @Event onSetLanguage: (language: string) => Promise<void> = async (_language: string) => {};
  /** The sheet's own bottom edge, so its scrolling rows can run under the bar and still rest above it. */
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
    Stack({ alignContent: Alignment.TopEnd }) {
      if (this.sheetState.page === 'language') {
        this.LanguagePanel()
      } else if (this.sheetState.page === 'deviceModels') {
        this.DeviceModelsPlaceholder()
      } else {
        this.SettingsHome()
      }
    }
    .width('100%')
    .height('100%')
    // The sheet's fill is the shell's bottom edge and runs to the screen edge,
    // and so does its scrolling viewport: the rows are content, and they roll
    // under the navigation indicator while they are still moving instead of
    // stopping short of it above a band of bare page colour. What stops above
    // the bar is the column's own tail padding, which brings the last row to
    // rest there once the sheet is scrolled to its end. The framework does not
    // inset a bottom sheet for the app while the window is immersive, so the
    // sheet does it itself.
    .backgroundColor(PAGE_BG)
    .borderRadius({ topLeft: SHEET_TOP_RADIUS, topRight: SHEET_TOP_RADIUS })
  }

  @Builder
  SettingsHome() {
    Column() {
      SheetCloseHeader({
        title: RemoteI18n.t('settings.title'),
        showDivider: true,
        onClose: this.onClose
      })

      Scroll() {
        Column({ space: 0 }) {
          AccountProfilePanel({
            accountUsername: this.accountUsername,
            accountAvatarUrl: this.accountAvatarUrl,
            accountUserId: this.authenticatedUserId,
            fallbackUserId: this.fallbackUserId,
            deviceId: this.deviceId,
            controlTargetType: this.controlTargetType,
            controlTargetDeviceId: this.controlTargetDeviceId,
            connectionState: this.connectionState,
            supportsDeviceModelDefaults: this.supportsDeviceModelDefaults,
            cloudLogout: this.cloudLogout,
            cloudListDevices: this.cloudListDevices,
            cloudSelectDevice: this.cloudSelectDevice,
            onReconnect: this.onReconnect,
            onOpenAccount: this.onOpenAccount,
            onOpenDeviceModelSettings: () => {
              this.sheetState.setPage('deviceModels');
            },
            onLoggedOut: this.onClose,
            connection: () => {
              this.CurrentConnectionSection()
              this.PermissionSection()
            },
            preferences: () => {
              this.GeneralSettingsSection()
            },
            about: () => {
              this.AboutSettingsSection()
            }
          })
        }
        .width('100%')
        .padding({
          left: SHEET_HORIZONTAL_PADDING,
          right: SHEET_HORIZONTAL_PADDING,
          top: 22,
          // The sheet's tail spacer: the strip plus its own breathing, so the
          // last row rests above the navigation bar once the scroll ends.
          bottom: this.insets.tailSpacing(34)
        })
      }
      .width('100%')
      .layoutWeight(1)
      .scrollBar(BarState.Off)
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  private CurrentConnectionSection() {
    CurrentControlSection({
      desktopName: this.desktopName,
      desktopId: this.desktopId,
      controlTargetType: this.controlTargetType,
      connectionState: this.connectionState,
      statusText: this.statusText,
      onDisconnect: this.onDisconnect,
      onClearPairing: this.onClearPairing,
      onReconnect: this.onReconnect
    })
  }

  @Builder
  private PermissionSection() {
    RemotePermissionSection({
      connectionState: this.connectionState,
      getPermissionMode: this.getPermissionMode,
      setPermissionMode: this.setPermissionMode
    })
  }

  @Builder
  private GeneralSettingsSection() {
    this.SectionTitle(RemoteI18n.t('settings.general.section'))
    this.GeneralCard()
  }

  @Builder
  private AboutSettingsSection() {
    this.SectionTitle(RemoteI18n.t('settings.about.section'))
    this.AboutCard()
  }

  @Builder
  SectionTitle(title: string) {
    Text(title)
      .fontSize(MobileDesignTypography.bodySmall.size)
      .lineHeight(MobileDesignTypography.bodySmall.lineHeight)
      .fontWeight(FontWeight.Medium)
      .fontColor(MUTED)
      .width('100%')
      .margin({ left: 8, bottom: 10 })
  }

  @Builder
  GeneralCard() {
    Column() {
      this.SettingsRow(
        RemoteI18n.t('settings.language.title'),
        RemoteI18n.nativeName(),
        true,
        () => {
          this.sheetState.setPage('language');
        },
        $r('sys.symbol.textformat')
      )
    }
    .width('100%')
    .backgroundColor(CARD)
    .borderRadius(MobileDesignGeometry.settingsCardRadius)
    .margin({ bottom: 24 })
  }

  @Builder
  AboutCard() {
    Column() {
      this.StaticRow(RemoteI18n.t('settings.about.openbitfun'), 'HarmonyOS')
      Text('')
        .width('84%')
        .height(1)
        .backgroundColor(LINE)
      this.StaticRow(RemoteI18n.t('settings.about.version'), '1.0.0')
    }
    .width('100%')
    .backgroundColor(CARD)
    .borderRadius(MobileDesignGeometry.settingsCardRadius)
  }

  @Builder
  StaticRow(title: string, value: string) {
    Row({ space: 16 }) {
      Text(title)
        .fontSize(MobileDesignTypography.bodyLarge.size)
        .fontWeight(FontWeight.Medium)
        .fontColor(INK)
      Blank()
      Text(value)
        .fontSize(MobileDesignTypography.titleSmall.size)
        .fontColor(MUTED)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    }
    .width('100%')
    .constraintSize({ minHeight: 56 })
    .padding({ left: 18, right: 18, top: 12, bottom: 12 })
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  SettingsRow(title: string, value: string, showChevron: boolean, action: () => void, icon: Resource) {
    Row({ space: 16 }) {
      SymbolGlyph(icon)
        .fontSize(20)
        .fontColor([MUTED])
        .width(23)
        .height(23)
      Text(title)
        .fontSize(MobileDesignTypography.bodyLarge.size)
        .fontWeight(FontWeight.Medium)
        .fontColor(INK)
      Blank()
      Text(value)
        .fontSize(MobileDesignTypography.titleSmall.size)
        .fontColor(MUTED)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .constraintSize({ maxWidth: 130 })
      if (showChevron) {
        SymbolGlyph($r('sys.symbol.chevron_right'))
          .fontSize(14)
          .fontColor([MUTED])
      }
    }
    .width('100%')
    .constraintSize({ minHeight: 56 })
    .padding({ left: 18, right: 18, top: 12, bottom: 12 })
    .alignItems(VerticalAlign.Center)
    .onClick(action)
  }

  @Builder
  LanguagePanel() {
    LanguageSettingsPanel({
      selectedLanguage: RemoteI18n.language(),
      onClose: () => {
        this.sheetState.setPage('main');
      },
      onSelect: (language: string) => {
        return this.onSetLanguage(language);
      }
    })
  }

  /**
   * Device model role settings, reached from the connected device row.
   *
   * TODO(model-roles-pages): the device model defaults panel and the role picker
   * page of this work package replace this placeholder. It exists so the entry
   * navigates to a real destination, the sheet keeps one page model, and the
   * degrade path stays visible, without pretending the pages are finished.
   */
  @Builder
  DeviceModelsPlaceholder() {
    Column() {
      SheetCloseHeader({
        title: RemoteI18n.t('settings.model.settingsTitle'),
        showDivider: true,
        onClose: () => {
          this.sheetState.setPage('main');
        }
      })

      Scroll() {
        Column({ space: 0 }) {
          this.SectionTitle(RemoteI18n.t('settings.model.section'))
          Text(this.deviceModelsPlaceholderText())
            .width('100%')
            .fontSize(MobileDesignTypography.bodySmall.size)
            .lineHeight(MobileDesignTypography.bodySmall.lineHeight)
            .fontColor(this.supportsDeviceModelDefaults ? MUTED : STATUS_DANGER)
            .padding({ left: 8, right: 8 })
        }
        .width('100%')
        .padding({
          left: SHEET_HORIZONTAL_PADDING,
          right: SHEET_HORIZONTAL_PADDING,
          top: 22,
          bottom: this.insets.tailSpacing(34)
        })
      }
      .width('100%')
      .layoutWeight(1)
      .scrollBar(BarState.Off)
    }
    .width('100%')
    .height('100%')
  }

  private deviceModelsPlaceholderText(): string {
    if (!this.supportsDeviceModelDefaults) {
      return RemoteI18n.t('settings.model.unsupported');
    }
    const device = this.desktopName || this.desktopId;
    return `${RemoteI18n.t('settings.model.default')} · ${device}`;
  }
}
