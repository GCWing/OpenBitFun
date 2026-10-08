import { AbilityConstant, Configuration, ConfigurationConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { display, window } from '@kit.ArkUI';
import { MobileDesignColors, MobileTextScale } from '../generated/MobileDesignTokens';

const DOMAIN = 0x0000;
const TAG = 'OpenBitFunRemote';

export default class EntryAbility extends UIAbility {
  private mainWindow?: window.Window;
  private initialPage: string = 'pages/AppRoot';
  private previewStorage?: LocalStorage;

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    const scenarioId = want.parameters?.['openbitfunDesignPreview'];
    if (scenarioId === 'history-scroll' || scenarioId === 'durable-timeline' || scenarioId === 'composer-submit' || scenarioId === 'catalog-refresh' || scenarioId === 'catalog-refresh-dark' || scenarioId === 'model-role-selector' || scenarioId === 'model-role-selector-dark' || scenarioId === 'model-role-selector-wide' || scenarioId === 'subagent-process' || scenarioId === 'subagent-process-dark' || scenarioId === 'file-visibility' || scenarioId === 'file-visibility-dark' || scenarioId === 'immersive-bottom' || scenarioId === 'immersive-bottom-dark' || scenarioId === 'immersive-bottom-wide' || scenarioId === 'immersive-bottom-drawer' || scenarioId === 'immersive-bottom-drawer-dark' || scenarioId === 'immersive-bottom-settings' || scenarioId === 'immersive-bottom-settings-dark' || scenarioId === 'immersive-bottom-cover' || scenarioId === 'immersive-bottom-miniapps' || scenarioId === 'immersive-bottom-wide-shell' || scenarioId === 'immersive-bottom-tools' || scenarioId === 'immersive-bottom-tools-editor' || scenarioId === 'immersive-bottom-tools-file-action' || scenarioId === 'immersive-bottom-view-settings' || scenarioId === 'immersive-bottom-connect' || scenarioId === 'composer-overflow' || scenarioId === 'composer-overflow-empty' || scenarioId === 'composer-overflow-dark' || scenarioId === 'composer-overflow-wide' || scenarioId === 'composer-overflow-expanded' || scenarioId === 'composer-overflow-expanded-dark' || scenarioId === 'device-selector' || scenarioId === 'device-selector-dark' || scenarioId === 'welcome-home' || scenarioId === 'connected-conversation' ||
      scenarioId === 'streaming-dark' ||
      scenarioId === 'reconnecting-wide' || scenarioId === 'narrow-multiline' ||
      scenarioId === 'fold-context' || scenarioId === 'long-reading' ||
      scenarioId === 'cold-start-home' || scenarioId === 'cold-start-home-dark' ||
      scenarioId === 'interaction-mailbox' || scenarioId === 'interaction-mailbox-dark') {
      this.initialPage = 'pages/preview/MobileDesignGallery';
      this.previewStorage = new LocalStorage();
      this.previewStorage.setOrCreate('scenarioId', scenarioId);
      AppStorage.setOrCreate('scenarioId', scenarioId);
    }
    try {
      const colorMode = scenarioId === 'cold-start-home-dark' || scenarioId === 'catalog-refresh-dark' || scenarioId === 'model-role-selector-dark' || scenarioId === 'subagent-process-dark' || scenarioId === 'file-visibility-dark' || scenarioId === 'immersive-bottom-dark' || scenarioId === 'immersive-bottom-drawer-dark' || scenarioId === 'immersive-bottom-settings-dark' || scenarioId === 'composer-overflow-dark' || scenarioId === 'composer-overflow-expanded-dark' || scenarioId === 'device-selector-dark' || scenarioId === 'streaming-dark' || scenarioId === 'interaction-mailbox-dark'
        ? ConfigurationConstant.ColorMode.COLOR_MODE_DARK
        : scenarioId === 'cold-start-home' || scenarioId === 'catalog-refresh' || scenarioId === 'model-role-selector' || scenarioId === 'model-role-selector-wide' || scenarioId === 'subagent-process' || scenarioId === 'file-visibility' || scenarioId === 'immersive-bottom' || scenarioId === 'immersive-bottom-wide' || scenarioId === 'immersive-bottom-drawer' || scenarioId === 'immersive-bottom-settings' || scenarioId === 'immersive-bottom-cover' || scenarioId === 'immersive-bottom-miniapps' || scenarioId === 'immersive-bottom-wide-shell' || scenarioId === 'immersive-bottom-tools' || scenarioId === 'immersive-bottom-tools-editor' || scenarioId === 'immersive-bottom-tools-file-action' || scenarioId === 'immersive-bottom-view-settings' || scenarioId === 'immersive-bottom-connect' || scenarioId === 'composer-overflow' || scenarioId === 'composer-overflow-empty' || scenarioId === 'composer-overflow-wide' || scenarioId === 'composer-overflow-expanded' || scenarioId === 'device-selector' || scenarioId === 'connected-conversation' || scenarioId === 'reconnecting-wide'
          ? ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT
          : ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET;
      this.context.getApplicationContext().setColorMode(colorMode);
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'Failed to set colorMode. Cause: %{public}s', JSON.stringify(err));
    }
    this.applyTextScale();
    hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onCreate');
  }

  // The type ramp is read through getters, so this has to land before the first
  // page module loads; onCreate runs ahead of loadContent. A fold changing
  // screens keeps the same pixel pitch on the devices we ship to, so one read at
  // startup is enough.
  private applyTextScale(): void {
    try {
      const metrics = display.getDefaultDisplaySync();
      const factor = MobileTextScale.apply(metrics.xDPI, metrics.densityPixels);
      hilog.info(DOMAIN, TAG, 'Text scale %{public}s (xDPI %{public}s, density %{public}s)',
        String(factor), String(metrics.xDPI), String(metrics.densityPixels));
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'Failed to read display metrics for text scale. Cause: %{public}s', JSON.stringify(err));
    }
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
      // The shell runs immersive: the chat page's transcript has to reach the
      // bottom edge of the screen, and pages read the avoid areas themselves to
      // keep their content clear of the system bars.
      mainWindow.setWindowLayoutFullScreen(true);
      this.logWindowInsets(mainWindow);
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

  /**
   * The immersive shell is not verifiable from a screenshot alone: whether the
   * window covers the status bar and how tall the bottom strip is are device
   * facts, so state them once per launch.
   */
  private logWindowInsets(mainWindow: window.Window): void {
    try {
      const system = mainWindow.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM);
      const navigation = mainWindow.getWindowAvoidArea(window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR);
      hilog.info(DOMAIN, TAG,
        'Window insets statusBar=%{public}s navigation=%{public}s windowRect=%{public}s',
        String(system.topRect.height), String(navigation.bottomRect.height),
        JSON.stringify(mainWindow.getWindowProperties().windowRect));
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'Failed to read window insets. Cause: %{public}s', JSON.stringify(err));
    }
  }

  private updateSystemBars(colorMode?: ConfigurationConstant.ColorMode): void {
    if (!this.mainWindow) {
      return;
    }
    const dark = colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
    const content = dark ? MobileDesignColors.ink.dark : MobileDesignColors.ink.light;
    try {
      this.mainWindow.setWindowSystemBarProperties({
        // Both bars are transparent, because the window is laid out full-screen
        // and the strips they occupy are the page's own edges: the drawer's fill
        // and the chat page's blurred header band are what should show there.
        // An opaque status bar painted the page colour over both, which clipped
        // the sidebar's title, and it also sat over the pull-down notification
        // centre's frosted background as a white strip instead of blending into
        // it. `statusBarContentColor` is what keeps the clock and the icons
        // legible against whatever the page puts behind them.
        statusBarColor: MobileDesignColors.transparent.light,
        navigationBarColor: MobileDesignColors.transparent.light,
        statusBarContentColor: content,
        navigationBarContentColor: content
      });
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'Failed to update system bars. Cause: %{public}s', JSON.stringify(err));
    }
  }
}
