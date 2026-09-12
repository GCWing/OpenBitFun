import { RemoteUiState } from '../../services/RemoteUiState';
import { REMOTE_CAPABILITY_HARNESS_PROFILES_V1 } from '../../model/RemoteModels';
import {
  AppRootPresentationActions,
  emptyAppRootPresentationActions
} from '../actions/AppRootPresentationActions';
import { WideLayoutGeometry } from '../layout/WideLayoutGeometry';
import { AppRoute, AppRouteContract } from '../navigation/AppRouteContract';
import { FilePreviewLayout, FilePreviewPlacement } from '../policy/FilePreviewPlacementPolicy';
import {
  SettingsPlacement,
  SettingsPlacementPolicy,
  SettingsSheetKind
} from '../policy/SettingsPlacementPolicy';
import { AppShellState } from '../state/AppShellState';
import { FilePreviewState } from '../state/FilePreviewState';
import { GeneralChatPageState } from '../state/GeneralChatPageState';
import { DeviceDirectoryState } from '../state/DeviceDirectoryState';
import { RemotePageState } from '../state/RemotePageState';
import { AppSidebar } from './AppSidebar';
import { ConversationRouteSurface } from './ConversationRouteSurface';
import { FilePreviewSurface } from './FilePreviewSurface';
import {
  RemoteSurfaceHost,
  RemoteSurfaceMode,
  RemoteSurfaceState
} from './remote/RemoteSurfaceHost';
import { SidebarToggleButton } from './SidebarToggleButton';
import { SidebarWorkspaceSection } from './SidebarWorkspaceSection';
import {
  CARD,
  LINE,
  PAGE_BG,
  SHADOW_SUBTLE,
} from './Theme';

const WIDE_DETAIL_CONTENT_MAX_WIDTH: number = 920;

@ComponentV2
export struct WideConversationHost {
  @Param route: AppRoute = AppRoute.RemoteHome;
  @Param shellState: AppShellState = new AppShellState();
  @Param remotePageState: RemotePageState = new RemotePageState();
  @Param deviceDirectoryState: DeviceDirectoryState = new DeviceDirectoryState();
  @Param generalPageState: GeneralChatPageState = new GeneralChatPageState();
  @Param filePreviewState: FilePreviewState = new FilePreviewState();
  @Param remoteSurfaceState: RemoteSurfaceState = new RemoteSurfaceState();
  @Param actions: AppRootPresentationActions = emptyAppRootPresentationActions();
  @Param filePreviewLayout: FilePreviewLayout = new FilePreviewLayout(FilePreviewPlacement.Hidden);
  @Param sessionDetailsPlacement: SettingsPlacement =
    SettingsPlacementPolicy.compactBottom(SettingsSheetKind.SessionDetails);
  @Param wideMasterPaneWidth: number = 0;
  @Param wideMasterDetailGap: number = 0;
  @Param wideDetailContentOffset: number = 0;
  @Param wideDetailContentWidth: number = 0;
  @Param wideCollapsedDetailContentOffset: number = 0;
  @Param wideCollapsedDetailContentWidth: number = 0;
  @Param wideMasterPaneCollapsed: boolean = false;
  @Param wideMasterPaneMotionActive: boolean = false;
  @Param filePreviewExpanded: boolean = false;
  @Param canToggleFilePreviewExpanded: boolean = false;
  @Event onCollapseMasterPane: () => void = () => {};
  @Event onRestoreMasterPane: () => void = () => {};
  @Event onToggleFilePreviewExpanded: () => void = () => {};
  @Event onOpenRemoteViewSettings: () => void = () => {};

  build() {
    if (this.showsRemoteConversation() &&
      this.filePreviewLayout.placement === FilePreviewPlacement.WideMasterPreviewFocus) {
      this.RemoteMasterPreviewFocusContent();
    } else if (this.showsRemoteConversation() &&
      this.filePreviewLayout.placement === FilePreviewPlacement.WideFocusSplit) {
      this.RemotePreviewFocusContent();
    } else if (this.showsRemoteDetail()) {
      this.RemoteChatContent();
    } else if (this.route === AppRoute.RemoteHome) {
      this.RemoteHomeContent();
    }
  }

  @Builder
  private RemoteHomeContent() {
    Row() {
      if (!this.wideMasterPaneCollapsed) {
        this.MasterPane()
        this.MasterDetailGap()
      }
      this.RemoteHomeDetail()
    }
    .width('100%').height('100%').backgroundColor(PAGE_BG)
  }

  @Builder
  private RemoteHomeDetail() {
    Stack({ alignContent: Alignment.TopStart }) {
      Row() {
        if (this.currentDetailOffset() > 0) {
          Row() {}.width(this.currentDetailOffset()).height('100%')
        }
        Column() {
          RemoteSurfaceHost({
            mode: RemoteSurfaceMode.Placeholder,
            remotePageState: this.remotePageState,
            presentationState: this.remoteSurfaceState,
            actions: this.actions,
            wideMasterPaneCollapsed: false,
            sessionDetailsPlacement: this.sessionDetailsPlacement,
            onRestoreSidebar: this.onRestoreMasterPane
          })
        }
        .width(this.currentDetailWidth() > 0 ? this.currentDetailWidth() : '100%')
        .height('100%').backgroundColor(PAGE_BG)
        if (this.currentDetailOffset() > 0) {
          Row() {}.layoutWeight(1).height('100%')
        }
      }
      .width('100%').height('100%').justifyContent(FlexAlign.Start).backgroundColor(PAGE_BG)

      if (this.wideMasterPaneCollapsed) {
        SidebarToggleButton({ restore: true, controlSize: 44, onToggle: this.onRestoreMasterPane })
          .position({ x: 12, y: 12 }).zIndex(2)
          .hitTestBehavior(HitTestMode.Default)
      }
    }
    .layoutWeight(1).height('100%').backgroundColor(PAGE_BG)
  }

  @Builder
  private MasterPane() {
    Column() {
      Column() {
        AppSidebar({
          connectionState: this.remotePageState.connectionState,
          accountUserId: this.remotePageState.accountUserId,
          showCollapseButton: true,
          showViewSettingsButton: false,
          showWorkspaceSection: true,
          contentSlot: () => {
            this.WorkspaceMasterContent()
          },
          onClose: this.actions.onSidebar.close,
          onNewChat: this.actions.onSidebar.newChat,
          onEnterCode: this.actions.onSidebar.enterCode,
          onOpenMiniApps: this.actions.onRemoteHome.openMiniApps,
          onScanDesktop: this.actions.onSidebar.scanDesktop,
          onCollapse: this.onCollapseMasterPane,
          onOpenViewSettings: this.onOpenRemoteViewSettings,
          onSearchQueryChange: (query: string) => {
            this.actions.onRemoteHome.queryChanged(query);
          },
          onOpenSettings: this.actions.onSidebar.settings,
          onOpenAccount: this.actions.onSidebar.openAccount,
        })
      }
      .width('100%').height('100%').backgroundColor(CARD)
      .borderRadius(18).clip(true)
      .shadow({ radius: 24, color: SHADOW_SUBTLE, offsetX: 4, offsetY: 8 })
    }
    .width(WideLayoutGeometry.masterPaneWidth(this.filePreviewLayout, this.wideMasterPaneWidth))
    .height('100%').padding({ left: 10, right: 6, top: 10, bottom: 10 }).backgroundColor(PAGE_BG)
    .transition(this.wideMasterPaneMotionActive ?
      TransitionEffect.translate({ x: -28, y: 0 }).combine(TransitionEffect.opacity(0))
        .animation({ duration: 220, curve: Curve.EaseInOut }) : TransitionEffect.opacity(1))
  }

  @Builder
  private WorkspaceMasterContent() {
    SidebarWorkspaceSection({
      directoryState: this.deviceDirectoryState,
      sessions: this.remotePageState.visibleSessions(),
      recentWorkspaces: this.remotePageState.recentWorkspaces,
      workspaceName: this.remotePageState.workspaceName,
      workspacePath: this.remotePageState.workspacePath,
      workspaceKind: this.remotePageState.workspaceKind,
      connectionState: this.remotePageState.connectionState,
      controlTargetType: this.remotePageState.controlTargetType,
      controlTargetDeviceId: this.remotePageState.controlTargetDeviceId,
      controlTargetDeviceName: this.remotePageState.controlTargetDeviceName ||
        this.remotePageState.desktopName,
      selectedSessionId: this.wideSelectedSessionId(),
      runningSessionId: this.remotePageState.hasRunningActiveTurn() ?
        this.remotePageState.activeSession.sessionId : '',
      supportsHarnessProfiles: this.remotePageState.supportsHostCapability(
        REMOTE_CAPABILITY_HARNESS_PROFILES_V1),
      workspacePickerPlacement: this.sessionDetailsPlacement,
      onOpenSession: this.actions.onRemoteHome.openSessionInPlace,
      onCreateInWorkspace: (deviceId: string, path: string, agentType: string) => {
        this.actions.onRemoteHome.createInWorkspaceInPlace(path, agentType, deviceId);
      },
      onOpenWorkspace: (deviceId: string, path: string) => {
        this.actions.onRemoteHome.selectWorkspace(path, deviceId);
      },
      onExpandWorkspace: async (deviceId: string, path: string): Promise<void> => {
        await this.actions.onRemoteHome.loadWorkspaceSessions(deviceId, path);
      },
      onSelectDevice: this.actions.onRemoteHome.selectDirectoryDevice,
      onRetryDevice: this.actions.onRemoteHome.retryDirectoryDevice,
      onAddWorkspace: this.actions.onRemoteHome.addDirectoryWorkspace,
      onRefreshDevices: this.actions.onSidebar.refreshDevices,
      onAddDevice: this.actions.onSidebar.addDesktop
    })
  }

  @Builder
  private RemoteChatContent() {
    if (this.filePreviewLayout.placement === FilePreviewPlacement.WideTriplePane) {
      Row() {
        if (!this.wideMasterPaneCollapsed) {
          this.MasterPane()
          this.PaneGap(
            this.filePreviewLayout.masterConversationGap,
            this.filePreviewLayout.masterConversationGapIsCrease
          )
        }
        this.ConversationDetail(
          false,
          this.wideMasterPaneCollapsed ? this.collapsedTripleConversationWidth() :
            this.filePreviewLayout.conversationPaneWidth
        )
        this.PaneGap(
          this.filePreviewLayout.conversationPreviewGap,
          this.filePreviewLayout.conversationPreviewGapIsCrease
        )
        this.FilePreviewPane(this.filePreviewLayout.previewPaneWidth)
      }
      .width('100%').height('100%').backgroundColor(PAGE_BG)
    } else {
      Row() {
        if (!this.wideMasterPaneCollapsed) {
          this.MasterPane()
          this.MasterDetailGap()
        }
        this.ConversationDetail(false)
      }
      .width('100%').height('100%').backgroundColor(PAGE_BG)
    }
  }

  @Builder
  private RemotePreviewFocusContent() {
    Row() {
      this.ConversationDetail(false, this.filePreviewLayout.conversationPaneWidth)
      this.PaneGap(
        this.filePreviewLayout.conversationPreviewGap,
        this.filePreviewLayout.conversationPreviewGapIsCrease
      )
      this.FilePreviewPane(this.filePreviewLayout.previewPaneWidth)
    }
    .width('100%').height('100%').backgroundColor(PAGE_BG)
  }

  @Builder
  private RemoteMasterPreviewFocusContent() {
    Row() {
      this.MasterPane()
      this.PaneGap(
        this.filePreviewLayout.masterConversationGap,
        this.filePreviewLayout.masterConversationGapIsCrease
      )
      this.FilePreviewPane(this.filePreviewLayout.previewPaneWidth)
    }
    .width('100%').height('100%').backgroundColor(PAGE_BG)
  }

  @Builder
  private FilePreviewPane(paneWidth: number) {
    Column() {
      FilePreviewSurface({
        state: this.filePreviewState,
        remoteAvailable: RemoteUiState.canUseRemote(this.remotePageState.connectionState),
        downloadPath: this.remotePageState.downloadingFilePath,
        downloadedPath: this.remotePageState.downloadedFilePath,
        downloadStatus: this.remotePageState.fileDownloadStatus,
        previewExpanded: this.filePreviewExpanded,
        canToggleExpanded: this.canToggleFilePreviewExpanded,
        onClose: this.actions.onFilePreview.close,
        onRefresh: this.actions.onFilePreview.refresh,
        onDownload: this.actions.onFilePreview.download,
        onOpenLink: this.actions.onFilePreview.openLink,
        onToggleExpanded: this.onToggleFilePreviewExpanded
      })
    }
    .width(paneWidth).height('100%').backgroundColor(PAGE_BG)
  }

  @Builder
  private ConversationDetail(showBackButton: boolean, paneWidth: number = 0) {
    if (paneWidth > 0) {
      Column() {
        this.RouteSurface(showBackButton)
      }
      .width(paneWidth).height('100%').constraintSize({ maxWidth: WIDE_DETAIL_CONTENT_MAX_WIDTH })
      .backgroundColor(PAGE_BG)
    } else {
      Stack({ alignContent: Alignment.TopStart }) {
        Row() {
          if (this.currentDetailOffset() > 0) {
            Row() {}.width(this.currentDetailOffset()).height('100%')
          }
          Row() {
            Column() { this.RouteSurface(showBackButton) }
              .width('100%').height('100%')
              .backgroundColor(PAGE_BG)
          }
          .width(this.currentDetailWidth() > 0 ? this.currentDetailWidth() : '100%')
          .height('100%').justifyContent(FlexAlign.Center)
          if (this.currentDetailOffset() > 0) {
            Row() {}.layoutWeight(1).height('100%')
          }
        }
        .width('100%').height('100%').justifyContent(FlexAlign.Start).backgroundColor(PAGE_BG)
      }
      .layoutWeight(1).height('100%').backgroundColor(PAGE_BG)
    }
  }

  @Builder
  private RouteSurface(showBackButton: boolean) {
    ConversationRouteSurface({
      route: this.route,
      remotePageState: this.remotePageState,
      generalPageState: this.generalPageState,
      filePreviewState: this.filePreviewState,
      remoteSurfaceState: this.remoteSurfaceState,
      actions: this.actions,
      showSidebarButton: false,
      showBackButton,
      showSidebarRestoreButton: WideLayoutGeometry.showsMasterRestoreButton(
        this.wideMasterPaneCollapsed,
        this.filePreviewLayout
      ),
      useWidePresentation: true,
      onRestoreSidebar: this.onRestoreMasterPane
    })
  }

  @Builder
  private MasterDetailGap() {
    if (this.wideMasterDetailGap > 0) {
      // Reserve the physical crease so rows do not sit on the hinge, but do
      // not paint it as a divider. The device already has that hinge.
      Row() {}.width(this.wideMasterDetailGap).height('100%').backgroundColor(PAGE_BG)
    }
  }

  @Builder
  private PaneGap(width: number, isPhysicalCrease: boolean) {
    if (width > 0) {
      Row() {}.width(width).height('100%').backgroundColor(isPhysicalCrease ? PAGE_BG : LINE)
    }
  }

  private wideSelectedSessionId(): string {
    if (this.remotePageState.pendingSessionId.length > 0) {
      return this.remotePageState.pendingSessionId;
    }
    return AppRouteContract.isRemoteRoute(this.route) ?
      this.remotePageState.activeSession.sessionId : '';
  }

  private showsRemoteConversation(): boolean {
    return this.route === AppRoute.RemoteChat;
  }

  private showsRemoteDetail(): boolean {
    return this.route === AppRoute.RemoteChat;
  }

  private currentDetailOffset(): number {
    return WideLayoutGeometry.detailOffset(
      this.wideMasterPaneCollapsed,
      this.wideDetailContentOffset,
      this.wideCollapsedDetailContentOffset
    );
  }

  private currentDetailWidth(): number {
    return WideLayoutGeometry.detailWidth(
      this.wideMasterPaneCollapsed,
      this.wideDetailContentWidth,
      this.wideCollapsedDetailContentWidth
    );
  }

  private collapsedTripleConversationWidth(): number {
    return this.filePreviewLayout.masterPaneWidth +
      this.filePreviewLayout.masterConversationGap +
      this.filePreviewLayout.conversationPaneWidth;
  }

}
