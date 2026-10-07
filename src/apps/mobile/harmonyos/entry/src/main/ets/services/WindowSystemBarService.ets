import { Context } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';

/** Platform window adapter for surfaces that need to draw behind system bars. */
export class WindowSystemBarService {
  static async setLayoutFullScreen(context: Context, enabled: boolean): Promise<void> {
    try {
      const appWindow = await window.getLastWindow(context);
      await appWindow.setWindowLayoutFullScreen(enabled);
    } catch (_err) {
      // Window layout is best effort and must not block page rendering.
    }
  }

  static async topSystemInsetPx(context: Context): Promise<number> {
    try {
      const appWindow = await window.getLastWindow(context);
      return appWindow.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM).topRect.height;
    } catch (_err) {
      return 0;
    }
  }
}
