import { MobileDesignGeometry, MobileDesignMotion, MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { CommandPaletteChip, CommandPaletteChipKind, CommandPaletteChipState } from '../../services/CommandPalettePolicy';
import { CommandPaletteNotice, CommandPalettePresentation } from '../state/CommandPaletteState';
import { CommandPaletteAction, CommandPaletteRequest } from '../actions/ConversationIntent';
import { ComposerPresentation } from './ComposerBar';
import {
  CONTENT_ON_ACTION,
  INK,
  LINE,
  MUTED,
  PAGE_BG,
  SOFT,
  STATUS_DANGER,
  TRANSPARENT
} from './Theme';

// The row's own geometry. It is new to this component and is not part of the
// cross-platform token contract yet, so it lives here rather than being pushed
// into another platform's generated tokens.
const CHIP_HEIGHT: number = 32;
const CHIP_RADIUS: number = 16;
const CHIP_HORIZONTAL_PADDING: number = 9;
const CHIP_GAP: number = 4;
const CHIP_TOP_PADDING: number = 6;
const CHIP_END_GUTTER: number = 32;
const CHIP_ICON_SIZE: number = 13;
const CHIP_CHEVRON_SIZE: number = 9;
const CHIP_ROW_FADE_WIDTH: number = 18;
const CHIP_DISABLED_OPACITY: number = 0.38;
const CHIP_IN_FLIGHT_OPACITY: number = 0.52;
const CHIP_BADGE_HEIGHT: number = 15;
const HINT_ICON_SIZE: number = 14;
const CHIP_ROW_HEIGHT: number = CHIP_HEIGHT + CHIP_TOP_PADDING + 2;

/**
 * The composer's command chips: one horizontally scrollable row directly above
 * the input, plus the single line the row owes the user underneath it.
 *
 * Commands execute on the tap; the skills chip opens the picker instead, which
 * is what its up-chevron says. A chip that cannot run is drawn grey and stays
 * tappable, because "nothing happened" is not an answer — the row explains
 * itself in the hint line below.
 */
@ComponentV2
export struct CommandChipRow {
  @Param palette: CommandPalettePresentation = CommandPalettePresentation.hidden();
  @Param presentation: ComposerPresentation = ComposerPresentation.Compact;
  @Event onRequest: (request: CommandPaletteRequest) => void = (_request: CommandPaletteRequest) => {};
  @Local showReason: boolean = false;

  build() {
    Column({ space: 4 }) {
      Stack({ alignContent: Alignment.End }) {
        Scroll() {
          Row({ space: CHIP_GAP }) {
            ForEach(this.palette.chips, (chip: CommandPaletteChip) => {
              this.Chip(chip)
            }, (chip: CommandPaletteChip) => chip.kind)
          }
          .alignItems(VerticalAlign.Center)
          .padding({
            left: this.horizontalInset(),
            right: CHIP_END_GUTTER,
            top: CHIP_TOP_PADDING,
            bottom: 2
          })
        }
        .scrollable(ScrollDirection.Horizontal)
        .scrollBar(BarState.Off)
        // Scroll centres content narrower than the viewport, which would park the
        // first chip in the middle of the row instead of at the composer's edge.
        .align(Alignment.Start)
        .width('100%')
        .height(CHIP_ROW_HEIGHT)

        this.RowEndFade()
      }
      .width('100%')
      .height(CHIP_ROW_HEIGHT)

      if (this.hintKey().length > 0) {
        this.HintLine()
      }
    }
    .width('100%')
    .constraintSize({ maxWidth: this.presentation === ComposerPresentation.Floating ? 760 : 10000 })
    .alignSelf(ItemAlign.Center)
  }

  @Builder
  Chip(chip: CommandPaletteChip) {
    Stack({ alignContent: Alignment.TopEnd }) {
      Row({ space: 4 }) {
        if (chip.state === CommandPaletteChipState.InFlight) {
          LoadingProgress()
            .width(CHIP_ICON_SIZE)
            .height(CHIP_ICON_SIZE)
            .color(MUTED)
        } else {
          SymbolGlyph(this.chipGlyph(chip.kind))
            .fontSize(CHIP_ICON_SIZE)
            .fontColor([this.chipGlyphColor(chip)])
            .opacity(chip.state === CommandPaletteChipState.Dimmed ? 1 : 0.82)
        }
        Text(RemoteI18n.t(chip.labelKey))
          .fontSize(MobileDesignTypography.bodySmall.size)
          .lineHeight(MobileDesignTypography.labelSmall.lineHeight)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.chipLabelColor(chip))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        if (chip.showsChevron) {
          SymbolGlyph($r('sys.symbol.chevron_up'))
            .fontSize(CHIP_CHEVRON_SIZE)
            .fontColor([this.chipChevronColor(chip)])
            .opacity(chip.state === CommandPaletteChipState.Dimmed ? 1 : 0.56)
        }
      }
      .height(CHIP_HEIGHT)
      .padding({ left: CHIP_HORIZONTAL_PADDING, right: CHIP_HORIZONTAL_PADDING })
      .backgroundColor(this.chipBackgroundColor(chip))
      .borderRadius(CHIP_RADIUS)

      // Absolutely offset rather than laid out inline: a badge that eats width
      // pushes the row's last chip off the screen edge.
      if (chip.badgeKey.length > 0) {
        this.ChipBadge(chip.badgeKey)
      }
    }
    .height(CHIP_HEIGHT)
    .opacity(this.chipOpacity(chip))
    .accessibilityText(chip.badgeKey.length > 0 ?
      `${RemoteI18n.t(chip.labelKey)} · ${RemoteI18n.t(chip.badgeKey)}` :
      RemoteI18n.t(chip.labelKey))
    .animation({ duration: MobileDesignMotion.quick, curve: Curve.EaseOut })
    .onClick(() => {
      this.tapChip(chip);
    })
  }

  /** The corner badge an unsupported host's chips carry. */
  @Builder
  ChipBadge(badgeKey: string) {
    Text(RemoteI18n.t(badgeKey))
      .fontSize(MobileDesignTypography.labelSmall.size)
      .lineHeight(CHIP_BADGE_HEIGHT)
      .fontColor(MUTED)
      .padding({ left: 4, right: 4 })
      .backgroundColor(LINE)
      .borderRadius(4)
      .offset({ x: 2, y: -CHIP_TOP_PADDING })
  }

  @Builder
  RowEndFade() {
    Column()
      .width(CHIP_ROW_FADE_WIDTH)
      .height(CHIP_HEIGHT)
      .margin({ top: CHIP_TOP_PADDING })
      .hitTestBehavior(HitTestMode.None)
      .linearGradient({
        angle: 90,
        colors: [[TRANSPARENT, 0.0], [PAGE_BG, 1.0]]
      })
  }

  /**
   * The row's explanation line.
   *
   * Three things can be said here and only one at a time: an unsupported host, a
   * verb that just failed (with its retry), or the goal chip waiting for its
   * argument. The goal prefill outranks the rest while it is lit, because that is
   * the state the user has to act on before anything can be sent.
   */
  @Builder
  HintLine() {
    Row({ space: 6 }) {
      SymbolGlyph(this.hintGlyph())
        .fontSize(HINT_ICON_SIZE)
        .fontColor([this.hintColor()])
      Text(RemoteI18n.t(this.hintKey()))
        .fontSize(MobileDesignTypography.labelSmall.size)
        .lineHeight(MobileDesignTypography.labelSmall.lineHeight)
        .fontColor(this.hintColor())
        .layoutWeight(1)
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      if (this.retryable()) {
        Text(RemoteI18n.t('common.retry'))
          .fontSize(MobileDesignTypography.labelSmall.size)
          .lineHeight(MobileDesignTypography.labelSmall.lineHeight)
          .fontWeight(FontWeight.Medium)
          .fontColor(INK)
          .padding({ left: 6, right: 6, top: 2, bottom: 2 })
          .backgroundColor(SOFT)
          .borderRadius(8)
          .accessibilityText(RemoteI18n.t('common.retry'))
          .onClick(() => {
            this.onRequest(new CommandPaletteRequest(
              CommandPaletteAction.RetryCommand, '', this.palette.notice.retryCommand));
          })
      }
    }
    .width('100%')
    .padding({ left: this.horizontalInset(), right: MobileDesignGeometry.conversationOverlaySideInset })
    .alignItems(VerticalAlign.Top)
  }

  private horizontalInset(): number {
    return this.presentation === ComposerPresentation.Floating ?
      24 : MobileDesignGeometry.conversationOverlaySideInset;
  }

  private tapChip(chip: CommandPaletteChip): void {
    if (!chip.runsAction) {
      // Degraded is a state to explain, not a dead control: the reason appears
      // under the row instead of being swallowed by the tap.
      this.showReason = chip.reasonKey.length > 0;
      return;
    }
    this.showReason = false;
    this.onRequest(this.requestFor(chip.kind));
  }

  private requestFor(kind: CommandPaletteChipKind): CommandPaletteRequest {
    if (kind === CommandPaletteChipKind.Compact) {
      return new CommandPaletteRequest(CommandPaletteAction.Compact);
    }
    if (kind === CommandPaletteChipKind.Init) {
      return new CommandPaletteRequest(CommandPaletteAction.InitAgentsMd);
    }
    if (kind === CommandPaletteChipKind.Goal) {
      return new CommandPaletteRequest(CommandPaletteAction.ToggleGoal);
    }
    if (kind === CommandPaletteChipKind.Usage) {
      return new CommandPaletteRequest(CommandPaletteAction.OpenUsage);
    }
    return new CommandPaletteRequest(CommandPaletteAction.OpenSkills);
  }

  private chipGlyph(kind: CommandPaletteChipKind): Resource {
    if (kind === CommandPaletteChipKind.Compact) return $r('sys.symbol.arrow_up_left_and_arrow_down_right');
    if (kind === CommandPaletteChipKind.Init) return $r('sys.symbol.doc_text_badge_arrow_up');
    if (kind === CommandPaletteChipKind.Goal) return $r('sys.symbol.list_checkmark');
    if (kind === CommandPaletteChipKind.Usage) return $r('sys.symbol.square_grid_2x2');
    return $r('sys.symbol.wrench_and_screwdriver');
  }

  private chipBackgroundColor(chip: CommandPaletteChip): ResourceColor {
    return chip.state === CommandPaletteChipState.Pending ? INK : SOFT;
  }

  private chipLabelColor(chip: CommandPaletteChip): ResourceColor {
    if (chip.state === CommandPaletteChipState.Pending) return CONTENT_ON_ACTION;
    return chip.state === CommandPaletteChipState.Dimmed ? MUTED : INK;
  }

  private chipGlyphColor(chip: CommandPaletteChip): ResourceColor {
    if (chip.state === CommandPaletteChipState.Pending) return CONTENT_ON_ACTION;
    return chip.state === CommandPaletteChipState.Dimmed ? MUTED : INK;
  }

  private chipChevronColor(chip: CommandPaletteChip): ResourceColor {
    return chip.state === CommandPaletteChipState.Dimmed ? MUTED : INK;
  }

  private chipOpacity(chip: CommandPaletteChip): number {
    if (chip.state === CommandPaletteChipState.InFlight) return CHIP_IN_FLIGHT_OPACITY;
    return chip.state === CommandPaletteChipState.Dimmed ? CHIP_DISABLED_OPACITY : 1;
  }

  private notice(): CommandPaletteNotice {
    return this.palette.notice;
  }

  private retryable(): boolean {
    return this.palette.rowReasonKey.length === 0 && this.notice().retryable;
  }

  private hintKey(): string {
    if (this.palette.rowReasonKey.length > 0) {
      return this.palette.rowReasonKey;
    }
    if (this.notice().visible) {
      return this.notice().labelKey;
    }
    const goal = this.palette.chips.find((chip: CommandPaletteChip): boolean =>
      chip.kind === CommandPaletteChipKind.Goal);
    if (goal && goal.state === CommandPaletteChipState.Pending) {
      return 'commands.goalHint';
    }
    if (this.showReason) {
      const dimmed = this.palette.chips.find((chip: CommandPaletteChip): boolean =>
        chip.reasonKey.length > 0);
      if (dimmed) {
        return dimmed.reasonKey;
      }
    }
    return '';
  }

  private hintGlyph(): Resource {
    const notice = this.notice();
    if (this.palette.rowReasonKey.length === 0 && notice.visible && notice.retryable) {
      return $r('sys.symbol.xmark');
    }
    return $r('sys.symbol.info_circle');
  }

  private hintColor(): ResourceColor {
    const notice = this.notice();
    if (this.palette.rowReasonKey.length === 0 && notice.visible && notice.retryable) {
      return STATUS_DANGER;
    }
    return MUTED;
  }
}
