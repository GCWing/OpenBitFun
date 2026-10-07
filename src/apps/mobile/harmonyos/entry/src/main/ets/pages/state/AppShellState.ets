import { AppRoute } from '../navigation/AppRouteContract';
import { SettingsSheetState } from './SettingsSheetState';

/**
 * Settings is one page ('general'). 'account' is the signed-out login step that
 * returns to that page once the account settles.
 */
export type SettingsMode = 'general' | 'account';

@ObservedV2
export class AppShellState {
  /**
   * Mirror of the navigation stack top. NavPathStack is not observable, so
   * surfaces that live outside Navigation — the drawer above all — have no way
   * to follow the route without this traced copy.
   */
  @Trace activeRoute: AppRoute = AppRoute.RemoteHome;
  @Trace showSidebar: boolean = false;
  @Trace showSettings: boolean = false;
  @Trace settingsMode: SettingsMode = 'general';
  @Trace showConnectSheet: boolean = false;
  /**
   * Mirror of the resolved master-detail layout mode. Only the presentation
   * layer measures the viewport, so runtime logic that must branch on compact
   * versus wide reads it from here.
   */
  @Trace wideLayout: boolean = false;
  /**
   * Bumped when the in-app locale changes so shell consumers that already
   * observe this object rebuild even if they do not call RemoteI18n.t().
   */
  @Trace localeRevision: number = 0;
  readonly settingsSheet: SettingsSheetState = new SettingsSheetState();
  private accountReturnsToSettings: boolean = false;

  setSidebarVisible(visible: boolean): void {
    this.showSidebar = visible;
  }

  setWideLayout(wide: boolean): void {
    this.wideLayout = wide;
  }

  setLocaleRevision(revision: number): void {
    this.localeRevision = revision;
  }

  setSettingsVisible(visible: boolean): void {
    this.showSettings = visible;
    if (!visible) {
      this.accountReturnsToSettings = false;
      this.settingsSheet.resetOnClose();
    }
  }

  openSettings(mode: SettingsMode): void {
    if (mode === 'account') {
      this.accountReturnsToSettings = this.showSettings;
    } else {
      this.accountReturnsToSettings = false;
      if (mode === 'general' && !this.showSettings) {
        this.settingsSheet.resetOnClose();
      }
    }
    this.settingsMode = mode;
    this.showSettings = true;
  }

  leaveSettings(): void {
    if (this.settingsMode === 'account' && this.accountReturnsToSettings) {
      this.settingsMode = 'general';
      this.accountReturnsToSettings = false;
      this.showSettings = true;
      return;
    }
    this.setSettingsVisible(false);
  }

  /**
   * The account request is settled (signed in, or signed out from the inline
   * account section). Stay in settings and land on the single settings page.
   */
  settleAccountSettings(): void {
    if (this.settingsMode !== 'account') {
      return;
    }
    this.settingsMode = 'general';
    this.accountReturnsToSettings = false;
    this.showSettings = true;
  }

  setConnectSheetVisible(visible: boolean): void {
    this.showConnectSheet = visible;
  }

  closeGlobalSurfaces(): void {
    this.showSidebar = false;
    this.showSettings = false;
    this.accountReturnsToSettings = false;
    this.settingsSheet.resetOnClose();
    this.showConnectSheet = false;
  }
}
