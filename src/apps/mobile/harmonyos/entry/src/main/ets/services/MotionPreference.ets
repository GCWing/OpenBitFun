import accessibility from '@ohos.accessibility';
import deviceInfo from '@ohos.deviceInfo';

/** Optional on older phones; never let a presentation preference block startup. */
export class MotionPreference {
  static reduceMotion(): boolean {
    try {
      return deviceInfo.sdkApiVersion >= 23 && accessibility.isAnimationReduceEnabledSync();
    } catch (_err) {
      return false;
    }
  }
}
