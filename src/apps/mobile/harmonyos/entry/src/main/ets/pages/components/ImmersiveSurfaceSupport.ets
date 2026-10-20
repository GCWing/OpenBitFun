/**
 * The wiring between a floating surface and the platform's immersive material.
 *
 * A surface that adopts `ImmersiveMaterial` (API 26) stops painting its own
 * background, blur, border and shadow — the material layer supplies them — and
 * a device below 26 keeps the painted surface it ships today. Every call site
 * therefore needs two answers, and this file is the one place that asks the
 * question: one scene, one resolved material, one merge into whatever option
 * object the surface binds with.
 *
 * Four rules keep it honest:
 *
 * - the device facts that cannot change while the app runs — the API level and
 *   the app-level material state — are read once per process
 *   (`ImmersiveMaterialService.snapshot()`), and the resolved material is cached
 *   per scene so a surface opened many times builds one material rather than one
 *   per rebuild;
 * - reduced motion is *not* one of those facts: the user can turn it on while the
 *   app runs, so it is read on every access (like the app's other motion
 *   consumers) and is part of the cache key, so a scene builds one material per
 *   answer rather than freezing the setting the process started with;
 * - the fallback colours are resolved from the scene's recipe, so a change to the
 *   shared material contract moves what the phone paints instead of leaving a
 *   colour literal behind on the one platform nobody re-reads;
 * - on the material path the merge returns the caller's option object with the
 *   material injected and the conflicting fill transparent; on the fallback path
 *   it returns the caller's option object with only the geometry the caller owns
 *   left as it was. The two surfaces that decorate a *component* rather than an
 *   option object — the blur and the hairline — resolve the same way, as values
 *   the caller's single node binds with.
 *
 * This is also the one place the two declarations of the material contract meet.
 * The policy must not import a service and the service must not import a page, so
 * the device facts and the plan are declared on both sides; ArkTS forbids
 * structural assignment between two such declarations, and the two boundaries
 * below therefore name the fields they carry across instead of passing the
 * service's object straight into the policy.
 *
 * The merge methods are pure given the resolved material, which is what makes
 * the degradation path — the shipped one on every device below API 26 — testable
 * on the host. See `tools/tests/immersive-surface-support.test.cjs`.
 */

import { promptAction } from '@kit.ArkUI';
import {
  ImmersiveMaterialDecision,
  ImmersiveMaterialSnapshot,
  ImmersiveSurfaceRecipe,
  ImmersiveSurfaceRecipes,
  ImmersiveSurfaceScene,
  resolveImmersiveMaterial
} from '../policy/ImmersiveMaterialPolicy';
import { ImmersiveMaterialPlan, ImmersiveMaterialService } from '../../services/ImmersiveMaterialService';
import { MotionPreference } from '../../services/MotionPreference';
import {
  CARD,
  CARD_OVERLAY,
  LINE,
  PAGE_BG,
  PAGE_BG_OVERLAY,
  TOAST_BACKGROUND,
  TRANSPARENT
} from './Theme';

/**
 * The device facts an app cannot change while it runs.
 *
 * Reduced motion is deliberately not here: it is a user setting the app is told
 * about while it is in use, so it stays a per-access read (see `materialFor`).
 */
interface ImmersiveDeviceFacts {
  apiLevel: number;
  materialState: string;
}

export class ImmersiveSurfaceSupport {
  /**
   * Every `floorColor` key the recipe contract declares.
   *
   * Declared rather than derived, because it is the vocabulary side of the
   * contract: `tools/tests/immersive-material-contract-sync.test.cjs` fails when
   * this set and the contract's colour names stop being the same, so a key the
   * contract adds cannot quietly resolve to the modal floor and a key it drops
   * cannot stay here.
   */
  static readonly FLOOR_COLOR_KEYS: string[] =
    ['page_bg_overlay', 'card_overlay', 'card', 'page_bg', 'toast_background'];
  /** Every `hairlineColor` key the recipe contract declares. */
  static readonly HAIRLINE_COLOR_KEYS: string[] = ['line'];

  /** The device facts, read once per process and shared by every scene. */
  private static device: ImmersiveDeviceFacts | undefined = undefined;
  /**
   * The material each scene resolved to, keyed by the scene and by the
   * reduced-motion answer it was resolved with.
   *
   * `null` records a scene that resolved to no material, so a later call can tell
   * "already answered, no material" from "not asked yet" without asking the
   * platform again. The motion answer is part of the key rather than read later,
   * which is what bounds this map: one entry per scene per answer, so two per
   * scene however often the user toggles the setting.
   */
  private static readonly materials: Map<string, SystemUiMaterial | null> =
    new Map<string, SystemUiMaterial | null>();

  /**
   * The material one scene resolves to, or `undefined` when the surface keeps
   * the surface it paints itself.
   *
   * `undefined` is the whole degradation contract and never means "ask again":
   * a device below API 26, an unmeasurable level, an app-level disable and a
   * construction the platform refuses all end here.
   */
  static materialFor(scene: ImmersiveSurfaceScene): SystemUiMaterial | undefined {
    const reduceMotion: boolean = ImmersiveSurfaceSupport.reduceMotionNow();
    const key: string = `${ImmersiveSurfaceSupport.sceneKey(scene)}|${reduceMotion}`;
    const cached: SystemUiMaterial | null | undefined = ImmersiveSurfaceSupport.materials.get(key);
    if (cached !== undefined) {
      return cached === null ? undefined : cached;
    }
    const decision: ImmersiveMaterialDecision =
      resolveImmersiveMaterial(scene, ImmersiveSurfaceSupport.snapshot(reduceMotion));
    // `ImmersiveMaterialPlan` is the material-facing projection of the decision:
    // the five fields the platform object is built from. The two live in different
    // modules on purpose (a service must not import a page), and ArkTS forbids
    // structural assignment between the pair, so the boundary names the five
    // fields instead of passing the decision through.
    const plan: ImmersiveMaterialPlan = {
      apply: decision.apply,
      level: decision.level,
      colorInvert: decision.colorInvert,
      interactive: decision.interactive,
      lightEffect: decision.lightEffect
    };
    const material: SystemUiMaterial | undefined = ImmersiveMaterialService.materialFor(plan);
    ImmersiveSurfaceSupport.materials.set(key, material === undefined ? null : material);
    return material;
  }

  /** Whether a scene paints the platform material rather than its own fallback. */
  static usesMaterial(scene: ImmersiveSurfaceScene): boolean {
    return ImmersiveSurfaceSupport.materialFor(scene) !== undefined;
  }

  /**
   * A sheet's options with the immersive material merged in.
   *
   * The material owns the sheet's background, border and shadow, so the fill is
   * made transparent on the material path; the fallback path returns the caller's
   * options unchanged, whatever fill they carried.
   */
  static sheetOptions(scene: ImmersiveSurfaceScene, options: SheetOptions): SheetOptions {
    const material: SystemUiMaterial | undefined = ImmersiveSurfaceSupport.materialFor(scene);
    if (material === undefined) {
      return options;
    }
    options.backgroundColor = TRANSPARENT;
    options.systemMaterial = material;
    return options;
  }

  /**
   * A popup's options with the immersive material merged in.
   *
   * The material is the popup bubble's own background, so a transparent
   * `popupColor` is what lets it show through instead of being covered.
   */
  static popupOptions(scene: ImmersiveSurfaceScene, options: CustomPopupOptions): CustomPopupOptions {
    const material: SystemUiMaterial | undefined = ImmersiveSurfaceSupport.materialFor(scene);
    if (material === undefined) {
      return options;
    }
    options.popupColor = TRANSPARENT;
    options.systemMaterial = material;
    return options;
  }

  /**
   * A menu's options with the immersive material merged in.
   *
   * A menu call site may have no options at all today; the fallback path keeps
   * that (`undefined` stays `undefined`), and the material path is the only one
   * that has to create the object.
   */
  static menuOptions(scene: ImmersiveSurfaceScene, options?: MenuOptions): MenuOptions | undefined {
    const material: SystemUiMaterial | undefined = ImmersiveSurfaceSupport.materialFor(scene);
    if (material === undefined) {
      return options;
    }
    if (options === undefined) {
      const created: MenuOptions = {};
      created.backgroundColor = TRANSPARENT;
      created.systemMaterial = material;
      return created;
    }
    options.backgroundColor = TRANSPARENT;
    options.systemMaterial = material;
    return options;
  }

  /** A toast's options with the immersive material merged in. */
  static toastOptions(scene: ImmersiveSurfaceScene, options: promptAction.ShowToastOptions): promptAction.ShowToastOptions {
    const material: SystemUiMaterial | undefined = ImmersiveSurfaceSupport.materialFor(scene);
    if (material === undefined) {
      return options;
    }
    options.systemMaterial = material;
    return options;
  }

  /**
   * The fill a content root paints.
   *
   * A sheet's own fill is only half of the background: the builder content sits
   * on top of it and paints the other half, so a root that keeps an opaque
   * colour on the material path covers the material the sheet just adopted.
   *
   * The colour is the scene's recipe floor, not a literal at the call site, so a
   * contract change moves what the surface paints. `override` is the escape hatch
   * for a site whose degradation is deliberately not that floor; it applies to the
   * fallback path only, because the material path is transparent either way.
   * Geometry (radius, size) stays the caller's.
   */
  static surfaceFill(scene: ImmersiveSurfaceScene, override?: ResourceColor): ResourceColor {
    if (ImmersiveSurfaceSupport.usesMaterial(scene)) {
      return TRANSPARENT;
    }
    if (override !== undefined) {
      return override;
    }
    const recipe: ImmersiveSurfaceRecipe = ImmersiveSurfaceRecipes.recipeFor(scene);
    return ImmersiveSurfaceSupport.floorColor(recipe.floorColor);
  }

  /**
   * A content root's hairline: the recipe's edge, or no edge on the material path.
   *
   * The recipe owns the colour because a hairline is a contract colour; the caller
   * owns the width, which is geometry. A border drawn over the material is a second
   * edge the material did not ask for, so the material path drops it instead.
   */
  static surfaceBorder(scene: ImmersiveSurfaceScene, options: BorderOptions): BorderOptions {
    const recipe: ImmersiveSurfaceRecipe = ImmersiveSurfaceRecipes.recipeFor(scene);
    if (ImmersiveSurfaceSupport.usesMaterial(scene)) {
      options.width = 0;
      options.color = TRANSPARENT;
      return options;
    }
    options.color = ImmersiveSurfaceSupport.hairlineColor(recipe.hairlineColor);
    return options;
  }

  /**
   * A content root's shadow, with the shadow removed on the material path.
   *
   * A material carries its own shadow and takes precedence over the general one
   * on the component that adopts it, but the content root is a child of that
   * component: its shadow would still draw over the material, so the material
   * path drops it rather than stacking the two. The recipe table has no shadow
   * field, so the fallback keeps the caller's own shadow untouched.
   */
  static surfaceShadow(scene: ImmersiveSurfaceScene, options: ShadowOptions): ShadowOptions {
    if (!ImmersiveSurfaceSupport.usesMaterial(scene)) {
      return options;
    }
    options.radius = 0;
    options.color = TRANSPARENT;
    return options;
  }

  /**
   * The blur a surface paints where it draws its own glass.
   *
   * The two paths cannot both blur. Where the material is drawn the answer is no
   * blur at all: the material is the blurring, and a component blur under it is
   * the second glass the platform's material guidance rules out. Where it is not
   * drawn, the answer is the recipe's `fallbackBlur` — the field the contract
   * states for exactly this surface, and which had no consumer until the wide top
   * band became the first self-drawn band to ask for one.
   *
   * A recipe value with no material spelling resolves to no blur rather than to an
   * invented thickness: the surface then paints its floor alone, which is legible,
   * while a guessed blur would be a look no recipe asked for.
   */
  static surfaceBlur(scene: ImmersiveSurfaceScene): BlurStyle {
    if (ImmersiveSurfaceSupport.usesMaterial(scene)) {
      return BlurStyle.NONE;
    }
    const recipe: ImmersiveSurfaceRecipe = ImmersiveSurfaceRecipes.recipeFor(scene);
    switch (recipe.fallbackBlur) {
      case 'thin':
        return BlurStyle.Thin;
      case 'thick':
        return BlurStyle.Thick;
      default:
        return BlurStyle.NONE;
    }
  }

  /**
   * The bottom hairline a self-drawn band wears.
   *
   * `surfaceBorder` answers the other posture: a content root inside a component that
   * already carries a surface, where any edge the root draws is a second edge the
   * surface did not ask for. A self-drawn band *is* that component rather than a root
   * inside one, and its own edge is part of what it is designed as — the wide top
   * band's half-pixel line along the bottom of the band's box, the capsule's edge
   * where its design has one.
   *
   * The line is drawn on every device, because the component scenes take no material
   * at all (see `ImmersiveMaterialPolicy.takesPlatformMaterial`): there is no posture
   * left in which the platform would supply the edge instead, so an answer of "no
   * edge" would silently drop an edge the design asks for.
   *
   * The width is geometry and stays the caller's; the colour is a contract colour
   * and comes from the recipe.
   */
  static surfaceHairline(scene: ImmersiveSurfaceScene, width: number): BorderOptions {
    const recipe: ImmersiveSurfaceRecipe = ImmersiveSurfaceRecipes.recipeFor(scene);
    const edge: BorderOptions = {
      width: { bottom: width },
      color: ImmersiveSurfaceSupport.hairlineColor(recipe.hairlineColor)
    };
    return edge;
  }

  /**
   * The `Theme.ets` colour a contract `floorColor` key names.
   *
   * The contract names colours, not values, so this is where a contract name turns
   * into something a component can paint. The key set is checked against the
   * contract by `tools/tests/immersive-material-contract-sync.test.cjs`; a key that
   * is not in the contract resolves to the modal floor, which is the most legible
   * of the five rather than an invisible surface.
   */
  static floorColor(key: string): ResourceColor {
    switch (key) {
      case 'page_bg_overlay':
        return PAGE_BG_OVERLAY;
      case 'card_overlay':
        return CARD_OVERLAY;
      case 'card':
        return CARD;
      case 'page_bg':
        return PAGE_BG;
      case 'toast_background':
        return TOAST_BACKGROUND;
      default:
        return PAGE_BG;
    }
  }

  /**
   * The `Theme.ets` colour a contract `hairlineColor` key names.
   *
   * `line` is the only hairline the contract declares, so a key the contract adds
   * needs a case here; the contract-sync test fails until the two sets match.
   */
  static hairlineColor(key: string): ResourceColor {
    switch (key) {
      case 'line':
        return LINE;
      default:
        return LINE;
    }
  }

  /**
   * Whether the user asked for reduced motion, read now.
   *
   * Read on every access rather than cached with the device facts: it is a
   * preference the user can change while the app runs, and the five other motion
   * consumers in the app read it the same way.
   */
  private static reduceMotionNow(): boolean {
    return MotionPreference.reduceMotion();
  }

  /**
   * The device facts, read once per process.
   *
   * The service declares the device facts and the policy declares the decision
   * input: one contract, two declarations, and no structural assignment between
   * them under ArkTS. The boundary states the fields rather than passing the
   * service's object straight into the policy.
   */
  private static deviceFacts(): ImmersiveDeviceFacts {
    const cached: ImmersiveDeviceFacts | undefined = ImmersiveSurfaceSupport.device;
    if (cached !== undefined) {
      return cached;
    }
    const device = ImmersiveMaterialService.snapshot();
    const facts: ImmersiveDeviceFacts = {
      apiLevel: device.apiLevel,
      materialState: device.materialState
    };
    ImmersiveSurfaceSupport.device = facts;
    return facts;
  }

  /** The policy's decision input: the cached facts plus the motion read taken now. */
  private static snapshot(reduceMotion: boolean): ImmersiveMaterialSnapshot {
    const device: ImmersiveDeviceFacts = ImmersiveSurfaceSupport.deviceFacts();
    return {
      apiLevel: device.apiLevel,
      materialState: device.materialState,
      reduceMotion: reduceMotion
    };
  }

  /**
   * The cache key for a scene.
   *
   * The scene is a closed string enum, so its value is the identity the cache
   * needs; an unmapped value resolves like `MODAL_SHEET` and is cached under its
   * own key without leaking into the mapped ones.
   */
  private static sceneKey(scene: ImmersiveSurfaceScene): string {
    return `${scene}`;
  }
}
