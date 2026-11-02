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
 * Nothing is sized here. HDS owns the geometry of its own icon slot — the modifier's
 * `fontSize` is documented as not applicable, and a chip that was given an icon size
 * by the app would be a chip the app is fighting — so a caller hands over the symbol
 * and nothing else.
 */
export class SystemSymbolIcon {
  /** The modifier a platform icon slot takes, for the symbol `src` names. */
  static modifier(src: Resource): SymbolGlyphModifier {
    return new SymbolGlyphModifier(src);
  }
}
