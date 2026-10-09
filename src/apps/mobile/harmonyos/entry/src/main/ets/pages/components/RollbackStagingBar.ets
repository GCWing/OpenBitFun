import { MobileDesignGeometry, MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { RollbackBarPresentation, RollbackPresentationPolicy } from '../policy/RollbackPresentationPolicy';
import { ComposerPresentation } from './ComposerBar';
import { INK, MUTED, SOFT } from './Theme';

/**
 * Height of the bar, and of the two icon-only controls inside it.
 *
 * Frozen in the approved artboard (H): a 48-high SOFT capsule whose right edge
 * holds two 40-vp controls, four apart, so the confirm glyph clears the capsule's
 * corner by its own padding rather than by a margin of its own.
 */
const ROLLBACK_BAR_HEIGHT: number = 48;
const ROLLBACK_ICON_BUTTON_SIZE: number = 40;
const ROLLBACK_GLYPH_SIZE: number = 20;
const ROLLBACK_BAR_RADIUS: number = 16;
const ROLLBACK_BAR_LEADING_PADDING: number = 12;
const ROLLBACK_BAR_TRAILING_PADDING: number = 4;
/** Gap between the label block and the controls, and between the two glyphs. */
const ROLLBACK_BAR_ACTION_GAP: number = 4;
const ROLLBACK_BAR_TEXT_GAP: number = 8;
/** The composer's own constrained width, which the bar sits directly above. */
const ROLLBACK_BAR_MAX_WIDTH: number = 760;

/**
 * The staged rollback's bar, pinned directly above the composer.
 *
 * It says what is about to be withdrawn and offers the two exits with no copy of
 * their own: the confirm glyph is the main-action ink, the close glyph is muted,
 * and each carries its label for accessibility instead of on screen. Both exits
 * live in a centered `Stack` that owns the touch target, so the glyph keeps its
 * natural advance box (see the SymbolGlyph rules in AGENTS.md).
 *
 * The bar is drawn in both responsive presentations: the compact composer and the
 * wide floating one, with the same horizontal inset each of them uses, so the bar
 * and the pill it sits above share both edges.
 */
@ComponentV2
export struct RollbackStagingBar {
  @Param presentation: ComposerPresentation = ComposerPresentation.Compact;
  @Param bar: RollbackBarPresentation = new RollbackBarPresentation(false, '', '');
  @Event onConfirm: () => void = () => {};
  @Event onClose: () => void = () => {};

  build() {
    // The whole box is conditional, not just its contents: a hidden bar that still
    // occupied its gap would push the composer down for the entire session.
    if (this.bar.visible) {
      Column() {
        Row({ space: ROLLBACK_BAR_TEXT_GAP }) {
          Row({ space: ROLLBACK_BAR_TEXT_GAP }) {
            Text(RemoteI18n.t(this.bar.titleKey))
              .fontSize(MobileDesignTypography.bodySmall.size)
              .lineHeight(MobileDesignTypography.bodySmall.lineHeight)
              .fontWeight(FontWeight.Medium)
              .fontColor(INK)
              .maxLines(1)
            Text(this.bar.preview)
              .fontSize(MobileDesignTypography.bodySmall.size)
              .lineHeight(MobileDesignTypography.bodySmall.lineHeight)
              .fontColor(MUTED)
              .layoutWeight(1)
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
          }
          .layoutWeight(1)
          .alignItems(VerticalAlign.Center)

          Row({ space: ROLLBACK_BAR_ACTION_GAP }) {
            this.ConfirmButton()
            this.CloseButton()
          }
          .alignItems(VerticalAlign.Center)
        }
        .width('100%')
        .height(ROLLBACK_BAR_HEIGHT)
        .padding({ left: ROLLBACK_BAR_LEADING_PADDING, right: ROLLBACK_BAR_TRAILING_PADDING })
        .backgroundColor(SOFT)
        .borderRadius(ROLLBACK_BAR_RADIUS)
        .transition(TransitionEffect.translate({ x: 0, y: 8 })
          .combine(TransitionEffect.opacity(0))
          .animation({ duration: 180, curve: Curve.EaseOut }))
      }
      .width('100%')
      .constraintSize({
        maxWidth: this.presentation === ComposerPresentation.Floating ? ROLLBACK_BAR_MAX_WIDTH : 10000
      })
      .alignSelf(ItemAlign.Center)
      // The composer below already keeps its own distance from the edge, so the bar
      // only carries the gap above itself.
      .padding({
        left: this.insetForPresentation(),
        right: this.insetForPresentation(),
        top: 8
      })
    }
  }

  @Builder
  private ConfirmButton() {
    Stack({ alignContent: Alignment.Center }) {
      SymbolGlyph($r('sys.symbol.arrow_counterclockwise'))
        .fontSize(ROLLBACK_GLYPH_SIZE)
        .fontColor([INK])
    }
    .width(ROLLBACK_ICON_BUTTON_SIZE)
    .height(ROLLBACK_ICON_BUTTON_SIZE)
    .accessibilityText(RemoteI18n.t(RollbackPresentationPolicy.ROLLBACK_ITEM_KEY))
    .onClick(() => {
      this.onConfirm();
    })
  }

  @Builder
  private CloseButton() {
    Stack({ alignContent: Alignment.Center }) {
      SymbolGlyph($r('sys.symbol.xmark'))
        .fontSize(ROLLBACK_GLYPH_SIZE)
        .fontColor([MUTED])
    }
    .width(ROLLBACK_ICON_BUTTON_SIZE)
    .height(ROLLBACK_ICON_BUTTON_SIZE)
    .accessibilityText(RemoteI18n.t('common.close'))
    .onClick(() => {
      this.onClose();
    })
  }

  private insetForPresentation(): number {
    return this.presentation === ComposerPresentation.Floating ?
      24 : MobileDesignGeometry.conversationOverlaySideInset;
  }
}
