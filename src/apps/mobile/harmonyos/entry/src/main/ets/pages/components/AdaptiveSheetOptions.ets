import {
  SettingsPlacement,
  SettingsPlacementMode
} from '../policy/SettingsPlacementPolicy';

/**
 * The SheetOptions every overlay sheet binds with.
 *
 * A sheet's chrome belongs to the platform: the title bar and its close icon,
 * the background the content sits on, the scrim over the page. This class
 * therefore owns geometry — the placement's height and width, the preferred
 * sheet type, the keyboard avoidance — plus the text of the platform's title
 * bar, and it deliberately sets no `backgroundColor`, no `maskColor`, no
 * `showClose` and no `dragBar`: the platform's own answers are what make a
 * surface read as a sheet. Every override here was one sheet that stopped
 * looking like one, and the painted background was the worst of them — a
 * transparent sheet whose content had to paint the fill meant the adopted
 * material could never show through it.
 *
 * Policy stays ArkUI-free; this is the only place preferType is chosen.
 */
export class AdaptiveSheetOptions {
  /**
   * The options one placement resolves to, with the platform title bar's text.
   *
   * `title` and `subtitle` are that bar's two lines. The sheets used to draw the
   * bar themselves, so what their own header said has to arrive here rather than
   * be dropped: the title is the heading, the subtitle is the second line a
   * header carried (the session a detail panel is about, the device a picker is
   * choosing a workspace on). Every host names its sheet for that reason, and
   * the close icon is on the same bar: the platform draws its own whether or not
   * a title was supplied — the nested file action form showed its close icon
   * over its own action row while it passed no title — so a titleless sheet is a
   * sheet whose close icon floats over content rather than one without a close.
   */
  static fromPlacement(
    placement: SettingsPlacement,
    title?: ResourceStr,
    subtitle?: ResourceStr
  ): SheetOptions {
    const options: SheetOptions = { keyboardAvoidMode: SheetKeyboardAvoidMode.RESIZE_ONLY };
    if (placement.mode === SettingsPlacementMode.FoldOperate) {
      options.height = placement.height;
      return AdaptiveSheetOptions.withTitle(options, title, subtitle);
    }
    if (placement.mode === SettingsPlacementMode.Side) {
      options.height = placement.height;
      options.width = placement.width;
      options.preferType = SheetType.SIDE;
      return AdaptiveSheetOptions.withTitle(options, title, subtitle);
    }
    if (placement.mode === SettingsPlacementMode.Center) {
      options.height = placement.height;
      options.width = placement.width;
      options.preferType = SheetType.CENTER;
      return AdaptiveSheetOptions.withTitle(options, title, subtitle);
    }
    options.height = placement.height > 0 ? placement.height : SheetSize.LARGE;
    return AdaptiveSheetOptions.withTitle(options, title, subtitle);
  }

  /**
   * The same chrome for the nested form, in the placement its host resolved.
   *
   * The file action form is three rows, so its height is its content's wherever
   * it lands — the platform fits the sheet to the form in the middle of a wide
   * window exactly as it does at the bottom edge of a phone's. What the placement
   * decides is only where that is: a wide host is a centered dialog, and every
   * other posture keeps the form at the bottom edge. The keyboard is translated
   * as well as resized in both, because the field it is open for is the form's
   * last row. Its title is the action's own name, so the platform title bar says
   * what the form is about; the row that used to say it beside a Cancel and a
   * Submit button is gone, and the form's one action is the row every other
   * sheet's confirm already uses.
   */
  static form(
    placement: SettingsPlacement,
    title?: ResourceStr,
    subtitle?: ResourceStr
  ): SheetOptions {
    const options: SheetOptions = {
      height: SheetSize.FIT_CONTENT,
      keyboardAvoidMode: SheetKeyboardAvoidMode.TRANSLATE_AND_RESIZE
    };
    if (placement.mode === SettingsPlacementMode.Center) {
      options.width = placement.width;
      options.preferType = SheetType.CENTER;
    }
    return AdaptiveSheetOptions.withTitle(options, title, subtitle);
  }

  /**
   * The platform title bar's own options.
   *
   * `showClose` is left at the platform default, which is the close icon beside
   * the title: the icon is the platform's answer to "how does this sheet close",
   * so nothing here draws a second one.
   */
  private static withTitle(
    options: SheetOptions,
    title?: ResourceStr,
    subtitle?: ResourceStr
  ): SheetOptions {
    if (title === undefined) {
      return options;
    }
    const sheetTitle: SheetTitleOptions =
      subtitle === undefined ? { title: title } : { title: title, subtitle: subtitle };
    options.title = sheetTitle;
    return options;
  }
}
