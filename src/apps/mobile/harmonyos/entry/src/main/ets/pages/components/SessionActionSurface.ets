import { MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { CARD, INK, LINE, MUTED, SHADOW_SUBTLE, STATUS_DANGER, TRANSPARENT } from './Theme';
import { AppActionButton, AppActionStyle } from './AppActionButton';

export enum SessionActionPresentation {
  BottomSheet = 'bottom_sheet',
  Popover = 'popover'
}

/**
 * One session's action list, in the two presentations that carry it.
 *
 * The bottom-sheet presentation is the platform sheet's content: the sheet owns
 * the title, the close icon, the fill and the corners, so this surface adds no
 * chrome of its own there. The popover presentation is anchored to the session
 * row, and nothing else draws its card, its title row or its close — so it keeps
 * them.
 */
@ComponentV2
export struct SessionActionSurface {
  @Param presentation: SessionActionPresentation = SessionActionPresentation.BottomSheet;
  /**
   * Whether the popover is presented by a container that adopts the immersive
   * material. The material is the bubble's background then, so the card's fill,
   * its hairline and its shadow are dropped rather than painted over it. Row
   * geometry is unchanged either way.
   */
  @Param immersiveMaterial: boolean = false;
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
      // The popover keeps its own header: it is anchored to the session row it
      // belongs to, not presented by a sheet, so no platform title bar exists to
      // carry its name and its close. In the sheet presentation both move into
      // the sheet's own title, and the close icon is the platform's.
      if (this.presentation === SessionActionPresentation.Popover) {
        this.PopoverHeader()
        Divider().color(LINE).margin({ top: 6, bottom: 8 })
      }

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
    // Only the popover paints a surface of its own. In the sheet presentation the
    // platform sheet is the surface — its fill, its hairline, its shadow and its
    // corners — so this content root paints nothing over it.
    .backgroundColor(this.paintsOwnCard() ? this.cardFill() : TRANSPARENT)
    .border(this.cardBorder())
    .borderRadius(this.paintsOwnCard() ? 16 : 0)
    .shadow(this.cardShadow())
    .alignItems(HorizontalAlign.Center)
  }

  /** Whether this presentation paints its own card rather than sitting on a sheet. */
  private paintsOwnCard(): boolean {
    return this.presentation === SessionActionPresentation.Popover;
  }

  /** The popover's fill: the material is the card when the platform renders one. */
  private cardFill(): ResourceColor {
    return this.immersiveMaterial ? TRANSPARENT : CARD;
  }

  /** The popover's hairline, which a material replaces with its own edge. */
  private cardBorder(): BorderOptions {
    const own: boolean = this.paintsOwnCard() && !this.immersiveMaterial;
    return { width: own ? 0.5 : 0, color: own ? LINE : TRANSPARENT };
  }

  /** The popover's lift, which a material carries instead. */
  private cardShadow(): ShadowOptions {
    const own: boolean = this.paintsOwnCard() && !this.immersiveMaterial;
    return {
      radius: own ? 20 : 0,
      color: own ? SHADOW_SUBTLE : TRANSPARENT,
      offsetY: own ? 8 : 0
    };
  }

  /**
   * The popover's own title row, with its close.
   *
   * It stays because nothing else can draw it: a popover is anchored to the row
   * it opened from, and the platform's sheet title bar is not part of it.
   */
  @Builder
  private PopoverHeader() {
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
