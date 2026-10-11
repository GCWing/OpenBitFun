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
      scenarioId === 'copy-selection' || scenarioId === 'copy-selection-dark' ||
      scenarioId === 'copy-selection-nav' || scenarioId === 'copy-selection-wide' ||
      scenarioId === 'interaction-mailbox' || scenarioId === 'interaction-mailbox-dark') {
      this.initialPage = 'pages/preview/MobileDesignGallery';
      this.previewStorage = new LocalStorage();
      this.previewStorage.setOrCreate('scenarioId', scenarioId);
      AppStorage.setOrCreate('scenarioId', scenarioId);
    }
    try {
      const colorMode = scenarioId === 'cold-start-home-dark' || scenarioId === 'catalog-refresh-dark' || scenarioId === 'model-role-selector-dark' || scenarioId === 'subagent-process-dark' || scenarioId === 'file-visibility-dark' || scenarioId === 'immersive-bottom-dark' || scenarioId === 'immersive-bottom-drawer-dark' || scenarioId === 'immersive-bottom-settings-dark' || scenarioId === 'composer-overflow-dark' || scenarioId === 'composer-overflow-expanded-dark' || scenarioId === 'device-selector-dark' || scenarioId === 'streaming-dark' || scenarioId === 'interaction-mailbox-dark' || scenarioId === 'copy-selection-dark'
        ? ConfigurationConstant.ColorMode.COLOR_MODE_DARK
        : scenarioId === 'cold-start-home' || scenarioId === 'catalog-refresh' || scenarioId === 'model-role-selector' || scenarioId === 'model-role-selector-wide' || scenarioId === 'subagent-process' || scenarioId === 'file-visibility' || scenarioId === 'immersive-bottom' || scenarioId === 'immersive-bottom-wide' || scenarioId === 'immersive-bottom-drawer' || scenarioId === 'immersive-bottom-settings' || scenarioId === 'immersive-bottom-cover' || scenarioId === 'immersive-bottom-miniapps' || scenarioId === 'immersive-bottom-wide-shell' || scenarioId === 'immersive-bottom-tools' || scenarioId === 'immersive-bottom-tools-editor' || scenarioId === 'immersive-bottom-tools-file-action' || scenarioId === 'immersive-bottom-view-settings' || scenarioId === 'immersive-bottom-connect' || scenarioId === 'composer-overflow' || scenarioId === 'composer-overflow-empty' || scenarioId === 'composer-overflow-wide' || scenarioId === 'composer-overflow-expanded' || scenarioId === 'device-selector' || scenarioId === 'connected-conversation' || scenarioId === 'reconnecting-wide' || scenarioId === 'copy-selection' || scenarioId === 'copy-selection-nav' || scenarioId === 'copy-selection-wide'
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
   * facts, so state them once per launch. The camera cutout is stated in full —
   * visibility and all four rectangles — because it is the one avoid area that
   * moves to a different edge when the device rotates, and a device without a
   * cutout reports zeroes here rather than staying silent about it.
   */
  private logWindowInsets(mainWindow: window.Window): void {
    try {
      const system = mainWindow.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM);
      const navigation = mainWindow.getWindowAvoidArea(window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR);
      hilog.info(DOMAIN, TAG,
        'Window insets statusBar=%{public}s navigation=%{public}s windowRect=%{public}s',
        String(system.topRect.height), String(navigation.bottomRect.height),
        JSON.stringify(mainWindow.getWindowProperties().windowRect));
      const cutout = mainWindow.getWindowAvoidArea(window.AvoidAreaType.TYPE_CUTOUT);
      hilog.info(DOMAIN, TAG,
        'Window cutout visible=%{public}s top=%{public}s bottom=%{public}s left=%{public}s right=%{public}s',
        String(cutout.visible), String(cutout.topRect.height), String(cutout.bottomRect.height),
        String(cutout.leftRect.width), String(cutout.rightRect.width));
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'Failed to read window insets. Cause: %{public}s', JSON.stringify(err));
    }
  }

  /**
   * The content colour of both system bars, for the whole window and the whole
   * app.
   *
   * This is one value for one window, and it is derived from one thing only: the
   * colour mode. There is no per-page override here, so any page whose top band
   * is dark — a media viewer, an immersive title, a hero the design decides to
   * paint dark — puts the light-mode ink on a dark band and the clock and the
   * status icons stop being readable against it. Every top band the app ships
   * today is a theme-following page colour (`PAGE_BG`, `SIDEBAR_BG`,
   * `PAGE_BG_OVERLAY`, `WELCOME_PAGE_BG`, `CARD`), which is why the single value
   * is correct as it stands; `immersive-bottom.test.cjs` guards that list as a
   * tripwire.
   *
   * So: a new page that paints its own dark top band is not finished here. It has
   * to come back to this method — either by declaring its band against the
   * colour mode the way the others do, or by giving the app a per-page override
   * (the platform's `HdsNavigation.systemBarStyle` is the page-level route, and
   * the platform also warns against mixing it with the window-level calls used
   * here). Either way the band and the content colour are one decision, not two.
   */
  private updateSystemBars(colorMode?: ConfigurationConstant.ColorMode): void {
    if (!this.mainWindow) {
      return;
    }
    const dark = colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
    const content = dark ? MobileDesignColors.ink.dark : MobileDesignColors.ink.light;
    try {
      this.mainWindow.setWindowSystemBarProperties({
        // The window is laid out full-screen above (`setWindowLayoutFullScreen(true)`),
        // so it already runs in the immersive layout, and the status bar and the
        // navigation area are transparent by platform default: both strips carry
        // the page's own background through. The page therefore owns what shows
        // there — the drawer's fill and the chat page's blurred header band — and
        // any background colour set here would repaint the page's edge instead.
        // The content colours are the only thing left to state: they keep the
        // clock and the icons legible against whatever the page puts behind them.
        statusBarContentColor: content,
        navigationBarContentColor: content
      });
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'Failed to update system bars. Cause: %{public}s', JSON.stringify(err));
    }
  }
}
