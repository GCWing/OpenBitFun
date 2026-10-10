import { MobileDesignGeometry, MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import {
  CommandCatalogProjection,
  COMMAND_CATALOG_FILTER_ALL,
  SkillCatalogFilter,
  SkillCatalogPresentation,
  SkillCatalogRow,
  SkillCatalogSection
} from '../../services/CommandCatalogProjection';
import {
  CommandPaletteCatalogStatus,
  CommandPalettePolicy,
  CommandPaletteProbeFailure
} from '../../services/CommandPalettePolicy';
import { CommandPalettePresentation } from '../state/CommandPaletteState';
import { WindowInsetsBinding } from '../../services/WindowSystemBarService';
import { AppActionButton, AppActionStyle } from './AppActionButton';
import { SheetCloseHeader } from './SheetCloseHeader';
import {
  SHEET_ACTION_HEIGHT,
  SHEET_FOOTER_BOTTOM_PADDING,
  SHEET_FOOTER_TOP_PADDING,
  SHEET_HORIZONTAL_PADDING,
  SHEET_TOP_RADIUS
} from './SheetLayout';
import { CARD, CONTENT_ON_ACTION, INK, LINE, MUTED, PAGE_BG, SOFT, SUBTLE, TRANSPARENT } from './Theme';

// The picker's own geometry, matching the approved design's half-sheet.
const SKILL_SEARCH_HEIGHT: number = 42;
const SKILL_SEARCH_RADIUS: number = 14;
const FILTER_CHIP_HEIGHT: number = 28;
const SKILL_ICON_SURFACE: number = 36;
const SKILL_ICON_RADIUS: number = 10;
const SKILL_SECTION_HEIGHT: number = 28;
const SKILL_TAG_HEIGHT: number = 16;
const SKILL_UNAVAILABLE_OPACITY: number = 0.4;

/**
 * The skill picker, opened from the composer's 技能 chip.
 *
 * It is the row's other half: the chips run commands, and this chooses the one
 * skill token a message may carry. Selecting inserts; it never sends. The sheet
 * is also where an unsupported desktop is explained, because a dead chip would
 * say less than an empty catalog with a reason and a way to re-check it.
 */
@ComponentV2
export struct SkillPickerSheet {
  @Param palette: CommandPalettePresentation = CommandPalettePresentation.hidden();
  @Event onSelect: (skillId: string, skillLabel: string) => void = (_skillId: string, _skillLabel: string) => {};
  @Event onRefresh: () => void = () => {};
  @Event onClose: () => void = () => {};
  @Local query: string = '';
  @Local filterId: string = COMMAND_CATALOG_FILTER_ALL;
  // The sheet is a bottom sheet under the immersive shell, so it reads the
  // navigation-bar strip itself and ends in a tail that rests above it.
  @Local insets: WindowInsetsBinding = new WindowInsetsBinding();

  aboutToAppear(): void {
    const context = this.getUIContext().getHostContext();
    if (context) {
      this.insets.bind(this.getUIContext(), context);
    }
  }

  aboutToDisappear(): void {
    this.insets.unbind();
    // The next open starts from the whole catalog rather than from whatever the
    // previous visit was filtering.
    this.query = '';
    this.filterId = COMMAND_CATALOG_FILTER_ALL;
  }

  build() {
    Column() {
      SheetCloseHeader({
        title: RemoteI18n.t('commands.skills.title'),
        showDivider: true,
        onClose: this.onClose
      })
      this.SearchBox()
      this.Filters()
      if (this.isLoading()) {
        this.LoadingState()
      } else if (this.isUnavailable()) {
        this.UnavailableState()
      } else if (this.presentation().isEmpty) {
        this.EmptyState()
      } else if (this.presentation().hasNoMatches) {
        this.NoMatchState()
      } else {
        this.SkillList()
      }
      this.Footer()
    }
    .width('100%')
    .height('100%')
    .backgroundColor(PAGE_BG)
    .borderRadius({ topLeft: SHEET_TOP_RADIUS, topRight: SHEET_TOP_RADIUS })
  }

  @Builder
  SearchBox() {
    Row({ space: 8 }) {
      SymbolGlyph($r('sys.symbol.magnifyingglass'))
        .fontSize(16)
        .fontColor([MUTED])
      TextInput({ placeholder: RemoteI18n.t('commands.skills.searchPlaceholder'), text: this.query })
        .layoutWeight(1)
        .height(SKILL_SEARCH_HEIGHT)
        .fontSize(MobileDesignTypography.bodySmall.size)
        .fontColor(INK)
        .placeholderColor(MUTED)
        .backgroundColor(TRANSPARENT)
        .padding(0)
        .maxLines(1)
        .enabled(!this.isUnavailable())
        .onChange((value: string) => {
          this.query = value;
        })
    }
    .width('100%')
    .height(SKILL_SEARCH_HEIGHT)
    .padding({ left: 12, right: 12 })
    .backgroundColor(CARD)
    .border({ width: 1, color: LINE })
    .borderRadius(SKILL_SEARCH_RADIUS)
    .opacity(this.isUnavailable() ? SKILL_UNAVAILABLE_OPACITY : 1)
    .margin({ left: SHEET_HORIZONTAL_PADDING, right: SHEET_HORIZONTAL_PADDING, top: 12 })
  }

  @Builder
  Filters() {
    Scroll() {
      Row({ space: 4 }) {
        ForEach(this.presentation().filters, (filter: SkillCatalogFilter) => {
          Text(`${RemoteI18n.t(filter.labelKey)} ${filter.count}`)
            .fontSize(MobileDesignTypography.labelSmall.size)
            .lineHeight(MobileDesignTypography.labelSmall.lineHeight)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.filterId === filter.id ? CONTENT_ON_ACTION : MUTED)
            .backgroundColor(this.filterId === filter.id ? INK : SOFT)
            .height(FILTER_CHIP_HEIGHT)
            .padding({ left: 12, right: 12 })
            .borderRadius(FILTER_CHIP_HEIGHT / 2)
            .accessibilityText(RemoteI18n.t(filter.labelKey))
            .onClick(() => {
              if (!this.isUnavailable()) {
                this.filterId = filter.id;
              }
            })
        }, (filter: SkillCatalogFilter) => filter.id)
      }
      .padding({ left: SHEET_HORIZONTAL_PADDING, right: SHEET_HORIZONTAL_PADDING })
    }
    .scrollable(ScrollDirection.Horizontal)
    .scrollBar(BarState.Off)
    .align(Alignment.Start)
    .width('100%')
    .height(FILTER_CHIP_HEIGHT)
    .margin({ top: 12 })
    .opacity(this.isUnavailable() ? SKILL_UNAVAILABLE_OPACITY : 1)
  }

  @Builder
  SkillList() {
    Scroll() {
      Column({ space: 2 }) {
        ForEach(this.presentation().sections, (section: SkillCatalogSection) => {
          this.SectionHeader(section)
          ForEach(section.rows, (row: SkillCatalogRow) => {
            this.SkillRow(row)
          }, (row: SkillCatalogRow) => row.id)
        }, (section: SkillCatalogSection) => section.id)
      }
      .width('100%')
      .padding({ bottom: this.insets.tailSpacing(12) })
    }
    .width('100%')
    .layoutWeight(1)
    .align(Alignment.TopStart)
    .scrollBar(BarState.Off)
    .margin({ top: 6 })
  }

  @Builder
  SectionHeader(section: SkillCatalogSection) {
    Row({ space: 6 }) {
      Text(RemoteI18n.t(section.titleKey))
        .fontSize(MobileDesignTypography.labelSmall.size)
        .lineHeight(MobileDesignTypography.labelSmall.lineHeight)
        .fontColor(SUBTLE)
      Text(`${section.count}`)
        .fontSize(MobileDesignTypography.labelSmall.size)
        .lineHeight(MobileDesignTypography.labelSmall.lineHeight)
        .fontColor(SUBTLE)
      Blank()
    }
    .width('100%')
    .height(SKILL_SECTION_HEIGHT)
    .padding({ left: SHEET_HORIZONTAL_PADDING + 2, right: SHEET_HORIZONTAL_PADDING + 2 })
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  SkillRow(row: SkillCatalogRow) {
    Row({ space: 10 }) {
      Stack({ alignContent: Alignment.Center }) {
        SymbolGlyph(row.isBuiltin ?
          $r('sys.symbol.wrench_and_screwdriver') : $r('sys.symbol.doc_text'))
          .fontSize(20)
          .fontColor([MUTED])
      }
      .width(SKILL_ICON_SURFACE)
      .height(SKILL_ICON_SURFACE)
      .backgroundColor(this.isSelected(row) ? CARD : SOFT)
      .borderRadius(SKILL_ICON_RADIUS)

      Column({ space: 1 }) {
        Row({ space: 6 }) {
          Text(row.name)
            .fontSize(MobileDesignTypography.titleSmall.size)
            .lineHeight(MobileDesignTypography.titleSmall.lineHeight)
            .fontWeight(FontWeight.Medium)
            .fontColor(INK)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          if (this.rowTag(row).length > 0) {
            Text(this.rowTag(row))
              .fontSize(MobileDesignTypography.labelSmall.size)
              .lineHeight(SKILL_TAG_HEIGHT)
              .fontColor(MUTED)
              .padding({ left: 4, right: 4 })
              .backgroundColor(this.isSelected(row) ? CARD : SOFT)
              .borderRadius(4)
          }
          Blank()
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)

        Text(row.description)
          .fontSize(MobileDesignTypography.bodySmall.size)
          .lineHeight(MobileDesignTypography.bodySmall.lineHeight)
          .fontColor(MUTED)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      Column({ space: 2 }) {
        Text(row.insertHint)
          .fontSize(MobileDesignTypography.labelSmall.size)
          .lineHeight(MobileDesignTypography.labelSmall.lineHeight)
          .fontColor(SUBTLE)
        if (this.isSelected(row)) {
          SymbolGlyph($r('sys.symbol.checkmark_circle'))
            .fontSize(16)
            .fontColor([INK])
        }
      }
      .alignItems(HorizontalAlign.End)
    }
    .width('100%')
    .constraintSize({ minHeight: MobileDesignGeometry.selectionRowHeight })
    .padding({ left: SHEET_HORIZONTAL_PADDING + 4, right: SHEET_HORIZONTAL_PADDING + 4, top: 8, bottom: 8 })
    .backgroundColor(this.isSelected(row) ? SOFT : TRANSPARENT)
    .borderRadius(12)
    .accessibilityText(`${row.name} · ${row.insertHint}`)
    .onClick(() => {
      this.onSelect(row.id, row.name);
    })
  }

  @Builder
  LoadingState() {
    Column() {
      LoadingProgress()
        .width(24)
        .height(24)
        .color(MUTED)
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Center)
  }

  /**
   * The read did not answer, so the sheet explains and offers the re-check.
   *
   * What it claims follows from how the read failed: a host that reported the
   * version gap is an upgrade, a host that refused for its own reasons is quoted,
   * and a read that never reached a host is a connection to look at. Claiming a
   * version gap for a timeout would send the user to update a desktop that is
   * already current.
   */
  @Builder
  UnavailableState() {
    Column({ space: 10 }) {
      Stack({ alignContent: Alignment.Center }) {
        SymbolGlyph($r('sys.symbol.info_circle'))
          .fontSize(26)
          .fontColor([MUTED])
      }
      .width(64)
      .height(64)
      .backgroundColor(SOFT)
      .borderRadius(32)

      Text(RemoteI18n.t(this.unavailableTitleKey()))
        .fontSize(MobileDesignTypography.bodyLarge.size)
        .lineHeight(MobileDesignTypography.bodyLarge.lineHeight)
        .fontWeight(FontWeight.Medium)
        .fontColor(INK)
        .textAlign(TextAlign.Center)

      Text(RemoteI18n.t(this.unavailableBodyKey()))
        .fontSize(MobileDesignTypography.bodySmall.size)
        .lineHeight(MobileDesignTypography.bodySmall.lineHeight)
        .fontColor(MUTED)
        .textAlign(TextAlign.Center)
        .constraintSize({ maxWidth: 260 })

      // The desktop's own words for the refusal. A version gap reads as one, and
      // so does the other common cause — a workspace or session the host cannot
      // find — which this app would otherwise have to guess at.
      if (this.palette.catalogErrorText.length > 0) {
        Text(this.palette.catalogErrorText)
          .fontSize(MobileDesignTypography.labelSmall.size)
          .lineHeight(MobileDesignTypography.labelSmall.lineHeight)
          .fontColor(SUBTLE)
          .textAlign(TextAlign.Center)
          .constraintSize({ maxWidth: 280 })
          .maxLines(4)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }

      AppActionButton({
        label: RemoteI18n.t('commands.skills.recheck'),
        style: AppActionStyle.Secondary,
        actionHeight: SHEET_ACTION_HEIGHT,
        elevated: false,
        onAction: this.onRefresh
      })
        .width(176)
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Center)
    .padding({ left: 10, right: 10, bottom: 12 })
  }

  @Builder
  NoMatchState() {
    Column() {
      Text(RemoteI18n.t('commands.skills.noMatch'))
        .fontSize(MobileDesignTypography.bodySmall.size)
        .lineHeight(MobileDesignTypography.bodySmall.lineHeight)
        .fontColor(MUTED)
        .textAlign(TextAlign.Center)
        .padding({ left: SHEET_HORIZONTAL_PADDING, right: SHEET_HORIZONTAL_PADDING })
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Center)
  }

  /**
   * The host answered, and this mode has nothing to invoke.
   *
   * Distinct from a failed probe: the read worked, so there is nothing to
   * re-check, and the sentence says which of the two happened.
   */
  @Builder
  EmptyState() {
    Column() {
      Text(RemoteI18n.t('commands.skills.empty'))
        .fontSize(MobileDesignTypography.bodySmall.size)
        .lineHeight(MobileDesignTypography.bodySmall.lineHeight)
        .fontColor(MUTED)
        .textAlign(TextAlign.Center)
        .constraintSize({ maxWidth: 260 })
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Center)
    .padding({ left: SHEET_HORIZONTAL_PADDING, right: SHEET_HORIZONTAL_PADDING })
  }

  @Builder
  Footer() {
    Text(RemoteI18n.t(this.isUnavailable() ?
      'commands.skills.footerUnavailable' : 'commands.skills.footer'))
      .fontSize(MobileDesignTypography.labelSmall.size)
      .lineHeight(MobileDesignTypography.labelSmall.lineHeight)
      .fontColor(MUTED)
      .textAlign(TextAlign.Center)
      .width('100%')
      .padding({
        left: SHEET_HORIZONTAL_PADDING,
        right: SHEET_HORIZONTAL_PADDING,
        top: SHEET_FOOTER_TOP_PADDING,
        bottom: SHEET_FOOTER_BOTTOM_PADDING
      })
  }

  private presentation(): SkillCatalogPresentation {
    return CommandCatalogProjection.present(this.palette.catalog, this.query, this.filterId);
  }

  private isLoading(): boolean {
    return this.palette.catalogStatus === CommandPaletteCatalogStatus.Loading;
  }

  /**
   * The read did not answer, so there is no list to show.
   *
   * The row's own explanation counts too, because a chip can reach this sheet
   * while the read that would fill it is still outstanding.
   */
  private isUnavailable(): boolean {
    if (this.palette.catalogStatus === CommandPaletteCatalogStatus.Failed) {
      return true;
    }
    return !this.isLoading() && this.palette.rowReasonKey.length > 0;
  }

  private unavailableTitleKey(): string {
    return CommandPalettePolicy.probeTitleKey(this.failure());
  }

  private unavailableBodyKey(): string {
    return CommandPalettePolicy.probeBodyKey(this.failure());
  }

  /**
   * How the read failed, as this sheet tells it.
   *
   * A read that never failed — the row is explaining something else — is not a
   * version claim either, so it takes the same wording as an unreachable host.
   */
  private failure(): string {
    if (this.palette.catalogStatus !== CommandPaletteCatalogStatus.Failed) {
      return CommandPaletteProbeFailure.Unreachable;
    }
    return this.palette.catalogFailure;
  }

  private rowTag(row: SkillCatalogRow): string {
    return row.group.length > 0 ? row.group : row.source;
  }

  private isSelected(row: SkillCatalogRow): boolean {
    return this.palette.skillId.length > 0 && this.palette.skillId === row.id;
  }
}
