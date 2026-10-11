// `SelectionContainerAttribute` is not decoration: the ArkUI compiler resolves
// the attribute type of a component that lives in an api/ declaration through
// this file's imports, so dropping it fails CompileArkTS.
import { SelectionContainer, SelectionContainerAttribute, SelectionContainerTextJoinStyle } from '@kit.ArkUI';
import { MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { DeviceApiLevelService } from '../../services/DeviceApiLevelService';
import {
  MarkdownParseCache,
  ParsedMarkdownBlock,
  ParsedMarkdownInline,
  ParsedMarkdownListItem,
  ParsedMarkdownTableCell,
  ParsedMarkdownTableRow
} from '../../services/MarkdownParser';
import { SelectionCapabilityPolicy } from '../policy/SelectionCapabilityPolicy';
import { CARD, FILE_LINK, INK, LINE, MUTED, SOFT } from './Theme';

@ComponentV2
export struct MarkdownContent {
  private readonly parseCache: MarkdownParseCache = new MarkdownParseCache();
  /**
   * Whether this device can select across blocks. Resolved once: a running
   * process cannot change its API level.
   */
  private readonly crossBlockSelection: boolean =
    SelectionCapabilityPolicy.supportsCrossBlockSelection(DeviceApiLevelService.sdkApiVersion());
  @Param text: string = '';
  // Explicit primitive invalidation for retained Repeat rows. The text remains
  // the source of truth; this revision only ensures parameter propagation on
  // ArkUI builds that do not observe nested object mutations across children.
  @Param renderRevision: number = 0;
  @Event onCopyText: (text: string) => void = (_text: string) => {};
  @Event onOpenLink: (reference: string, label: string) => void = (_reference: string, _label: string) => {};

  build() {
    if (this.crossBlockSelection) {
      // API 26 only: the container is what lets one long press span several
      // `Text` children. Its `copyOption` and join style govern the system
      // selection menu, which copies the selected range with a line break
      // between the blocks it covers. The children keep their own `copyOption`
      // as well: that is the documented shape, and it is also what keeps each
      // block copyable on its own.
      //
      // Colors are deliberately left to the platform. The app has no caret or
      // selection-highlight token, and native color resources are generated from
      // the shared mobile token contract, so inventing one here would rewrite
      // the Android, iOS and design-preview token outputs. The platform paints
      // its own interactive-selection state, which is what the approved UI draft
      // specifies for the missing tokens; the handles take the app's information
      // accent so selection reads as this app's.
      SelectionContainer() {
        this.MarkdownBlockColumn()
      }
      .width('100%')
      .copyOption(CopyOptions.LocalDevice)
      .textJoinStyle(SelectionContainerTextJoinStyle.NEWLINE)
      .caretColor(FILE_LINK)
    } else {
      this.MarkdownBlockColumn()
    }
  }

  /**
   * The rendered answer. Both selection paths draw this exact subtree; only the
   * wrapper differs, so the fallback below API 26 cannot drift from the API 26
   * presentation.
   */
  @Builder
  MarkdownBlockColumn() {
    Column({ space: 5 }) {
      ForEach(this.parseCache.blocksFor(this.text), (block: ParsedMarkdownBlock) => {
        this.MarkdownBlockView(block)
      }, (block: ParsedMarkdownBlock) => block.renderKey)
    }
    .width('100%')
  }

  @Builder
  MarkdownBlockView(block: ParsedMarkdownBlock) {
    if (block.type === 'code') {
      this.CodeBlock(block.language, block.text)
    } else if (block.type === 'frontmatter') {
      this.FrontmatterBlock(block.text)
    } else if (block.type === 'heading') {
      this.InlineText(block.inlines, this.headingFontSize(block.level), this.headingLineHeight(block.level), INK, true)
    } else if (block.type === 'quote') {
      Column() {
        this.InlineText(
          block.inlines,
          MobileDesignTypography.bodySmall.size,
          MobileDesignTypography.bodySmall.lineHeight,
          MUTED,
          false
        )
      }
        .width('100%')
        .padding({ left: 9 + Math.max(0, block.level - 1) * 10 })
        .border({ width: { left: 2 }, color: LINE })
    } else if (block.type === 'list') {
      this.MarkdownList(block.items, this.listMarkerWidth(block.items))
    } else if (block.type === 'table') {
      this.MarkdownTable(block.tableRows)
    } else if (block.type === 'divider') {
      Text('')
        .width('100%')
        .height(1)
        .backgroundColor(LINE)
    } else {
      this.InlineText(
        block.inlines,
        MobileDesignTypography.bodyLarge.size,
        MobileDesignTypography.bodyLarge.lineHeight,
        INK,
        false
      )
    }
  }

  @Builder
  FrontmatterBlock(body: string) {
    Text(body)
      .width('100%')
      .fontSize(MobileDesignTypography.bodySmall.size)
      .lineHeight(MobileDesignTypography.bodySmall.lineHeight)
      .fontColor(MUTED)
      .fontFamily('monospace')
      // `copyOption` is what carries selection; without it `textSelectable`
      // alone is inert. Kept alongside it because it states the intent that this
      // surface is read-only: selectable, never focusable.
      .copyOption(CopyOptions.LocalDevice)
      .textSelectable(TextSelectableMode.SELECTABLE_UNFOCUSABLE)
  }

  @Builder
  InlineText(inlines: ParsedMarkdownInline[], fontSize: number, lineHeight: number, color: ResourceColor, bold: boolean) {
    Text() {
      ForEach(inlines, (inline: ParsedMarkdownInline) => {
        this.InlineSpan(inline, color, bold)
      }, (inline: ParsedMarkdownInline) => inline.id)
    }
    .fontSize(fontSize)
    .lineHeight(lineHeight)
    .fontColor(color)
    .width('100%')
    // Paragraphs, headings, quotes and list items all render through this one
    // Text, so its `copyOption` is the fallback path for every prose block: one
    // block per long press on a device without `SelectionContainer`.
    .copyOption(CopyOptions.LocalDevice)
  }

  @Builder
  InlineSpan(inline: ParsedMarkdownInline, color: ResourceColor, bold: boolean) {
    if (inline.type === 'strong') {
      Span(inline.text)
        .fontWeight(FontWeight.Bold)
        .fontColor(color)
    } else if (inline.type === 'emphasis') {
      Span(inline.text)
        .fontStyle(FontStyle.Italic)
        .fontWeight(bold ? FontWeight.Bold : FontWeight.Regular)
        .fontColor(color)
    } else if (inline.type === 'code') {
      Span(inline.text)
        .fontFamily('monospace')
        .fontWeight(bold ? FontWeight.Bold : FontWeight.Regular)
        .fontColor(INK)
    } else if (inline.type === 'delete') {
      Span(inline.text)
        .fontWeight(bold ? FontWeight.Bold : FontWeight.Regular)
        .fontColor(color)
        .decoration({ type: TextDecorationType.LineThrough, color })
    } else if (inline.type === 'link') {
      Span(inline.text)
        .fontWeight(bold ? FontWeight.Bold : FontWeight.Regular)
        .fontColor(FILE_LINK)
        .decoration({ type: TextDecorationType.Underline, color: FILE_LINK })
        .onClick(() => {
          this.onOpenLink(inline.url, inline.text);
        })
    } else {
      Span(inline.text)
        .fontWeight(bold ? FontWeight.Bold : FontWeight.Regular)
        .fontColor(color)
    }
  }

  private listMarkerWidth(items: ParsedMarkdownListItem[]): number {
    const context = this.getUIContext();
    let width: number = 20;
    for (const item of items) {
      if (item.checked >= 0) continue;
      const size = context.getMeasureUtils().measureTextSize({
        textContent: item.marker,
        fontSize: `${MobileDesignTypography.bodyLarge.size}fp`
      });
      width = Math.max(width, Math.ceil(context.px2vp(Number(size.width))));
    }
    return width;
  }

  @Builder
  MarkdownList(items: ParsedMarkdownListItem[], markerWidth: number) {
    Column({ space: 4 }) {
      ForEach(items, (item: ParsedMarkdownListItem) => {
        Row({ space: 7 }) {
          if (item.checked >= 0) {
            Stack({ alignContent: Alignment.Center }) {
              Text(item.checked === 1 ? '✓' : '')
                .fontSize(MobileDesignTypography.labelSmall.size)
                .fontWeight(FontWeight.Bold)
                .fontColor(MUTED)
                .textAlign(TextAlign.Center)
            }
            .width(16)
            .height(16)
            .margin({ left: 2, right: 2, top: 2 })
            .border({ width: 1, color: LINE })
            .borderRadius(4)
          } else {
            Text(item.marker)
              .width(markerWidth)
              .maxLines(1)
              .flexShrink(0)
              .fontSize(MobileDesignTypography.bodyLarge.size)
              .lineHeight(MobileDesignTypography.bodyLarge.lineHeight)
              .fontColor(MUTED)
              .textAlign(TextAlign.End)
          }
          Column() {
            this.InlineText(
              item.inlines,
              MobileDesignTypography.bodyLarge.size,
              MobileDesignTypography.bodyLarge.lineHeight,
              INK,
              false
            )
          }
            .layoutWeight(1)
        }
        .width('100%')
        .padding({ left: item.depth * 16 })
        .alignItems(VerticalAlign.Top)
      }, (item: ParsedMarkdownListItem) => item.id)
    }
    .width('100%')
  }

  @Builder
  MarkdownTable(rows: ParsedMarkdownTableRow[]) {
    Scroll() {
      Column() {
        ForEach(rows, (row: ParsedMarkdownTableRow, rowIndex: number) => {
          Row() {
            ForEach(row.cells, (cell: ParsedMarkdownTableCell) => {
              this.MarkdownTableCell(cell, row.header)
            }, (cell: ParsedMarkdownTableCell) => cell.id)
          }
          .constraintSize({ minWidth: '100%' })
          .backgroundColor(this.tableRowBackground(row.header, rowIndex))
          .border({
            width: { bottom: rowIndex < rows.length - 1 ? 1 : 0 },
            color: LINE
          })
        }, (row: ParsedMarkdownTableRow) => row.id)
      }
      .constraintSize({ minWidth: '100%' })
    }
    .scrollable(ScrollDirection.Horizontal)
    .scrollBar(BarState.Off)
    .width('100%')
    .backgroundColor(CARD)
    .borderRadius(10)
    .border({ width: 1, color: LINE })
    .clip(true)
  }

  @Builder
  MarkdownTableCell(cell: ParsedMarkdownTableCell, header: boolean) {
    Column() {
      Text() {
        ForEach(cell.inlines, (inline: ParsedMarkdownInline) => {
          this.InlineSpan(inline, INK, false)
        }, (inline: ParsedMarkdownInline) => inline.id)
      }
      .width('100%')
      .fontSize(MobileDesignTypography.bodySmall.size)
      .lineHeight(MobileDesignTypography.bodySmall.lineHeight)
      .fontWeight(header ? FontWeight.Medium : FontWeight.Regular)
      .fontColor(INK)
      .textAlign(this.tableTextAlign(cell.alignment))
      // A cell is its own Text because the table lays cells out in Rows, so it
      // needs its own copyOption to be selectable inside the container and on
      // the fallback path alike.
      .copyOption(CopyOptions.LocalDevice)
    }
    .layoutWeight(1)
    .constraintSize({ minWidth: 132, minHeight: 42 })
    .padding({ left: 12, right: 12, top: 10, bottom: 10 })
    .justifyContent(FlexAlign.Center)
  }

  @Builder
  CodeBlock(language: string, body: string) {
    Column({ space: 7 }) {
      Row() {
        Text(language.length > 0 ? language : 'code')
          .fontSize(MobileDesignTypography.labelSmall.size)
          .fontColor(MUTED)
          .textSelectable(TextSelectableMode.UNSELECTABLE)
        Blank()
        Text(RemoteI18n.t('common.copy'))
          .fontSize(MobileDesignTypography.labelSmall.size)
          .fontColor(MUTED)
          .textSelectable(TextSelectableMode.UNSELECTABLE)
          .onClick(() => {
            this.onCopyText(body);
          })
      }
      .width('100%')
      Scroll() {
        Text(body)
          .fontSize(MobileDesignTypography.labelSmall.size)
          .lineHeight(MobileDesignTypography.labelSmall.lineHeight)
          .fontColor(INK)
          .fontFamily('monospace')
          .constraintSize({ minWidth: '100%' })
          // The code body scrolls horizontally inside the block, so it carries
          // its own copyOption rather than relying on the container to reach it.
          // The language label and the copy action above stay outside the
          // selection: measured on device, a container selection that spans the
          // block copied those two labels as well, so the block's chrome reached
          // the clipboard as text. `UNSELECTABLE` is what keeps a label out of a
          // selection the container drives; the copy action's click still fires.
          .copyOption(CopyOptions.LocalDevice)
      }
      .scrollable(ScrollDirection.Horizontal)
      .scrollBar(BarState.Off)
      .width('100%')
    }
    .width('100%')
    .padding({ left: 9, right: 9, top: 8, bottom: 8 })
    .backgroundColor(SOFT)
    .borderRadius(12)
    .border({ width: 1, color: LINE })
  }

  private headingFontSize(level: number): number {
    if (level <= 1) {
      return MobileDesignTypography.headlineSmall.size;
    }
    if (level === 2) {
      return MobileDesignTypography.titleMedium.size;
    }
    if (level === 3) {
      return MobileDesignTypography.titleSmall.size;
    }
    return MobileDesignTypography.bodyLarge.size;
  }

  private headingLineHeight(level: number): number {
    if (level <= 1) {
      return MobileDesignTypography.headlineSmall.lineHeight;
    }
    if (level === 2) {
      return MobileDesignTypography.titleMedium.lineHeight;
    }
    if (level === 3) {
      return MobileDesignTypography.titleSmall.lineHeight;
    }
    return MobileDesignTypography.bodyLarge.lineHeight;
  }

  private tableTextAlign(alignment: string): TextAlign {
    if (alignment === 'center') {
      return TextAlign.Center;
    }
    if (alignment === 'right') {
      return TextAlign.End;
    }
    return TextAlign.Start;
  }

  private tableRowBackground(header: boolean, rowIndex: number): ResourceColor {
    if (header || rowIndex % 2 === 0) {
      return SOFT;
    }
    return CARD;
  }
}
