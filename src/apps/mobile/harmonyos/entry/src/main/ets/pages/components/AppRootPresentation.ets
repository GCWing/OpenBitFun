import { RemoteCompactHomePolicy } from '../policy/RemoteCompactHomePolicy';
import { MiniAppActions, emptyMiniAppActions } from '../../model/MiniAppModels';
import { MiniAppState } from '../state/MiniAppState';
import { MiniAppSurface } from './MiniAppSurface';
import display from '@ohos.display';
import mediaQuery from '@ohos.mediaquery';
import { RemoteUiState } from '../../services/RemoteUiState';
import { AppShell } from './AppShell';
import { FilePreviewSurface } from './FilePreviewSurface';
import { PAGE_BG } from './Theme';
import { AppRoute } from '../navigation/AppRouteContract';
import {
  AppRootPresentationActions,
  emptyAppRootPresentationActions
} from '../actions/AppRootPresentationActions';
import { AppShellState } from '../state/AppShellState';
import {
  ConversationLayoutCrease,
  ConversationLayoutHorizontalCrease,
  ConversationLayoutPolicy,
  ConversationLayoutRect
} from '../policy/ConversationLayoutPolicy';
import { AdaptiveLayoutInput } from '../policy/AdaptiveLayoutInput';
import {
  SettingsPlacement,
  SettingsPlacementPolicy,
  SettingsSheetKind
} from '../policy/SettingsPlacementPolicy';
import { AdaptiveSheetOptions } from './AdaptiveSheetOptions';
import { i18n } from '@kit.LocalizationKit';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { GeneralChatPageState } from '../state/GeneralChatPageState';
import { DeviceDirectoryState } from '../state/DeviceDirectoryState';
import { RemotePageState } from '../state/RemotePageState';
import { FilePreviewState } from '../state/FilePreviewState';
import {
  FilePreviewLayout,
  FilePreviewPlacement,
  FilePreviewPlacementPolicy
} from '../policy/FilePreviewPlacementPolicy';
import { WideLayoutGeometry } from '../layout/WideLayoutGeometry';
import { ConversationRouteSurface } from './ConversationRouteSurface';
import { WideConversationHost } from './WideConversationHost';
import {
  AppConnectSurface,
  AppSettingsSurface,
  AppSidebarSurface
} from './AppRootOverlaySurfaces';
import {
  RemoteSurfaceHost,
  RemoteSurfaceMode,
  RemoteSurfaceState
} from './remote/RemoteSurfaceHost';

function safeFoldStatus(): display.FoldStatus {
  try { return display.getFoldStatus(); } catch (_err) { return display.FoldStatus.FOLD_STATUS_UNKNOWN; }
}

enum WideWorkspacePresentationMode {
  Default = 'default',
  SidebarCollapsed = 'sidebar_collapsed',
  PreviewExpanded = 'preview_expanded'
}

@ComponentV2
export struct AppRootPresentation {
  @Param miniAppState: MiniAppState = new MiniAppState();
  @Param miniAppActions: MiniAppActions = emptyMiniAppActions();
  @Param shellState: AppShellState = new AppShellState();
  @Param navigationStack: NavPathStack = new NavPathStack();
  @Param remotePageState: RemotePageState = new RemotePageState();
  @Param deviceDirectoryState: DeviceDirectoryState = new DeviceDirectoryState();
  @Param generalPageState: GeneralChatPageState = new GeneralChatPageState();
  @Param filePreviewState: FilePreviewState = new FilePreviewState();
  @Param deviceId: string = '';
  @Local viewportWidth: number = 0;
  @Local viewportHeight: number = 0;
  @Local wideLayoutMatched: boolean = false;
  @Local foldStatus: display.FoldStatus = safeFoldStatus();
  @Local largeScreenLayout: boolean = false;
  @Local wideMasterPaneWidth: number = ConversationLayoutPolicy.FALLBACK_MASTER_PANE_WIDTH;
  @Local wideMasterDetailGap: number = 0;
  @Local wideDetailContentOffset: number = 0;
  @Local wideDetailContentWidth: number = 0;
  @Local wideCollapsedDetailContentOffset: number = 0;
  @Local wideCollapsedDetailContentWidth: number = 0;
  @Local wideWorkspacePresentationMode: WideWorkspacePresentationMode = WideWorkspacePresentationMode.Default;
  @Local wideMasterPaneMotionActive: boolean = false;
  @Local showRemoteViewSettings: boolean = false;
  @Local remoteSurfaceState: RemoteSurfaceState = new RemoteSurfaceState();
  @Local settingsPlacement: SettingsPlacement =
    SettingsPlacementPolicy.compactBottom(SettingsSheetKind.Settings);
  @Local connectPlacement: SettingsPlacement =
    SettingsPlacementPolicy.compactBottom(SettingsSheetKind.Connect);
  @Local sessionDetailsPlacement: SettingsPlacement =
    SettingsPlacementPolicy.compactBottom(SettingsSheetKind.SessionDetails);
  @Local remoteViewSettingsPlacement: SettingsPlacement =
    SettingsPlacementPolicy.compactBottom(SettingsSheetKind.RemoteViewSettings);
  private verticalCreases: ConversationLayoutCrease[] = [];
  private horizontalCreases: ConversationLayoutHorizontalCrease[] = [];
  private wideQueryListener?: mediaQuery.MediaQueryListener;
  private foldStatusChanged: (status: display.FoldStatus) => void =
    (status: display.FoldStatus): void => {
      this.foldStatus = status;
      this.refreshWideGeometry();
    };
  private foldDisplayModeChanged: (mode: display.FoldDisplayMode) => void =
    (_mode: display.FoldDisplayMode): void => {
      this.refreshWideGeometry();
    };
  private wideQueryChanged: (result: mediaQuery.MediaQueryResult) => void =
    (result: mediaQuery.MediaQueryResult): void => {
      this.wideLayoutMatched = result.matches;
      this.refreshWideGeometry();
    };
  @Param actions: AppRootPresentationActions = emptyAppRootPresentationActions();

  aboutToAppear(): void {
    this.bindResponsiveQueries();
    this.bindFoldStatus();
  }

  aboutToDisappear(): void {
    this.unbindFoldStatus();
    this.unbindResponsiveQueries();
  }

  @Monitor('filePreviewState.visible')
  onFilePreviewVisibilityChanged(): void {
    if (!this.filePreviewState.visible && this.isFilePreviewExpanded()) {
      this.wideWorkspacePresentationMode = WideWorkspacePresentationMode.Default;
    }
  }

  build() {
    Stack() {
      AppShell({
        shellState: this.shellState,
        useWideLayout: this.isWideLayout(),
        allowSidebar: !this.showWelcomeHome(),
        settingsPlacement: this.settingsPlacement,
        compactAccountLogin: this.shellState.settingsMode === 'account' &&
          this.remotePageState.accountUserId.trim().length === 0,
        connectPlacement: this.connectPlacement,
        content: () => { this.NavigationContent(); },
        sidebar: () => { this.SidebarContent(); },
        settings: () => { this.SettingsContent(); },
        connect: () => { this.ConnectContent(); },
        onCloseSidebar: this.actions.onCloseSidebar
      })
      if (this.filePreviewPlacement() === FilePreviewPlacement.CompactFullPage) {
        this.FilePreviewPane()
      }
    }
    .width('100%')
    .height('100%')
    .id(`app-root-locale-${this.shellState.localeRevision}`)
    .bindSheet($$this.showRemoteViewSettings, this.RemoteViewSettingsSheet(), this.remoteViewSettingsSheetOptions())
    .onAreaChange((_oldArea: Area, newArea: Area) => {
      const areaWidth = this.areaWidth(newArea.width);
      const areaHeight = this.areaWidth(newArea.height);
      const displaySize = this.currentDisplaySize();
      this.viewportWidth = ConversationLayoutPolicy.resolveLayoutViewportWidth(
        areaWidth,
        areaHeight,
        displaySize[0],
        displaySize[1],
        displaySize[2]
      );
      this.viewportHeight = areaHeight > 0 ? areaHeight : displaySize[1];
      if (this.viewportWidth === Math.max(displaySize[0], displaySize[1]) &&
        areaWidth !== this.viewportWidth) {
        this.viewportHeight = Math.min(displaySize[0], displaySize[1]);
      }
      this.refreshWideGeometry();
    })
  }

  @Builder
  NavigationContent() {
    Stack() {
      Navigation(this.navigationStack) { this.RouteContent(AppRoute.RemoteHome) }
        .id('openbitfunHomeNavigation')
        .width('100%').height('100%').hideTitleBar(true)
        .mode(NavigationMode.Stack)
        .navBarWidth('100%')
        .minContentWidth(0)
        .navDestination(this.NavigationDestination)
        .visibility(this.isWideLayout() ? Visibility.Hidden : Visibility.Visible)

      if (this.isWideLayout()) {
        Column() { this.WideRouteContent() }
          .width('100%').height('100%').backgroundColor(PAGE_BG)
      }

      // Sidebar destinations belong to the moving content pane. A root-level
      // overlay would cover the drawer before its closing animation can run.
      if (this.miniAppState.visible) {
        MiniAppSurface({ state: this.miniAppState, actions: this.miniAppActions })
      }
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  NavigationDestination(name: string) {
    NavDestination() { this.RouteContent(name as AppRoute) }.hideTitleBar(true).backgroundColor(PAGE_BG)
      .onBackPressed(() => this.actions.onNavigationBack(name as AppRoute))
  }

  /**
   * The wide column, and the only place the wide surface is built. The route is
   * read here rather than taken as a @Builder parameter: a parameterised
   * builder re-evaluates its arguments only when its own body re-runs, so the
   * column used to keep whatever route it was first built with and a workspace
   * session opened behind a pane that never followed.
   */
  @Builder
  WideRouteContent() {
    if (this.showWelcomeHome()) {
      RemoteSurfaceHost({
        mode: RemoteSurfaceMode.Placeholder,
        remotePageState: this.remotePageState,
        presentationState: this.remoteSurfaceState,
        actions: this.actions
      })
    } else {
    WideConversationHost({
      route: this.shellState.activeRoute,
      shellState: this.shellState,
      remotePageState: this.remotePageState,
      deviceDirectoryState: this.deviceDirectoryState,
      generalPageState: this.generalPageState,
      filePreviewState: this.filePreviewState,
      remoteSurfaceState: this.remoteSurfaceState,
      actions: this.actions,
      filePreviewLayout: this.filePreviewLayout(),
      sessionDetailsPlacement: this.sessionDetailsPlacement,
      wideMasterPaneWidth: this.wideMasterPaneWidth,
      wideMasterDetailGap: this.wideMasterDetailGap,
      wideDetailContentOffset: this.wideDetailContentOffset,
      wideDetailContentWidth: this.wideDetailContentWidth,
      wideCollapsedDetailContentOffset: this.wideCollapsedDetailContentOffset,
      wideCollapsedDetailContentWidth: this.wideCollapsedDetailContentWidth,
      wideMasterPaneCollapsed: this.wideWorkspacePresentationMode ===
        WideWorkspacePresentationMode.SidebarCollapsed,
      wideMasterPaneMotionActive: this.wideMasterPaneMotionActive,
      filePreviewExpanded: this.wideWorkspacePresentationMode ===
        WideWorkspacePresentationMode.PreviewExpanded,
      canToggleFilePreviewExpanded: this.canToggleFilePreviewExpanded(),
      onCollapseMasterPane: () => this.collapseWideMasterPane(),
      onRestoreMasterPane: () => this.restoreWideMasterPane(),
      onToggleFilePreviewExpanded: () => this.toggleFilePreviewExpanded(),
      onOpenRemoteViewSettings: () => { this.showRemoteViewSettings = true; }
    })
    }
  }

  /**
   * Navigation content, which is the compact surface only. Wide layout keeps
   * the stack for its paths and its back handling but draws the surface in
   * WideRouteContent, so building it here too would put an invisible second
   * copy behind the visible one — per nav bar, and per pushed destination.
   */
  @Builder
  RouteContent(route: AppRoute) {
    if (!this.isWideLayout()) {
      ConversationRouteSurface({
        route,
        remotePageState: this.remotePageState,
        generalPageState: this.generalPageState,
        filePreviewState: this.filePreviewState,
        remoteSurfaceState: this.remoteSurfaceState,
        actions: this.actions,
        showSidebarButton: true,
        // Compact conversations own the drawer, not a back control: Local and
        // Remote both open the sidebar over the chat instead of leaving it.
        showBackButton: false,
        hoverOperateMode: this.isHoverLayout(),
        onRestoreSidebar: () => this.restoreWideMasterPane()
      })
    }
  }

  @Builder
  RemoteViewSettingsSheet() {
    RemoteSurfaceHost({
      mode: RemoteSurfaceMode.Settings,
      remotePageState: this.remotePageState,
      presentationState: this.remoteSurfaceState,
      actions: this.actions,
      onCloseSettings: () => { this.showRemoteViewSettings = false; }
    })
  }

  @Builder
  FilePreviewPane(paneWidth: number = 0) {
    Column() {
      FilePreviewSurface({
        state: this.filePreviewState,
        remoteAvailable: RemoteUiState.canUseRemote(this.remotePageState.connectionState),
        downloadPath: this.remotePageState.downloadingFilePath,
        downloadedPath: this.remotePageState.downloadedFilePath,
        downloadStatus: this.remotePageState.fileDownloadStatus,
        onClose: this.actions.onFilePreview.close,
        onRefresh: this.actions.onFilePreview.refresh,
        onDownload: this.actions.onFilePreview.download,
        onOpenLink: this.actions.onFilePreview.openLink
      })
    }
    .layoutWeight(paneWidth > 0 ? 0 : 1)
    .width(paneWidth > 0 ? paneWidth : '100%')
    .height('100%')
    .backgroundColor(PAGE_BG)
  }

  private showWelcomeHome(): boolean {
    return RemoteCompactHomePolicy.shouldShowWelcomeHome(this.remotePageState.controlTargetType,
      this.remotePageState.connectionState, this.remotePageState.accountUserId.trim().length > 0);
  }

  private isWideLayout(): boolean {
    return this.largeScreenLayout;
  }

  private collapseWideMasterPane(): void {
    if (!this.isWideLayout()) {
      return;
    }
    // Expanded preview borrows the conversation panels while keeping workspace
    // navigation visible. Collapsing navigation exits that focus mode first,
    // then leaves the regular right-panel preview beside the wider chat.
    this.enableWideMasterPaneMotion();
    this.getUIContext().animateTo({ duration: 220, curve: Curve.EaseInOut }, () => {
      this.wideWorkspacePresentationMode = WideWorkspacePresentationMode.SidebarCollapsed;
    });
  }

  private restoreWideMasterPane(): void {
    const previewLayout = this.filePreviewLayout();
    if (WideLayoutGeometry.restoreMasterClosesPreview(previewLayout)) {
      // Focus split temporarily borrows the master pane's space. Restoring the
      // master therefore dismisses the preview instead of leaving a restore
      // control that cannot change the visible layout.
      this.actions.onFilePreview.close();
    }
    this.enableWideMasterPaneMotion();
    this.getUIContext().animateTo({ duration: 220, curve: Curve.EaseInOut }, () => {
      this.wideWorkspacePresentationMode = WideWorkspacePresentationMode.Default;
    });
  }

  private enableWideMasterPaneMotion(): void {
    this.wideMasterPaneMotionActive = true;
    setTimeout(() => {
      this.wideMasterPaneMotionActive = false;
    }, 240);
  }

  private toggleFilePreviewExpanded(): void {
    if (!this.canToggleFilePreviewExpanded()) {
      return;
    }
    this.wideWorkspacePresentationMode = this.isFilePreviewExpanded() ?
      WideWorkspacePresentationMode.Default : WideWorkspacePresentationMode.PreviewExpanded;
  }

  private canToggleFilePreviewExpanded(): boolean {
    if (!this.filePreviewState.visible || !this.isWideLayout()) {
      return false;
    }
    const defaultLayout = FilePreviewPlacementPolicy.resolveLayout(
      true,
      true,
      this.viewportWidth,
      this.verticalCreases,
      this.wideMasterPaneWidth,
      false
    );
    const expandedLayout = FilePreviewPlacementPolicy.resolveLayout(
      true,
      true,
      this.viewportWidth,
      this.verticalCreases,
      this.wideMasterPaneWidth,
      true
    );
    return defaultLayout.placement === FilePreviewPlacement.WideTriplePane &&
      expandedLayout.placement === FilePreviewPlacement.WideMasterPreviewFocus;
  }

  private filePreviewPlacement(): FilePreviewPlacement {
    return this.filePreviewLayout().placement;
  }

  private filePreviewLayout(): FilePreviewLayout {
    return FilePreviewPlacementPolicy.resolveLayout(
      this.filePreviewState.visible,
      this.isWideLayout(),
      this.viewportWidth,
      this.verticalCreases,
      this.wideMasterPaneWidth,
      this.isFilePreviewExpanded()
    );
  }

  private isWideMasterPaneCollapsed(): boolean {
    return this.wideWorkspacePresentationMode === WideWorkspacePresentationMode.SidebarCollapsed;
  }

  private isFilePreviewExpanded(): boolean {
    return this.wideWorkspacePresentationMode === WideWorkspacePresentationMode.PreviewExpanded;
  }

  private bindResponsiveQueries(): void {
    this.unbindResponsiveQueries();
    try {
      const appMediaQuery = this.getUIContext().getMediaQuery();
      this.wideQueryListener = appMediaQuery.matchMediaSync(
        `screen and (${ConversationLayoutPolicy.MD_MIN_WIDTH} < width)`
      );
      this.wideLayoutMatched = this.wideQueryListener.matches;
      this.wideQueryListener.on('change', this.wideQueryChanged);
    } catch (_err) {
      this.wideLayoutMatched = this.viewportWidth >= ConversationLayoutPolicy.WIDE_LAYOUT_MIN_WIDTH;
      this.unbindResponsiveQueries();
    }
  }

  private bindFoldStatus(): void {
    this.unbindFoldStatus();
    try {
      this.foldStatus = display.getFoldStatus();
      this.refreshWideGeometry();
      display.on('foldStatusChange', this.foldStatusChanged);
      display.on('foldDisplayModeChange', this.foldDisplayModeChanged);
    } catch (_err) {
      this.foldStatus = display.FoldStatus.FOLD_STATUS_UNKNOWN;
      this.unbindFoldStatus();
    }
  }

  private unbindFoldStatus(): void {
    try {
      display.off('foldStatusChange', this.foldStatusChanged);
      display.off('foldDisplayModeChange', this.foldDisplayModeChanged);
    } catch (_err) {
    }
  }

  private unbindResponsiveQueries(): void {
    if (this.wideQueryListener) {
      this.wideQueryListener.off('change', this.wideQueryChanged);
      this.wideQueryListener = undefined;
    }
  }

  private areaWidth(width: Object): number {
    return WideLayoutGeometry.areaLength(width);
  }

  private refreshWideGeometry(): void {
    const wasWideLayout = this.largeScreenLayout;
    const creaseRects = this.reportedCreaseRects();
    const reportedVertical = ConversationLayoutPolicy.verticalCreasesFromRects(
      this.viewportWidth,
      this.viewportHeight,
      creaseRects
    );
    this.horizontalCreases = ConversationLayoutPolicy.horizontalCreasesFromRects(
      this.viewportWidth,
      this.viewportHeight,
      creaseRects
    );
    const verticalCreases = this.currentVerticalCreases(reportedVertical);
    this.verticalCreases = verticalCreases;
    this.largeScreenLayout = ConversationLayoutPolicy.useMasterDetail(
      this.viewportWidth,
      this.wideLayoutMatched,
      ConversationLayoutPolicy.isFoldedStatus(this.foldStatus),
      verticalCreases,
      this.isExpandedFoldable(),
      this.isHoverLayout()
    );
    const geometry = ConversationLayoutPolicy.resolveWideGeometry(
      this.viewportWidth,
      verticalCreases
    );
    this.wideMasterPaneWidth = geometry.masterPaneWidth;
    this.wideMasterDetailGap = geometry.masterDetailGap;
    this.wideDetailContentOffset = geometry.detailContentOffset;
    this.wideDetailContentWidth = geometry.detailContentWidth;
    this.wideCollapsedDetailContentOffset = geometry.collapsedDetailContentOffset;
    this.wideCollapsedDetailContentWidth = geometry.collapsedDetailContentWidth;
    this.refreshSheetPlacements(reportedVertical);
    this.actions.onLayoutModeChanged(this.largeScreenLayout);
    if (wasWideLayout && !this.largeScreenLayout) {
      this.actions.onCompactLayoutEntered();
    }
  }

  private refreshSheetPlacements(reportedVertical: ConversationLayoutCrease[]): void {
    const input = new AdaptiveLayoutInput(
      this.viewportWidth,
      this.viewportHeight,
      this.foldStatus,
      ConversationLayoutPolicy.isFoldedStatus(this.foldStatus),
      this.isExpandedFoldable(),
      this.isHoverLayout(),
      this.wideLayoutMatched,
      reportedVertical,
      this.horizontalCreases,
      this.isRtlLayout()
    );
    this.settingsPlacement = SettingsPlacementPolicy.resolve(input, SettingsSheetKind.Settings);
    this.connectPlacement = SettingsPlacementPolicy.resolve(input, SettingsSheetKind.Connect);
    this.sessionDetailsPlacement = SettingsPlacementPolicy.resolve(input, SettingsSheetKind.SessionDetails);
    this.remoteViewSettingsPlacement = SettingsPlacementPolicy.resolve(
      input,
      SettingsSheetKind.RemoteViewSettings
    );
  }

  private isRtlLayout(): boolean {
    try {
      return i18n.isRTL(RemoteI18n.language());
    } catch (_err) {
      return false;
    }
  }

  private isHoverLayout(): boolean {
    return ConversationLayoutPolicy.useHoverOperate(
      this.foldStatus,
      this.viewportWidth,
      this.viewportHeight
    );
  }

  private isExpandedFoldable(): boolean {
    return ConversationLayoutPolicy.isExpandedFoldableStatus(this.foldStatus) && this.isFoldableDevice();
  }

  private currentDisplaySize(): [number, number, number] {
    try {
      const metrics = display.getDefaultDisplaySync();
      return [
        this.getUIContext().px2vp(metrics.width),
        this.getUIContext().px2vp(metrics.height),
        metrics.rotation
      ];
    } catch (_err) {
      return [0, 0, 0];
    }
  }

  private isFoldableDevice(): boolean {
    try {
      return display.isFoldable();
    } catch (_err) {
      return ConversationLayoutPolicy.isExpandedFoldableStatus(this.foldStatus) ||
        ConversationLayoutPolicy.isFoldedStatus(this.foldStatus);
    }
  }

  private currentVerticalCreases(reportedVertical: ConversationLayoutCrease[]): ConversationLayoutCrease[] {
    if (ConversationLayoutPolicy.isFoldedStatus(this.foldStatus) || this.isHoverLayout()) {
      return [];
    }
    return ConversationLayoutPolicy.effectiveVerticalCreases(
      this.viewportWidth,
      reportedVertical,
      this.isExpandedFoldable()
    );
  }

  private reportedCreaseRects(): ConversationLayoutRect[] {
    try {
      const region = display.getCurrentFoldCreaseRegion();
      const creaseRects = region.creaseRects;
      if (!creaseRects) {
        return [];
      }
      return creaseRects.map((rect: display.Rect): ConversationLayoutRect => {
        return new ConversationLayoutRect(
          this.getUIContext().px2vp(rect.left),
          this.getUIContext().px2vp(rect.top),
          this.getUIContext().px2vp(rect.width),
          this.getUIContext().px2vp(rect.height)
        );
      });
    } catch (_err) {
      return [];
    }
  }

  private remoteViewSettingsSheetOptions(): SheetOptions {
    return AdaptiveSheetOptions.fromPlacement(this.remoteViewSettingsPlacement, true);
  }

  @Builder SidebarContent() {
    AppSidebarSurface({
      shellState: this.shellState,
      sessionDetailsPlacement: this.sessionDetailsPlacement,
      remotePageState: this.remotePageState,
      deviceDirectoryState: this.deviceDirectoryState,
      generalPageState: this.generalPageState,
      remoteSurfaceState: this.remoteSurfaceState,
      actions: this.actions,
      onOpenRemoteViewSettings: () => { this.showRemoteViewSettings = true; }
    })
  }

  @Builder SettingsContent() {
    AppSettingsSurface({
      shellState: this.shellState,
      remotePageState: this.remotePageState,
      generalPageState: this.generalPageState,
      deviceId: this.deviceId,
      actions: this.actions
    })
  }

  @Builder ConnectContent() {
    AppConnectSurface({
      remotePageState: this.remotePageState,
      deviceId: this.deviceId,
      openIntent: this.shellState.connectSheetIntent,
      actions: this.actions
    })
  }
}
