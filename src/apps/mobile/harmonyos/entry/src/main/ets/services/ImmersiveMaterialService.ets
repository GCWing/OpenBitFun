import { uiMaterial } from '@kit.ArkUI';
import { DeviceApiLevelService } from './DeviceApiLevelService';
import { MotionPreference } from './MotionPreference';
import { RemoteLogger } from './RemoteLogger';

/**
 * The device facts one immersive material decision is resolved from.
 *
 * Declared here as well as in `pages/policy/ImmersiveMaterialPolicy`, because a
 * service must not import a page module and the policy must not import a platform
 * kit. The two declarations are one contract, and
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
 * The material-facing projection of one resolved decision.
 *
 * `resolveImmersiveMaterial(scene, snapshot)` answers a decision that carries
 * these five fields, and the call site builds this plan from it field by field:
 * the two declarations live in different modules rather than being one type, so
 * the boundary names the fields it passes. The port is deliberately only the
 * fields the platform object is built from: the recipe's fallback blur, floor
 * colour and hairline belong to the surface the component paints, which this
 * service does not build.
 */
export interface ImmersiveMaterialPlan {
  /** False keeps the surface on its own painted fallback. */
  apply: boolean;
  /** The recipe level, mapped to `uiMaterial.ImmersiveStyle` here. */
  level: string;
  /** Only the two thinnest styles can invert; the policy has already resolved this. */
  colorInvert: boolean;
  /** The material's press deformation; dropped under reduced motion. */
  interactive: boolean;
  /** The material's light feedback; dropped under reduced motion. */
  lightEffect: boolean;
}

/**
 * The platform's immersive material, read and built only from API 26 on.
 *
 * The app's `compatibleSdkVersion` is 6.0.1 (21) while `ImmersiveMaterial` ships
 * in 26, so every `uiMaterial` member in this file sits behind `supported()`. The
 * import above is safe on its own — loading the module does not ask the platform
 * for a material — but reading `getMaterialInfo()` or constructing the material
 * object on an older device is not, and neither call site is reachable before the
 * gate. A read that fails, a device whose level cannot be measured, a device that
 * reports no material capability, and a device that refuses the construction all
 * take the same path as an old device: the caller keeps the surface it paints
 * itself.
 */
export class ImmersiveMaterialService {
  /** First API level that ships `uiMaterial.ImmersiveMaterial`. */
  static readonly IMMERSIVE_MATERIAL_API_LEVEL: number = 26;
  /** `MaterialState.DEFAULT`: the module declares no material metadata, so the platform decides per component. */
  static readonly MATERIAL_STATE_DEFAULT: string = 'default';
  /** `MaterialState.ENABLE`: the app-level switch turns materials on. */
  static readonly MATERIAL_STATE_ENABLE: string = 'enable';
  /** `MaterialState.DISABLE`: no component may enable a material at all. */
  static readonly MATERIAL_STATE_DISABLE: string = 'disable';

  /**
   * Whether this device can render an immersive material at all.
   *
   * Two questions, in this order. The level comes first, because below API 26 none
   * of these members exists and an unmeasurable level reports unsupported rather
   * than capable: `DeviceApiLevelService` answers `0` when the platform read
   * fails, and no gate treats `0` as API 26.
   *
   * Only then is the device asked whether it will draw the material:
   * `isImmersiveMaterialSupported()` is defined by the device and cannot be
   * modified, and when it is false an `ImmersiveMaterial` handed to
   * `systemMaterial` is accepted and then ignored. That has to read as "no
   * material" here rather than as a construction that will not render, because a
   * surface drops its own painted floor and hairline as soon as it is handed a
   * material: a false reported as support would leave a bare floating panel over
   * the content. A read that fails is treated the same way, for the same reason.
   */
  static supported(): boolean {
    const apiLevel = DeviceApiLevelService.sdkApiVersion();
    if (!(Number.isFinite(apiLevel) &&
      apiLevel >= ImmersiveMaterialService.IMMERSIVE_MATERIAL_API_LEVEL)) {
      return false;
    }
    try {
      return uiMaterial.isImmersiveMaterialSupported() === true;
    } catch (err) {
      RemoteLogger.error(`Immersive material capability read failed: ${err}`);
      return false;
    }
  }

  /** The device facts one decision is resolved from, in one read. */
  static snapshot(): ImmersiveMaterialSnapshot {
    const apiLevel = DeviceApiLevelService.sdkApiVersion();
    return {
      apiLevel: apiLevel,
      materialState: ImmersiveMaterialService.materialState(apiLevel),
      reduceMotion: MotionPreference.reduceMotion()
    };
  }

  /**
   * The platform material for one resolved decision, or `undefined` when the
   * caller keeps the surface it paints itself.
   *
   * `undefined` is the whole degradation contract, and it is the only signal a
   * caller may read to drop its own painted floor, hairline, blur and shadow: a
   * plan that does not apply, a device below API 26, a device whose
   * `isImmersiveMaterialSupported()` is false, and a construction the platform
   * refuses all end here. `decision.apply` means the material was worth asking
   * for, not that it will be drawn, so a surface that keys on `apply` instead of
   * on this answer can drop its floor for a material that never arrives.
   *
   * `applyShadow` is left at its platform default, because a material's own shadow
   * takes precedence over the general `shadow()` attribute — a surface that adopts
   * a material drops its painted shadow rather than stacking the two.
   */
  static materialFor(plan: ImmersiveMaterialPlan): uiMaterial.Material | undefined {
    if (!plan.apply) {
      return undefined;
    }
    // Re-read here rather than trusting the plan: the capability belongs to the
    // device, so a hand-built or stale plan cannot reach the material API on a
    // device that will not render one.
    if (!ImmersiveMaterialService.supported()) {
      return undefined;
    }
    try {
      const options: uiMaterial.ImmersiveOptions = {
        style: ImmersiveMaterialService.styleFor(plan.level),
        interactive: plan.interactive,
        colorInvert: plan.colorInvert,
        lightEffect: ImmersiveMaterialService.lightEffectFor(plan.lightEffect)
      };
      return new uiMaterial.ImmersiveMaterial(options);
    } catch (err) {
      RemoteLogger.error(`Immersive material construction failed for level ${plan.level}: ${err}`);
      return undefined;
    }
  }

  /**
   * The material state the module's metadata reports.
   *
   * `MaterialState` is read only after the level gate: below API 26 the member does
   * not exist, so even naming the enum would be a platform call on a device that
   * cannot answer it. A failed read reports the default state, which leaves the
   * decision to each surface's own gate instead of switching materials off
   * globally on evidence the app does not have.
   */
  private static materialState(apiLevel: number): string {
    if (!(Number.isFinite(apiLevel) &&
      apiLevel >= ImmersiveMaterialService.IMMERSIVE_MATERIAL_API_LEVEL)) {
      return ImmersiveMaterialService.MATERIAL_STATE_DEFAULT;
    }
    try {
      const state: number = uiMaterial.getMaterialInfo().state;
      if (state === uiMaterial.MaterialState.DISABLE) {
        return ImmersiveMaterialService.MATERIAL_STATE_DISABLE;
      }
      if (state === uiMaterial.MaterialState.ENABLE) {
        return ImmersiveMaterialService.MATERIAL_STATE_ENABLE;
      }
      return ImmersiveMaterialService.MATERIAL_STATE_DEFAULT;
    } catch (err) {
      RemoteLogger.error(`Immersive material state read failed: ${err}`);
      return ImmersiveMaterialService.MATERIAL_STATE_DEFAULT;
    }
  }

  /**
   * The platform style for one recipe level.
   *
   * An unknown level is not evidence of a thin material, so it resolves to
   * `REGULAR` and never to one of the two thinnest styles, which would also make
   * the surface invertible. The level is announced, because a level the policy does
   * not define is a wiring mistake rather than a device fact.
   */
  private static styleFor(level: string): uiMaterial.ImmersiveStyle {
    if (level === 'ultra_thin') {
      return uiMaterial.ImmersiveStyle.ULTRA_THIN;
    }
    if (level === 'thin') {
      return uiMaterial.ImmersiveStyle.THIN;
    }
    if (level === 'thick') {
      return uiMaterial.ImmersiveStyle.THICK;
    }
    if (level === 'ultra_thick') {
      return uiMaterial.ImmersiveStyle.ULTRA_THICK;
    }
    if (level !== 'regular') {
      RemoteLogger.warn(`Unknown immersive material level ${level}, using regular`);
    }
    return uiMaterial.ImmersiveStyle.REGULAR;
  }

  /**
   * The light feedback option, or an explicit `null` when it is off.
   *
   * `null` is the documented way to disable the feedback. The option object stays
   * empty so the platform's own feedback colour applies, rather than a colour this
   * layer would have to name outside the theme tokens.
   */
  private static lightEffectFor(enabled: boolean): uiMaterial.LightEffectOptions | null {
    if (!enabled) {
      return null;
    }
    const options: uiMaterial.LightEffectOptions = {};
    return options;
  }
}
