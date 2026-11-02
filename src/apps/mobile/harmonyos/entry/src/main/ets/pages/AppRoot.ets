import { StartupRevealPreference } from '../services/StartupRevealPreference';
import { StartupBrandReveal } from './components/StartupBrandReveal';
import { ColdStartPresentationState } from './state/ColdStartPresentationState';
import { ColdStartHomeTransition } from './components/ColdStartHomeTransition';
import { AppRootPresentation } from './components/AppRootPresentation';
import { WatchProvisionCard } from './components/WatchProvisionCard';
import { ArkUiAppRootHostAdapter } from './host/AppRootHostAdapter';
import { AppRootRuntime } from './runtime/AppRootRuntime';

@Entry
@ComponentV2
struct AppRoot {
  @Local showStartupBrand: boolean = false;
  @Local showColdStart: boolean = false;
  private readonly hostAdapter: ArkUiAppRootHostAdapter = new ArkUiAppRootHostAdapter();
  private readonly runtime: AppRootRuntime = new AppRootRuntime(this.hostAdapter);
  @Provider() coldStartGeometry: ColdStartPresentationState = new ColdStartPresentationState();
  private coldStartConsumed: boolean = false;

  async aboutToAppear(): Promise<void> {
    const hostContext = this.getUIContext().getHostContext();
    if (!hostContext) {
      throw new Error('App root host context is unavailable.');
    }
    this.showStartupBrand = StartupRevealPreference.claim(hostContext);
    this.hostAdapter.attach(hostContext, this.getUIContext());
    const firstLaunch = this.showStartupBrand;
    const coldStartCandidate = ColdStartPresentationState.claimProcess() && !firstLaunch;
    await this.runtime.aboutToAppear((signedIn: boolean): void => {
      if (!this.coldStartConsumed) {
        this.coldStartConsumed = true;
        this.showColdStart = coldStartCandidate && signedIn;
      }
    });
  }

  onPageShow(): void {
    this.runtime.onPageShow();
  }

  onPageHide(): void {
    this.showStartupBrand = false;
    this.showColdStart = false;
    this.coldStartConsumed = true;
    this.runtime.onPageHide();
  }

  aboutToDisappear(): void {
    this.coldStartConsumed = true;
    this.showColdStart = false;
    this.runtime.aboutToDisappear();
  }

  onBackPress(): boolean {
    if (this.runtime.miniAppViewModel.state.visible) {
      if (this.runtime.miniAppViewModel.state.appId) this.runtime.miniAppViewModel.actions.back();
      else this.runtime.miniAppViewModel.close();
      return true;
    }
    return this.runtime.handleRootBack();
  }

  build() {
    Stack() {
      AppRootPresentation({
        shellState: this.runtime.appShellState,
        miniAppState: this.runtime.miniAppViewModel.state,
        miniAppActions: this.runtime.miniAppViewModel.actions,
        navigationStack: this.runtime.navigationStack,
        remotePageState: this.runtime.remotePageState,
        deviceDirectoryState: this.runtime.deviceDirectoryState,
        generalPageState: this.runtime.generalChatPageState,
        filePreviewState: this.runtime.filePreviewState,
        deviceId: this.runtime.remoteConnectionController.getDeviceId(),
        actions: this.runtime.presentationActions
      })
      .accessibilityLevel(this.showStartupBrand || this.showColdStart ? 'no-hide-descendants' : 'auto')

      if (this.showStartupBrand) {
        StartupBrandReveal({ onFinished: () => { this.showStartupBrand = false; } })
      }
      if (this.showColdStart) {
        ColdStartHomeTransition({ geometry: this.coldStartGeometry, onFinished: () => { this.showColdStart = false; } })
      }

      // Sits above every route on purpose: a watch waiting for approval must
      // not be hidden behind whatever screen the phone happens to be on.
      WatchProvisionCard({
        state: this.runtime.watchProvisionState,
        onApprove: (password: string) => {
          void this.runtime.watchProvisionController.approve(password);
        },
        onReject: () => {
          void this.runtime.watchProvisionController.reject();
        },
        onDismiss: () => {
          this.runtime.watchProvisionController.dismiss();
        }
      })
    }
    .width('100%')
    .height('100%')
    .onAreaChange((_old: Area, area: Area) => {
      this.coldStartGeometry.originX = Number(area.globalPosition.x);
      this.coldStartGeometry.originY = Number(area.globalPosition.y);
    })
  }
}
