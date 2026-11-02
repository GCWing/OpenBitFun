/**
 * Which HDS title bar the top chrome asks for, and what it says on the devices
 * that cannot render one.
 *
 * The platform's title bar (`HdsNavigation` / `HdsNavDestination` `titleBar`) is
 * the chrome the compact conversation route hands its header to: the band that
 * used to be drawn in the page now belongs to the platform, which is also what
 * makes the platform's own translucent bar and the immersive material available at
 * all. The members that describe that behaviour do not all arrive at once:
 *
 * - `titleBar`, `TitleBarStyleOptions.originalStyle` and
 *   `ScrollEffectType.GRADIENT_BLUR` start at 5.1.0(18) / 6.0.0(20), so the app's
 *   `compatibleSdkVersion` 6.0.1(21) can name them on every supported device;
 * - `ScrollEffectType.IMMERSIVE_GRADIENT_BLUR` and `systemMaterialEffect`
 *   (`hdsMaterial`) start at 6.1.0(23), so below that level neither may be
 *   evaluated at all — a member that does not exist is not a value the platform
 *   can ignore;
 * - the immersive material itself (`MaterialType.IMMERSIVE`) is what a device
 *   says it can draw, which is a second, older-and-independent answer.
 *
 * The tiers this file decides, in one place so a device-level change moves one
 * table rather than three call sites:
 *
 * | API level              | blur                      | material effect                |
 * |------------------------|---------------------------|--------------------------------|
 * | 21 – 22 (and unknown)  | `GRADIENT_BLUR`           | not attached (23+ only)        |
 * | 23 – 25                | `IMMERSIVE_GRADIENT_BLUR` | `{ADAPTIVE, SMOOTH}`           |
 * | 26+ without IMMERSIVE  | `IMMERSIVE_GRADIENT_BLUR` | `{ADAPTIVE, SMOOTH}`           |
 * | 26+ with IMMERSIVE     | `IMMERSIVE_GRADIENT_BLUR` | `{ADAPTIVE, ADAPTIVE}`         |
 *
 * `SMOOTH` is the level the platform's own guidance asks for on a device that
 * does not report the IMMERSIVE material type: it costs less and is the one
 * degradation that cannot read as broken. `ADAPTIVE` is the recommended level
 * everywhere else — the system picks the cost from the device's own performance.
 *
 * What each tier actually looks like on a 21/22 device is *undetermined*: the
 * `systemMaterialEffect` field is a 23+ member, so it is not passed there at all,
 * and the tier is the platform's `originalStyle` floor on the `GRADIENT_BLUR` family
 * with no material — which, since `blurRadius` is a 23+ member too, may be that
 * floor with no blur over it. The floor is what has to hold either way: the
 * transcript sits under this band at every offset, so the band is never allowed to
 * be transparent, and a tier that only loses its blur still has a legible bar. This
 * file deliberately does not gamble the whole band on the blur.
 *
 * The three restrictions that keep this file pure policy, the same ones
 * `ImmersiveMaterialPolicy` keeps:
 *
 * - no `@kit` or ArkUI import, so the whole decision is host-testable;
 * - `scrollEffectType`, `materialType` and `materialLevel` are this file's own
 *   names rather than `ScrollEffectType` / `hdsMaterial` members, so it never has
 *   to name a platform type and never evaluates a 23+ member on an older device;
 * - `barHeight` is a number, not a `LengthMetrics`.
 */

/** One top-edge chrome band that can be handed to the platform title bar. */
export enum HdsTitleBarScene {
  /** The compact conversation route: a transcript scrolls under this band. */
  Conversation = 'conversation'
}

/**
 * The device facts one decision is resolved from.
 *
 * Filled by `HdsTitleBarMaterialService.snapshot()`, and declared there as well:
 * a service must not import a page module, and this file must not import a
 * platform kit. The two declarations are one contract, and the drift test in
 * `tools/tests/hds-titlebar-policy.test.cjs` fails when they stop agreeing.
 */
export interface HdsTitleBarInput {
  /** The device's reported API level; `0` when the platform read failed. */
  apiLevel: number;
  /** Whether the device reports the IMMERSIVE material type. */
  immersiveMaterialSupported: boolean;
}

/**
 * One band's resolved title bar plan.
 *
 * `immersiveBlur` and `materialAttached` are the gate itself: they are true only
 * on a device that can evaluate the 23+ members, and the component-side support
 * class names those members nowhere else. The two name fields are the request
 * the support class maps back to a platform enum. Geometry is deliberately not
 * here: the band's height is a property of the platform mode the app asks for,
 * not of the device, so it stays the constant below.
 */
export interface HdsTitleBarDecision {
  /** Whether the immersive (23+) blur type may be named. */
  immersiveBlur: boolean;
  /** Whether `systemMaterialEffect` (23+) may be attached. */
  materialAttached: boolean;
  /** `gradient_blur` or `immersive_gradient_blur`; mapped by the support class. */
  scrollEffectType: string;
  /** `adaptive`; mapped to `hdsMaterial.MaterialType.ADAPTIVE`. */
  materialType: string;
  /** `adaptive` or `smooth`; mapped to `hdsMaterial.MaterialLevel`. */
  materialLevel: string;
}

/** The gates and the tier table, named where a caller can read them. */
export class HdsTitleBarPolicy {
  /** First API level that ships `ScrollEffectType.IMMERSIVE_GRADIENT_BLUR` and `systemMaterialEffect`. */
  static readonly IMMERSIVE_BLUR_API_LEVEL: number = 23;
  /** First API level whose material level may follow the device's own answer. */
  static readonly IMMERSIVE_MATERIAL_API_LEVEL: number = 26;
  /**
   * The platform title bar's own height in `HdsNavDestinationTitleMode.MINI`,
   * which is the destination title bar's default mode. `titleBar` overlays the
   * content rather than insetting it — the platform's own sample pushes its page
   * down by exactly this much — so this is what the page below reserves while
   * the platform owns the top edge, and what keeps an interactive row out from
   * under the chrome.
   */
  static readonly TITLE_BAR_HEIGHT_MINI: number = 56;

  /** The two blur types this file can ask for, as its own names. */
  static readonly GRADIENT_BLUR: string = 'gradient_blur';
  static readonly IMMERSIVE_GRADIENT_BLUR: string = 'immersive_gradient_blur';
  /** The material names this file can ask for, as its own names. */
  static readonly MATERIAL_TYPE_ADAPTIVE: string = 'adaptive';
  static readonly MATERIAL_LEVEL_ADAPTIVE: string = 'adaptive';
  static readonly MATERIAL_LEVEL_SMOOTH: string = 'smooth';

  /**
   * Whether a level can be measured at all.
   *
   * Anything that is not a finite number is not evidence of a modern device: a
   * read that failed reports `0` and takes the oldest tier, which is the one that
   * names no 23+ member.
   */
  static measurable(apiLevel: number): number {
    return Number.isFinite(apiLevel) && apiLevel > 0 ? apiLevel : 0;
  }

  /**
   * The blur type one scene asks for on a device that can name the immersive one.
   *
   * The platform documents the two for different content: `IMMERSIVE_GRADIENT_BLUR`
   * for a page with content scrolling underneath it as an image would, and
   * `GRADIENT_BLUR` for a plain list. The conversation route is the first kind,
   * and it is also the only kind this app has a title bar for today, so the scene
   * is what selects the family rather than a second hard-coded type.
   */
  static blurFor(scene: HdsTitleBarScene, immersiveBlur: boolean): string {
    if (!immersiveBlur) {
      return HdsTitleBarPolicy.GRADIENT_BLUR;
    }
    return scene === HdsTitleBarScene.Conversation ? HdsTitleBarPolicy.IMMERSIVE_GRADIENT_BLUR :
      HdsTitleBarPolicy.GRADIENT_BLUR;
  }

  /**
   * The material level for the answered capability.
   *
   * A device that reports the IMMERSIVE material type gets the system's own
   * adaptive level; one that does not — including every device below 26, where
   * the question cannot even be asked — gets `SMOOTH`, which is the level the
   * platform recommends exactly there.
   */
  static materialLevelFor(apiLevel: number, immersiveMaterialSupported: boolean): string {
    const level = HdsTitleBarPolicy.measurable(apiLevel);
    return level >= HdsTitleBarPolicy.IMMERSIVE_MATERIAL_API_LEVEL && immersiveMaterialSupported ?
      HdsTitleBarPolicy.MATERIAL_LEVEL_ADAPTIVE : HdsTitleBarPolicy.MATERIAL_LEVEL_SMOOTH;
  }

  /** The height the content below the band reserves, in vp, for one scene. */
  static barHeight(scene: HdsTitleBarScene): number {
    return scene === HdsTitleBarScene.Conversation ? HdsTitleBarPolicy.TITLE_BAR_HEIGHT_MINI : 0;
  }

  /**
   * The top offset a page below the platform band reserves, in vp.
   *
   * The band avoids the system area (`avoidLayoutSafeArea`, set by the support
   * class), so it is laid out below the status bar strip and its own content — the
   * title, the back control, the menu — is clear of the clock and the indicators.
   * What the band yields is not free space for the page either: the pane below
   * still starts under the band, so it reserves the bar *and* the strip above it.
   *
   * Both numbers come from the one measurement the app has: `WindowInsetsBinding`
   * for the strip, this table for the bar. No second measurement is taken here and
   * none is taken at the call site. A strip that cannot be measured reserves nothing
   * extra — the bar's own height is still reserved, which is the half that must
   * never be dropped.
   */
  static reservedBandHeight(scene: HdsTitleBarScene, topStrip: number): number {
    return HdsTitleBarPolicy.barHeight(scene) + HdsTitleBarPolicy.measuredLength(topStrip);
  }

  /** A measured length, or `0` when the measurement is not one. */
  private static measuredLength(value: number): number {
    return Number.isFinite(value) && value > 0 ? value : 0;
  }
}

/**
 * Resolves one scene against the device it is drawn on.
 *
 * Pure: the device is given, never read, so the boundary is host-testable and the
 * platform reads stay behind `HdsTitleBarMaterialService`.
 */
export function resolveHdsTitleBar(
  scene: HdsTitleBarScene,
  input: HdsTitleBarInput
): HdsTitleBarDecision {
  const apiLevel = HdsTitleBarPolicy.measurable(input.apiLevel);
  // The gate first, and only once: the 23+ members are named by the support class
  // nowhere else, so this one flag is the whole "may this device see the new API"
  // answer and both flags below follow it.
  const immersiveBlur = apiLevel >= HdsTitleBarPolicy.IMMERSIVE_BLUR_API_LEVEL;
  return {
    immersiveBlur: immersiveBlur,
    materialAttached: immersiveBlur,
    scrollEffectType: HdsTitleBarPolicy.blurFor(scene, immersiveBlur),
    materialType: HdsTitleBarPolicy.MATERIAL_TYPE_ADAPTIVE,
    materialLevel: HdsTitleBarPolicy.materialLevelFor(input.apiLevel, input.immersiveMaterialSupported)
  };
}
