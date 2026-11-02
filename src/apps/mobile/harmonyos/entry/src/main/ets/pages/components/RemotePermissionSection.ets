import { MobileDesignGeometry, MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { CARD, INK, LINE, MUTED, STATUS_DANGER } from './Theme';
import { RemotePermissionMode } from '../../model/RemoteModels';
import { AppActionButton, AppActionStyle } from './AppActionButton';

/**
 * Remote permission mode section of the single settings page. It is always
 * visible; without a connected desktop the rows are disabled and the status
 * line explains that a connection is required. The mode is read from the
 * desktop when the page opens connected, and again when the connection comes
 * up while the page is open. Full access keeps its explicit confirmation.
 */
@ComponentV2
export struct RemotePermissionSection {
  @Param connectionState: string = 'idle';
  @Event getPermissionMode: () => Promise<RemotePermissionMode> = async (): Promise<RemotePermissionMode> => 'ask';
  @Event setPermissionMode: (mode: RemotePermissionMode) => Promise<RemotePermissionMode> =
    async (mode: RemotePermissionMode): Promise<RemotePermissionMode> => mode;
  @Local permissionMode: RemotePermissionMode = 'ask';
  @Local permissionModeBusy: boolean = false;
  @Local permissionModeLoaded: boolean = false;
  @Local permissionModeError: string = '';
  @Local confirmFullAccess: boolean = false;

  aboutToAppear(): void {
    if (this.canManagePermissions()) {
      this.refreshPermissionMode();
    }
  }

  @Monitor('connectionState')
  onConnectionStateChanged(): void {
    if (this.canManagePermissions()) {
      this.refreshPermissionMode();
      return;
    }
    this.confirmFullAccess = false;
    this.permissionModeLoaded = false;
    this.permissionModeError = '';
  }

  build() {
    Column({ space: 0 }) {
      this.PermissionSectionHeader()
      this.PermissionModeCard()
    }
    .width('100%')
  }

  @Builder
  private PermissionSectionHeader() {
    Row() {
      Text(RemoteI18n.t('remote.permissions.title'))
        .fontSize(MobileDesignTypography.bodySmall.size)
        .lineHeight(MobileDesignTypography.bodySmall.lineHeight)
        .fontWeight(FontWeight.Medium)
        .fontColor(MUTED)
      Blank()
      if (this.canManagePermissions()) {
        Text(RemoteI18n.t('common.refresh'))
          .fontSize(MobileDesignTypography.bodySmall.size)
          .fontColor(this.permissionModeBusy ? MUTED : INK)
          .onClick(() => this.refreshPermissionMode())
      }
    }
    .width('100%')
    .padding({ left: 8, right: 8 })
    .margin({ bottom: 10 })
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  private PermissionModeCard() {
    Column() {
      Text(RemoteI18n.t('remote.permissions.scope'))
        .width('100%')
        .fontSize(MobileDesignTypography.bodySmall.size)
        .lineHeight(MobileDesignTypography.bodySmall.lineHeight)
        .fontColor(MUTED)
        .padding({ left: 18, right: 18, top: 16, bottom: 8 })

      this.PermissionModeRow(
        'ask',
        RemoteI18n.t('remote.permissions.ask'),
        RemoteI18n.t('remote.permissions.askDescription')
      )
      Divider().strokeWidth(1).color(LINE).margin({ left: 18, right: 18 })
      this.PermissionModeRow(
        'auto',
        RemoteI18n.t('remote.permissions.auto'),
        RemoteI18n.t('remote.permissions.autoDescription')
      )
      Divider().strokeWidth(1).color(LINE).margin({ left: 18, right: 18 })
      this.PermissionModeRow(
        'full_access',
        RemoteI18n.t('remote.permissions.fullAccess'),
        RemoteI18n.t('remote.permissions.fullAccessDescription')
      )

      Text(this.permissionStatusText())
        .width('100%')
        .height(28)
        .fontSize(MobileDesignTypography.labelSmall.size)
        .fontColor(this.permissionModeError.length > 0 ? STATUS_DANGER : MUTED)
        .padding({ left: 18, right: 18, top: 4 })
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })

      if (this.confirmFullAccess) {
        this.FullAccessConfirmation()
      }
    }
    .width('100%')
    .backgroundColor(CARD)
    .borderRadius(MobileDesignGeometry.settingsCardRadius)
    .margin({ bottom: 24 })
  }

  @Builder
  private PermissionModeRow(mode: RemotePermissionMode, label: string, description: string) {
    Row({ space: 12 }) {
      Stack({ alignContent: Alignment.Center }) {
        if (this.permissionModeLoaded && this.permissionMode === mode) {
          SymbolGlyph($r('sys.symbol.checkmark_circle_fill'))
            .fontSize(19)
            .fontColor([INK])
            .width(20)
            .height(20)
        }
      }
      .width(22)
      .height(24)
      Column({ space: 3 }) {
        Text(label)
          .width('100%')
          .fontSize(MobileDesignTypography.bodyLarge.size)
          .fontWeight(FontWeight.Medium)
          .fontColor(INK)
        Text(description)
          .width('100%')
          .fontSize(MobileDesignTypography.labelSmall.size)
          .lineHeight(MobileDesignTypography.labelSmall.lineHeight)
          .fontColor(MUTED)
          .maxLines(2)
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .height(72)
    .padding({ left: 18, right: 18 })
    .opacity(this.canChangePermissionMode() ? 1 : 0.54)
    .onClick(() => this.selectPermissionMode(mode))
  }

  @Builder
  private FullAccessConfirmation() {
    Column({ space: 10 }) {
      Text(RemoteI18n.t('remote.permissions.fullAccessWarningTitle'))
        .width('100%')
        .fontSize(MobileDesignTypography.titleSmall.size)
        .fontWeight(FontWeight.Bold)
        .fontColor(STATUS_DANGER)
      Text(RemoteI18n.t('remote.permissions.fullAccessWarningBody'))
        .width('100%')
        .fontSize(MobileDesignTypography.bodySmall.size)
        .lineHeight(MobileDesignTypography.bodySmall.lineHeight)
        .fontColor(INK)
      Row({ space: 10 }) {
        AppActionButton({
          label: RemoteI18n.t('remote.permissions.cancel'),
          style: AppActionStyle.Quiet,
          actionHeight: 42,
          onAction: (): void => { this.confirmFullAccess = false; }
        })
          .layoutWeight(1)
        AppActionButton({
          label: RemoteI18n.t('remote.permissions.confirmFullAccess'),
          style: AppActionStyle.Destructive,
          actionHeight: 42,
          onAction: (): void => { void this.applyPermissionMode('full_access'); }
        })
          .layoutWeight(1)
      }
      .width('100%')
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 14, bottom: 16 })
    .backgroundColor(CARD)
    .border({ width: 1, color: STATUS_DANGER })
    .borderRadius(18)
    .margin({ left: 12, right: 12, bottom: 14 })
  }

  private canManagePermissions(): boolean {
    return this.connectionState === 'connected';
  }

  private canChangePermissionMode(): boolean {
    return this.canManagePermissions() && !this.permissionModeBusy;
  }

  private async refreshPermissionMode(): Promise<void> {
    if (!this.canManagePermissions() || this.permissionModeBusy) {
      return;
    }
    this.permissionModeBusy = true;
    this.permissionModeError = '';
    try {
      this.permissionMode = await this.getPermissionMode();
      this.permissionModeLoaded = true;
    } catch (err) {
      this.permissionModeError = err instanceof Error ? err.message :
        RemoteI18n.t('remote.permissions.loadFailed');
    } finally {
      this.permissionModeBusy = false;
    }
  }

  private selectPermissionMode(mode: RemotePermissionMode): void {
    if (!this.canChangePermissionMode() ||
      (this.permissionModeLoaded && this.permissionMode === mode)) {
      return;
    }
    if (mode === 'full_access') {
      this.confirmFullAccess = true;
      return;
    }
    this.confirmFullAccess = false;
    this.applyPermissionMode(mode);
  }

  private async applyPermissionMode(mode: RemotePermissionMode): Promise<void> {
    if (!this.canChangePermissionMode()) {
      return;
    }
    this.permissionModeBusy = true;
    this.permissionModeError = '';
    try {
      this.permissionMode = await this.setPermissionMode(mode);
      this.permissionModeLoaded = true;
      this.confirmFullAccess = false;
    } catch (err) {
      this.permissionModeError = err instanceof Error ? err.message :
        RemoteI18n.t('remote.permissions.saveFailed');
    } finally {
      this.permissionModeBusy = false;
    }
  }

  private permissionStatusText(): string {
    if (!this.canManagePermissions()) {
      return RemoteI18n.t('remote.permissions.connectionRequired');
    }
    if (this.permissionModeBusy) {
      return RemoteI18n.t('remote.permissions.loading');
    }
    return this.permissionModeError;
  }
}
