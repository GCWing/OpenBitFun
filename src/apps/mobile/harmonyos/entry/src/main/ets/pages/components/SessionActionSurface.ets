import { MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { CARD, INK, LINE, MUTED, SHADOW_SUBTLE, STATUS_DANGER, TRANSPARENT } from './Theme';
import { AppActionButton, AppActionStyle } from './AppActionButton';

export enum SessionActionPresentation {
  BottomSheet = 'bottom_sheet',
  Popover = 'popover'
}

@ComponentV2
export struct SessionActionSurface {
  @Param presentation: SessionActionPresentation = SessionActionPresentation.BottomSheet;
  @Param sessionTitle: string = '';
  /**
   * Bottom padding in vp. The bottom-sheet presentation sits at the screen
   * edge under the immersive shell, so its host passes the strip-aware value
   * (`insets.bottomPadding(18)`); a popover keeps the plain design spacing.
   */
  @Param bottomPadding: number = 18;
  @Param archived: boolean = false;
  @Param canViewDetails: boolean = false;
  @Param canArchive: boolean = false;
  @Param canExport: boolean = false;
  @Param canDelete: boolean = false;
  @Event onArchive: () => void = () => {};
  @Event onViewDetails: () => void = () => {};
  @Event onExport: () => void = () => {};
  @Event onDelete: () => void = () => {};
  @Event onClose: () => void = () => {};
  @Local confirmingDelete: boolean = false;

  build() {
    Column() {
      if (this.presentation === SessionActionPresentation.BottomSheet) {
        Text('')
          .width(36)
          .height(4)
          .backgroundColor(LINE)
          .borderRadius(2)
          .margin({ bottom: 10 })
      }

      Row({ space: 12 }) {
        Column({ space: 3 }) {
          Text(RemoteI18n.t('session.actions'))
            .width('100%')
            .fontSize(MobileDesignTypography.bodySmall.size)
            .fontWeight(FontWeight.Medium)
            .fontColor(MUTED)
          Text(this.sessionTitle || RemoteI18n.t('sidebar.untitled'))
            .width('100%')
            .fontSize(MobileDesignTypography.titleSmall.size)
            .fontWeight(FontWeight.Medium)
            .fontColor(INK)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)

        Stack({ alignContent: Alignment.Center }) {
          SymbolGlyph($r('sys.symbol.xmark'))
            .fontSize(16)
            .fontColor([MUTED])
        }
        .width(40)
        .height(40)
        .accessibilityText(RemoteI18n.t('common.close'))
        .onClick(() => this.onClose())
      }
      .width('100%')
      .height(52)
      .alignItems(VerticalAlign.Center)

      Divider().color(LINE).margin({ top: 6, bottom: 8 })

      if (this.confirmingDelete) {
        this.DeleteConfirmation()
      } else {
        if (this.canViewDetails) {
          this.ActionRow('details', RemoteI18n.t('session.viewDetails'), () => {
            this.onViewDetails();
            this.onClose();
          })
        }
        if (this.canArchive) {
          this.ActionRow('archive', this.archived ? RemoteI18n.t('sidebar.unarchive') :
            RemoteI18n.t('sidebar.archive'), () => {
            this.onArchive();
            this.onClose();
          })
        }
        if (this.canExport) {
          this.ActionRow('export', RemoteI18n.t('sidebar.exportMarkdown'), () => {
            this.onExport();
            this.onClose();
          })
        }
        if (this.canDelete) {
          if (this.canArchive || this.canExport) {
            Divider().color(LINE).margin({ top: 6, bottom: 6 })
          }
          this.ActionRow('delete', RemoteI18n.t('common.delete'), () => {
            this.confirmingDelete = true;
          }, true)
        }
      }
    }
    .width(this.presentation === SessionActionPresentation.Popover ? 300 : '100%')
    // The card's fill still reaches the sheet's bottom edge; the padding is
    // what keeps the last action row out of the navigation bar's strip.
    .padding({ left: 16, right: 16, top: 10, bottom: this.bottomPadding })
    .backgroundColor(CARD)
    .border({ width: this.presentation === SessionActionPresentation.Popover ? 0.5 : 1, color: LINE })
    .borderRadius(16)
    .shadow({
      radius: this.presentation === SessionActionPresentation.Popover ? 20 : 0,
      color: this.presentation === SessionActionPresentation.Popover ? SHADOW_SUBTLE : TRANSPARENT,
      offsetY: this.presentation === SessionActionPresentation.Popover ? 8 : 0
    })
    .alignItems(HorizontalAlign.Center)
  }

  @Builder
  private ActionRow(kind: string, label: string, action: () => void, destructive: boolean = false) {
    Row({ space: 12 }) {
      this.ActionIcon(kind, destructive)
      Text(label)
        .layoutWeight(1)
        .fontSize(MobileDesignTypography.titleSmall.size)
        .fontColor(destructive ? STATUS_DANGER : INK)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    }
    .width('100%')
    .height(46)
    .padding({ left: 10, right: 10 })
    .borderRadius(8)
    .backgroundColor(TRANSPARENT)
    .onClick(action)
  }

  @Builder
  private ActionIcon(kind: string, destructive: boolean) {
    if (kind === 'details') {
      SymbolGlyph($r('sys.symbol.info_circle'))
        .fontSize(19)
        .fontColor([MUTED])
    } else if (kind === 'archive') {
      SymbolGlyph($r('sys.symbol.archivebox'))
        .fontSize(19)
        .fontColor([destructive ? STATUS_DANGER : MUTED])
    } else if (kind === 'export') {
      SymbolGlyph($r('sys.symbol.cloud'))
        .fontSize(19)
        .fontColor([MUTED])
    } else {
      SymbolGlyph($r('sys.symbol.trash'))
        .fontSize(19)
        .fontColor([STATUS_DANGER])
    }
  }

  @Builder
  private DeleteConfirmation() {
    Column({ space: 12 }) {
      Text(RemoteI18n.t('sidebar.deleteConfirm'))
        .width('100%')
        .fontSize(MobileDesignTypography.bodySmall.size)
        .lineHeight(MobileDesignTypography.bodySmall.lineHeight)
        .fontColor(MUTED)
      Row({ space: 10 }) {
        AppActionButton({
          label: RemoteI18n.t('common.cancel'),
          style: AppActionStyle.Quiet,
          actionHeight: 44,
          onAction: (): void => {
            this.confirmingDelete = false;
          }
        })
          .layoutWeight(1)
        AppActionButton({
          label: RemoteI18n.t('common.delete'),
          style: AppActionStyle.Destructive,
          actionHeight: 44,
          onAction: (): void => {
            this.onDelete();
            this.onClose();
          }
        })
          .layoutWeight(1)
      }
      .width('100%')
    }
    .width('100%')
    .padding({ top: 4, bottom: 4 })
  }
}
