import { SymbolGlyphModifier } from '@kit.ArkUI';

/**
 * A system symbol, carried the way a platform *icon slot* wants it.
 *
 * A component the app draws itself takes a symbol as markup — `SymbolGlyph` in the
 * component tree. A platform component takes one as a value: HDS's
 * `HdsNavigationIconOptions.icon` is an `IconType`, and the member of that union
 * that carries a symbol is a `SymbolGlyphModifier`. ArkUI declares that name in its
 * global scope as a type alias only (`declare type SymbolGlyphModifier = import(...)`),
 * so a value of it can only come from the ArkUI kit itself — which is why the one
 * import lives here.
 *
 * This leaf is where the two vocabularies meet: a caller names the symbol it wants
 * (`$r('sys.symbol.…')`) and the band's support class names no API family beyond the
 * design kit it already reads.
 *
 * The *size* is here because the caller owns it as much as the ink. Left alone the
 * platform draws the symbol at its own icon size inside its own chip, and on this
 * device that reads smaller than the system's own title bar does: measured on the
 * phone, the four dots filled about a quarter of the chip the platform drew
 * (`0.24 x 0.23` at 1320px) while the system Settings WLAN band's own four-dot
 * trigger — the reference the app is held to — fills about `0.38 x 0.36` of the
 * same-sized chip. `menuStyle` states a colour and no size at all, and HDS documents
 * the modifier's `fontSize` as not applying to its *toolbar*'s icon items — but on
 * the title bar's own icon slot it lands: stated as 24vp, the dots measure 51x49px
 * in the same 134px chip, `0.38 x 0.36`, the reference ratio, with the chip
 * unmoved. So `fontSize` is the one channel left for this slot, and this leaf sets
 * it. The size is never a second number here — the caller passes the one named
 * value both postures draw (`ConversationHeaderPolicy.TRIGGER_GLYPH_SIZE`).
 *
 * A box is still not stated. A `SymbolGlyph` forced to `.width()`/`.height()` draws
 * its ink left-anchored inside the forced box rather than scaling, and the platform
 * slot is 24vp square; `fontSize` is the axis that scales the ink and leaves the
 * slot's own geometry alone.
 *
 * The ink is here because the slot does not answer for it. A `SymbolGlyphModifier`
 * that states no colour is drawn in ArkUI's own default ink, which does not follow
 * the appearance; HDS's `menuStyle.iconColor` does not reach a caller-supplied
 * modifier either (measured on the phone: stated there, the four dots stayed
 * near-black on a lighter chip in the dark appearance). `fontColor` on the modifier
 * is the same knob the app's own `SymbolGlyph` carries in its wide header, and it is
 * the one that lands in the platform's slot.
 */
export class SystemSymbolIcon {
  /**
   * The modifier a platform icon slot takes, for the symbol `src` names, the ink
   * `ink` states and the `size` it draws at.
   */
  static modifier(src: Resource, ink: ResourceColor, size: number): SymbolGlyphModifier {
    return new SymbolGlyphModifier(src).fontColor([ink]).fontSize(size);
  }
}
