import { ConversationIntent } from '../actions/ConversationIntent';
import {
  AppRootPresentationActions,
  emptyAppRootPresentationActions
} from '../actions/AppRootPresentationActions';
import { AppRoute } from '../navigation/AppRouteContract';
import {
  SettingsPlacement,
  SettingsPlacementPolicy,
  SettingsSheetKind
} from '../policy/SettingsPlacementPolicy';
import { FilePreviewPhase, FilePreviewState } from '../state/FilePreviewState';
import { GeneralChatPageState } from '../state/GeneralChatPageState';
import { RemotePageState } from '../state/RemotePageState';
import { ComposerPresentation } from './ComposerBar';
import { ConversationViewHost } from './ConversationViewHost';
import {
  RemoteSurfaceHost,
  RemoteSurfaceMode,
  RemoteSurfaceState
} from './remote/RemoteSurfaceHost';
import { ConversationViewState } from '../state/ConversationViewState';
import { PAGE_BG } from './Theme';

@ComponentV2
export struct ConversationRouteSurface {
  @Param route: AppRoute = AppRoute.RemoteHome;
  @Param remotePageState: RemotePageState = new RemotePageState();
  @Param generalPageState: GeneralChatPageState = new GeneralChatPageState();
  @Param filePreviewState: FilePreviewState = new FilePreviewState();
  @Param remoteSurfaceState: RemoteSurfaceState = new RemoteSurfaceState();
  @Param actions: AppRootPresentationActions = emptyAppRootPresentationActions();
  @Param showSidebarButton: boolean = true;
  @Param showBackButton: boolean = false;
  @Param showSidebarRestoreButton: boolean = false;
  @Param useWidePresentation: boolean = false;
  @Param hoverOperateMode: boolean = false;
  @Param fullTextSheetPlacement: SettingsPlacement =
    SettingsPlacementPolicy.compactBottom(SettingsSheetKind.UserMessageFullText);
  @Event onRestoreSidebar: () => void = () => {};

  build() {
    Column() {
      if (this.route !== AppRoute.RemoteChat) {
        RemoteSurfaceHost({
          mode: RemoteSurfaceMode.CompactHome,
          remotePageState: this.remotePageState,
          presentationState: this.remoteSurfaceState,
          actions: this.actions,
          onOpenSidebar: this.actions.onRemoteHome.openSidebar
        })
      } else {
        ConversationViewHost({
          viewState: ConversationViewState.project(
            this.route,
            this.remotePageState,
            this.generalPageState,
            this.actions.generalStatus()
          ),
          activeFilePreviewPath: this.route === AppRoute.RemoteChat && this.filePreviewState.visible ?
            this.filePreviewState.target.remotePath : '',
          activeFilePreviewLoading: this.route === AppRoute.RemoteChat && this.filePreviewState.visible &&
            this.filePreviewState.phase === FilePreviewPhase.Loading,
          showSidebarButton: this.showSidebarButton,
          showBackButton: this.showBackButton,
          showSidebarRestoreButton: this.showSidebarRestoreButton,
          composerPresentation: this.composerPresentation(),
          composerInputId: 'conversation-composer-input',
          hoverOperateMode: this.hoverOperateMode,
          fullTextSheetPlacement: this.fullTextSheetPlacement,
          onRestoreSidebar: this.onRestoreSidebar,
          onIntent: (intent: ConversationIntent) => this.dispatchConversationIntent(intent)
        })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(PAGE_BG)
  }

  private composerPresentation(): ComposerPresentation {
    if (this.useWidePresentation) {
      return ComposerPresentation.Floating;
    }
    return ComposerPresentation.Compact;
  }

  private dispatchConversationIntent(intent: ConversationIntent): void {
    this.actions.onConversationIntent(this.route, intent);
  }
}
