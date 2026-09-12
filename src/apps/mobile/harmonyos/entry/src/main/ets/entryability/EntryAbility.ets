import { AbilityConstant, Configuration, ConfigurationConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { MobileDesignColors } from '../generated/MobileDesignTokens';

const DOMAIN = 0x0000;
const TAG = 'OpenBitFunRemote';

export default class EntryAbility extends UIAbility {
  private mainWindow?: window.Window;
  private initialPage: string = 'pages/AppRoot';
  private previewStorage?: LocalStorage;

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    const scenarioId = want.parameters?.['openbitfunDesignPreview'];
    if (scenarioId === 'welcome-home' || scenarioId === 'connected-conversation' ||
      scenarioId === 'streaming-dark' ||
      scenarioId === 'reconnecting-wide' || scenarioId === 'narrow-multiline' ||
      scenarioId === 'fold-context' || scenarioId === 'long-reading') {
      this.initialPage = 'pages/preview/MobileDesignGallery';
      this.previewStorage = new LocalStorage();
      this.previewStorage.setOrCreate('scenarioId', scenarioId);
      AppStorage.setOrCreate('scenarioId', scenarioId);
    }
    try {
      const colorMode = scenarioId === 'streaming-dark'
        ? ConfigurationConstant.ColorMode.COLOR_MODE_DARK
        : scenarioId === 'connected-conversation' || scenarioId === 'reconnecting-wide'
          ? ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT
          : ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET;
      this.context.getApplicationContext().setColorMode(colorMode);
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'Failed to set colorMode. Cause: %{public}s', JSON.stringify(err));
    }
    hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onCreate');
  }

  onDestroy(): void {
    hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onDestroy');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    // Main window is created, set main page for this ability
    hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onWindowStageCreate');
    try {
      const mainWindow = windowStage.getMainWindowSync();
      this.mainWindow = mainWindow;
      mainWindow.setWindowLayoutFullScreen(false);
      this.updateSystemBars(this.context.config?.colorMode);
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'Failed to configure window bars. Cause: %{public}s', JSON.stringify(err));
    }

    const onContentLoaded = (err: BusinessError): void => {
      if (err.code) {
        hilog.error(DOMAIN, TAG, 'Failed to load the content. Cause: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(DOMAIN, TAG, 'Succeeded in loading the content.');
    };
    if (this.previewStorage) {
      windowStage.loadContent(this.initialPage, this.previewStorage, onContentLoaded);
    } else {
      windowStage.loadContent(this.initialPage, onContentLoaded);
    }
  }

  onWindowStageDestroy(): void {
    // Main window is destroyed, release UI related resources
    hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onWindowStageDestroy');
  }

  onForeground(): void {
    // Ability has brought to foreground
    hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onForeground');
  }

  onConfigurationUpdate(newConfig: Configuration): void {
    this.updateSystemBars(newConfig.colorMode);
  }

  onBackground(): void {
    // Ability has back to background
    hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onBackground');
  }

  private updateSystemBars(colorMode?: ConfigurationConstant.ColorMode): void {
    if (!this.mainWindow) {
      return;
    }
    const dark = colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
    const background = dark ? MobileDesignColors.pageBg.dark : MobileDesignColors.pageBg.light;
    const content = dark ? MobileDesignColors.ink.dark : MobileDesignColors.ink.light;
    try {
      this.mainWindow.setWindowSystemBarProperties({
        statusBarColor: background,
        navigationBarColor: background,
        statusBarContentColor: content,
        navigationBarContentColor: content
      });
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'Failed to update system bars. Cause: %{public}s', JSON.stringify(err));
    }
  }
}
