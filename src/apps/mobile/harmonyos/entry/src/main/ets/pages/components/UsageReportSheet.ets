import { MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { CommandPaletteUsageStatus, CommandPalettePresentation } from '../state/CommandPaletteState';
import { UsageReportRow, UsageReportSection } from '../policy/UsageReportPresentationPolicy';
import { WindowInsetsBinding } from '../../services/WindowSystemBarService';
import { AppActionButton, AppActionStyle } from './AppActionButton';
import { SheetCloseHeader } from './SheetCloseHeader';
import { SHEET_ACTION_HEIGHT, SHEET_FOOTER_BOTTOM_PADDING, SHEET_FOOTER_TOP_PADDING, SHEET_HORIZONTAL_PADDING, SHEET_TOP_RADIUS } from './SheetLayout';
import { INK, MUTED, PAGE_BG, SUBTLE } from './Theme';

const USAGE_SECTION_HEIGHT: number = 30;
const USAGE_ROW_MIN_HEIGHT: number = 30;

/**
 * The session's usage, opened from the 用量 chip.
 *
 * Every row comes from the report the host actually sent: the desktop report is
 * mirrored field by field and all of it is optional, so this sheet renders what
 * is present and never fills a missing metric with a zero. A report that
 * arrived with gaps says so at the end instead of pretending to be complete.
 */
@ComponentV2
export struct UsageReportSheet {
  @Param palette: CommandPalettePresentation = CommandPalettePresentation.hidden();
  @Event onRetry: () => void = () => {};
  @Event onClose: () => void = () => {};
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
  }

  build() {
    Column() {
      SheetCloseHeader({
        title: RemoteI18n.t('usage.title'),
        showDivider: true,
        onClose: this.onClose
      })
      if (this.isLoading()) {
        this.LoadingState()
      } else if (this.isFailed()) {
        this.FailedState()
      } else if (this.palette.usageSections.length === 0) {
        this.EmptyState()
      } else {
        this.Report()
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(PAGE_BG)
    .borderRadius({ topLeft: SHEET_TOP_RADIUS, topRight: SHEET_TOP_RADIUS })
  }

  @Builder
  Report() {
    Scroll() {
      Column({ space: 4 }) {
        ForEach(this.palette.usageSections, (section: UsageReportSection) => {
          this.SectionHeader(section)
          ForEach(section.rows, (row: UsageReportRow) => {
            this.ReportRow(row)
          }, (row: UsageReportRow, index: number) => `${section.id}-${index}-${row.labelKey}`)
        }, (section: UsageReportSection) => section.id)
        if (this.palette.usagePartial) {
          Text(RemoteI18n.t('usage.partialNote'))
            .fontSize(MobileDesignTypography.labelSmall.size)
            .lineHeight(MobileDesignTypography.labelSmall.lineHeight)
            .fontColor(SUBTLE)
            .width('100%')
            .padding({ left: SHEET_HORIZONTAL_PADDING, right: SHEET_HORIZONTAL_PADDING, top: 10 })
        }
      }
      .width('100%')
      .padding({ top: 8, bottom: this.insets.tailSpacing(SHEET_FOOTER_BOTTOM_PADDING) })
    }
    .width('100%')
    .layoutWeight(1)
    .align(Alignment.TopStart)
    .scrollBar(BarState.Off)
  }

  @Builder
  SectionHeader(section: UsageReportSection) {
    Row() {
      Text(RemoteI18n.t(section.titleKey))
        .fontSize(MobileDesignTypography.labelSmall.size)
        .lineHeight(MobileDesignTypography.labelSmall.lineHeight)
        .fontColor(SUBTLE)
      Blank()
    }
    .width('100%')
    .height(USAGE_SECTION_HEIGHT)
    .padding({ left: SHEET_HORIZONTAL_PADDING, right: SHEET_HORIZONTAL_PADDING })
    .alignItems(VerticalAlign.Bottom)
  }

  @Builder
  ReportRow(row: UsageReportRow) {
    Row() {
      Text(RemoteI18n.t(row.labelKey))
        .fontSize(MobileDesignTypography.bodySmall.size)
        .lineHeight(MobileDesignTypography.bodySmall.lineHeight)
        .fontColor(MUTED)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
      Blank()
      Text(row.valueKey.length > 0 ? RemoteI18n.t(row.valueKey) : row.value)
        .fontSize(MobileDesignTypography.bodySmall.size)
        .lineHeight(MobileDesignTypography.bodySmall.lineHeight)
        .fontWeight(FontWeight.Medium)
        .fontColor(INK)
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .textAlign(TextAlign.End)
    }
    .width('100%')
    .constraintSize({ minHeight: USAGE_ROW_MIN_HEIGHT })
    .padding({ left: SHEET_HORIZONTAL_PADDING, right: SHEET_HORIZONTAL_PADDING, top: 4, bottom: 4 })
    .alignItems(VerticalAlign.Top)
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
   * The read failed. The host's own text is shown when it sent one — a usage
   * failure is usually about the target session, not about this app.
   */
  @Builder
  FailedState() {
    Column({ space: 10 }) {
      Text(RemoteI18n.t('usage.loadFailed'))
        .fontSize(MobileDesignTypography.bodyLarge.size)
        .lineHeight(MobileDesignTypography.bodyLarge.lineHeight)
        .fontColor(INK)
        .textAlign(TextAlign.Center)
      if (this.palette.usageErrorText.length > 0) {
        Text(this.palette.usageErrorText)
          .fontSize(MobileDesignTypography.bodySmall.size)
          .lineHeight(MobileDesignTypography.bodySmall.lineHeight)
          .fontColor(MUTED)
          .textAlign(TextAlign.Center)
          .constraintSize({ maxWidth: 280 })
      }
      AppActionButton({
        label: RemoteI18n.t('common.retry'),
        style: AppActionStyle.Secondary,
        actionHeight: SHEET_ACTION_HEIGHT,
        elevated: false,
        onAction: this.onRetry
      })
        .width(176)
        .margin({ top: 4 })
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Center)
    .padding({ left: 10, right: 10, bottom: 12 })
  }

  @Builder
  EmptyState() {
    Column() {
      Text(RemoteI18n.t('usage.empty'))
        .fontSize(MobileDesignTypography.bodySmall.size)
        .lineHeight(MobileDesignTypography.bodySmall.lineHeight)
        .fontColor(MUTED)
        .textAlign(TextAlign.Center)
        .padding({ left: SHEET_HORIZONTAL_PADDING, right: SHEET_HORIZONTAL_PADDING })
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Center)
    .padding({ bottom: SHEET_FOOTER_TOP_PADDING })
  }

  private isLoading(): boolean {
    return this.palette.usageStatus === CommandPaletteUsageStatus.Loading;
  }

  private isFailed(): boolean {
    return this.palette.usageStatus === CommandPaletteUsageStatus.Failed;
  }
}
