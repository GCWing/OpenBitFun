import { common } from '@kit.AbilityKit';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { INK } from '../components/Theme';
import { ImmersiveSurfaceSupport } from '../components/ImmersiveSurfaceSupport';
import { ImmersiveSurfaceScene } from '../policy/ImmersiveMaterialPolicy';

export interface AppRootHostPort {
  attach(context: Context, uiContext: UIContext): void;
  context(): Context;
  animate(duration: number, callback: () => void): void;
  showToast(message: string, duration: number): boolean;
  openExternalLink?(link: string): Promise<boolean>;
  offerTaskNotifications?(): Promise<boolean>;
}

export class ArkUiAppRootHostAdapter implements AppRootHostPort {
  private hostContext: Context = {} as Context;
  private uiContext: UIContext = {} as UIContext;

  attach(context: Context, uiContext: UIContext): void {
    this.hostContext = context;
    this.uiContext = uiContext;
  }

  context(): Context {
    return this.hostContext;
  }

  animate(duration: number, callback: () => void): void {
    try {
      this.uiContext.animateTo({ duration, curve: Curve.EaseOut }, callback);
    } catch (_err) {
      callback();
    }
  }

  showToast(message: string, duration: number): boolean {
    try {
      this.uiContext.getPromptAction().showToast(
        ImmersiveSurfaceSupport.toastOptions(ImmersiveSurfaceScene.TOAST, { message, duration })
      );
      return true;
    } catch (_err) {
      return false;
    }
  }

  async offerTaskNotifications(): Promise<boolean> {
    const result = await this.uiContext.getPromptAction().showDialog({
      title: RemoteI18n.t('notification.onboardingTitle'),
      message: RemoteI18n.t('notification.onboardingBody'),
      buttons: [
        { text: RemoteI18n.t('notification.onboardingLater'), color: INK as Resource },
        { text: RemoteI18n.t('notification.onboardingEnable'), color: INK as Resource }
      ]
    });
    return result.index === 1;
  }

  async openExternalLink(link: string): Promise<boolean> {
    const value = link.trim();
    if (!/^https?:\/\//i.test(value)) {
      return false;
    }
    try {
      await (this.hostContext as common.UIAbilityContext).openLink(value);
      return true;
    } catch (_err) {
      return false;
    }
  }
}
