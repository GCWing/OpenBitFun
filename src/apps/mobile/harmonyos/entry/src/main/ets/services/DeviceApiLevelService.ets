import { deviceInfo } from '@kit.BasicServicesKit';

/**
 * The device's reported API level, for presentation that must not read a
 * platform kit itself.
 *
 * A failed read is reported as 0, which no capability gate treats as a
 * supported level, so an unmeasurable device keeps the conservative path
 * instead of being assumed capable.
 */
export class DeviceApiLevelService {
  static sdkApiVersion(): number {
    try {
      return deviceInfo.sdkApiVersion;
    } catch (_err) {
      return 0;
    }
  }
}
