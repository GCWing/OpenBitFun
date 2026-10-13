import { MobileDesignGeometry, MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import {
  RemoteModelDefaultsRole,
  RemoteModelDefaultsState
} from '../../services/RemoteModelDefaultsController';
import { WindowInsetsBinding } from '../../services/WindowSystemBarService';
import { ConversationModelPresentationPolicy } from '../policy/ConversationModelPresentationPolicy';
import { ModelRoleCandidatesPolicy, ModelRoleRowProjection } from '../policy/ModelRoleCandidatesPolicy';
import { toConversationUiModel } from '../state/ConversationUiModels';
import { DeviceModelDefaultsSheetState } from '../state/DeviceModelDefaultsSheetState';
import { SettingsSheetState } from '../state/SettingsSheetState';
import { NavigationBackButton } from './NavigationBackButton';
import { SheetCloseButton } from './SheetCloseButton';
import { SHEET_HEADER_HEIGHT, SHEET_HEADER_SIDE_PADDING, SHEET_HORIZONTAL_PADDING } from './SheetLayout';
import {
  CARD,
  INK,
  LINE,
  MUTED,
  PAGE_BG,
  SOFT,
  STATUS_DANGER,
  STATUS_SUCCESS,
  SUBTLE,
  TRANSPARENT
} from './Theme';

/** The three roles in the order the page lists them. */
const ROLE_ORDER: RemoteModelDefaultsRole[] = ['primary', 'fast', 'image_understanding'];

/**
 * The device model settings page: the three role slots of the desktop this phone
 * is driving, on the same sheet, one level above the settings list.
 *
 * It is a page of the sheet rather than a stand-alone service panel: the header
 * carries back and close, the rows are the settings list's row language, and the
 * write feedback happens in place. The desktop owns the values, so a row shows
 * the last device read and never the tap that is still in flight: selecting a
 * model returns here and the value changes only when the read-back lands.
 *
 * Control flow stays in the sheet's state object the whole time — an older
 * desktop that cannot answer, a desktop that stopped answering, and a phone that
 * is simply not connected are three different states, and all three are stated
 * in the page instead of failing the tap silently.
 */
@ComponentV2
export struct DeviceModelDefaultsPanel {
  @Param sheetState: SettingsSheetState = new SettingsSheetState();
  @Param deviceModels: DeviceModelDefaultsSheetState = new DeviceModelDefaultsSheetState();
  @Param desktopName: string = '';
  @Param desktopId: string = '';
  @Param controlTargetType: string = 'none';
  @Param connectionState: string = 'idle';
  @Event onClose: () => void = () => {};
  @Local insets: WindowInsetsBinding = new WindowInsetsBinding();

  aboutToAppear(): void {
    const context = this.getUIContext().getHostContext();
    if (context) {
      this.insets.bind(this.getUIContext(), context);
    }
    // The page is where the device is actually read: opening the sheet only arms
    // the gate, so a user who never comes here never spends the read.
    void this.deviceModels.ensureLoaded();
  }

  aboutToDisappear(): void {
    this.insets.unbind();
  }

  build() {
    Column({ space: 0 }) {
      this.PageHeader()
      Scroll() {
        Column({ space: 0 }) {
          this.DeviceSummaryCard()
          if (this.deviceModels.state.available) {
            this.RoleSection()
          } else {
            this.UnavailableCard()
          }
          this.ScopeCard()
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
    .backgroundColor(PAGE_BG)
  }

  /**
   * The page header, in the one header language the sheet has: a quiet control on
   * each side and the page's identity between them. Back is a real second level —
   * this page was pushed from the settings list — so it sits next to the close
   * that leaves the sheet entirely.
   */
  @Builder
  private PageHeader() {
    Row() {
      NavigationBackButton({
        isEnabled: !this.locked(),
        onBack: (): void => {
          this.sheetState.setPage('main');
        }
      })
      Column({ space: 3 }) {
        Text(RemoteI18n.t('settings.model.settingsTitle'))
          .width('100%')
          .fontSize(MobileDesignTypography.bodySmall.size)
          .lineHeight(MobileDesignTypography.bodySmall.lineHeight)
          .fontWeight(FontWeight.Medium)
          .fontColor(MUTED)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(this.deviceLabel())
          .width('100%')
          .fontSize(MobileDesignTypography.headlineSmall.size)
          .lineHeight(MobileDesignTypography.headlineSmall.lineHeight)
          .fontWeight(FontWeight.Medium)
          .fontColor(INK)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
      SheetCloseButton({
        isEnabled: !this.locked(),
        onClose: this.onClose
      })
    }
    .width('100%')
    .height(SHEET_HEADER_HEIGHT)
    .padding({ left: SHEET_HEADER_SIDE_PADDING, right: SHEET_HEADER_SIDE_PADDING })
    .alignItems(VerticalAlign.Center)
    .border({ width: { bottom: 1 }, color: LINE })
  }

  /**
   * Which desktop these values belong to. This page edits a device, not a
   * session, so the device is stated once at the top rather than repeated on
   * every row.
   */
  @Builder
  private DeviceSummaryCard() {
    Row({ space: 12 }) {
      Stack({ alignContent: Alignment.Center }) {
        SymbolGlyph($r('sys.symbol.desktop'))
          .fontSize(20)
          .fontColor([INK])
          .opacity(0.9)
      }
      .width(28)
      .height(28)
      Column({ space: 2 }) {
        Text(this.deviceLabel())
          .width('100%')
          .fontSize(MobileDesignTypography.titleSmall.size)
          .fontWeight(FontWeight.Medium)
          .fontColor(INK)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(this.summaryStatus())
          .width('100%')
          .fontSize(MobileDesignTypography.bodySmall.size)
          .fontColor(this.connectionState === 'connected' ? STATUS_SUCCESS : MUTED)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .constraintSize({ minHeight: MobileDesignGeometry.modelSourceRowHeight })
    .padding({ left: 18, right: 18, top: 10, bottom: 10 })
    .alignItems(VerticalAlign.Center)
    .backgroundColor(CARD)
    .borderRadius(MobileDesignGeometry.settingsCardRadius)
    .margin({ bottom: 24 })
  }

  @Builder
  private RoleSection() {
    Column({ space: 0 }) {
      if (!this.deviceModels.state.loaded) {
        this.ReadingCard()
      } else {
        Text(RemoteI18n.t('settings.model.section'))
          .width('100%')
          .fontSize(MobileDesignTypography.bodySmall.size)
          .lineHeight(MobileDesignTypography.bodySmall.lineHeight)
          .fontWeight(FontWeight.Medium)
          .fontColor(MUTED)
          .margin({ left: 8, bottom: 10 })
        Column() {
          ForEach(ROLE_ORDER, (role: RemoteModelDefaultsRole) => {
            this.RoleRow(role)
          }, (role: RemoteModelDefaultsRole): string => role)
        }
        .width('100%')
        .backgroundColor(CARD)
        .borderRadius(MobileDesignGeometry.settingsCardRadius)
        if (this.deviceModels.state.error.length > 0 || this.deviceModels.feedbackVisible) {
          this.WriteFeedback()
        }
        if (ModelRoleCandidatesPolicy.isEmptyCatalog(this.deviceModels.state.catalog)) {
          this.EmptyCatalogCard()
        }
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  private ReadingCard() {
    Text(this.readingText())
      .width('100%')
      .fontSize(MobileDesignTypography.bodySmall.size)
      .lineHeight(MobileDesignTypography.bodySmall.lineHeight)
      .fontColor(MUTED)
      .padding({ left: 18, right: 18, top: 16, bottom: 16 })
      .backgroundColor(CARD)
      .borderRadius(MobileDesignGeometry.settingsCardRadius)
  }

  /**
   * One role slot. The row is the settings list's own row language — a leading
   * mark, a two-line body and a trailing control — because these three rows sit
   * on the same sheet as the permission rows above them.
   *
   * The mark states whether the role resolves to a model at all, the meta line
   * states which one, and the row is the way into that role's picker. Nothing is
   * written from here: the picker is the only place a model is chosen.
   */
  @Builder
  private RoleRow(role: RemoteModelDefaultsRole) {
    Row({ space: 12 }) {
      Stack({ alignContent: Alignment.Center }) {
        if (this.roleBusy(role)) {
          LoadingProgress()
            .width(16)
            .height(16)
            .color(INK)
        } else if (this.roleProjection(role).resolved) {
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
        Text(RemoteI18n.t(ModelRoleCandidatesPolicy.roleLabelKey(role)))
          .width('100%')
          .fontSize(MobileDesignTypography.bodyLarge.size)
          .lineHeight(MobileDesignTypography.bodyLarge.lineHeight)
          .fontWeight(FontWeight.Medium)
          .fontColor(INK)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(this.roleMeta(role))
          .width('100%')
          .fontSize(MobileDesignTypography.labelSmall.size)
          .lineHeight(MobileDesignTypography.labelSmall.lineHeight)
          .fontColor(MUTED)
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
      Row({ space: 4 }) {
        if (this.roleUpdated(role)) {
          Text(RemoteI18n.t('status.modelDefaultsUpdated'))
            .fontSize(MobileDesignTypography.bodyMedium.size)
            .fontWeight(FontWeight.Medium)
            .fontColor(STATUS_SUCCESS)
            .maxLines(1)
        }
        SymbolGlyph($r('sys.symbol.chevron_right'))
          .fontSize(14)
          .fontColor([MUTED])
      }
      .alignItems(VerticalAlign.Center)
    }
    .width('100%')
    .height(72)
    .padding({ left: 18, right: 18 })
    .alignItems(VerticalAlign.Center)
    .backgroundColor(this.roleBusy(role) ? SOFT : TRANSPARENT)
    .opacity(this.locked() ? 0.6 : 1)
    .id(`device-model-role-${role}`)
    .enabled(!this.locked())
    .onClick(() => {
      this.sheetState.openModelPick(role);
    })
  }

  /**
   * What the write did, in the two shapes it has: the host's own rejection with a
   * way to answer it again, or a confirmed write whose value has already been
   * read back. Neither is a place to show the value that was asked for — that is
   * the point of reading the desktop back.
   */
  @Builder
  private WriteFeedback() {
    Row({ space: 10 }) {
      if (this.deviceModels.state.error.length > 0) {
        Text(this.deviceModels.state.error)
          .layoutWeight(1)
          .fontSize(MobileDesignTypography.bodySmall.size)
          .lineHeight(MobileDesignTypography.bodySmall.lineHeight)
          .fontColor(STATUS_DANGER)
          .maxLines(3)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(RemoteI18n.t('common.retry'))
          .fontSize(MobileDesignTypography.bodyMedium.size)
          .fontWeight(FontWeight.Medium)
          .fontColor(INK)
          .padding({ left: 10, right: 10, top: 6, bottom: 6 })
          .backgroundColor(SOFT)
          .borderRadius(14)
          .id('device-model-retry')
          .enabled(!this.locked())
          .onClick(() => {
            void this.deviceModels.retry();
          })
      } else if (this.deviceModels.feedbackVisible) {
        Text(RemoteI18n.f('settings.model.updatedResult', this.writtenValue()))
          .layoutWeight(1)
          .fontSize(MobileDesignTypography.bodySmall.size)
          .lineHeight(MobileDesignTypography.bodySmall.lineHeight)
          .fontColor(STATUS_SUCCESS)
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .id('device-model-updated')
      }
    }
    .width('100%')
    .padding({ left: 8, right: 8, top: 10 })
    .alignItems(VerticalAlign.Center)
  }

  /**
   * The desktop has no models at all. The rows stay where they are — the user
   * came here for three slots and three slots are what the device has — and this
   * card says what to do about it, because nothing on this page can add a model.
   */
  @Builder
  private EmptyCatalogCard() {
    Column({ space: 6 }) {
      SymbolGlyph($r('sys.symbol.desktop'))
        .fontSize(26)
        .fontColor([SUBTLE])
      Text(RemoteI18n.t('settings.model.emptyTitle'))
        .fontSize(MobileDesignTypography.bodyLarge.size)
        .fontWeight(FontWeight.Medium)
        .fontColor(INK)
        .textAlign(TextAlign.Center)
      Text(RemoteI18n.t('settings.model.emptyText'))
        .fontSize(MobileDesignTypography.bodySmall.size)
        .lineHeight(MobileDesignTypography.bodySmall.lineHeight)
        .fontColor(MUTED)
        .textAlign(TextAlign.Center)
    }
    .width('100%')
    .padding({ left: 18, right: 18, top: 26, bottom: 22 })
    .alignItems(HorizontalAlign.Center)
    .margin({ top: 24 })
    .backgroundColor(CARD)
    .borderRadius(MobileDesignGeometry.settingsCardRadius)
  }

  /**
   * The page's one scope card, in every state it has: an older desktop is told
   * why in place of the rows, and the rules that hold regardless are still true
   * once it is upgraded.
   */
  @Builder
  private ScopeCard() {
    Column({ space: 4 }) {
      this.ScopeLine(RemoteI18n.t('settings.model.scopeNewSessions'))
      this.ScopeLine(RemoteI18n.t('settings.model.scopeFastFollowsPrimary'))
      this.ScopeLine(RemoteI18n.t('settings.model.scopeImageUnderstanding'))
    }
    .width('100%')
    .padding({ left: 18, right: 18, top: 14, bottom: 14 })
    .alignItems(HorizontalAlign.Start)
    .margin({ top: 24 })
    .backgroundColor(CARD)
    .borderRadius(MobileDesignGeometry.settingsCardRadius)
  }

  @Builder
  private ScopeLine(text: string) {
    Text(text)
      .width('100%')
      .fontSize(MobileDesignTypography.bodySmall.size)
      .lineHeight(MobileDesignTypography.bodySmall.lineHeight)
      .fontColor(MUTED)
  }

  /**
   * The desktop cannot answer this page. The entry that led here is greyed for
   * the same reason, but the page is reachable from a stale capability set too,
   * so it states the reason itself — the controller already decided which of the
   * two it is, and this card does not re-judge it.
   */
  @Builder
  private UnavailableCard() {
    Text(this.deviceModels.state.error.length > 0 ? this.deviceModels.state.error :
      RemoteI18n.t('status.remoteUnavailable'))
      .width('100%')
      .fontSize(MobileDesignTypography.bodySmall.size)
      .lineHeight(MobileDesignTypography.bodySmall.lineHeight)
      .fontColor(STATUS_DANGER)
      .padding({ left: 18, right: 18, top: 16, bottom: 16 })
      .backgroundColor(CARD)
      .borderRadius(MobileDesignGeometry.settingsCardRadius)
  }

  private deviceLabel(): string {
    return this.desktopName.length > 0 ? this.desktopName : this.desktopId;
  }

  /** The desktop this page belongs to, and how the phone reached it. */
  private summaryStatus(): string {
    const presence = this.connectionState === 'connected' ?
      RemoteI18n.t('connect.connected') : RemoteI18n.t('connect.disconnected');
    const source = this.controlTargetType === 'account_device' ?
      RemoteI18n.t('settings.modelService.accountSource') :
      RemoteI18n.t('settings.modelService.localSource');
    return `${presence} · ${source}`;
  }

  private readingText(): string {
    const status = this.deviceModels.state.statusText;
    return status.length > 0 ? status : RemoteI18n.t('status.loadingModelDefaults');
  }

  /** A write in flight owns the page: both header controls and every row wait for it. */
  private locked(): boolean {
    return this.deviceModels.state.busy;
  }

  private deviceModelState(): RemoteModelDefaultsState {
    return this.deviceModels.state;
  }

  private roleProjection(role: RemoteModelDefaultsRole): ModelRoleRowProjection {
    return ModelRoleCandidatesPolicy.roleRow(
      this.deviceModelState().roles, role, this.deviceModelState().catalog);
  }

  private roleBusy(role: RemoteModelDefaultsRole): boolean {
    return this.locked() && this.deviceModels.pendingRole === role;
  }

  /** True while the just-written role row carries the transient result word. */
  private roleUpdated(role: RemoteModelDefaultsRole): boolean {
    return this.deviceModels.feedbackVisible && this.deviceModels.pendingRole === role;
  }

  /**
   * The role's value line: the model the desktop returned, or the placeholder
   * for a role that has none, with its fallback hint. A model the desktop holds
   * but no longer lists is shown by id — the value is real even when the catalog
   * cannot describe it.
   */
  private roleMeta(role: RemoteModelDefaultsRole): string {
    const base = this.roleValue(role);
    const projection = this.roleProjection(role);
    if (projection.hintKey.length > 0) {
      return `${base} · ${RemoteI18n.t(projection.hintKey)}`;
    }
    return base;
  }

  private roleValue(role: RemoteModelDefaultsRole): string {
    const projection = this.roleProjection(role);
    if (projection.model) {
      return ConversationModelPresentationPolicy.roleMetaLabel(
        toConversationUiModel(projection.model), projection.modelId);
    }
    if (projection.modelId.length > 0) {
      return projection.modelId;
    }
    return RemoteI18n.t(projection.unsetKey);
  }

  /** The value the confirmed write left behind, read back from the device. */
  private writtenValue(): string {
    const role = this.deviceModels.pendingRole;
    return role === '' ? RemoteI18n.t('status.modelDefaultsUpdated') : this.roleValue(role);
  }
}
