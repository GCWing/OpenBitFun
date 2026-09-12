import { StartupBrandReveal } from './components/StartupBrandReveal';
import { AppRootPresentation } from './components/AppRootPresentation';
import { WatchProvisionCard } from './components/WatchProvisionCard';
import { ArkUiAppRootHostAdapter } from './host/AppRootHostAdapter';
import { AppRootRuntime } from './runtime/AppRootRuntime';

@Entry
@ComponentV2
struct AppRoot {
  @Local showStartupBrand: boolean = true;
  private readonly hostAdapter: ArkUiAppRootHostAdapter = new ArkUiAppRootHostAdapter();
  private readonly runtime: AppRootRuntime = new AppRootRuntime(this.hostAdapter);

  async aboutToAppear(): Promise<void> {
    const hostContext = this.getUIContext().getHostContext();
    if (!hostContext) {
      throw new Error('App root host context is unavailable.');
    }
    this.hostAdapter.attach(hostContext, this.getUIContext());
    await this.runtime.aboutToAppear();
  }

  onPageShow(): void {
    this.runtime.onPageShow();
  }

  onPageHide(): void {
    this.showStartupBrand = false;
    this.runtime.onPageHide();
  }

  aboutToDisappear(): void {
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

      if (this.showStartupBrand) {
        StartupBrandReveal({ onFinished: () => { this.showStartupBrand = false; } })
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
  }
}
