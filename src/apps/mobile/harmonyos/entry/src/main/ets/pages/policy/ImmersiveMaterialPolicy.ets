/**
 * Which immersive material a floating surface asks for, and what it paints when
 * the device cannot render one.
 *
 * `ImmersiveMaterial` (API 26) is the platform's glass material: a component that
 * adopts it stops painting its own background, blur, shadow and border, and the
 * material layer supplies them. Every surface therefore has two answers to give
 * rather than one — the request and the degradation — because the app's
 * `compatibleSdkVersion` is 6.0.1 (21): a device below 26 keeps a painted
 * surface, and that path is a shipped form, not an error.
 *
 * The table below is the one place a scene's thickness is decided. It mirrors the
 * shared material recipe contract, so a token change has to move this table with
 * it, and `tools/tests/immersive-material-policy.test.cjs` checks the colour
 * names it reads against `Theme.ets` and the module's colour resources.
 *
 * Two restrictions keep this file pure policy:
 *
 * - no `@kit` or ArkUI import, so the whole decision is host-testable and no
 *   component reaches a platform kit through a policy;
 * - `level`, `fallbackBlur`, `floorColor` and `hairlineColor` are the policy's
 *   own names, not `uiMaterial` enum members or `ResourceColor` values, so this
 *   file never has to name a platform type.
 *
 * Who reads each field today:
 *
 * - `level` is mapped to `uiMaterial.ImmersiveStyle` by
 *   `ImmersiveMaterialService`, which also answers whether the device will render
 *   a material at all;
 * - `floorColor` and `hairlineColor` are consumed from this batch on by the
 *   surface resolver in `ImmersiveSurfaceSupport`, which turns the two names into
 *   the `$r('app.color.*')` tokens a component paints with;
 * - `fallbackBlur` is the blur a self-drawn surface keeps where no material is
 *   drawn, mapped to a `BlurStyle` by `ImmersiveSurfaceSupport.surfaceBlur`. Its
 *   first consumer is the wide top band, which draws its own glass on every device
 *   below the material's API level.
 */

/** One floating surface that can carry the immersive material. */
export enum ImmersiveSurfaceScene {
  /** Top chrome over scrolling content: the chat header band. */
  TOP_CHROME = 'top_chrome',
  /** Bottom chrome: the composer and other controls docked at the bottom edge. */
  BOTTOM_CHROME = 'bottom_chrome',
  /** The sidebar's search field — an officially named immersive material scene. */
  SEARCH_FIELD = 'search_field',
  /** An anchored menu or popover opened anywhere on the page. */
  FLOATING_MENU = 'floating_menu',
  /** A half-modal sheet or a large dialog. */
  MODAL_SHEET = 'modal_sheet',
  /** A toast. */
  TOAST = 'toast'
}

/**
 * One surface's material recipe.
 *
 * `level` is the immersive style (`ultra_thin` … `ultra_thick`); `fallbackBlur` is
 * the blur retained for a surface that draws its own glass (`thin`, `thick`, or
 * `none` for a solid floor), which is a later stage than these surfaces;
 * `floorColor` and `hairlineColor` name the `Theme.ets` semantic colours the
 * surface paints while no material is drawn.
 */
export interface ImmersiveSurfaceRecipe {
  level: string;
  fallbackBlur: string;
  floorColor: string;
  hairlineColor: string;
}

/**
 * The recipe table.
 *
 * Static fields rather than a map: the scene set is closed and small, and ArkTS
 * reads a static field where an object-literal map would need a declared key type.
 * The thickness order follows the platform's own usage guidance — the thinnest
 * material at a top edge, thicker as a surface floats further from the content it
 * covers — so a menu sitting over the transcript is always more opaque than a band
 * the content scrolls underneath.
 */
export class ImmersiveSurfaceRecipes {
  static readonly TOP_CHROME: ImmersiveSurfaceRecipe = {
    level: 'ultra_thin',
    fallbackBlur: 'thin',
    floorColor: 'page_bg_overlay',
    hairlineColor: 'line'
  };
  static readonly BOTTOM_CHROME: ImmersiveSurfaceRecipe = {
    level: 'thin',
    fallbackBlur: 'thin',
    floorColor: 'card_overlay',
    hairlineColor: 'line'
  };
  static readonly SEARCH_FIELD: ImmersiveSurfaceRecipe = {
    level: 'thin',
    fallbackBlur: 'thin',
    floorColor: 'card_overlay',
    hairlineColor: 'line'
  };
  static readonly FLOATING_MENU: ImmersiveSurfaceRecipe = {
    level: 'thick',
    fallbackBlur: 'thick',
    floorColor: 'card',
    hairlineColor: 'line'
  };
  static readonly MODAL_SHEET: ImmersiveSurfaceRecipe = {
    level: 'ultra_thick',
    fallbackBlur: 'none',
    floorColor: 'page_bg',
    hairlineColor: 'line'
  };
  static readonly TOAST: ImmersiveSurfaceRecipe = {
    level: 'thin',
    fallbackBlur: 'none',
    floorColor: 'toast_background',
    hairlineColor: 'line'
  };

  /**
   * The recipe one scene asks for.
   *
   * An unmapped scene is treated as a modal surface: the thickest material with a
   * solid floor, which is the only degradation that can turn out more legible than
   * the surface it replaces. Guessing at a thin material for an unknown surface
   * would take away the paint that currently keeps it readable.
   */
  static recipeFor(scene: ImmersiveSurfaceScene): ImmersiveSurfaceRecipe {
    switch (scene) {
      case ImmersiveSurfaceScene.TOP_CHROME:
        return ImmersiveSurfaceRecipes.TOP_CHROME;
      case ImmersiveSurfaceScene.BOTTOM_CHROME:
        return ImmersiveSurfaceRecipes.BOTTOM_CHROME;
      case ImmersiveSurfaceScene.SEARCH_FIELD:
        return ImmersiveSurfaceRecipes.SEARCH_FIELD;
      case ImmersiveSurfaceScene.FLOATING_MENU:
        return ImmersiveSurfaceRecipes.FLOATING_MENU;
      case ImmersiveSurfaceScene.TOAST:
        return ImmersiveSurfaceRecipes.TOAST;
      default:
        return ImmersiveSurfaceRecipes.MODAL_SHEET;
    }
  }
}

/**
 * The device facts one decision is resolved from.
 *
 * Filled by `ImmersiveMaterialService.snapshot()`, and declared there as well:
 * a service must not import a page module, and this file must not import a
 * platform kit. The two declarations are one contract, and
 * `tools/tests/immersive-material-policy.test.cjs` fails when they drift.
 */
export interface ImmersiveMaterialSnapshot {
  /** The device's reported API level; `0` when the platform read failed. */
  apiLevel: number;
  /** `default`, `enable` or `disable`, from the app-level material metadata. */
  materialState: string;
  /** Whether the user asked for reduced motion. */
  reduceMotion: boolean;
}

/**
 * One surface's resolved plan.
 *
 * The material fields (`level`, `colorInvert`, `interactive`, `lightEffect`) are
 * what `ImmersiveMaterialService` builds the platform object from, and only that
 * service's answer decides whether a material is really drawn; the recipe fields
 * name the surface painted without one, `floorColor` and `hairlineColor` through
 * `ImmersiveSurfaceSupport` and `fallbackBlur` through `surfaceBlur`. Both halves are
 * always filled, so the degradation path never depends on a decision being taken.
 */
export interface ImmersiveMaterialDecision {
  /** Whether the platform material is requested for this surface. */
  apply: boolean;
  /** The recipe level, already mapped from the scene. */
  level: string;
  /** Whether the material may adapt to the complementary colour of what is behind it. */
  colorInvert: boolean;
  /** Whether the material may deform under a press. */
  interactive: boolean;
  /** Whether the material may answer with its light feedback. */
  lightEffect: boolean;
  /** The blur retained for a surface that draws its own glass, mapped by `surfaceBlur`. */
  fallbackBlur: string;
  /** The fallback surface's floor colour, as a `Theme.ets` resource name. */
  floorColor: string;
  /** The fallback surface's hairline colour, as a `Theme.ets` resource name. */
  hairlineColor: string;
}

/** The gates this decision is resolved against, named where a caller can read them. */
export class ImmersiveMaterialPolicy {
  /** First API level that ships `uiMaterial.ImmersiveMaterial`. */
  static readonly IMMERSIVE_MATERIAL_API_LEVEL: number = 26;
  /** The one material state that forbids every material, per `MaterialState.DISABLE`. */
  static readonly MATERIAL_STATE_DISABLE: string = 'disable';

  /**
   * Whether a style can adapt its content to the complementary colour of what is
   * behind it.
   *
   * The platform defines this for materials that are thin enough, which is the two
   * thinnest styles alone: a thicker surface is asked for a legible floor, not for
   * the automatic inversion that only a nearly transparent one can carry.
   */
  static invertsWithContent(level: string): boolean {
    return level === 'thin' || level === 'ultra_thin';
  }
}

/**
 * Resolves one scene against the device it is being drawn on.
 *
 * Pure: the device is given, never read, so the whole boundary is host-testable and
 * the platform read stays behind a service (see the mobile architecture rules for
 * components).
 */
export function resolveImmersiveMaterial(
  scene: ImmersiveSurfaceScene,
  snapshot: ImmersiveMaterialSnapshot
): ImmersiveMaterialDecision {
  const recipe = ImmersiveSurfaceRecipes.recipeFor(scene);
  // Anything that is not a finite number is not evidence of API 26, and a device
  // whose level cannot be measured keeps its painted surface instead of risking a
  // call the platform would reject. A state the app has switched off is the other
  // way a material can be forbidden outright, for every surface at once.
  const applies = Number.isFinite(snapshot.apiLevel) &&
    snapshot.apiLevel >= ImmersiveMaterialPolicy.IMMERSIVE_MATERIAL_API_LEVEL &&
    snapshot.materialState !== ImmersiveMaterialPolicy.MATERIAL_STATE_DISABLE;
  // Deformation and light feedback are motion, so the user's reduced-motion
  // preference turns both off while the material itself stays.
  const animated = applies && !snapshot.reduceMotion;
  return {
    apply: applies,
    level: recipe.level,
    colorInvert: applies && ImmersiveMaterialPolicy.invertsWithContent(recipe.level),
    interactive: animated,
    lightEffect: animated,
    // The fallback is always answered, whatever the gate decided: the caller's
    // degradation path must not have to ask a second question.
    fallbackBlur: recipe.fallbackBlur,
    floorColor: recipe.floorColor,
    hairlineColor: recipe.hairlineColor
  };
}
