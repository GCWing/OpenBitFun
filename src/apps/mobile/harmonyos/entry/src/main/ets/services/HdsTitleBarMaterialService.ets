import { hdsMaterial } from '@kit.UIDesignKit';
import { DeviceApiLevelService } from './DeviceApiLevelService';
import { RemoteLogger } from './RemoteLogger';

/**
 * The device facts one HDS title bar decision is resolved from.
 *
 * Declared here as well as in `pages/policy/HdsTitleBarPolicy`, because a service
 * must not import a page module and the policy must not import a platform kit:
 * one contract, two declarations, and `tools/tests/hds-titlebar-policy.test.cjs`
 * fails when they drift.
 */
export interface HdsTitleBarSnapshot {
  /** The device's reported API level; `0` when the platform read failed. */
  apiLevel: number;
  /** Whether the device reports the IMMERSIVE material type. */
  immersiveMaterialSupported: boolean;
}

/**
 * The HDS title bar's material capability, read only where the platform can
 * answer it.
 *
 * `hdsMaterial` and every member this file reads are 6.1.0(23), while the app's
 * `compatibleSdkVersion` is 6.0.1(21). The import above is safe on its own —
 * loading the module asks the platform for nothing — but `getSystemMaterialTypes()`
 * and `MaterialType.IMMERSIVE` are not, so both sit behind the level gate and the
 * order is the point: *the level first, then the member*. A device whose level
 * cannot be measured answers unsupported rather than capable, exactly like
 * `ImmersiveMaterialService`.
 *
 * A false answer is the SMOOTH tier, not "no bar": the title bar itself starts at
 * 5.1.0(18) and is the chrome on every device this app supports. What the device
 * cannot have is the immersive material, and the policy lowers the requested
 * level instead of dropping the band.
 */
export class HdsTitleBarMaterialService {
  /** First API level that ships the immersive blur type and `systemMaterialEffect`. */
  static readonly IMMERSIVE_BLUR_API_LEVEL: number = 23;
  /** First API level that ships `hdsMaterial`, and so the read below. */
  static readonly IMMERSIVE_MATERIAL_API_LEVEL: number = 26;

  /** Whether the level is high enough to name the 23+ title bar members. */
  static immersiveBlurSupported(): boolean {
    const apiLevel = DeviceApiLevelService.sdkApiVersion();
    return Number.isFinite(apiLevel) && apiLevel >= HdsTitleBarMaterialService.IMMERSIVE_BLUR_API_LEVEL;
  }

  /**
   * Whether this device reports the IMMERSIVE material type.
   *
   * Two questions in this order, the same order the immersive material's own
   * service uses: the level first, because below 26 neither the read nor the enum
   * member exists. A read that fails and a device that lists no immersive type
   * both answer false, which is the SMOOTH tier.
   */
  static immersiveMaterialSupported(): boolean {
    const apiLevel = DeviceApiLevelService.sdkApiVersion();
    if (!(Number.isFinite(apiLevel) &&
      apiLevel >= HdsTitleBarMaterialService.IMMERSIVE_MATERIAL_API_LEVEL)) {
      return false;
    }
    try {
      const types: Array<hdsMaterial.MaterialType> = hdsMaterial.getSystemMaterialTypes();
      return types.indexOf(hdsMaterial.MaterialType.IMMERSIVE) >= 0;
    } catch (err) {
      RemoteLogger.error(`HDS title bar material capability read failed: ${err}`);
      return false;
    }
  }

  /** The device facts one decision is resolved from, in one read. */
  static snapshot(): HdsTitleBarSnapshot {
    const apiLevel = DeviceApiLevelService.sdkApiVersion();
    return {
      apiLevel: apiLevel,
      // Only asked where it can be answered: `immersiveMaterialSupported` reads
      // the level itself first, so this stays two platform reads at most and
      // never touches `hdsMaterial` below 26.
      immersiveMaterialSupported: HdsTitleBarMaterialService.immersiveMaterialSupported()
    };
  }
}
