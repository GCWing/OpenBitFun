import {
  AppRootPresentationActions,
  emptyAppRootPresentationActions
} from '../actions/AppRootPresentationActions';
import { AppRouteContract } from '../navigation/AppRouteContract';
import { AppShellState, CONNECT_INTENT_AUTO } from '../state/AppShellState';
import {
  SettingsPlacement,
  SettingsPlacementPolicy,
  SettingsSheetKind
} from '../policy/SettingsPlacementPolicy';
import { GeneralChatPageState } from '../state/GeneralChatPageState';
import { DeviceDirectoryState } from '../state/DeviceDirectoryState';
import { RemotePageState } from '../state/RemotePageState';
import { REMOTE_CAPABILITY_HARNESS_PROFILES_V1 } from '../../model/RemoteModels';
import { AppSidebar } from './AppSidebar';
import { ConnectView } from './ConnectView';
import { RemoteControlSettingsSheet } from './RemoteControlSettingsSheet';
import { RemoteSurfaceState } from './remote/RemoteSurfaceHost';
import { SettingsSheet } from './SettingsSheet';
import { SidebarWorkspaceSection } from './SidebarWorkspaceSection';

@ComponentV2
export struct AppSidebarSurface {
  @Param shellState: AppShellState = new AppShellState();
  @Param sessionDetailsPlacement: SettingsPlacement =
    SettingsPlacementPolicy.compactBottom(SettingsSheetKind.SessionDetails);
  @Param remotePageState: RemotePageState = new RemotePageState();
  @Param deviceDirectoryState: DeviceDirectoryState = new DeviceDirectoryState();
  @Param generalPageState: GeneralChatPageState = new GeneralChatPageState();
  @Param remoteSurfaceState: RemoteSurfaceState = new RemoteSurfaceState();
  @Param actions: AppRootPresentationActions = emptyAppRootPresentationActions();
  @Event onOpenRemoteViewSettings: () => void = () => {};

  build() {
    AppSidebar({
      connectionState: this.remotePageState.connectionState,
      isBusy: this.remotePageState.isBusy,
      workspaceKind: this.remotePageState.workspaceKind,
      workspacePath: this.remotePageState.workspacePath,
      controlTargetDeviceId: this.remotePageState.controlTargetDeviceId,
      supportsHarnessProfiles: this.remotePageState.supportsHostCapability(REMOTE_CAPABILITY_HARNESS_PROFILES_V1),
      accountUserId: this.remotePageState.accountUserId,
      controlTargetType: this.remotePageState.controlTargetType,
      showViewSettingsButton: false,
      showWorkspaceSection: true,
      contentSlot: () => {
        this.WorkspaceContent()
      },
      onClose: this.actions.onSidebar.close,
      onNewChat: this.actions.onSidebar.newChat,
      onEnterCode: this.actions.onSidebar.enterCode,
      onOpenMiniApps: this.actions.onRemoteHome.openMiniApps,
      onScanDesktop: this.actions.onSidebar.scanDesktop,
      onOpenViewSettings: this.onOpenRemoteViewSettings,
      onSearchQueryChange: (query: string) => {
        this.actions.onRemoteHome.queryChanged(query);
      },
      onOpenSettings: this.actions.onSidebar.settings,
      onOpenAccount: this.actions.onSidebar.openAccount,
    })
  }

  @Builder
  private WorkspaceContent() {
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
      selectedSessionId: this.remoteSelectedSessionId(),
      runningSessionId: this.remoteRunningSessionId(),
      supportsHarnessProfiles: this.remotePageState.supportsHostCapability(
        REMOTE_CAPABILITY_HARNESS_PROFILES_V1),
      workspacePickerPlacement: this.sessionDetailsPlacement,
      onOpenSession: this.actions.onSidebar.openSession,
      onCreateInWorkspace: (deviceId: string, path: string, agentType: string) => {
        this.actions.onSidebar.close();
        this.actions.onRemoteHome.createInWorkspace(path, agentType, deviceId);
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

  private remoteSelectedSessionId(): string {
    if (AppRouteContract.isGeneralComposerRoute(this.shellState.activeRoute)) {
      return '';
    }
    if (this.remotePageState.pendingSessionId.length > 0) {
      return this.remotePageState.pendingSessionId;
    }
    return this.remotePageState.activeSession.sessionId;
  }

  private remoteRunningSessionId(): string {
    return this.remotePageState.hasRunningActiveTurn() ? this.remotePageState.activeSession.sessionId : '';
  }
}

@ComponentV2
export struct AppSettingsSurface {
  @Param shellState: AppShellState = new AppShellState();
  @Param remotePageState: RemotePageState = new RemotePageState();
  @Param generalPageState: GeneralChatPageState = new GeneralChatPageState();
  @Param deviceId: string = '';
  @Param actions: AppRootPresentationActions = emptyAppRootPresentationActions();

  build() {
    if (this.shellState.settingsMode === 'remote' || this.shellState.settingsMode === 'account') {
      RemoteControlSettingsSheet({
        desktopName: this.remotePageState.desktopName,
        desktopId: this.remotePageState.desktopId,
        userId: this.remotePageState.userId,
        accountUsername: this.remotePageState.accountUsername,
        accountAvatarUrl: this.remotePageState.accountAvatarUrl,
        accountUserId: this.remotePageState.accountUserId,
        deviceId: this.deviceId,
        controlTargetType: this.remotePageState.controlTargetType,
        controlTargetDeviceId: this.remotePageState.controlTargetDeviceId,
        connectionState: this.remotePageState.connectionState,
        statusText: this.remotePageState.conversation.statusText,
        isBusy: this.remotePageState.conversation.isBusy,
        onClose: this.actions.onSettings.close,
        onOpenAccount: this.actions.onSettings.openAccount,
        onAddConnection: this.actions.onSettings.addConnection,
        cloudLogin: this.actions.onSettings.cloudLogin,
        cloudCancelLogin: this.actions.onSettings.cloudCancelLogin,
        cloudLogout: this.actions.onSettings.cloudLogout,
        cloudListDevices: this.actions.onSettings.cloudListDevices,
        cloudSelectDevice: this.actions.onSettings.cloudSelectDevice,
        getPermissionMode: this.actions.onSettings.getPermissionMode,
        setPermissionMode: this.actions.onSettings.setPermissionMode,
        openAccountOnAppear: this.shellState.settingsMode === 'account',
        onDisconnect: this.actions.onSettings.disconnect,
        onReconnect: this.actions.onSettings.reconnect
      })
    } else {
      SettingsSheet({
        sheetState: this.shellState.settingsSheet,
        accountUsername: this.remotePageState.accountUsername,
        accountAvatarUrl: this.remotePageState.accountAvatarUrl,
        authenticatedUserId: this.remotePageState.accountUserId,
        fallbackUserId: this.remotePageState.userId,
        desktopName: this.remotePageState.desktopName,
        desktopId: this.remotePageState.desktopId,
        deviceId: this.deviceId,
        controlTargetType: this.remotePageState.controlTargetType,
        controlTargetDeviceId: this.remotePageState.controlTargetDeviceId,
        connectionState: this.remotePageState.connectionState,
        onOpenAccount: this.actions.onSettings.openAccount,
        onDisconnect: this.actions.onSettings.disconnect,
        onClearPairing: this.actions.onSettings.clearPairing,
        onReconnect: this.actions.onSettings.reconnect,
        cloudLogout: this.actions.onSettings.cloudLogout,
        cloudListDevices: this.actions.onSettings.cloudListDevices,
        cloudSelectDevice: this.actions.onSettings.cloudSelectDevice,
        onSetLanguage: this.actions.onSettings.setLanguage,
        onClose: this.actions.onSettings.close
      })
    }
  }
}

@ComponentV2
export struct AppConnectSurface {
  @Param remotePageState: RemotePageState = new RemotePageState();
  @Param deviceId: string = '';
  @Param openIntent: string = CONNECT_INTENT_AUTO;
  @Param actions: AppRootPresentationActions = emptyAppRootPresentationActions();

  build() {
    ConnectView({
      remoteUrl: this.remotePageState.remoteUrl,
      userId: this.remotePageState.userId,
      statusText: this.remotePageState.conversation.statusText,
      connectionState: this.remotePageState.connectionState,
      connectionFailureKind: this.remotePageState.connectionFailureKind,
      isBusy: this.remotePageState.conversation.isBusy,
      isConnected: this.remotePageState.connectionState === 'connected',
      desktopName: this.remotePageState.desktopName,
      deviceId: this.deviceId,
      accountUserId: this.remotePageState.accountUserId,
      controlTargetDeviceId: this.remotePageState.controlTargetDeviceId,
      requiresAccountAuth: this.remotePageState.requiresAccountAuth,
      accountUsername: this.remotePageState.accountUsername,
      openIntent: this.openIntent,
      onBack: this.actions.onConnect.back,
      onOpenAccount: this.actions.onConnect.openAccount,
      onConnect: this.actions.onConnect.connect,
      onRemoteUrlChange: this.actions.onConnect.urlChanged,
      onUserIdChange: this.actions.onConnect.userChanged,
      onRemoteUrlDetected: this.actions.onConnect.detected,
      onRemoteUrlInputVisibleChange: this.actions.onConnect.inputVisible,
      cloudListDevices: this.actions.onConnect.cloudListDevices,
      cloudSelectDevice: this.actions.onConnect.cloudSelectDevice
    })
    .width('100%')
    .height('100%')
  }
}
